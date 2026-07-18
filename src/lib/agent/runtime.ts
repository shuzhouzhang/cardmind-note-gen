import type OpenAI from 'openai'
import { createChatCompletionStreamWithToolChoiceFallback, createOpenAIClient, getAISettings, getChatTokenLimitParams, getSystemPromptContent, handleAIError, validateAIService, withFastAiRequestOptions } from '@/lib/ai/utils'
import { estimateTokens } from '@/lib/ai/token-counter'
import { AgentContextManager } from './context-manager'
import { agentEventBus } from './event-bus'
import { AgentPermissionEngine } from './permission-engine'
import { AgentPromptAssembler, hasInlineCurrentEditorState } from './prompt-assembler'
import { AgentRecoveryManager } from './recovery-manager'
import { createAgentId, AgentTraceRecorder } from './trace-recorder'
import { agentToolRegistry, buildEditorApprovalPreview } from './tool-registry'
import { agentDebugLog, previewText } from './debug-log'
import type {
  AgentChange,
  AgentContextSnapshot,
  AgentPermissionMode,
  AgentRuntimeCallbacks,
  AgentRuntimeInput,
  AgentRuntimeResult,
  AgentSteeringPayload,
  AgentStep,
  AgentTool,
  AgentToolResult,
  ToolCall,
  ToolResult,
} from './types'

const ABSOLUTE_MAX_MODEL_ROUNDS = 30
const MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS = 2
const MAX_INVALID_QUOTED_WRITE_REPAIRS = 2
const MAX_IDENTICAL_READ_RESULT_REPEATS = 2
const MAX_IDENTICAL_FAILED_TOOL_RESULT_REPEATS = 1
const MUTATING_TOOL_RISKS = new Set(['editor-write', 'file-create', 'file-update', 'delete', 'medium'])

export function isRequestAbortError(error: unknown) {
  if (typeof error === 'string') {
    return /(?:request (?:was )?aborted|operation (?:was )?aborted|aborterror)/i.test(error)
  }

  if (!error || typeof error !== 'object') {
    return false
  }

  const errorWithCode = error as { name?: string; code?: string; message?: string }
  return errorWithCode.name === 'AbortError'
    || errorWithCode.code === 'ABORT_ERR'
    || /(?:request (?:was )?aborted|operation (?:was )?aborted|aborterror)/i.test(errorWithCode.message || '')
}

function parseToolArguments(rawArguments: string | undefined): Record<string, unknown> {
  if (!rawArguments || !rawArguments.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawArguments)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch (error) {
    throw new Error(`Invalid tool arguments JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function toolResultToLegacy(result: AgentToolResult): ToolResult {
  return {
    success: result.ok,
    message: result.message,
    data: result.data,
    error: result.error,
    changes: result.changes,
  }
}

function stringifyToolResult(result: AgentToolResult) {
  const payload = {
    ok: result.ok,
    message: result.message,
    data: result.data,
    error: result.error,
    changes: result.changes,
  }

  return JSON.stringify(payload)
}

function stringifyMessageContent(content: unknown) {
  if (typeof content === 'string') {
    return content
  }

  if (content === null || content === undefined) {
    return ''
  }

  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function normalizeBaseMessage(message: OpenAI.Chat.ChatCompletionMessageParam): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'system') {
    return message
  }

  return {
    role: 'user',
    content: `## App Context\n${stringifyMessageContent(message.content)}`,
  }
}

interface StreamingToolCallAccumulator {
  id?: string
  index: number
  type?: 'function'
  function: {
    name: string
    arguments: string
  }
}

function toToolCallList(
  toolCalls: Map<number, StreamingToolCallAccumulator>
): OpenAI.Chat.ChatCompletionMessageToolCall[] {
  return [...toolCalls.values()]
    .sort((a, b) => a.index - b.index)
    .filter((toolCall) => toolCall.function.name)
    .map((toolCall) => ({
      id: toolCall.id || createAgentId('tool-call'),
      type: 'function' as const,
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }))
}

function summarizeMessage(message: OpenAI.Chat.ChatCompletionMessageParam, index: number) {
  const content = 'content' in message ? message.content : undefined
  const text = stringifyMessageContent(content)

  return {
    index,
    role: message.role,
    contentLength: text.length,
    preview: previewText(text),
  }
}

function normalizeFilePathForCompare(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim()
}

function getStringArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function getNumberArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  return typeof value === 'number' ? value : undefined
}

function normalizeForNoOpCheck(text: string) {
  return text.replace(/\r\n/g, '\n').trim()
}

function validateQuotedEditorWrite(
  context: AgentContextSnapshot,
  toolName: string,
  args: Record<string, unknown>
): AgentToolResult | null {
  const quote = context.currentQuote
  if (!quote) {
    return null
  }

  if (toolName === 'editor_replace_range' && quote.from >= 0 && quote.to >= quote.from) {
    const from = getNumberArg(args, 'from')
    const to = getNumberArg(args, 'to')
    const content = getStringArg(args, 'content')
    const selectedText = quote.fullContent || ''
    const selectedIsSingleLine = quote.startLine === quote.endLine

    if (from !== quote.from || to !== quote.to) {
      return {
        ok: false,
        message: `工具参数越界：当前请求只能替换用户选区 from=${quote.from}, to=${quote.to}，请用这个精确范围重试。`,
        error: 'INVALID_QUOTED_RANGE',
      }
    }

    if (!content.trim()) {
      return {
        ok: false,
        message: '工具参数无效：content 不能为空，请只传入改写后的选中文本。',
        error: 'EMPTY_REPLACEMENT_CONTENT',
      }
    }

    const effectiveReplacement = selectedIsSingleLine && content.includes('\n')
      ? extractSingleLineReplacement(content) || content
      : content
    if (
      normalizeForNoOpCheck(effectiveReplacement) &&
      normalizeForNoOpCheck(effectiveReplacement) === normalizeForNoOpCheck(selectedText)
    ) {
      return {
        ok: false,
        message: '工具参数无效：改写结果与选中文本完全相同。请根据用户要求给出真正改写后的选中文本，不要返回原文、标题或相邻段落。',
        error: 'NO_OP_REPLACEMENT_CONTENT',
      }
    }

    if (selectedIsSingleLine && content.includes('\n')) {
      return {
        ok: false,
        message: '工具参数越界：用户只选中了一行内的文本，content 只能是替换这段选中文本的单行内容，不能包含标题、段落或换行。',
        error: 'REPLACEMENT_EXPANDS_SELECTION',
      }
    }

    if (!/^#{1,6}\s/m.test(selectedText) && /^#{1,6}\s/m.test(content)) {
      return {
        ok: false,
        message: '工具参数越界：用户没有选中 Markdown 标题，content 不能包含标题。请只返回选中文本本身的正式改写。',
        error: 'REPLACEMENT_INCLUDES_UNSELECTED_HEADING',
      }
    }
  }

  return null
}

