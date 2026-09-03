import type OpenAI from 'openai'
import { agentEventBus } from './event-bus'
import { agentDebugLog } from './debug-log'
import {
  AgentPermissionEngine,
  createAgentOperationKey,
  hasExplicitWriteIntent,
} from './permission-engine'
import { AgentRecoveryManager, abortableSleep } from './recovery-manager'
import { formatAgentSchemaErrors, validateAgentToolInput } from './schema-validator'
import { AgentTraceRecorder, createAgentId } from './trace-recorder'
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentChange,
  AgentContextSnapshot,
  AgentModelUsage,
  AgentRunMetrics,
  AgentRuntimeCallbacks,
  AgentRuntimeDependencies,
  AgentRuntimeInput,
  AgentRuntimeOutcome,
  AgentRuntimeResult,
  AgentStep,
  AgentTerminationReason,
  AgentTool,
  AgentToolResult,
  ToolCall,
  ToolResult,
} from './types'

const MAX_MISSING_WRITE_TOOL_REPAIRS = 2
const MUTATING_TOOL_RISKS = new Set(['editor-write', 'file-create', 'file-update', 'delete', 'medium'])

interface StreamingToolCallAccumulator {
  id?: string
  index: number
  type?: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface ModelTurn {
  assistantContent: string
  finishReason?: string | null
  toolUses: OpenAI.Chat.ChatCompletionMessageToolCall[]
  usage?: AgentModelUsage
  attempt: number
}

interface MutableMetrics {
  startedAt: number
  currentIteration: number
  iterations: number
  modelCalls: number
  modelAttempts: number
  retries: number
  successfulTools: number
  failedTools: number
  deduplicatedTools: number
  effectUnknownCount: number
  usage?: AgentModelUsage
}

class AgentDeadlineError extends Error {
  constructor(readonly kind: 'model' | 'tool' | 'approval', readonly timeoutMs: number) {
    super(`${kind} timed out after ${timeoutMs}ms`)
    this.name = 'AgentDeadlineError'
  }
}

function notifyObserver<Args extends unknown[]>(
  observer: ((...args: Args) => unknown) | undefined,
  ...args: Args
) {
  try {
    if (!observer) return
    const detachedArgs = args.map((value) => {
      if (!value || typeof value !== 'object') return value
      try {
        return structuredClone(value)
      } catch {
        try {
          return JSON.parse(JSON.stringify(value))
        } catch {
          return undefined
        }
      }
    }) as Args
    const result = observer(...detachedArgs)
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => undefined)
    }
  } catch {
    // UI and trace observers are best-effort and cannot alter runtime semantics.
  }
}

