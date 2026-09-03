import type OpenAI from 'openai'
import type {
  AgentModelPort,
  AgentModelSettings,
  AgentModelStreamRequest,
  AgentModelValidation,
} from '../../src/lib/agent/types'
import type { ReplayTurn } from './types'

function chunk(
  id: string,
  delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
  finishReason: 'stop' | 'tool_calls' | null,
): OpenAI.Chat.Completions.ChatCompletionChunk {
  return {
    id,
    created: 0,
    model: 'cardmind-replay',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
      logprobs: null,
    }],
  }
}

function usageChunk(
  id: string,
  usage: NonNullable<ReplayTurn['usage']>,
): OpenAI.Chat.Completions.ChatCompletionChunk {
  return {
    id,
    created: 0,
    model: 'cardmind-replay',
    object: 'chat.completion.chunk',
    choices: [],
    usage: {
      prompt_tokens: usage.promptTokens || 0,
      completion_tokens: usage.completionTokens || 0,
      total_tokens: usage.totalTokens || 0,
    },
  }
}

export class ReplayModelPort implements AgentModelPort {
  private cursor = 0
  readonly requests: AgentModelStreamRequest[] = []

  constructor(
    private readonly turns: ReplayTurn[],
    private readonly settings: AgentModelSettings = {
      model: 'cardmind-replay',
      baseURL: 'memory://agent-eval',
      temperature: 0,
    },
  ) {}

  async loadSettings() {
    return this.settings
  }

  async validateSettings() {
    return { ok: true }
  }

  async getSystemPrompt() {
    return 'You are the CardMind replay evaluator. Follow the user request and use only the provided tools.'
  }

  async createStream(request: AgentModelStreamRequest) {
    this.requests.push(request)
    const turn = this.turns[this.cursor]
    this.cursor += 1

    if (!turn) {
      throw new Error(`REPLAY_EXHAUSTED: no turn at index ${this.cursor - 1}`)
    }
    if (turn.createError) {
      throw new Error(turn.createError)
    }

    const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = []
    const id = `replay-${this.cursor}`
    if (turn.content) {
      chunks.push(chunk(id, { content: turn.content }, turn.toolCalls?.length ? null : 'stop'))
    }
    if (turn.toolCalls?.length) {
      const serialized = turn.toolCalls.map((call) => typeof call.arguments === 'string'
        ? call.arguments
        : JSON.stringify(call.arguments))
      if (turn.fragmentToolCalls) {
        chunks.push(chunk(id, {
          tool_calls: turn.toolCalls.map((call, index) => {
            const cut = Math.ceil(serialized[index].length / 2)
            return {
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: serialized[index].slice(0, cut) },
            }
          }),
        }, null))
        chunks.push(chunk(id, {
          tool_calls: turn.toolCalls.map((_call, index) => {
            const cut = Math.ceil(serialized[index].length / 2)
            return {
              index,
              function: { arguments: serialized[index].slice(cut) },
            }
          }),
        } as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta, 'tool_calls'))
      } else {
        chunks.push(chunk(id, {
          tool_calls: turn.toolCalls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: serialized[index],
            },
          })),
        }, 'tool_calls'))
      }
    }
    if (!turn.content && !turn.toolCalls?.length) {
      chunks.push(chunk(id, {}, 'stop'))
    }
    if (turn.usage) {
      chunks.push(usageChunk(id, turn.usage))
    }

    const errorAfter = turn.streamErrorAfterChunks
    return (async function* replay() {
      let delivered = 0
      for (const item of chunks) {
        if (request.signal.aborted) {
          throw new DOMException('The operation was aborted', 'AbortError')
        }
        if (errorAfter !== undefined && delivered >= errorAfter) {
          throw new Error('REPLAY_STREAM_INTERRUPTED')
        }
        yield item
        delivered += 1
      }
      if (errorAfter !== undefined && delivered >= errorAfter) {
        throw new Error('REPLAY_STREAM_INTERRUPTED')
      }
    })()
  }

  formatError(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  remainingTurns() {
    return this.turns.length - this.cursor
  }
}

