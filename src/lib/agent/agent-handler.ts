import OpenAI from 'openai'
import useChatStore from '@/stores/chat'
import { awaitAgentHandlerCallback } from './agent-handler-callbacks'
import { AgentRuntime } from './runtime'
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentChange,
  AgentRuntimeResult,
  AgentSkillSummary,
  AgentStep,
  AgentTraceEvent,
  ToolCall,
} from './types'

export interface AgentHandlerConfig {
  activeChatId?: number
  activeFilePath?: string
  onThought?: (thought: string) => void
  onAction?: (action: string, params: Record<string, any>) => void
  onObservation?: (observation: string) => void
  onComplete?: (
    result: string,
    steps?: AgentStep[],
    stopped?: boolean,
    runtimeResult?: AgentRuntimeResult
  ) => void | Promise<void>
  onError?: (error: string) => void | Promise<void>
  onFinalAnswerRender?: (markdownContent: string) => void
  formatAutoFinalAnswer?: (key: string, values?: Record<string, string>) => string
  requestConfirmation?: (
    request: AgentApprovalRequest,
    signal: AbortSignal
  ) => Promise<AgentApprovalDecision>
  currentQuote?: {
    fileName: string
    startLine: number
    endLine: number
    from: number
    to: number
    fullContent?: string
  }
}

export class AgentHandler {
  private runtime: AgentRuntime | null = null
  private readonly config: AgentHandlerConfig

  constructor(config: AgentHandlerConfig) {
    this.config = config
  }

  async execute(
    userInput: string,
    contextOrMessages?: string | OpenAI.Chat.ChatCompletionMessageParam[],
    imageUrls?: string[]
  ): Promise<string> {
    const store = useChatStore.getState()

    store.resetAgentState()
    store.setAgentState({
      activeChatId: this.config.activeChatId,
      isRunning: true,
      isThinking: false,
      status: 'preparing_context',
      currentStepStartTime: Date.now(),
    })

    const skillsInfo: AgentSkillSummary[] = []

    const messages = Array.isArray(contextOrMessages)
      ? contextOrMessages
      : contextOrMessages
        ? [{ role: 'system' as const, content: contextOrMessages }]
        : []

    this.runtime = new AgentRuntime()

    try {
      const result = await this.runtime.run({
        userInput,
        messages,
        imageUrls,
        activeChatId: this.config.activeChatId,
        activeFilePath: this.config.activeFilePath,
        currentQuote: this.config.currentQuote,
        availableSkills: skillsInfo,
      }, {
        onStatus: (status) => {
          store.setAgentState({
            status,
            isRunning: status !== 'completed' && status !== 'failed' && status !== 'stopped',
            isThinking: status === 'thinking',
            currentStepStartTime: status === 'thinking' || status === 'calling_tool'
              ? Date.now()
              : useChatStore.getState().agentState.currentStepStartTime,
          })
        },
        onTrace: (event) => {
          this.appendTrace(event)
        },
        onToolCall: (toolCall) => {
          this.upsertToolCall(toolCall)
        },
        onChange: (change) => {
          this.appendChange(change)
        },
        onStep: (step) => {
          this.appendStep(step)
          if (step.action) {
            this.config.onAction?.(step.action.tool, step.action.params)
          }
          if (step.observation) {
            this.config.onObservation?.(step.observation)
          }
        },
        onCandidateAnswerRender: (content) => {
          store.setAgentState({
            activeChatId: this.config.activeChatId,
            isFinalAnswerMode: true,
            finalAnswerContent: content,
          })
        },
        onCandidateAnswerClear: () => {
          store.setAgentState({
            isFinalAnswerMode: false,
            finalAnswerContent: undefined,
          })
        },
        onFinalAnswerRender: (content) => {
          store.setAgentState({
            activeChatId: this.config.activeChatId,
            isFinalAnswerMode: true,
            finalAnswerContent: content,
          })
          this.config.onFinalAnswerRender?.(content)
        },
        requestConfirmation: async (request, signal) => {
          return await this.config.requestConfirmation?.(request, signal) || {
            approved: false,
            reason: signal.aborted ? 'aborted' : 'denied',
          }
        },
      })

      this.finishRun(result)
      await awaitAgentHandlerCallback(
        this.config.onComplete,
        result.content,
        result.steps,
        result.stopped,
        result
      )
      return result.content
    } catch (error) {
      store.setAgentState({
        isRunning: false,
        isThinking: false,
        status: 'failed',
      })
      const errorMessage = error instanceof Error ? error.message : String(error)
      await awaitAgentHandlerCallback(this.config.onError, errorMessage)
      throw error
    }
  }

  stop() {
    this.runtime?.stop()
  }

  private appendTrace(event: AgentTraceEvent) {
    const current = useChatStore.getState().agentState
    useChatStore.getState().setAgentState({
      runId: event.runId,
      traceEvents: [
        ...(current.traceEvents || []).filter((item) => item.id !== event.id),
        event,
      ],
      currentThought: event.message || event.title,
      currentIteration: event.iteration ?? current.currentIteration,
    })
    this.config.onThought?.(event.message || event.title)
  }

  private upsertToolCall(toolCall: ToolCall) {
    const currentState = useChatStore.getState()
    const existing = currentState.agentState.toolCalls.find((item) => item.id === toolCall.id)
    if (existing) {
      currentState.updateAgentToolCall(toolCall.id, toolCall)
    } else {
      currentState.addAgentToolCall(toolCall)
    }

    currentState.setAgentState({
      currentAction: `${toolCall.toolName}(${JSON.stringify(toolCall.params)})`,
    })

  }

  private appendStep(step: AgentStep) {
    const current = useChatStore.getState().agentState
    useChatStore.getState().setAgentState({
      completedSteps: [...current.completedSteps, step],
      currentObservation: step.observation,
      currentThought: step.thought,
    })
  }

  private appendChange(change: AgentChange) {
    const current = useChatStore.getState().agentState
    useChatStore.getState().setAgentState({
      changes: [
        ...(current.changes || []).filter((item) => item.id !== change.id),
        change,
      ],
    })
  }

  private finishRun(result: AgentRuntimeResult) {
    const store = useChatStore.getState()
    store.setAgentState({
      runId: result.runId,
      isRunning: false,
      isThinking: false,
      status: result.outcome === 'success'
        ? 'completed'
        : result.outcome === 'stopped'
          ? 'stopped'
          : 'failed',
      currentIteration: result.metrics.currentIteration,
      completedSteps: result.steps,
      toolCalls: result.toolCalls,
      changes: result.changes,
      traceEvents: result.trace,
      currentAction: undefined,
      currentObservation: undefined,
    })
  }
}