function parseToolArguments(rawArguments: string | undefined): Record<string, unknown> {
  if (!rawArguments || !rawArguments.trim()) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch (error) {
    throw new Error(`Invalid tool arguments JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid tool arguments JSON: the top-level value must be an object')
  }
  return parsed as Record<string, unknown>
}

function toolResultToLegacy(result: AgentToolResult): ToolResult {
  return {
    success: result.ok,
    message: result.message,
    data: result.data,
    error: result.error,
    effectStatus: result.effectStatus,
  }
}

function stringifyToolResult(result: AgentToolResult) {
  return JSON.stringify({
    ok: result.ok,
    message: result.message,
    data: result.data,
    error: result.error,
    effectStatus: result.effectStatus,
    changes: result.changes,
  })
}

function stringifyMessageContent(content: unknown) {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function normalizeBaseMessage(message: OpenAI.Chat.ChatCompletionMessageParam): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'system') return message
  return {
    role: 'user',
    content: `## App Context\n${stringifyMessageContent(message.content)}`,
  }
}

function toToolCallList(toolCalls: Map<number, StreamingToolCallAccumulator>) {
  return [...toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .filter((toolCall) => toolCall.function.name)
    .map((toolCall): OpenAI.Chat.ChatCompletionMessageToolCall => ({
      id: toolCall.id || createAgentId('tool-call'),
      type: 'function',
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }))
}

function isMutatingTool(tool: AgentTool) {
  return MUTATING_TOOL_RISKS.has(tool.risk)
}

function normalizeToolEffect(tool: AgentTool, result: AgentToolResult): AgentToolResult {
  if (!isMutatingTool(tool)) {
    return {
      ...result,
      effectStatus: result.effectStatus || 'none',
    }
  }

  if (result.effectStatus === 'unknown') {
    return {
      ...result,
      ok: false,
      error: 'EFFECT_UNKNOWN',
    }
  }

  if (result.effectStatus) {
    return result
  }

  if (result.ok) {
    return { ...result, effectStatus: 'applied' }
  }

  // A write executor has already started. A legacy-style structured failure
  // without an explicit effect status cannot prove that it failed before the
  // side effect, so it must be protected from automatic replay.
  return {
    ...result,
    error: 'EFFECT_UNKNOWN',
    effectStatus: 'unknown',
  }
}

function getForcedWriteTool(context: AgentContextSnapshot) {
  if (!hasExplicitWriteIntent(context.userInput) || !context.currentQuote) return undefined
  if (context.currentQuote.from >= 0 && context.currentQuote.to >= context.currentQuote.from) {
    return 'editor_replace_range'
  }
  if (context.currentQuote.startLine > 0 && context.currentQuote.endLine >= context.currentQuote.startLine) {
    return 'editor_replace_lines'
  }
  return undefined
}

function buildToolChoice(context: AgentContextSnapshot): OpenAI.Chat.ChatCompletionToolChoiceOption {
  const forcedTool = getForcedWriteTool(context)
  return forcedTool
    ? { type: 'function', function: { name: forcedTool } }
    : 'auto'
}

function requiresSelectedContext(userInput: string) {
  return /(这段|这句话|这行|选中|所选|引用|这部分|当前选区|selected|selection|this text|this paragraph|this line)/i.test(userInput)
}

function hasExplicitMcpIntent(userInput: string) {
  const token = '(?:\\bMCP\\b|Model\\s+Context\\s+Protocol)'
  if (new RegExp(`(不要|不使用|无需|禁止|别)[^\\n。；;，,]{0,12}${token}|without[^\\n。；;，,]{0,12}${token}`, 'i').test(userInput)) {
    return false
  }
  return new RegExp(`(使用|用|通过(?!的)|调用|借助)[^\\n。；;，,]{0,12}${token}|\\b(use|using|call|invoke|via|with)\\b[^\\n。；;，,]{0,12}${token}`, 'i').test(userInput)
}

function requestedDisabledCapability(userInput: string) {
  if (hasExplicitMcpIntent(userInput)) return 'MCP'
  const negatedSkill = /(不要|不使用|不调用|无需|禁止|别)[^。；;\n]{0,40}(Agent\s*)?(Skill|技能)|\b(do not|don't|without)\b[^.;\n]{0,40}\b(agent\s+)?skills?\b/i.test(userInput)
  if (!negatedSkill && /(使用|调用|执行|加载|通过).{0,12}(Agent\s*)?(Skill|技能)|\b(use|invoke|run|load)\b.{0,12}\b(agent\s+)?skills?\b/i.test(userInput)) {
    return 'Skills'
  }
  const negatedMemory = /(不要|不使用|不调用|不写入|不读取|无需|禁止|别)[^。；;\n]{0,48}(Agent\s*)?(长期记忆|记忆工具|Memory\s*Agent)|\b(do not|don't|without)\b[^.;\n]{0,48}\b(memory agent|memory tool)\b/i.test(userInput)
  if (!negatedMemory && /(写入|保存|读取|删除|清空|调用|使用).{0,12}(Agent\s*)?(长期记忆|记忆工具|Memory\s*Agent)|\b(use|invoke|write|read|clear)\b.{0,12}\b(memory agent|memory tool)\b/i.test(userInput)) {
    return 'Memory Agent'
  }
  return undefined
}

function normalizeFilePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim()
}

function explicitTargetPath(userInput: string) {
  const match = userInput.match(/(?:^|[\s"'`：:，,（(])((?:[\w.-]+\/)+[\w.-]+\.md|[\w.-]+\.md)(?=$|[\s"'`。；;，,）)])/i)
  return match?.[1] ? normalizeFilePath(match[1]) : undefined
}

function sameFile(left: string, right: string) {
  const normalizedLeft = normalizeFilePath(left)
  const normalizedRight = normalizeFilePath(right)
  return normalizedLeft === normalizedRight ||
    (!normalizedLeft.includes('/') && normalizedRight.endsWith(`/${normalizedLeft}`)) ||
    (!normalizedRight.includes('/') && normalizedLeft.endsWith(`/${normalizedRight}`))
}

function hasCreateOnlyFileIntent(userInput: string) {
  if (/(新建|创建).{0,20}(文件夹|目录)|create.{0,20}(folder|directory)|mkdir/i.test(userInput)) return false
  return /(新建|创建|create)\s+[\w./-]+\.md|(?:新建|创建).{0,20}文件|create.{0,20}file/i.test(userInput) &&
    !/(更新|覆盖|替换|改写|改成|改为|如果.{0,8}存在|若.{0,8}存在|不存在.{0,8}则|update|overwrite|replace|upsert)/i.test(userInput)
}

function getCreateOnlyExistingActiveFile(context: AgentContextSnapshot) {
  if (!hasCreateOnlyFileIntent(context.userInput)) return undefined
  const target = explicitTargetPath(context.userInput)
  return target && context.activeFilePath && sameFile(target, context.activeFilePath)
    ? context.activeFilePath
    : undefined
}

function indicatesNoChangeNeeded(content: string) {
  return /(已经存在|已存在|无需(重复)?(添加|修改|写入|更新)|不需要(重复)?(添加|修改|写入|更新)|无需重复|不要重复|already exists|no need to|nothing to change|no changes? needed)/i.test(content)
}

function indicatesWriteCompletedClaim(content: string) {
  return /(已|已经|完成|成功).{0,12}(修改|更新|删除|添加|插入|写入|创建)|done|completed|updated|modified|deleted|inserted|added/i.test(content)
}

function buildMissingWriteToolReminder(context: AgentContextSnapshot, assistantContent: string) {
  const quote = context.currentQuote
  const targetHint = quote
    ? quote.from >= 0 && quote.to >= quote.from
      ? `Call editor_replace_range with from=${quote.from}, to=${quote.to}, and content set to ONLY the rewritten selected text.`
      : `Call editor_replace_lines with startLine=${quote.startLine}, endLine=${quote.endLine}, and replaceContent set to ONLY the rewritten selected text.`
    : 'Call the appropriate write tool for the requested change.'
  return [
    indicatesWriteCompletedClaim(assistantContent)
      ? 'You claimed the change was completed, but no write tool was called.'
      : 'The user explicitly requested a change, but no write tool was called.',
    'Do not present proposed text as a completed change.',
    targetHint,
  ].join('\n\n')
}

function buildStep(tool: AgentTool, input: Record<string, unknown>, result: AgentToolResult, duration: number): AgentStep {
  return {
    thought: tool.title,
    action: { tool: tool.name, params: input },
    observation: result.message,
    duration,
  }
}

function combineUsage(current: AgentModelUsage | undefined, next: AgentModelUsage | undefined) {
  if (!next) return current
  return {
    promptTokens: (current?.promptTokens || 0) + (next.promptTokens || 0),
    completionTokens: (current?.completionTokens || 0) + (next.completionTokens || 0),
    totalTokens: (current?.totalTokens || 0) + (next.totalTokens || 0),
  }
}

function usageFromChunk(chunk: OpenAI.Chat.ChatCompletionChunk): AgentModelUsage | undefined {
  const usage = chunk.usage
  if (!usage) return undefined
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }
}

function buildMetrics(metrics: MutableMetrics, toolCalls: ToolCall[], completedAt: number): AgentRunMetrics {
  return {
    startedAt: metrics.startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - metrics.startedAt),
    currentIteration: metrics.currentIteration,
    iterations: metrics.iterations,
    modelCalls: metrics.modelCalls,
    modelAttempts: metrics.modelAttempts,
    retries: metrics.retries,
    toolCalls: toolCalls.length,
    successfulTools: metrics.successfulTools,
    failedTools: metrics.failedTools,
    deduplicatedTools: metrics.deduplicatedTools,
    effectUnknownCount: metrics.effectUnknownCount,
    usageAvailable: Boolean(metrics.usage),
    usage: metrics.usage,
  }
}

function defaultUserMessage(text: string, imageUrls?: string[]): OpenAI.Chat.ChatCompletionMessageParam {
  if (!imageUrls?.length) return { role: 'user', content: text }
  return {
    role: 'user',
    content: [
      ...imageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      { type: 'text' as const, text },
    ],
  }
}

function defaultPrompt(context: AgentContextSnapshot, tools: AgentTool[], basePrompt: string) {
  const catalog = tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')
  return [
    basePrompt,
    context.activeFilePath ? `Current file: ${context.activeFilePath}` : '',
    context.currentQuote
      ? `Selection: lines ${context.currentQuote.startLine}-${context.currentQuote.endLine}, offsets ${context.currentQuote.from}-${context.currentQuote.to}.`
      : '',
    'Available tools:',
    catalog,
  ].filter(Boolean).join('\n\n')
}

async function runWithDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
  kind: 'model' | 'tool' | 'approval'
): Promise<T> {
  if (parentSignal.aborted) throw new DOMException('Operation was aborted', 'AbortError')

  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parentSignal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      controller.abort(parentSignal.reason)
      finish(() => reject(new DOMException('Operation was aborted', 'AbortError')))
    }
    const timer = setTimeout(() => {
      controller.abort(new AgentDeadlineError(kind, timeoutMs))
      finish(() => reject(new AgentDeadlineError(kind, timeoutMs)))
    }, timeoutMs)

    parentSignal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => task(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      )
  })
}