export interface RecordedModelCall {
  iteration: number
  attempt: number
  model: string
  messageRoles: string[]
  toolNames: string[]
  chunks: Array<{
    choiceCount: number
    finishReasons: Array<string | null>
    hasContent: boolean
    toolCallDeltaCount: number
    usageAvailable: boolean
  }>
  completed: boolean
  errorPhase?: 'create' | 'stream'
  error?: string
}

interface CapturedError {
  name: string
  message: string
}

interface CapturedRequestMetadata {
  iteration: number
  attempt: number
  model: string
  messageRoles: string[]
  toolNames: string[]
}

interface CapturedModelRequest {
  settings: AgentModelSettings
  messages: AgentModelStreamRequest['messages']
  tools: AgentModelStreamRequest['tools']
  toolChoice: AgentModelStreamRequest['toolChoice']
  iteration: number
  attempt: number
}

interface CapturedModelAttempt {
  metadata: CapturedRequestMetadata
  request: CapturedModelRequest
  chunks: OpenAI.Chat.Completions.ChatCompletionChunk[]
  createError?: CapturedError
  streamError?: CapturedError
  streamCompleted: boolean
  streamAbandoned: boolean
}

function captureRequest(request: AgentModelStreamRequest): CapturedModelRequest {
  return {
    settings: {
      model: request.settings.model,
      baseURL: request.settings.baseURL,
      temperature: request.settings.temperature,
      topP: request.settings.topP,
    },
    messages: structuredClone(request.messages),
    tools: structuredClone(request.tools),
    toolChoice: structuredClone(request.toolChoice),
    iteration: request.iteration,
    attempt: request.attempt,
  }
}

function requestMetadata(request: AgentModelStreamRequest): CapturedRequestMetadata {
  return {
    iteration: request.iteration,
    attempt: request.attempt,
    model: request.settings.model,
    messageRoles: request.messages.map((message) => message.role),
    toolNames: request.tools.map((tool) => tool.function.name),
  }
}

function captureError(error: unknown): CapturedError {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  }
}

function throwCaptured(error: CapturedError): never {
  if (error.name === 'AbortError') {
    throw new DOMException(error.message, 'AbortError')
  }
  const replayed = new Error(error.message)
  replayed.name = error.name
  throw replayed
}

function cloneChunk(chunk: OpenAI.Chat.Completions.ChatCompletionChunk) {
  return structuredClone(chunk)
}

class RecordedReplayModelPort implements AgentModelPort {
  private cursor = 0

  constructor(
    private readonly attempts: CapturedModelAttempt[],
    private readonly settings: AgentModelSettings | null | undefined,
    private readonly validation: { ok: boolean; reason?: string },
    private readonly systemPrompt: string,
  ) {}

  async loadSettings() {
    return this.settings ? { ...this.settings } : this.settings
  }

  async validateSettings() {
    return { ...this.validation }
  }

  async getSystemPrompt() {
    return this.systemPrompt
  }

  async createStream(request: AgentModelStreamRequest) {
    const attempt = this.attempts[this.cursor]
    this.cursor += 1
    if (!attempt) {
      throw new Error(`RECORDED_REPLAY_EXHAUSTED: no attempt at index ${this.cursor - 1}`)
    }

    const actual = captureRequest(request)
    if (JSON.stringify(actual) !== JSON.stringify(attempt.request)) {
      throw new Error(`RECORDED_REPLAY_REQUEST_MISMATCH at attempt ${this.cursor - 1}`)
    }
    if (attempt.createError) {
      throwCaptured(attempt.createError)
    }

    return (async function* replayCapturedStream() {
      for (const item of attempt.chunks) {
        if (request.signal.aborted) {
          throw new DOMException('The operation was aborted', 'AbortError')
        }
        yield cloneChunk(item)
      }
      if (attempt.streamError) {
        throwCaptured(attempt.streamError)
      }
    })()
  }