function validateEditorTargetFile(
  context: AgentContextSnapshot,
  tool: AgentTool,
  args: Record<string, unknown>
): AgentToolResult | null {
  if (tool.category !== 'editor' || tool.risk === 'read') {
    return null
  }

  const activeFilePath = context.activeFilePath
  const targetFilePath = typeof args.filePath === 'string' ? args.filePath : ''

  if (!activeFilePath) {
    return {
      ok: false,
      message: '当前没有打开的编辑器文件，不能执行 editor_* 写入工具。请改用带明确 filePath 的 note_* 工具。',
      error: 'EDITOR_TOOL_WITHOUT_ACTIVE_FILE',
    }
  }

  if (!targetFilePath) {
    return {
      ok: false,
      message: `editor_* 写入工具必须在结构化参数 filePath 中声明目标文件。当前编辑器文件是 ${activeFilePath}，请使用这个完整路径重试。`,
      error: 'EDITOR_TOOL_MISSING_TARGET_FILE',
    }
  }

  if (normalizeFilePathForCompare(targetFilePath) === normalizeFilePathForCompare(activeFilePath)) {
    return null
  }

  return {
    ok: false,
    message: `工具参数中的目标文件是 ${targetFilePath}，但当前编辑器文件是 ${activeFilePath}。请不要使用 editor_* 工具，改用 note_read_file 和 note_update_file 针对目标文件操作。`,
    error: 'EDITOR_TOOL_WRONG_TARGET_FILE',
  }
}

function validateToolInputShape(tool: AgentTool, args: Record<string, unknown>): AgentToolResult | null {
  const properties = tool.inputSchema.properties || {}
  const allowedKeys = new Set(Object.keys(properties))
  const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `工具参数包含未声明字段：${unknownKeys.join(', ')}。请只使用结构化工具定义中的参数。`,
      error: 'UNKNOWN_TOOL_ARGUMENTS',
    }
  }

  const missingKeys = (tool.inputSchema.required || []).filter((key) =>
    args[key] === undefined || args[key] === null
  )
  if (missingKeys.length > 0) {
    return {
      ok: false,
      message: `工具缺少必填参数：${missingKeys.join(', ')}。`,
      error: 'MISSING_TOOL_ARGUMENTS',
    }
  }

  return null
}

function extractSingleLineReplacement(content: string) {
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s/.test(line))
    .filter((line) => !/^---+$/.test(line))

  if (lines.length !== 1) {
    return ''
  }

  return lines[0]
}