function partialFailureContent(changes: AgentChange[], failedStep: string, effectUnknown = false) {
  const completed = changes.length
    ? changes.map((change) => `- ${change.summary || change.target}`).join('\n')
    : '- 没有可确认的已完成改动'
  return [
    effectUnknown
      ? '执行未能安全完成：有写操作已经启动，但其最终副作用无法确认。请先检查目标内容，不要自动重试。'
      : '任务仅部分完成；系统没有执行虚假回滚，并已停止后续写操作。',
    '',
    '已确认的改动：',
    completed,
    '',
    `失败步骤：${failedStep}`,
  ].join('\n')
}

export class AgentRuntime {
  private abortController: AbortController | null = null
  private stopped = false
  private running = false

  constructor(private readonly overrides: Partial<AgentRuntimeDependencies> = {}) {}

  stop() {
    this.stopped = true
    this.abortController?.abort(new DOMException('User stopped the agent run', 'AbortError'))
  }

  private async resolveDependencies(): Promise<AgentRuntimeDependencies> {
    const pureDefaults: Partial<AgentRuntimeDependencies> = {
      now: Date.now,
      createId: createAgentId,
      sleep: abortableSleep,
      maxIterations: 15,
      maxModelRetries: 2,
      modelTimeoutMs: 30_000,
      toolTimeoutMs: 30_000,
      approvalTimeoutMs: 5 * 60_000,
      prepareMessages: (messages) => messages,
      buildCurrentUserMessage: async (text, imageUrls) => defaultUserMessage(text, imageUrls),
      assemblePrompt: defaultPrompt,
    }

    let applicationDefaults: Partial<AgentRuntimeDependencies> = {}
    if (!this.overrides.modelPort || !this.overrides.toolCatalog) {
      const runtimeDefaults = await import('./runtime-defaults')
      applicationDefaults = runtimeDefaults.createDefaultAgentRuntimeDependencies()
    }

    const dependencies = {
      ...pureDefaults,
      ...applicationDefaults,
      ...this.overrides,
    }
    if (!dependencies.modelPort || !dependencies.toolCatalog) {
      throw new Error('AgentRuntime requires modelPort and toolCatalog dependencies')
    }
    return dependencies as AgentRuntimeDependencies
  }

  async run(input: AgentRuntimeInput, callbacks: AgentRuntimeCallbacks = {}): Promise<AgentRuntimeResult> {
    if (this.running) {
      const now = Date.now()
      const runId = createAgentId('run-busy')
      const recorder = new AgentTraceRecorder(runId, { now: () => now })
      recorder.setStatus('failed')
      recorder.add({
        type: 'final',
        title: '运行中',
        status: 'error',
        message: '同一个 AgentRuntime 实例已有任务正在运行。',
        iteration: 0,
        terminationReason: 'runtime_busy',
      })
      return {
        runId,
        content: '同一个 AgentRuntime 实例已有任务正在运行；本次请求未启动。',
        stopped: false,
        outcome: 'failed',
        terminationReason: 'runtime_busy',
        metrics: {
          startedAt: now,
          completedAt: now,
          durationMs: 0,
          currentIteration: 0,
          iterations: 0,
          modelCalls: 0,
          modelAttempts: 0,
          retries: 0,
          toolCalls: 0,
          successfulTools: 0,
          failedTools: 0,
          deduplicatedTools: 0,
          effectUnknownCount: 0,
          usageAvailable: false,
        },
        steps: [],
        toolCalls: [],
        changes: [],
        trace: recorder.all(),
      }
    }

    this.running = true
    try {
      return await this.runExclusive(input, callbacks)
    } finally {
      this.running = false
      this.abortController = null
    }
  }