  formatError(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  remainingAttempts() {
    return this.attempts.length - this.cursor
  }
}

/**
 * Records every create/stream attempt in memory so the same model traffic can
 * be replayed. The public `calls` view intentionally contains metadata only:
 * no messages, chunk content, tool arguments, provider settings, or credentials.
 */
export class RecordingModelPort implements AgentModelPort {
  readonly calls: RecordedModelCall[] = []
  private readonly capturedAttempts: CapturedModelAttempt[] = []
  private loadedSettings: AgentModelSettings | null | undefined
  private settingsCaptured = false
  private validation: AgentModelValidation = { ok: true }
  private systemPrompt: string | undefined

  constructor(private readonly inner: AgentModelPort) {}

  async loadSettings() {
    const settings = await this.inner.loadSettings()
    this.loadedSettings = settings
      ? {
          model: settings.model,
          baseURL: settings.baseURL,
          temperature: settings.temperature,
          topP: settings.topP,
        }
      : settings
    this.settingsCaptured = true
    return settings
  }

  async validateSettings(settings: AgentModelSettings) {
    this.validation = await (this.inner.validateSettings?.(settings) || Promise.resolve({ ok: true }))
    return this.validation
  }

  async getSystemPrompt() {
    this.systemPrompt = await this.inner.getSystemPrompt()
    return this.systemPrompt
  }

  async createStream(request: AgentModelStreamRequest) {
    const metadata = requestMetadata(request)
    const record: RecordedModelCall = {
      ...metadata,
      messageRoles: [...metadata.messageRoles],
      toolNames: [...metadata.toolNames],
      chunks: [],
      completed: false,
    }
    this.calls.push(record)
    const captured: CapturedModelAttempt = {
      metadata: structuredClone(metadata),
      request: captureRequest(request),
      chunks: [],
      streamCompleted: false,
      streamAbandoned: false,
    }
    this.capturedAttempts.push(captured)

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
    try {
      stream = await this.inner.createStream(request)
    } catch (error) {
      captured.createError = captureError(error)
      record.errorPhase = 'create'
      record.error = captured.createError.name
      record.completed = true
      throw error
    }

    return (async function* recordStream() {
      try {
        for await (const item of stream) {
          captured.chunks.push(cloneChunk(item))
          record.chunks.push({
            choiceCount: item.choices?.length || 0,
            finishReasons: (item.choices || []).map((choice) => choice.finish_reason),
            hasContent: (item.choices || []).some((choice) => Boolean(choice.delta?.content)),
            toolCallDeltaCount: (item.choices || []).reduce(
              (total, choice) => total + (choice.delta?.tool_calls?.length || 0),
              0,
            ),
            usageAvailable: Boolean(item.usage),
          })
          yield item
        }
        captured.streamCompleted = true
        record.completed = true
      } catch (error) {
        captured.streamError = captureError(error)
        record.errorPhase = 'stream'
        record.error = captured.streamError.name
        record.completed = true
        throw error
      } finally {
        if (!captured.streamCompleted && !captured.streamError) {
          captured.streamAbandoned = true
        }
      }
    })()
  }

  formatError(error: unknown) {
    return this.inner.formatError?.(error) || (error instanceof Error ? error.message : String(error))
  }

  createReplayPort() {
    if (!this.settingsCaptured || this.systemPrompt === undefined) {
      throw new Error('RECORDING_INCOMPLETE: runtime settings or system prompt were not captured')
    }
    if (this.capturedAttempts.some((attempt) =>
      attempt.streamAbandoned
      || (!attempt.createError && !attempt.streamCompleted && !attempt.streamError),
    )) {
      throw new Error('RECORDING_INCOMPLETE: a model stream was not fully consumed')
    }
    return new RecordedReplayModelPort(
      this.capturedAttempts.map((attempt) => ({
        metadata: structuredClone(attempt.metadata),
        request: structuredClone(attempt.request),
        chunks: attempt.chunks.map(cloneChunk),
        createError: attempt.createError ? { ...attempt.createError } : undefined,
        streamError: attempt.streamError ? { ...attempt.streamError } : undefined,
        streamCompleted: attempt.streamCompleted,
        streamAbandoned: attempt.streamAbandoned,
      })),
      this.loadedSettings ? { ...this.loadedSettings } : this.loadedSettings,
      { ...this.validation },
      this.systemPrompt,
    )
  }
}