function repairQuotedEditorWriteArgs(
  context: AgentContextSnapshot,
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> | null {
  const quote = context.currentQuote
  if (!quote || toolName !== 'editor_replace_range') {
    return null
  }

  if (quote.startLine !== quote.endLine) {
    return null
  }

  const from = getNumberArg(args, 'from')
  const to = getNumberArg(args, 'to')
  const content = getStringArg(args, 'content')
  if (from !== quote.from || to !== quote.to || !content.includes('\n')) {
    return null
  }

  const repairedContent = extractSingleLineReplacement(content)
  if (!repairedContent || repairedContent === content) {
    return null
  }

  const repairedArgs = {
    ...args,
    content: repairedContent,
  }

  if (validateQuotedEditorWrite(context, toolName, repairedArgs)) {
    return null
  }

  return repairedArgs
}

function selectToolsForContext(
  context: AgentContextSnapshot,
  tools: AgentTool[],
  permissionMode: AgentPermissionMode = 'ask'
) {
  let selectedTools = tools

  if (permissionMode === 'read-only') {
    selectedTools = selectedTools.filter((tool) =>
      tool.risk === 'read' || tool.risk === 'external'
    )
  }

  if (!context.activeFilePath) {
    selectedTools = selectedTools.filter((tool) => tool.category !== 'editor')
  }

  return selectedTools
}

function buildStep(tool: AgentTool, input: Record<string, unknown>, result: AgentToolResult, duration: number): AgentStep {
  return {
    thought: `${tool.title}`,
    action: {
      tool: tool.name,
      params: input,
    },
    observation: result.message,
    duration,
  }
}

function isMutatingTool(tool: AgentTool) {
  return MUTATING_TOOL_RISKS.has(tool.risk)
}

function getReadToolCallSignature(tool: AgentTool, args: Record<string, unknown>) {
  if (tool.risk !== 'read') {
    return undefined
  }

  return `${tool.name}:${JSON.stringify(args)}`
}

function isEditorStateStaleResult(tool: AgentTool, result: AgentToolResult) {
  if (result.ok || !isMutatingTool(tool)) {
    return false
  }

  return /content has changed|editor content.*changed|内容已变化|版本.*(?:变化|不匹配)/i.test(
    `${result.error || ''}\n${result.message || ''}`
  )
}

export class AgentRuntime {
  private readonly contextManager = new AgentContextManager()
  private readonly promptAssembler = new AgentPromptAssembler()
  private readonly permissionEngine = new AgentPermissionEngine()
  private readonly recoveryManager = new AgentRecoveryManager()
  private abortController: AbortController | null = null
  private stopped = false
  private steeringRequested = false
  private steeringQueue: AgentSteeringPayload[] = []
  private steeringReadyResolver: (() => void) | null = null

  stop() {
    this.stopped = true
    this.steeringQueue = []
    this.steeringRequested = false
    this.steeringReadyResolver?.()
    this.steeringReadyResolver = null
    this.abortController?.abort()
  }

  beginSteering() {
    if (!this.stopped) {
      this.steeringRequested = true
    }
  }

  steer(payload: AgentSteeringPayload) {
    if (this.stopped) return
    this.steeringRequested = true
    this.steeringQueue.push(payload)
    this.steeringQueue.sort((a, b) => a.sequence - b.sequence)
    this.steeringReadyResolver?.()
    this.steeringReadyResolver = null
  }

  async run(input: AgentRuntimeInput, callbacks: AgentRuntimeCallbacks = {}): Promise<AgentRuntimeResult> {
    this.stopped = false
    this.abortController = new AbortController()

    const recorder = new AgentTraceRecorder()
    const runId = recorder.getRunId()
    const steps: AgentStep[] = []
    const toolCalls: ToolCall[] = []
    const changes: AgentChange[] = []

    const context: AgentContextSnapshot = {
      activeChatId: input.activeChatId,
      activeFilePath: input.activeFilePath,
      currentEditorState: input.currentEditorState,
      userInput: input.userInput,
      currentQuote: input.currentQuote,
      availableSkills: input.availableSkills,
    }

    agentDebugLog('run_start', {
      runId,
      activeChatId: input.activeChatId,
      activeFilePath: input.activeFilePath || null,
      userInput: input.userInput,
      imageCount: input.imageUrls?.length || 0,
      hasQuote: Boolean(input.currentQuote),
      hasEditorState: Boolean(input.currentEditorState),
      availableSkillCount: input.availableSkills?.length || 0,
    })

    const allTools = agentToolRegistry.listTools()
    let tools = selectToolsForContext(context, allTools, input.permissionMode)
    const customSystemPrompt = await getSystemPromptContent()
    let systemPrompt = this.promptAssembler.assemble(
      context,
      tools,
      customSystemPrompt
    )
    const baseMessages = this.contextManager.prepareMessages(input.messages || [])
      .map(normalizeBaseMessage)

    const currentUserMessage = await this.contextManager.buildCurrentUserMessage(
      input.userInput,
      input.imageUrls
    )

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...baseMessages,
      currentUserMessage,
    ]

    agentDebugLog('context_prepared', {
      runId,
      systemPromptLength: systemPrompt.length,
      toolCount: tools.length,
      rawMessageCount: input.messages?.length || 0,
      preparedMessageCount: messages.length,
      appContextMessageCount: baseMessages.filter((message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.startsWith('## App Context')
      ).length,
      messages: messages.map(summarizeMessage),
    })
    callbacks.onStatus?.('preparing_context')

    const aiConfig = await getAISettings()
    const validatedBaseURL = await validateAIService(aiConfig?.baseURL)
    if (!aiConfig || validatedBaseURL === null) {
      agentDebugLog('ai_service_invalid', { runId })
      return {
        runId,
        content: '',
        stopped: false,
        steps,
        toolCalls,
        changes,
        trace: recorder.all(),
      }
    }

    const client = await createOpenAIClient(aiConfig)
    let editorStateReadLocked = hasInlineCurrentEditorState(context)
    let finalContent = ''
    let invalidQuotedWriteRepairCount = 0
    let writeActionCompleted = false
    const readToolResultHistory = new Map<string, {
      result: string
      repeatCount: number
    }>()
    const failedToolResultHistory = new Map<string, {
      result: string
      repeatCount: number
    }>()
    const successfulToolEvidence = new Set<string>()
    let consecutiveNoProgressRounds = 0
    let latestEditorStateResult: AgentToolResult | undefined
    let activeModelTraceId: string | undefined
    let activeModelStartedAt = 0
    let activeModelReasoning = ''
    let activeModelContent = ''
    let activeModelStreamedTokenCount = 0

    const getSafeStoppedContent = () => {
      if (toolCalls.length > 0 && !finalContent) {
        return [
          '已停止生成最终说明；已成功执行的操作请以工具结果和改动记录为准。',
          changes.length > 0 ? `本轮已记录 ${changes.length} 项成功改动。` : '',
        ].filter(Boolean).join('\n')
      }

      return activeModelContent || finalContent
    }

    const drainSteering = async () => {
      if (!this.steeringRequested) return false
      if (this.steeringQueue.length === 0 && !this.stopped) {
        await new Promise<void>((resolve) => {
          this.steeringReadyResolver = resolve
        })
      }
      if (this.stopped) return false

      const payloads = this.steeringQueue.splice(0)
      if (payloads.length === 0) return false
      this.steeringRequested = false
      callbacks.onStatus?.('steering')

      for (const payload of payloads) {
        const text = payload.additionalContext
          ? `## App Context\n${payload.additionalContext}\n\n## User steering message\n${payload.text}`
          : payload.text
        messages.push(await this.contextManager.buildCurrentUserMessage(text, payload.imageUrls))
      }

      const latest = payloads[payloads.length - 1]
      context.userInput = latest.text
      context.currentQuote = latest.currentQuote
      context.currentEditorState = undefined
      tools = selectToolsForContext(context, allTools, input.permissionMode)
      editorStateReadLocked = false
      invalidQuotedWriteRepairCount = 0
      consecutiveNoProgressRounds = 0
      systemPrompt = this.promptAssembler.assemble(context, tools, customSystemPrompt)
      messages[0] = { role: 'system', content: systemPrompt }

      const steeringTrace = recorder.add({
        type: 'steering',
        title: '已应用追加信息',
        status: 'success',
        message: payloads.map((payload) => payload.text).join('\n'),
      })
      callbacks.onTrace?.(steeringTrace)
      return true
    }

    const finalizeInterruptedModelTrace = (status: 'success' | 'error', title: string) => {
      if (!activeModelTraceId) {
        return
      }

      const interruptedTrace = recorder.update(activeModelTraceId, {
        type: 'model_response',
        title,
        status,
        duration: Date.now() - activeModelStartedAt,
        output: activeModelContent || undefined,
        reasoning: activeModelReasoning || undefined,
        streamedTokenCount: activeModelStreamedTokenCount,
      })
      if (interruptedTrace) callbacks.onTrace?.(interruptedTrace)

      activeModelTraceId = undefined
      activeModelStartedAt = 0
      activeModelReasoning = ''
      activeModelContent = ''
      activeModelStreamedTokenCount = 0
    }

    try {
      for (let iteration = 1; iteration <= ABSOLUTE_MAX_MODEL_ROUNDS; iteration += 1) {
        if (this.stopped) {
          callbacks.onStatus?.('stopped')
          const stoppedContent = getSafeStoppedContent()
          if (stoppedContent) {
            callbacks.onFinalAnswerRender?.(stoppedContent)
          }
          return {
            runId,
            content: stoppedContent,
            stopped: true,
            steps,
            toolCalls,
            changes,
            trace: recorder.all(),
          }
        }

        await drainSteering()
        const evidenceCountAtRoundStart = successfulToolEvidence.size

        callbacks.onStatus?.('thinking')
        await agentEventBus.emit('before-model-call', { runId })
        agentDebugLog('model_call_start', {
          runId,
          iteration,
          model: aiConfig?.model || '',
          messageCount: messages.length,
          toolCount: tools.length,
        })
        const modelTrace = recorder.add({
          type: 'model_call',
          title: '模型思考',
          status: 'running',
          message: `第 ${iteration} 轮`,
          streamedTokenCount: 0,
        })
        activeModelTraceId = modelTrace.id
        activeModelStartedAt = modelTrace.timestamp
        activeModelReasoning = ''
        activeModelContent = ''
        activeModelStreamedTokenCount = 0
        callbacks.onTrace?.(modelTrace)

        const offeredTools = editorStateReadLocked
          ? tools.filter((tool) => tool.name !== 'editor_get_state')
          : tools
        const offeredToolNames = new Set(offeredTools.map((tool) => tool.name))
        const openAITools = agentToolRegistry.toOpenAITools(offeredTools)
        const stream = await this.recoveryManager.withRetry(() =>
          createChatCompletionStreamWithToolChoiceFallback(client, withFastAiRequestOptions({
            model: aiConfig?.model || '',
            messages,
            temperature: aiConfig?.temperature,
            top_p: aiConfig?.topP,
            tools: openAITools,
            tool_choice: 'auto',
            stream: true,
            ...getChatTokenLimitParams(aiConfig),
          }, aiConfig), {
            signal: this.abortController?.signal,
          })
        )
        let assistantContent = ''
        let finishReason: string | null | undefined
        let toolCallsStarted = false
        let candidateAnswerRendered = false
        let assistantReasoning = ''
        let streamedText = ''
        let streamedTokenCount = 0
        let lastModelProgressTraceAt = 0
        let steeringInterrupted = false
        const streamedToolCalls = new Map<number, StreamingToolCallAccumulator>()

        for await (const chunk of stream) {
          if (this.stopped) {
            throw new Error('USER_STOPPED')
          }
          if (this.steeringRequested) {
            steeringInterrupted = true
            break
          }

          const choice = chunk.choices[0]
          if (!choice) {
            continue
          }

          finishReason = choice.finish_reason ?? finishReason
          const delta = choice.delta
          const extendedDelta = delta as typeof delta & {
            reasoning?: string
            reasoning_content?: string
          }
          const reasoningDelta = extendedDelta.reasoning_content || extendedDelta.reasoning
          if (typeof reasoningDelta === 'string') {
            assistantReasoning += reasoningDelta
            streamedText += reasoningDelta
            activeModelReasoning = assistantReasoning
          }
          if (typeof delta.content === 'string' && delta.content) {
            assistantContent += delta.content
            streamedText += delta.content
            activeModelContent = assistantContent
            if (
              !toolCallsStarted &&
              assistantContent.trim()
            ) {
              candidateAnswerRendered = true
              callbacks.onCandidateAnswerRender?.(assistantContent)
            }
          }

          for (const toolCallDelta of delta.tool_calls || []) {
            if (!toolCallsStarted) {
              toolCallsStarted = true
            }

            const index = toolCallDelta.index
            const current = streamedToolCalls.get(index) || {
              index,
              id: toolCallDelta.id,
              type: 'function' as const,
              function: {
                name: '',
                arguments: '',
              },
            }

            if (toolCallDelta.id) {
              current.id = toolCallDelta.id
            }
            if (toolCallDelta.type === 'function') {
              current.type = toolCallDelta.type
            }
            if (toolCallDelta.function?.name) {
              current.function.name += toolCallDelta.function.name
              streamedText += toolCallDelta.function.name
            }
            if (toolCallDelta.function?.arguments) {
              current.function.arguments += toolCallDelta.function.arguments
              streamedText += toolCallDelta.function.arguments
            }

            streamedToolCalls.set(index, current)
          }

          const now = Date.now()
          if (streamedText && now - lastModelProgressTraceAt >= 100) {
            streamedTokenCount = estimateTokens(streamedText)
            activeModelStreamedTokenCount = streamedTokenCount
            lastModelProgressTraceAt = now
            const progressTrace = recorder.update(modelTrace.id, {
              output: assistantContent || undefined,
              reasoning: assistantReasoning || undefined,
              streamedTokenCount,
            })
            if (progressTrace) callbacks.onTrace?.(progressTrace)
          }
        }
        streamedTokenCount = estimateTokens(streamedText)
        activeModelStreamedTokenCount = streamedTokenCount
        assistantContent = assistantContent.trim() ? assistantContent : ''
        const toolUses = toToolCallList(streamedToolCalls)
        if (steeringInterrupted) {
          finalizeInterruptedModelTrace('success', '模型响应已被追加信息引导')
          if (assistantContent) {
            messages.push({ role: 'assistant', content: assistantContent })
          }
          await drainSteering()
          iteration -= 1
          continue
        }
        agentDebugLog('model_call_end', {
          runId,
          iteration,
          finishReason,
          assistantContentLength: assistantContent.length,
          assistantPreview: previewText(assistantContent),
          toolCalls: toolUses.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            argumentsPreview: previewText(toolCall.function.arguments || ''),
          })),
        })
        const modelTraceOutput = assistantContent || (
          toolUses.length > 0
            ? {
              finishReason,
              toolCalls: toolUses.map((toolCall) => ({
                id: toolCall.id,
                name: toolCall.function.name,
                argumentsPreview: previewText(toolCall.function.arguments || '', 500),
              })),
            }
            : undefined
        )
        const responseTrace = recorder.update(modelTrace.id, {
          type: 'model_response',
          title: assistantContent ? '模型响应' : toolUses.length > 0 ? '模型选择工具' : '模型思考',
          status: 'success',
          duration: Date.now() - modelTrace.timestamp,
          output: modelTraceOutput,
          reasoning: assistantReasoning || undefined,
          streamedTokenCount,
        })
        if (responseTrace) callbacks.onTrace?.(responseTrace)
        activeModelTraceId = undefined
        activeModelStartedAt = 0
        activeModelReasoning = ''
        activeModelContent = ''
        activeModelStreamedTokenCount = 0
        if (toolCallsStarted && candidateAnswerRendered) {
          callbacks.onCandidateAnswerClear?.()
        }
        await agentEventBus.emit('after-model-call', { runId, content: assistantContent })

        if (toolUses.length === 0) {
          const resolvedContent = assistantContent || finalContent
          if (!resolvedContent) {
            throw new Error('AI response did not include a message')
          }
          agentDebugLog('final_answer', {
            runId,
            contentLength: resolvedContent.length,
            preview: previewText(resolvedContent),
          })
          callbacks.onStatus?.('completed')
          callbacks.onFinalAnswerRender?.(resolvedContent)
          const finalTrace = recorder.add({
            type: 'final',
            title: '完成',
            status: 'success',
            message: resolvedContent,
          })
          callbacks.onTrace?.(finalTrace)

          return {
            runId,
            content: resolvedContent,
            stopped: false,
            steps,
            toolCalls,
            changes,
            trace: recorder.all(),
          }
        }

        messages.push({
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: toolUses,
        })

        for (const toolUse of toolUses) {
          if (this.stopped) {
            throw new Error('USER_STOPPED')
          }
          if (this.steeringRequested) {
            messages.push({
              role: 'tool',
              tool_call_id: toolUse.id,
              content: stringifyToolResult({
                ok: false,
                message: '用户追加了新的引导信息，本次尚未开始的工具调用已取消。',
                error: 'SUPERSEDED_BY_STEERING',
              }),
            })
            continue
          }

          const toolName = toolUse.function.name
          const tool = agentToolRegistry.getTool(toolName)
          let args: Record<string, unknown>
          try {
            args = parseToolArguments(toolUse.function.arguments)
          } catch (error) {
            const parseErrorResult: AgentToolResult = {
              ok: false,
              message: `工具参数 JSON 无效：${error instanceof Error ? error.message : String(error)}。请重新发起同一个工具调用，并返回合法 JSON 参数。`,
              error: 'INVALID_TOOL_ARGUMENTS_JSON',
            }
            const toolCall: ToolCall = {
              id: toolUse.id || createAgentId('tool-call'),
              toolName,
              params: {},
              status: 'error',
              result: toolResultToLegacy(parseErrorResult),
              timestamp: Date.now(),
            }
            toolCalls.push(toolCall)
            callbacks.onToolCall?.(toolCall)
            agentDebugLog('tool_args_parse_error', {
              runId,
              toolCallId: toolUse.id,
              toolName,
              rawArguments: toolUse.function.arguments || '',
              error: parseErrorResult.message,
            })
            messages.push({
              role: 'tool',
              tool_call_id: toolUse.id,
              content: stringifyToolResult(parseErrorResult),
            })
            continue
          }

          agentDebugLog('tool_call_received', {
            runId,
            toolCallId: toolUse.id,
            toolName,
            args,
          })

          if (!tool) {
            const missingResult: AgentToolResult = {
              ok: false,
              message: `工具不存在：${toolName}`,
              error: `Unknown tool ${toolName}`,
            }
            agentDebugLog('tool_missing', {
              runId,
              toolName,
            })
            messages.push({
              role: 'tool',
              tool_call_id: toolUse.id,
              content: stringifyToolResult(missingResult),
            })
            continue
          }

          callbacks.onStatus?.('calling_tool')
          const toolCall: ToolCall = {
            id: toolUse.id || createAgentId('tool-call'),
            toolName,
            params: args,
            status: 'pending',
            timestamp: Date.now(),
          }
          toolCalls.push(toolCall)
          callbacks.onToolCall?.(toolCall)

          if (!offeredToolNames.has(toolName)) {
            const blockedResult: AgentToolResult = {
              ok: false,
              message: `已阻止当前上下文或权限模式未提供的工具调用：${toolName}。`,
              error: 'BLOCKED_UNAVAILABLE_TOOL',
            }
            agentDebugLog('tool_blocked_as_unavailable', {
              runId,
              toolName,
              args,
              offeredToolNames: [...offeredToolNames],
            })
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(blockedResult)
            callbacks.onToolCall?.(toolCall)
            messages.push({
              role: 'tool',
              tool_call_id: toolUse.id,
              content: stringifyToolResult(blockedResult),
            })
            continue
          }

          const invalidToolInput = validateToolInputShape(tool, args)
          if (invalidToolInput) {
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(invalidToolInput)
            callbacks.onToolCall?.(toolCall)
            messages.push({
              role: 'tool',
              tool_call_id: toolUse.id,
              content: stringifyToolResult(invalidToolInput),
            })
            continue
          }

          const invalidEditorTarget = validateEditorTargetFile(context, tool, args)
          if (invalidEditorTarget) {
            agentDebugLog('tool_args_rejected', {
              runId,
              toolName,
              args,
              reason: invalidEditorTarget.message,
              error: invalidEditorTarget.error,
            })
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(invalidEditorTarget)
            callbacks.onToolCall?.(toolCall)
            messages.push({
              role: 'tool',
              tool_call_id: toolUse.id,
              content: stringifyToolResult(invalidEditorTarget),
            })
            continue
          }

          const invalidQuotedWrite = validateQuotedEditorWrite(context, toolName, args)
          if (invalidQuotedWrite) {
            const repairedArgs = repairQuotedEditorWriteArgs(context, toolName, args)
            if (repairedArgs) {
              agentDebugLog('tool_args_auto_repaired', {
                runId,
                toolName,
                originalArgs: args,
                repairedArgs,
                reason: invalidQuotedWrite.message,
                error: invalidQuotedWrite.error,
              })
              args = repairedArgs
              toolCall.params = args
              callbacks.onToolCall?.(toolCall)
            } else {
              invalidQuotedWriteRepairCount += 1
              agentDebugLog('tool_args_rejected', {
                runId,
                toolName,
                args,
                reason: invalidQuotedWrite.message,
                error: invalidQuotedWrite.error,
                retryCount: invalidQuotedWriteRepairCount,
              })
              toolCall.status = 'error'
              toolCall.result = toolResultToLegacy(invalidQuotedWrite)
              callbacks.onToolCall?.(toolCall)
              messages.push({
                role: 'tool',
                tool_call_id: toolUse.id,
                content: stringifyToolResult(invalidQuotedWrite),
              })

              if (invalidQuotedWriteRepairCount >= MAX_INVALID_QUOTED_WRITE_REPAIRS) {
                finalContent = '模型连续返回了超出选区范围的替换内容，已停止执行，未修改笔记。'
                agentDebugLog('invalid_tool_args_final', {
                  runId,
                  toolName,
                  retryCount: invalidQuotedWriteRepairCount,
                  content: finalContent,
                })
                callbacks.onStatus?.('completed')
                callbacks.onFinalAnswerRender?.(finalContent)
                const finalTrace = recorder.add({
                  type: 'final',
                  title: '停止执行',
                  status: 'error',
                  message: finalContent,
                })
                callbacks.onTrace?.(finalTrace)

                return {
                  runId,
                  content: finalContent,
                  stopped: false,
                  steps,
                  toolCalls,
                  changes,
                  trace: recorder.all(),
                }
              }

              continue
            }
          }

          const blockedByHook = await agentEventBus.emit('pre-tool-use', {
            runId,
            tool,
            input: args,
          })

          if (blockedByHook) {
            const blockedResult: AgentToolResult = {
              ok: false,
              message: blockedByHook,
              error: 'BLOCKED_BY_HOOK',
            }
            agentDebugLog('tool_blocked_by_hook', {
              runId,
              toolName,
              reason: blockedByHook,
            })
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(blockedResult)
            callbacks.onToolCall?.(toolCall)
            messages.push({
              role: 'tool',
              tool_call_id: toolUse.id,
              content: stringifyToolResult(blockedResult),
            })
            continue
          }

          const permission = this.permissionEngine.evaluate(tool, args, input.permissionMode)
          agentDebugLog('permission_decision', {
            runId,
            toolName,
            risk: tool.risk,
            allowed: permission.allowed,
            requiresApproval: permission.requiresApproval,
            reason: permission.reason,
            canApproveForSession: permission.canApproveForSession,
            sessionApprovalType: permission.sessionApprovalType,
            sessionApprovalSkillId: permission.sessionApprovalSkillId,
          })
          if (!permission.allowed) {
            const deniedResult: AgentToolResult = {
              ok: false,
              message: permission.reason || '工具调用被权限策略阻止。',
              error: 'BLOCKED_BY_PERMISSION',
            }
            agentDebugLog('tool_blocked_by_permission', {
              runId,
              toolName,
              reason: deniedResult.message,
            })
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(deniedResult)
            callbacks.onToolCall?.(toolCall)
            messages.push({
              role: 'tool',
              tool_call_id: toolUse.id,
              content: stringifyToolResult(deniedResult),
            })
            continue
          }

          if (permission.requiresApproval) {
            callbacks.onStatus?.('waiting_approval')
            agentDebugLog('approval_request', {
              runId,
              toolName,
              args,
            })
            const approvalTrace = recorder.add({
              type: 'approval',
              title: '等待用户确认',
              status: 'running',
              toolName,
              input: args,
            })
            callbacks.onTrace?.(approvalTrace)

            const approvalPreview = await buildEditorApprovalPreview(tool.name, args)
            if (this.stopped) {
              throw new Error('USER_STOPPED')
            }
            let approvalDecision = this.steeringRequested
              ? 'steered'
              : await callbacks.requestConfirmation?.(
                  tool.name,
                  args,
                  approvalPreview ?? { previewParams: args }
                )

            agentDebugLog('approval_result', {
              runId,
              toolName,
              approved: approvalDecision === 'approved',
              decision: approvalDecision,
            })

            if (this.stopped) {
              throw new Error('USER_STOPPED')
            }
            if (this.steeringRequested) {
              approvalDecision = 'steered'
            }

            if (approvalDecision === 'steered') {
              const supersededResult: AgentToolResult = {
                ok: false,
                message: '用户追加了新的引导信息，本次待确认操作已取消。',
                error: 'SUPERSEDED_BY_STEERING',
              }
              toolCall.status = 'error'
              toolCall.result = toolResultToLegacy(supersededResult)
              callbacks.onToolCall?.(toolCall)
              const updatedApprovalTrace = recorder.update(approvalTrace.id, {
                status: 'error',
                message: supersededResult.message,
                output: supersededResult,
              })
              if (updatedApprovalTrace) callbacks.onTrace?.(updatedApprovalTrace)
              messages.push({
                role: 'tool',
                tool_call_id: toolUse.id,
                content: stringifyToolResult(supersededResult),
              })
              continue
            }

            if (approvalDecision !== 'approved') {
              const deniedResult: AgentToolResult = {
                ok: false,
                message: '用户拒绝了这个操作。请不要重复调用同一高风险工具，改用只读回答或询问用户新的处理方式。',
                error: 'USER_DENIED_TOOL',
              }
              toolCall.status = 'error'
              toolCall.result = toolResultToLegacy(deniedResult)
              callbacks.onToolCall?.(toolCall)
              const updatedApprovalTrace = recorder.update(approvalTrace.id, {
                status: 'error',
                message: deniedResult.message,
                output: deniedResult,
              })
              if (updatedApprovalTrace) callbacks.onTrace?.(updatedApprovalTrace)
              messages.push({
                role: 'tool',
                tool_call_id: toolUse.id,
                content: stringifyToolResult(deniedResult),
              })
              finalContent = changes.length > 0
                ? `已取消当前待确认操作；此前已有 ${changes.length} 项改动成功执行，请以改动记录为准。`
                : '已取消当前待确认操作，未执行该项改动。'
              agentDebugLog('approval_denied_final', {
                runId,
                toolName,
                content: finalContent,
              })
              callbacks.onStatus?.('completed')
              callbacks.onFinalAnswerRender?.(finalContent)
              const finalTrace = recorder.add({
                type: 'final',
                title: '已取消',
                status: 'success',
                message: finalContent,
              })
              callbacks.onTrace?.(finalTrace)

              return {
                runId,
                content: finalContent,
                stopped: false,
                steps,
                toolCalls,
                changes,
                trace: recorder.all(),
              }
            }

            const updatedApprovalTrace = recorder.update(approvalTrace.id, {
              status: 'success',
              message: '用户已确认操作。',
            })
            if (updatedApprovalTrace) callbacks.onTrace?.(updatedApprovalTrace)
          }

          callbacks.onStatus?.(
            ['editor-write', 'file-create', 'file-update', 'delete', 'medium'].includes(tool.risk)
              ? 'applying_change'
              : 'calling_tool'
          )

          const trace = recorder.add({
            type: 'tool_call',
            title: tool.title,
            status: 'running',
            toolName,
            input: args,
          })
          callbacks.onTrace?.(trace)
          toolCall.status = 'running'
          callbacks.onToolCall?.(toolCall)

          const startedAt = Date.now()
          const reusableEditorStateResult = toolName === 'editor_get_state' && editorStateReadLocked
            ? latestEditorStateResult
            : undefined
          const reusedLockedEditorState = reusableEditorStateResult !== undefined
          agentDebugLog('tool_execute_start', {
            runId,
            iteration,
            toolName,
            args,
            reusedLockedEditorState,
          })
          const result: AgentToolResult = reusableEditorStateResult
            ? {
                ...reusableEditorStateResult,
                message: [
                  reusableEditorStateResult.message,
                  '本轮已经读取过相同的编辑器状态，请直接使用此前返回的内容，不要再次读取。',
                ].join('\n\n'),
              }
            : await tool.execute(args, {
                runId,
                signal: this.abortController?.signal,
                context,
              })
          const duration = Date.now() - startedAt
          agentDebugLog('tool_execute_end', {
            runId,
            iteration,
            toolName,
            ok: result.ok,
            duration,
            message: result.message,
            error: result.error,
            changeCount: result.changes?.length || 0,
          })

          if (result.changes) {
            for (const change of result.changes) {
              changes.push(change)
              callbacks.onChange?.(change)
              const changeTrace = recorder.add({
                type: 'change',
                title: change.summary || '记录改动',
                status: 'success',
                toolName,
                output: change,
                message: change.target,
              })
              callbacks.onTrace?.(changeTrace)
            }
          }

          toolCall.status = result.ok ? 'success' : 'error'
          toolCall.result = toolResultToLegacy(result)
          callbacks.onToolCall?.(toolCall)

          const step = buildStep(tool, args, result, duration)
          steps.push(step)
          callbacks.onStep?.(step)

          const updatedTrace = recorder.update(trace.id, {
            status: result.ok ? 'success' : 'error',
            duration,
            output: result,
            message: result.message,
          })
          if (updatedTrace) callbacks.onTrace?.(updatedTrace)

          await agentEventBus.emit('post-tool-use', {
            runId,
            tool,
            input: args,
            result,
          })

          let modelFacingResult = result
          let identicalReadResultRepeatCount = 0
          const readToolCallSignature = reusedLockedEditorState
            ? undefined
            : getReadToolCallSignature(tool, args)
          if (result.ok && readToolCallSignature) {
            const serializedResult = stringifyToolResult(result)
            const previousRead = readToolResultHistory.get(readToolCallSignature)

            if (previousRead?.result === serializedResult) {
              identicalReadResultRepeatCount = previousRead.repeatCount + 1
              readToolResultHistory.set(readToolCallSignature, {
                result: serializedResult,
                repeatCount: identicalReadResultRepeatCount,
              })
              modelFacingResult = {
                ...result,
                message: [
                  result.message,
                  '这次读取与上次完全相同，上次结果仍在上下文中。不要再次读取；请使用已有结果执行下一步写入，或直接完成回答。',
                ].join('\n\n'),
              }
            } else {
              readToolResultHistory.set(readToolCallSignature, {
                result: serializedResult,
                repeatCount: 0,
              })
            }
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolUse.id,
            content: stringifyToolResult(modelFacingResult),
          })

          if (result.ok) {
            successfulToolEvidence.add([
              tool.name,
              JSON.stringify(args),
              stringifyToolResult(result),
            ].join(':'))
          }

          if (!result.ok) {
            const failedCallSignature = `${tool.name}:${JSON.stringify(args)}`
            const serializedResult = stringifyToolResult(result)
            const previousFailure = failedToolResultHistory.get(failedCallSignature)
            const repeatCount = previousFailure?.result === serializedResult
              ? previousFailure.repeatCount + 1
              : 0
            failedToolResultHistory.set(failedCallSignature, {
              result: serializedResult,
              repeatCount,
            })

            const mustStopWithoutRetry = tool.risk !== 'read'
            if (mustStopWithoutRetry || repeatCount >= MAX_IDENTICAL_FAILED_TOOL_RESULT_REPEATS) {
              callbacks.onCandidateAnswerClear?.()
              finalContent = [
                mustStopWithoutRetry
                  ? `${tool.title}执行失败。为避免重复副作用，已禁止自动重试。`
                  : `${tool.title}以相同参数连续失败，已停止重复调用。`,
                result.message || result.error || '工具未返回可确认的成功结果。',
                changes.length > 0 ? `此前已有 ${changes.length} 项改动成功执行，请以改动记录为准。` : '本次操作未确认完成。',
              ].join('\n')
              callbacks.onStatus?.('completed')
              callbacks.onFinalAnswerRender?.(finalContent)
              const finalTrace = recorder.add({
                type: 'final',
                title: '停止重复执行',
                status: 'error',
                message: finalContent,
              })
              callbacks.onTrace?.(finalTrace)

              return {
                runId,
                content: finalContent,
                stopped: false,
                steps,
                toolCalls,
                changes,
                trace: recorder.all(),
              }
            }
          } else {
            failedToolResultHistory.delete(`${tool.name}:${JSON.stringify(args)}`)
          }

          if (identicalReadResultRepeatCount >= MAX_IDENTICAL_READ_RESULT_REPEATS) {
            callbacks.onCandidateAnswerClear?.()
            finalContent = [
              `模型连续重复调用 ${toolName}，且读取结果始终未变，已停止执行以避免循环。`,
              writeActionCompleted ? '已保留此前完成的修改。' : '本次修改尚未完成。',
            ].join('\n')
            callbacks.onStatus?.('completed')
            callbacks.onFinalAnswerRender?.(finalContent)
            const finalTrace = recorder.add({
              type: 'final',
              title: '停止重复执行',
              status: 'error',
              message: finalContent,
            })
            callbacks.onTrace?.(finalTrace)

            return {
              runId,
              content: finalContent,
              stopped: false,
              steps,
              toolCalls,
              changes,
              trace: recorder.all(),
            }
          }

          if (result.ok && isMutatingTool(tool)) {
            writeActionCompleted = true
            readToolResultHistory.clear()
            latestEditorStateResult = undefined
            editorStateReadLocked = false
          } else if (isEditorStateStaleResult(tool, result)) {
            latestEditorStateResult = undefined
            editorStateReadLocked = false
          }

          if (result.ok && tool.name === 'editor_get_state') {
            if (!reusedLockedEditorState) {
              latestEditorStateResult = result
            }
            editorStateReadLocked = true
          }

        }

        const madeProgress = successfulToolEvidence.size > evidenceCountAtRoundStart
        consecutiveNoProgressRounds = madeProgress
          ? 0
          : consecutiveNoProgressRounds + 1
        agentDebugLog('agent_round_progress', {
          runId,
          iteration,
          madeProgress,
          newEvidenceCount: successfulToolEvidence.size - evidenceCountAtRoundStart,
          consecutiveNoProgressRounds,
        })

        if (consecutiveNoProgressRounds >= MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS) {
          finalContent = [
            `连续 ${MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS} 轮没有获得新的成功工具结果，已停止执行以避免无效循环。`,
            changes.length > 0 ? `此前已有 ${changes.length} 项改动成功执行，请以改动记录为准。` : '本次任务尚未确认完成。',
          ].join('\n')
          callbacks.onCandidateAnswerClear?.()
          callbacks.onStatus?.('completed')
          callbacks.onFinalAnswerRender?.(finalContent)
          const finalTrace = recorder.add({
            type: 'final',
            title: '停止无进展循环',
            status: 'error',
            message: finalContent,
          })
          callbacks.onTrace?.(finalTrace)
          return {
            runId,
            content: finalContent,
            stopped: false,
            steps,
            toolCalls,
            changes,
            trace: recorder.all(),
          }
        }

      }

      finalContent = finalContent || `已达到 ${ABSOLUTE_MAX_MODEL_ROUNDS} 轮绝对安全上限，任务可能未完全完成。`
      callbacks.onFinalAnswerRender?.(finalContent)
      return {
        runId,
        content: finalContent,
        stopped: false,
        steps,
        toolCalls,
        changes,
        trace: recorder.all(),
      }
    } catch (error) {
      if (
        this.stopped
        || (error instanceof Error && error.message === 'USER_STOPPED')
        || isRequestAbortError(error)
      ) {
        // AbortController may surface an AbortError before the stream loop can throw
        // USER_STOPPED. Treat both paths as a normal stop and preserve what the
        // current model has already streamed to the user.
        finalContent = getSafeStoppedContent()
        finalizeInterruptedModelTrace('success', '模型响应已停止')
        callbacks.onStatus?.('stopped')
        if (finalContent) {
          callbacks.onFinalAnswerRender?.(finalContent)
        }
        return {
          runId,
          content: finalContent,
          stopped: true,
          steps,
          toolCalls,
          changes,
          trace: recorder.all(),
        }
      }

      callbacks.onStatus?.('failed')
      finalizeInterruptedModelTrace('error', '模型响应失败')
      const message = handleAIError(error, false) || (error instanceof Error ? error.message : String(error))
      const errorTrace = recorder.add({
        type: 'error',
        title: '执行失败',
        status: 'error',
        message,
      })
      callbacks.onTrace?.(errorTrace)
      throw new Error(message)
    }
  }
}