  private async runExclusive(input: AgentRuntimeInput, callbacks: AgentRuntimeCallbacks = {}): Promise<AgentRuntimeResult> {
    this.stopped = false
    this.abortController = new AbortController()
    const dependencies = await this.resolveDependencies()
    const startedAt = dependencies.now()
    const runId = dependencies.createId('run')
    const recorder = new AgentTraceRecorder(runId, {
      now: dependencies.now,
      createId: dependencies.createId,
    })
    const permissionEngine = new AgentPermissionEngine()
    const recoveryManager = new AgentRecoveryManager()
    const steps: AgentStep[] = []
    const toolCalls: ToolCall[] = []
    const changes: AgentChange[] = []
    const completedCallResults = new Map<string, AgentToolResult>()
    const protectedMutationOperations = new Map<string, AgentToolResult>()
    const sessionApprovalScopes = new Set<string>()
    const metrics: MutableMetrics = {
      startedAt,
      currentIteration: 0,
      iterations: 0,
      modelCalls: 0,
      modelAttempts: 0,
      retries: 0,
      successfulTools: 0,
      failedTools: 0,
      deduplicatedTools: 0,
      effectUnknownCount: 0,
    }
    let finalContent = ''
    let writeActionCompleted = false
    let missingWriteToolRepairCount = 0

    const context: AgentContextSnapshot = {
      activeChatId: input.activeChatId,
      activeFilePath: input.activeFilePath,
      userInput: input.userInput,
      currentQuote: input.currentQuote,
      availableSkills: input.availableSkills,
    }

    const finish = async (
      content: string,
      outcome: AgentRuntimeOutcome,
      terminationReason: AgentTerminationReason,
      title: string
    ): Promise<AgentRuntimeResult> => {
      finalContent = content
      const status = outcome === 'success'
        ? 'completed'
        : outcome === 'partial'
          ? 'failed'
          : outcome === 'stopped'
            ? 'stopped'
            : 'failed'
      recorder.setStatus(status)
      const finalTrace = recorder.add({
        type: 'final',
        title,
        status: outcome === 'success' ? 'success' : 'error',
        message: content,
        iteration: metrics.currentIteration,
        terminationReason,
        usage: metrics.usage,
      })
      notifyObserver(callbacks.onTrace, finalTrace)
      notifyObserver(callbacks.onStatus, status)
      notifyObserver(callbacks.onCandidateAnswerClear)
      notifyObserver(callbacks.onFinalAnswerRender, content)

      try {
        if (outcome === 'stopped') {
          await agentEventBus.emit('run-stop', { runId, trace: recorder.all() })
        } else if (outcome === 'failed' || outcome === 'partial') {
          await agentEventBus.emit('run-error', { runId, error: new Error(`${terminationReason}: ${content}`) })
        }
      } catch {
        // Observability hooks must never change the run's terminal state.
      }

      return {
        runId,
        content,
        stopped: outcome === 'stopped',
        outcome,
        terminationReason,
        metrics: buildMetrics(metrics, toolCalls, dependencies.now()),
        steps,
        toolCalls,
        changes,
        trace: recorder.all(),
      }
    }

    const rejectToolCall = (
      toolCallId: string,
      toolName: string,
      params: Record<string, unknown>,
      result: AgentToolResult
    ) => {
      const call: ToolCall = {
        id: toolCallId,
        toolName,
        params,
        status: result.ok ? 'success' : 'error',
        result: toolResultToLegacy(result),
        timestamp: dependencies.now(),
      }
      toolCalls.push(call)
      if (result.ok) metrics.successfulTools += 1
      else metrics.failedTools += 1
      notifyObserver(callbacks.onToolCall, call)
      return call
    }

    agentDebugLog('run_start', {
      runId,
      activeFilePath: input.activeFilePath || null,
      userInput: input.userInput,
      imageCount: input.imageUrls?.length || 0,
      hasQuote: Boolean(input.currentQuote),
    })

    const disabledCapability = requestedDisabledCapability(input.userInput)
    if (disabledCapability) {
      return finish(
        `CAPABILITY_DISABLED: ${disabledCapability} 在 Agent Reliability v1 中已禁用。`,
        'failed',
        'capability_disabled',
        '能力已禁用'
      )
    }

    if (hasExplicitWriteIntent(input.userInput) && requiresSelectedContext(input.userInput) && !input.currentQuote) {
      return finish(
        '没有检测到当前选区。请先在编辑器中选中要修改的文本，再发送这条指令。',
        'failed',
        'guardrail_blocked',
        '缺少选区'
      )
    }

    const existingActiveCreateTarget = getCreateOnlyExistingActiveFile(context)
    if (existingActiveCreateTarget) {
      return finish(
        `文件 \`${existingActiveCreateTarget}\` 已经存在，已取消新建操作，未修改现有内容。`,
        'success',
        'no_change_needed',
        '文件已存在'
      )
    }

    notifyObserver(callbacks.onStatus, 'preparing_context')
    const tools = dependencies.toolCatalog.listTools()
    let settings
    let systemPromptContent
    try {
      settings = await dependencies.modelPort.loadSettings()
      if (!settings) {
        return finish('Agent 模型未配置，请先选择模型并配置服务地址。', 'failed', 'configuration_error', '配置缺失')
      }
      const validation = await dependencies.modelPort.validateSettings?.(settings)
      if (validation && !validation.ok) {
        return finish(validation.reason || 'Agent 模型配置无效。', 'failed', 'configuration_error', '配置无效')
      }
      systemPromptContent = await dependencies.modelPort.getSystemPrompt()
    } catch (error) {
      const message = dependencies.modelPort.formatError?.(error) || (error instanceof Error ? error.message : String(error))
      return finish(`Agent 配置加载失败：${message}`, 'failed', 'configuration_error', '配置加载失败')
    }

    const systemPrompt = dependencies.assemblePrompt(context, tools, systemPromptContent)
    const baseMessages = dependencies.prepareMessages(input.messages || []).map(normalizeBaseMessage)
    const currentUserMessage = await dependencies.buildCurrentUserMessage(input.userInput, input.imageUrls)
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...baseMessages,
      currentUserMessage,
    ]

