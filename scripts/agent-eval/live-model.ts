import OpenAI from 'openai'
import type {
  AgentModelPort,
  AgentModelSettings,
  AgentModelStreamRequest,
} from '../../src/lib/agent/types'
import { DEFAULT_SYSTEM_PROMPT } from '../../src/lib/ai/system-prompt'
import { safeError } from './redaction'

export interface LiveBudget {
  totalLimit: number
  perScenarioLimit: number
  totalUsed: number
  probeCalls: number
  byScenario: Map<string, number>
}

interface ProviderConfig {
  baseURL: string
  apiKey: string
}

function validateProvider(config: ProviderConfig) {
  const url = new URL(config.baseURL)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('The live provider URL must be credential-free HTTPS without query or fragment data')
  }
  const normalizedPath = url.pathname.replace(/\/$/, '') || '/'
  if (url.hostname.toLowerCase() !== 'api.notegen.top' || url.port || normalizedPath !== '/v1') {
    throw new Error('notegen-free live evaluation is restricted to https://api.notegen.top/v1')
  }
  if (!config.apiKey.trim()) {
    throw new Error('The live provider API key is missing')
  }
  return { ...config, baseURL: 'https://api.notegen.top/v1' }
}

export function loadNoteGenProvider(): ProviderConfig {
  const envBaseURL = process.env.CARDMIND_AGENT_EVAL_BASE_URL
  const envApiKey = process.env.CARDMIND_AGENT_EVAL_API_KEY
  if (envBaseURL || envApiKey) {
    if (!envBaseURL || !envApiKey) {
      throw new Error('Both CARDMIND_AGENT_EVAL_BASE_URL and CARDMIND_AGENT_EVAL_API_KEY are required')
    }
    return validateProvider({
      baseURL: envBaseURL,
      apiKey: envApiKey,
    })
  }
  throw new Error('Live evaluation requires explicit CARDMIND_AGENT_EVAL_BASE_URL and CARDMIND_AGENT_EVAL_API_KEY values')
}

export class LiveModelPort implements AgentModelPort {
  private scenarioId = 'unassigned'
  private readonly client: OpenAI
  readonly endpointHost: string
  lastFailureKind?: 'provider' | 'budget'
  lastBudgetFailure?: 'scenario' | 'total'

  constructor(
    private readonly provider: ProviderConfig,
    readonly budget: LiveBudget,
    private readonly model = 'Qwen/Qwen3-8B',
    private readonly maxTokens = 256,
  ) {
    this.endpointHost = new URL(provider.baseURL).hostname
    this.client = new OpenAI({
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      maxRetries: 0,
      timeout: 30_000,
    })
  }

  setScenario(id: string) {
    this.scenarioId = id
  }

  async loadSettings(): Promise<AgentModelSettings> {
    return { model: this.model, baseURL: this.provider.baseURL, temperature: 0 }
  }

  async validateSettings() {
    return { ok: true }
  }

  async getSystemPrompt() {
    return DEFAULT_SYSTEM_PROMPT
  }

  private consumeBudget(probe = false) {
    const scenarioUsed = this.budget.byScenario.get(this.scenarioId) || 0
    if (this.budget.totalUsed >= this.budget.totalLimit) {
      this.lastFailureKind = 'budget'
      this.lastBudgetFailure = 'total'
      throw new Error('LIVE_MODEL_TOTAL_BUDGET_EXCEEDED')
    }
    if (!probe && scenarioUsed >= this.budget.perScenarioLimit) {
      this.lastFailureKind = 'budget'
      this.lastBudgetFailure = 'scenario'
      throw new Error('LIVE_MODEL_SCENARIO_BUDGET_EXCEEDED')
    }
    this.budget.totalUsed += 1
    if (probe) {
      this.budget.probeCalls += 1
    } else {
      this.budget.byScenario.set(this.scenarioId, scenarioUsed + 1)
    }
  }

  async createStream(request: AgentModelStreamRequest) {
    this.lastFailureKind = undefined
    this.lastBudgetFailure = undefined
    this.consumeBudget()
    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: request.messages,
        tools: request.tools,
        tool_choice: request.toolChoice,
        temperature: 0,
        max_tokens: this.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal: request.signal })
      const owner = this
      return (async function* trackedStream() {
        try {
          for await (const item of stream) yield item
        } catch (error) {
          if (!request.signal.aborted) owner.lastFailureKind = 'provider'
          throw error
        }
      })()
    } catch (error) {
      if (!request.signal.aborted) this.lastFailureKind = 'provider'
      throw error
    }
  }

  async probeFunctionCalling(signal: AbortSignal) {
    this.scenarioId = '__probe__'
    this.lastFailureKind = undefined
    this.lastBudgetFailure = undefined
    this.consumeBudget(true)
    const nonce = 'cardmind-function-probe-v1'
    let stream
    try {
      stream = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: `Call probe_echo exactly once with nonce ${nonce}.` }],
      tools: [{
        type: 'function',
        function: {
          name: 'probe_echo',
          description: 'No-side-effect function-calling compatibility probe.',
          parameters: {
            type: 'object',
            properties: { nonce: { type: 'string' } },
            required: ['nonce'],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'probe_echo' } },
      temperature: 0,
      max_tokens: this.maxTokens,
      stream: true,
      }, { signal })
    } catch (error) {
      if (!signal.aborted) this.lastFailureKind = 'provider'
      throw error
    }

    let name = ''
    let args = ''
    try {
      for await (const item of stream) {
        const delta = item.choices?.[0]?.delta
        for (const call of delta?.tool_calls || []) {
          name += call.function?.name || ''
          args += call.function?.arguments || ''
        }
      }
    } catch (error) {
      if (!signal.aborted) this.lastFailureKind = 'provider'
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(args)
    } catch {
      parsed = undefined
    }
    return name === 'probe_echo'
      && Boolean(parsed)
      && typeof parsed === 'object'
      && (parsed as Record<string, unknown>).nonce === nonce
  }

  formatError(error: unknown) {
    return safeError(error)
  }
}

export function createLiveBudget(totalLimit: number, perScenarioLimit: number): LiveBudget {
  return {
    totalLimit,
    perScenarioLimit,
    totalUsed: 0,
    probeCalls: 0,
    byScenario: new Map(),
  }
}
