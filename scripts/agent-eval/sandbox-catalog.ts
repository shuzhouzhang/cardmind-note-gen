import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentRuntimeCallbacks,
  AgentTool,
  AgentToolCatalog,
  AgentToolExecutionContext,
  AgentToolResult,
} from '../../src/lib/agent/types'
import {
  AGENT_TOOL_MANIFEST,
  manifestToOpenAITools,
} from '../../src/lib/agent/tool-manifest'
import type {
  ApprovalFixture,
  ApprovalLogEntry,
  SandboxExecution,
  SandboxToolResponse,
} from './types'

function abortableDelay(ms: number, signal: AbortSignal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Executes only deterministic in-memory responses, while exposing the exact
 * same complete model-facing manifest as the production CardMind registry.
 */
export class SandboxToolCatalog implements AgentToolCatalog {
  readonly executions: SandboxExecution[] = []
  readonly requested: Array<{ toolName: string; args: Record<string, unknown> }> = []
  unexpectedExecutions = 0
  readonly realExecutionCount = 0
  readonly files = new Map<string, string>()
  editorContent = ''
  memoryMutationCount = 0
  private readonly cursors = new Map<string, number>()
  private readonly tools: AgentTool[]

  constructor(private readonly responses: Record<string, SandboxToolResponse[]>) {
    this.tools = AGENT_TOOL_MANIFEST.map((definition) => ({
      ...definition,
      execute: (args, context) => this.execute(definition.name, args, context),
    }))
  }

  listTools() {
    return [...this.tools]
  }

  getTool(name: string) {
    this.requested.push({ toolName: name, args: {} })
    return this.tools.find((tool) => tool.name === name)
  }

  toOpenAITools() {
    return manifestToOpenAITools()
  }

  private async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolResult> {
    const index = this.cursors.get(toolName) || 0
    const queue = this.responses[toolName] || []
    const response = queue[index]
    this.cursors.set(toolName, index + 1)
    this.requested[this.requested.length - 1] = { toolName, args: structuredClone(args) }

    if (!response) {
      this.unexpectedExecutions += 1
      return {
        ok: false,
        message: `No sandbox response configured for ${toolName}`,
        error: 'UNEXPECTED_SANDBOX_EXECUTION',
        effectStatus: 'none',
      }
    }

    const execution: SandboxExecution = {
      toolName,
      args: structuredClone(args),
      operationKey: context.operationKey,
      toolCallId: context.toolCallId,
    }
    this.executions.push(execution)
    await abortableDelay(response.delayMs || 0, context.signal)
    if (response.throw) {
      throw new Error(response.throw)
    }

    const result: AgentToolResult = {
      ok: response.ok,
      message: response.message,
      data: response.data,
      error: response.error,
      effectStatus: response.effectStatus ?? (response.ok ? undefined : 'none'),
      changes: response.changes,
    }
    execution.result = result
    execution.changes = result.changes
    if (result.ok) this.applyMemoryEffect(toolName, args)
    return result
  }

  private applyMemoryEffect(toolName: string, args: Record<string, unknown>) {
    if (toolName === 'note_create_file') {
      const name = typeof args.fileName === 'string' ? args.fileName : ''
      const folder = typeof args.folderPath === 'string' ? args.folderPath.replace(/\/$/, '') : ''
      const target = [folder, name].filter(Boolean).join('/')
      if (target) {
        this.files.set(target, typeof args.content === 'string' ? args.content : '')
        this.memoryMutationCount += 1
      }
    } else if (toolName === 'note_update_file') {
      if (typeof args.filePath === 'string') {
        this.files.set(args.filePath, typeof args.content === 'string' ? args.content : '')
        this.memoryMutationCount += 1
      }
    } else if (toolName === 'note_delete_file') {
      if (typeof args.filePath === 'string') {
        this.files.delete(args.filePath)
        this.memoryMutationCount += 1
      }
    } else if (
      toolName === 'editor_insert_at_cursor'
      || toolName === 'editor_replace_range'
      || toolName === 'editor_replace_lines'
      || toolName === 'editor_apply_transaction'
    ) {
      this.editorContent = typeof args.content === 'string'
        ? args.content
        : typeof args.replaceContent === 'string'
          ? args.replaceContent
          : JSON.stringify(args.operations || [])
      this.memoryMutationCount += 1
    }
  }
}

export function createApprovalCallbacks(
  fixtures: ApprovalFixture[],
  log: ApprovalLogEntry[],
): Pick<AgentRuntimeCallbacks, 'requestConfirmation'> {
  let cursor = 0
  return {
    requestConfirmation: async (request: AgentApprovalRequest, signal: AbortSignal) => {
      if (signal.aborted) {
        return { approved: false, reason: 'aborted' }
      }
      const fixture = fixtures[cursor]
      cursor += 1
      let decision: AgentApprovalDecision
      if (!fixture) {
        decision = { approved: false, reason: 'denied' }
      } else if (
        (fixture.toolName && fixture.toolName !== request.toolName)
        || (fixture.target && fixture.target !== request.target)
      ) {
        decision = { approved: false, reason: 'denied' }
      } else {
        decision = {
          approved: fixture.approved,
          scope: fixture.scope,
          reason: fixture.reason || (fixture.approved ? 'approved' : 'denied'),
        }
      }
      log.push({ request, decision })
      return decision
    },
  }
}