    const consumeModelTurn = async (iteration: number, modelTraceId: string): Promise<ModelTurn> => {
      return recoveryManager.withRetry((attempt) => runWithDeadline(async (modelSignal) => {
        metrics.modelAttempts += 1
        if (attempt > 1) notifyObserver(callbacks.onCandidateAnswerClear)
        const assistantParts: string[] = []
        let finishReason: string | null | undefined
        let usage: AgentModelUsage | undefined
        let toolCallsStarted = false
        let candidateRendered = false
        const streamedToolCalls = new Map<number, StreamingToolCallAccumulator>()
        recorder.update(modelTraceId, { attempt, status: 'running' })

        const stream = await dependencies.modelPort.createStream({
          settings,
          messages,
          tools: dependencies.toolCatalog.toOpenAITools(),
          toolChoice: buildToolChoice(context),
          iteration,
          attempt,
          signal: modelSignal,
        })

        for await (const chunk of stream) {
          if (this.stopped || modelSignal.aborted) {
            throw new DOMException('Operation was aborted', 'AbortError')
          }

          usage = usageFromChunk(chunk) || usage
          const choice = chunk.choices?.[0]
          if (!choice) continue
          finishReason = choice.finish_reason ?? finishReason
          const delta = choice.delta
          if (typeof delta.content === 'string' && delta.content) {
            assistantParts.push(delta.content)
            if (!toolCallsStarted) {
              candidateRendered = true
              notifyObserver(callbacks.onCandidateAnswerRender, assistantParts.join(''))
            }
          }

          for (const toolCallDelta of delta.tool_calls || []) {
            if (!toolCallsStarted) {
              toolCallsStarted = true
              if (candidateRendered) notifyObserver(callbacks.onCandidateAnswerClear)
            }
            const index = toolCallDelta.index
            const current = streamedToolCalls.get(index) || {
              index,
              id: toolCallDelta.id,
              type: 'function' as const,
              function: { name: '', arguments: '' },
            }
            if (toolCallDelta.id) current.id = toolCallDelta.id
            if (toolCallDelta.function?.name) current.function.name += toolCallDelta.function.name
            if (toolCallDelta.function?.arguments) current.function.arguments += toolCallDelta.function.arguments
            streamedToolCalls.set(index, current)
          }
        }

        const assistantContent = assistantParts.join('').trim()
        const toolUses = toToolCallList(streamedToolCalls)
        if (!assistantContent && toolUses.length === 0) {
          throw Object.assign(new Error('AI response did not include content or tool calls'), { code: 'EMPTY_RESPONSE' })
        }
        return { assistantContent, finishReason, toolUses, usage, attempt }
      }, this.abortController!.signal, dependencies.modelTimeoutMs, 'model'), {
        maxRetries: dependencies.maxModelRetries,
        signal: this.abortController!.signal,
        sleep: dependencies.sleep,
        onRetry: ({ attempt, delayMs, error }) => {
          metrics.retries += 1
          notifyObserver(callbacks.onStatus, 'recovering')
          notifyObserver(callbacks.onCandidateAnswerClear)
          const retryTrace = recorder.add({
            type: 'error',
            title: '模型流重试',
            status: 'error',
            iteration,
            attempt,
            message: `模型流失败，将在 ${delayMs}ms 后重新创建并完整消费；未完成候选内容已清除。${error instanceof Error ? ` ${error.message}` : ''}`,
          })
          notifyObserver(callbacks.onTrace, retryTrace)
        },
      })
    }

    for (let iteration = 1; iteration <= dependencies.maxIterations; iteration += 1) {
      metrics.currentIteration = iteration
      metrics.iterations = iteration
      if (this.stopped || this.abortController.signal.aborted) {
        return finish('Agent 已停止；停止后没有启动新的工具。', 'stopped', 'user_stopped', '已停止')
      }

      notifyObserver(callbacks.onStatus, 'thinking')
      try {
        await agentEventBus.emit('before-model-call', { runId })
      } catch {
        // Hooks are advisory and cannot bypass the runtime state machine.
      }
      metrics.modelCalls += 1
      const modelTrace = recorder.add({
        type: 'model_call',
        title: '模型思考',
        status: 'running',
        iteration,
        attempt: 1,
        message: `第 ${iteration} 轮`,
      })
      notifyObserver(callbacks.onTrace, modelTrace)

      let turn: ModelTurn
      try {
        turn = await consumeModelTurn(iteration, modelTrace.id)
      } catch (error) {
        notifyObserver(callbacks.onCandidateAnswerClear)
        if (this.stopped || this.abortController.signal.aborted) {
          return finish('Agent 已停止；停止后没有启动新的工具。', 'stopped', 'user_stopped', '已停止')
        }
        const isEmpty = error instanceof Error && (error as Error & { code?: string }).code === 'EMPTY_RESPONSE'
        const isModelTimeout = error instanceof AgentDeadlineError && error.kind === 'model'
        const reason: AgentTerminationReason = isEmpty
          ? 'empty_response'
          : isModelTimeout
            ? 'model_timeout'
            : 'model_error'
        const formatted = dependencies.modelPort.formatError?.(error) || (error instanceof Error ? error.message : String(error))
        recorder.update(modelTrace.id, { status: 'error', message: formatted })
        const outcome: AgentRuntimeOutcome = writeActionCompleted || changes.length ? 'partial' : 'failed'
        const content = outcome === 'partial'
          ? partialFailureContent(changes, `模型调用失败：${formatted}`)
          : `Agent 模型调用失败：${formatted}`
        return finish(
          content,
          outcome,
          reason,
          isEmpty ? '模型返回空响应' : isModelTimeout ? '模型调用超时' : '模型调用失败'
        )
      }

      metrics.usage = combineUsage(metrics.usage, turn.usage)
      finalContent = turn.assistantContent || finalContent
      const responseTrace = recorder.update(modelTrace.id, {
        title: turn.assistantContent ? '模型响应' : '模型选择工具',
        status: 'success',
        duration: Math.max(0, dependencies.now() - modelTrace.timestamp),
        attempt: turn.attempt,
        usage: turn.usage,
        output: turn.assistantContent || {
          finishReason: turn.finishReason,
          toolCalls: turn.toolUses.map((toolUse) => ({ id: toolUse.id, name: toolUse.function.name })),
        },
      })
      if (responseTrace) notifyObserver(callbacks.onTrace, responseTrace)
      try {
        await agentEventBus.emit('after-model-call', { runId, content: turn.assistantContent })
      } catch {
        // Hooks are advisory.
      }

      if (turn.toolUses.length === 0) {
        if (hasExplicitWriteIntent(context.userInput) && indicatesNoChangeNeeded(turn.assistantContent)) {
          return finish(turn.assistantContent, 'success', 'no_change_needed', '无需修改')
        }

        if (!writeActionCompleted && hasExplicitWriteIntent(context.userInput)) {
          if (missingWriteToolRepairCount < MAX_MISSING_WRITE_TOOL_REPAIRS) {
            missingWriteToolRepairCount += 1
            notifyObserver(callbacks.onCandidateAnswerClear)
            messages.push({ role: 'assistant', content: turn.assistantContent || null })
            messages.push({ role: 'user', content: buildMissingWriteToolReminder(context, turn.assistantContent) })
            continue
          }
          return finish(
            '模型没有执行用户要求的写工具，已停止；没有把候选文本误报为已修改。',
            'failed',
            'missing_required_tool',
            '缺少写工具调用'
          )
        }

        return finish(turn.assistantContent, 'success', 'final_answer', '完成')
      }

      messages.push({
        role: 'assistant',
        content: turn.assistantContent || null,
        tool_calls: turn.toolUses,
      })

      let skipRemaining = false
      for (const toolUse of turn.toolUses) {
        const toolCallId = toolUse.id || dependencies.createId('tool-call')
        const toolName = toolUse.function.name
        const tool = dependencies.toolCatalog.getTool(toolName)

        if (this.stopped || this.abortController.signal.aborted) {
          return finish('Agent 已停止；停止后没有启动新的工具。', 'stopped', 'user_stopped', '已停止')
        }

        if (skipRemaining) {
          const skipped: AgentToolResult = {
            ok: false,
            message: '同一批次的前序工具失败，已停止后续工具，避免产生部分写入。',
            error: 'SKIPPED_AFTER_TOOL_FAILURE',
            effectStatus: 'none',
          }
          rejectToolCall(toolCallId, toolName, {}, skipped)
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(skipped) })
          continue
        }

        let args: Record<string, unknown>
        try {
          args = parseToolArguments(toolUse.function.arguments)
        } catch (error) {
          const result: AgentToolResult = {
            ok: false,
            message: `工具参数 JSON 无效：${error instanceof Error ? error.message : String(error)}`,
            error: 'INVALID_TOOL_ARGUMENTS_JSON',
            effectStatus: 'none',
          }
          rejectToolCall(toolCallId, toolName, {}, result)
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })
          skipRemaining = true
          continue
        }

        if (!tool) {
          const result: AgentToolResult = {
            ok: false,
            message: `工具不存在：${toolName}`,
            error: 'UNKNOWN_TOOL',
            effectStatus: 'none',
          }
          rejectToolCall(toolCallId, toolName, args, result)
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })
          skipRemaining = true
          continue
        }

        const existingCallResult = completedCallResults.get(toolCallId)
        if (existingCallResult) {
          metrics.deduplicatedTools += 1
          const result: AgentToolResult = existingCallResult.effectStatus === 'unknown'
            ? { ...existingCallResult, ok: false, message: '重复 toolCallId 已去重；原写操作副作用仍未知，禁止自动重放。' }
            : { ok: true, message: '重复 toolCallId 已去重，未再次执行。', data: { deduplicated: true }, effectStatus: 'none' }
          rejectToolCall(toolCallId, toolName, args, result)
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })
          continue
        }

        let schemaValidation
        try {
          schemaValidation = validateAgentToolInput(tool, args)
        } catch (error) {
          const result: AgentToolResult = {
            ok: false,
            message: `工具 Schema 无法验证：${error instanceof Error ? error.message : String(error)}`,
            error: 'TOOL_SCHEMA_ERROR',
            effectStatus: 'none',
          }
          completedCallResults.set(toolCallId, result)
          rejectToolCall(toolCallId, toolName, args, result)
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })
          skipRemaining = true
          continue
        }
        if (!schemaValidation.valid) {
          const result: AgentToolResult = {
            ok: false,
            message: `工具参数不符合 Schema：${formatAgentSchemaErrors(schemaValidation)}`,
            error: 'INVALID_TOOL_ARGUMENTS_SCHEMA',
            data: { validationErrors: schemaValidation.errors },
            effectStatus: 'none',
          }
          completedCallResults.set(toolCallId, result)
          rejectToolCall(toolCallId, toolName, args, result)
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })
          skipRemaining = true
          continue
        }

        const permission = permissionEngine.evaluate(tool, args, context)
        if (!permission.allowed) {
          const result: AgentToolResult = {
            ok: false,
            message: permission.reason || '工具调用被权限策略阻止。',
            error: 'BLOCKED_BY_PERMISSION',
            effectStatus: 'none',
          }
          completedCallResults.set(toolCallId, result)
          rejectToolCall(toolCallId, toolName, args, result)
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })
          if (writeActionCompleted || changes.length) {
            return finish(partialFailureContent(changes, result.message), 'partial', 'tool_error', '部分完成')
          }
          skipRemaining = true
          continue
        }

        const operationKey = permission.operationKey || createAgentOperationKey(tool, args, context)
        const protectedOperation = isMutatingTool(tool) ? protectedMutationOperations.get(operationKey) : undefined
        if (protectedOperation) {
          metrics.deduplicatedTools += 1
          const result: AgentToolResult = protectedOperation.effectStatus === 'unknown'
            ? { ...protectedOperation, ok: false, message: '相同副作用签名的写操作结果未知，已阻止自动重放。' }
            : { ok: true, message: '相同副作用签名的写操作已成功执行，本次已去重。', data: { deduplicated: true }, effectStatus: 'none' }
          completedCallResults.set(toolCallId, result)
          rejectToolCall(toolCallId, toolName, args, result)
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })
          continue
        }

        try {
          const blockedByHook = await agentEventBus.emit('pre-tool-use', { runId, tool, input: args })
          if (blockedByHook) {
            const result: AgentToolResult = {
              ok: false,
              message: blockedByHook,
              error: 'BLOCKED_BY_HOOK',
              effectStatus: 'none',
            }
            completedCallResults.set(toolCallId, result)
            rejectToolCall(toolCallId, toolName, args, result)
            messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })
            skipRemaining = true
            continue
          }
        } catch (error) {
          const result: AgentToolResult = {
            ok: false,
            message: `工具前置检查失败：${error instanceof Error ? error.message : String(error)}`,
            error: 'PRE_TOOL_HOOK_ERROR',
            effectStatus: 'none',
          }
          completedCallResults.set(toolCallId, result)
          rejectToolCall(toolCallId, toolName, args, result)
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })
          skipRemaining = true
          continue
        }

        let pendingApprovalCall: ToolCall | undefined
        if (permission.requiresApproval && !sessionApprovalScopes.has(permission.approvalScopeKey)) {
          pendingApprovalCall = {
            id: toolCallId,
            toolName,
            params: args,
            status: 'pending',
            timestamp: dependencies.now(),
          }
          toolCalls.push(pendingApprovalCall)
          notifyObserver(callbacks.onToolCall, pendingApprovalCall)
          notifyObserver(callbacks.onStatus, 'waiting_approval')
          const approvalRequest: AgentApprovalRequest = {
            id: dependencies.createId('approval'),
            runId,
            toolName,
            title: tool.title,
            risk: tool.risk,
            params: args,
            previewParams: args,
            filePath: permission.target,
            target: permission.target,
            operationKey,
            approvalScopeKey: permission.approvalScopeKey,
            canApproveForSession: permission.canApproveForSession,
          }
          const approvalTrace = recorder.add({
            type: 'approval',
            title: '等待用户确认',
            status: 'running',
            toolName,
            input: args,
            iteration,
            attempt: 1,
          })
          notifyObserver(callbacks.onTrace, approvalTrace)

          let decision: AgentApprovalDecision
          try {
            decision = callbacks.requestConfirmation
              ? await runWithDeadline(
                (signal) => callbacks.requestConfirmation!(approvalRequest, signal),
                this.abortController.signal,
                dependencies.approvalTimeoutMs,
                'approval'
              )
              : { approved: false, reason: 'denied' }
          } catch (error) {
            if (this.stopped || this.abortController.signal.aborted) {
              pendingApprovalCall.status = 'error'
              pendingApprovalCall.result = toolResultToLegacy({
                ok: false,
                message: '审批等待已因停止而取消。',
                error: 'USER_STOPPED',
                effectStatus: 'none',
              })
              metrics.failedTools += 1
              notifyObserver(callbacks.onToolCall, pendingApprovalCall)
              recorder.update(approvalTrace.id, { status: 'error', message: '审批等待已因停止而取消。' })
              return finish('Agent 已停止；审批取消后没有启动工具。', 'stopped', 'user_stopped', '已停止')
            }
            if (error instanceof AgentDeadlineError) {
              pendingApprovalCall.status = 'error'
              pendingApprovalCall.result = toolResultToLegacy({
                ok: false,
                message: '审批等待超时，工具没有启动。',
                error: 'APPROVAL_TIMEOUT',
                effectStatus: 'none',
              })
              metrics.failedTools += 1
              notifyObserver(callbacks.onToolCall, pendingApprovalCall)
              recorder.update(approvalTrace.id, { status: 'error', message: '审批等待超时。' })
              return finish('审批等待已超时，工具没有启动。', 'failed', 'approval_timeout', '审批超时')
            }
            decision = { approved: false, reason: 'denied' }
          }

          if (!decision.approved) {
            pendingApprovalCall.status = 'error'
            pendingApprovalCall.result = toolResultToLegacy({
              ok: false,
              message: '用户拒绝了工具操作。',
              error: 'USER_DENIED_TOOL',
              effectStatus: 'none',
            })
            metrics.failedTools += 1
            notifyObserver(callbacks.onToolCall, pendingApprovalCall)
            recorder.update(approvalTrace.id, { status: 'error', message: '用户拒绝了工具操作。' })
            const hasCompletedWrite = writeActionCompleted || changes.length > 0
            const content = hasCompletedWrite
              ? partialFailureContent(changes, `用户拒绝 ${tool.title}`)
              : '已取消本次操作；被拒绝的工具没有启动。'
            return finish(content, hasCompletedWrite ? 'partial' : 'failed', 'approval_denied', '审批被拒绝')
          }
          if (decision.scope === 'session' && permission.canApproveForSession) {
            sessionApprovalScopes.add(permission.approvalScopeKey)
          }
          recorder.update(approvalTrace.id, { status: 'success', message: '用户已确认操作。' })
        }

        if (this.stopped || this.abortController.signal.aborted) {
          return finish('Agent 已停止；停止后没有启动新的工具。', 'stopped', 'user_stopped', '已停止')
        }

        notifyObserver(callbacks.onStatus, isMutatingTool(tool) ? 'applying_change' : 'calling_tool')
        const call: ToolCall = pendingApprovalCall || {
          id: toolCallId,
          toolName,
          params: args,
          status: 'pending',
          timestamp: dependencies.now(),
        }
        if (!pendingApprovalCall) toolCalls.push(call)
        call.status = 'running'
        notifyObserver(callbacks.onToolCall, call)
        const toolTrace = recorder.add({
          type: 'tool_call',
          title: tool.title,
          status: 'running',
          toolName,
          input: args,
          iteration,
          attempt: 1,
        })
        notifyObserver(callbacks.onTrace, toolTrace)

        const toolStartedAt = dependencies.now()
        let result: AgentToolResult
        try {
          result = await runWithDeadline(
            (signal) => tool.execute(args, {
              runId,
              toolCallId,
              operationKey,
              attempt: 1,
              signal,
              context,
            }),
            this.abortController.signal,
            dependencies.toolTimeoutMs,
            'tool'
          )
          result = normalizeToolEffect(tool, result)
        } catch (error) {
          // Once a write executor starts, an unstructured throw cannot prove
          // whether the side effect happened before the error surfaced.
          // Only an explicit structured failure may assert effectStatus=none.
          const effectUnknown = isMutatingTool(tool)
          result = {
            ok: false,
            message: effectUnknown
              ? '写工具已启动，但异常、取消或超时后无法确认最终副作用；禁止自动重放。'
              : `工具执行异常：${error instanceof Error ? error.message : String(error)}`,
            error: effectUnknown
              ? 'EFFECT_UNKNOWN'
              : error instanceof AgentDeadlineError
                ? 'TOOL_TIMEOUT'
                : 'TOOL_EXECUTION_ERROR',
            data: effectUnknown ? { target: permission.target, operationKey } : undefined,
            effectStatus: effectUnknown ? 'unknown' : 'none',
          }
        }
        const duration = Math.max(0, dependencies.now() - toolStartedAt)
        completedCallResults.set(toolCallId, result)
        if (isMutatingTool(tool) && (result.ok || result.effectStatus !== 'none')) {
          protectedMutationOperations.set(operationKey, result)
        }
        if (result.effectStatus === 'unknown') metrics.effectUnknownCount += 1

        if (result.changes) {
          for (const change of result.changes) {
            changes.push(change)
            notifyObserver(callbacks.onChange, change)
            const changeTrace = recorder.add({
              type: 'change',
              title: change.summary || '记录改动',
              status: 'success',
              toolName,
              output: change,
              message: change.target,
              iteration,
              attempt: 1,
            })
            notifyObserver(callbacks.onTrace, changeTrace)
          }
        }

        call.status = result.ok ? 'success' : 'error'
        call.result = toolResultToLegacy(result)
        if (result.ok) metrics.successfulTools += 1
        else metrics.failedTools += 1
        notifyObserver(callbacks.onToolCall, call)
        const step = buildStep(tool, args, result, duration)
        steps.push(step)
        notifyObserver(callbacks.onStep, step)
        const updatedTrace = recorder.update(toolTrace.id, {
          status: result.ok ? 'success' : 'error',
          duration,
          output: result,
          message: result.message,
        })
        if (updatedTrace) notifyObserver(callbacks.onTrace, updatedTrace)
        try {
          await agentEventBus.emit('post-tool-use', { runId, tool, input: args, result })
        } catch {
          // Tool result remains authoritative even if a post hook fails.
        }
        messages.push({ role: 'tool', tool_call_id: toolCallId, content: stringifyToolResult(result) })

        if (result.ok && isMutatingTool(tool)) writeActionCompleted = true
        if (!result.ok) {
          if (result.effectStatus === 'unknown') {
            const outcome: AgentRuntimeOutcome = this.stopped || this.abortController.signal.aborted
              ? 'stopped'
              : changes.length || writeActionCompleted
                ? 'partial'
                : 'failed'
            return finish(
              partialFailureContent(changes, result.message, true),
              outcome,
              'effect_unknown',
              '写操作结果未知'
            )
          }
          if (changes.length || writeActionCompleted) {
            return finish(partialFailureContent(changes, result.message), 'partial', result.error === 'TOOL_TIMEOUT' ? 'tool_timeout' : 'tool_error', '部分完成')
          }
          skipRemaining = true
          continue
        }

        const forcedWriteTool = getForcedWriteTool(context)
        if (forcedWriteTool && tool.name === forcedWriteTool) {
          return finish('已按要求修改选中内容。', 'success', 'final_answer', '完成')
        }
      }
    }

    const maxIterationContent = changes.length || writeActionCompleted
      ? partialFailureContent(changes, '达到最大执行轮数，无法确认剩余步骤。')
      : '已达到最大执行轮数，任务没有完成。'
    return finish(
      maxIterationContent,
      changes.length || writeActionCompleted ? 'partial' : 'failed',
      'maximum_iterations',
      '达到最大轮数'
    )
  }
}
