import type OpenAI from 'openai'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export interface JsonSchema {
  type?: string | string[]
  description?: string
  const?: JsonPrimitive
  enum?: JsonPrimitive[]
  oneOf?: JsonSchema[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minItems?: number
  additionalProperties?: boolean | JsonSchema
  minLength?: number
  pattern?: string
  default?: JsonValue
}

export type AgentToolCategory =
  | 'editor'
  | 'note'
  | 'folder'
  | 'tag'
  | 'mark'
  | 'chat'
  | 'memory'
  | 'skill'
  | 'mcp'
  | 'system'

export type AgentToolRisk =
  | 'read'
  | 'editor-write'
  | 'file-create'
  | 'file-update'
  | 'delete'
  | 'script'
  | 'external'
  | 'medium'

export interface AgentContextSnapshot {
  activeChatId?: number
  activeFilePath?: string
  userInput: string
  currentQuote?: AgentQuoteSnapshot
  availableSkills?: AgentSkillSummary[]
  selectedMcpServerIds?: string[]
}

export interface AgentQuoteSnapshot {
  fileName: string
  startLine: number
  endLine: number
  from: number
  to: number
  fullContent?: string
}

export interface AgentSkillSummary {
  id: string
  name: string
  description?: string
}

export interface AgentToolExecutionContext {
  signal: AbortSignal
  runId: string
  toolCallId: string
  operationKey: string
  attempt: number
  context: AgentContextSnapshot
}

export interface AgentChange {
  id: string
  type: 'editor' | 'file' | 'tag' | 'mark' | 'memory' | 'chat' | 'folder'
  target: string
  before?: string
  after?: string
  reversible: boolean
  summary?: string
}

export interface AgentToolResult {
  ok: boolean
  message: string
  data?: unknown
  error?: string
  effectStatus?: 'none' | 'applied' | 'unknown'
  changes?: AgentChange[]
}

export interface AgentTool {
  name: string
  title: string
  description: string
  category: AgentToolCategory
  risk: AgentToolRisk
  inputSchema: JsonSchema
  execute: (
    input: Record<string, unknown>,
    context: AgentToolExecutionContext
  ) => Promise<AgentToolResult>
  legacyName?: string
}

export type AgentRunStatus =
  | 'idle'
  | 'preparing_context'
  | 'thinking'
  | 'calling_tool'
  | 'waiting_approval'
  | 'applying_change'
  | 'recovering'
  | 'completed'
  | 'stopped'
  | 'failed'

export interface AgentTraceEvent {
  schemaVersion?: 1
  id: string
  runId: string
  type:
    | 'model_call'
    | 'model_response'
    | 'tool_call'
    | 'tool_result'
    | 'approval'
    | 'change'
    | 'error'
    | 'final'
  title: string
  status: 'pending' | 'running' | 'success' | 'error'
  timestamp: number
  duration?: number
  iteration?: number
  attempt?: number
  usage?: AgentModelUsage
  terminationReason?: AgentTerminationReason
  toolName?: string
  input?: Record<string, unknown>
  output?: unknown
  message?: string
}

export interface AgentApprovalRequest {
  id: string
  runId: string
  toolName: string
  title: string
  risk: AgentToolRisk
  params: Record<string, unknown>
  target: string
  operationKey: string
  approvalScopeKey: string
  previewParams?: Record<string, unknown>
  originalContent?: string
  modifiedContent?: string
  filePath?: string
  canApproveForSession?: boolean
}

export interface AgentApprovalDecision {
  approved: boolean
  scope?: 'once' | 'session'
  reason?: 'approved' | 'denied' | 'timeout' | 'aborted'
}

export interface AgentRuntimeInput {
  userInput: string
  messages?: OpenAI.Chat.ChatCompletionMessageParam[]
  imageUrls?: string[]
  activeChatId?: number
  activeFilePath?: string
  currentQuote?: AgentQuoteSnapshot
  availableSkills?: AgentSkillSummary[]
}

export interface AgentRuntimeCallbacks {
  onStatus?: (status: AgentRunStatus) => void
  onTrace?: (event: AgentTraceEvent) => void
  onToolCall?: (toolCall: ToolCall) => void
  onChange?: (change: AgentChange) => void
  onStep?: (step: AgentStep) => void
  onCandidateAnswerRender?: (markdownContent: string) => void
  onCandidateAnswerClear?: () => void
  onFinalAnswerRender?: (markdownContent: string) => void
  requestConfirmation?: (
    request: AgentApprovalRequest,
    signal: AbortSignal
  ) => Promise<AgentApprovalDecision>
}

export interface AgentModelUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface AgentModelSettings {
  model: string
  baseURL?: string
  temperature?: number
  topP?: number
  raw?: unknown
}

export interface AgentModelValidation {
  ok: boolean
  reason?: string
}

export interface AgentModelStreamRequest {
  settings: AgentModelSettings
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  tools: OpenAI.Chat.ChatCompletionTool[]
  toolChoice: OpenAI.Chat.ChatCompletionToolChoiceOption
  iteration: number
  attempt: number
  signal: AbortSignal
}

/** Production, fake, record and replay models all implement this small port. */
export interface AgentModelPort {
  loadSettings: () => Promise<AgentModelSettings | null | undefined>
  validateSettings?: (settings: AgentModelSettings) => Promise<AgentModelValidation>
  getSystemPrompt: () => Promise<string>
  createStream: (
    request: AgentModelStreamRequest
  ) => Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>
  formatError?: (error: unknown) => string
}

/** A run receives an explicit catalog instead of reaching into the global registry. */
export interface AgentToolCatalog {
  listTools: () => AgentTool[]
  getTool: (name: string) => AgentTool | undefined
  toOpenAITools: () => OpenAI.Chat.ChatCompletionTool[]
}

export interface AgentRuntimeDependencies {
  modelPort: AgentModelPort
  toolCatalog: AgentToolCatalog
  now: () => number
  createId: (prefix: string) => string
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  maxIterations: number
  maxModelRetries: number
  modelTimeoutMs: number
  toolTimeoutMs: number
  approvalTimeoutMs: number
  prepareMessages: (
    messages: OpenAI.Chat.ChatCompletionMessageParam[]
  ) => OpenAI.Chat.ChatCompletionMessageParam[]
  buildCurrentUserMessage: (
    text: string,
    imageUrls?: string[]
  ) => Promise<OpenAI.Chat.ChatCompletionMessageParam>
  assemblePrompt: (
    context: AgentContextSnapshot,
    tools: AgentTool[],
    basePrompt: string
  ) => string
}

export type AgentRuntimeOutcome = 'success' | 'partial' | 'failed' | 'stopped'

export type AgentTerminationReason =
  | 'final_answer'
  | 'no_change_needed'
  | 'configuration_error'
  | 'capability_disabled'
  | 'guardrail_blocked'
  | 'approval_denied'
  | 'approval_timeout'
  | 'empty_response'
  | 'model_error'
  | 'model_timeout'
  | 'tool_error'
  | 'tool_timeout'
  | 'effect_unknown'
  | 'maximum_iterations'
  | 'missing_required_tool'
  | 'runtime_busy'
  | 'user_stopped'

export interface AgentRunMetrics {
  startedAt: number
  completedAt: number
  durationMs: number
  currentIteration: number
  iterations: number
  modelCalls: number
  modelAttempts: number
  retries: number
  toolCalls: number
  successfulTools: number
  failedTools: number
  deduplicatedTools: number
  effectUnknownCount: number
  usageAvailable: boolean
  usage?: AgentModelUsage
}

export interface AgentRuntimeResult {
  runId: string
  content: string
  stopped: boolean
  outcome: AgentRuntimeOutcome
  terminationReason: AgentTerminationReason
  metrics: AgentRunMetrics
  steps: AgentStep[]
  toolCalls: ToolCall[]
  changes: AgentChange[]
  trace: AgentTraceEvent[]
}

// Compatibility types kept for existing store/UI while the runtime is rewritten.
export type ToolParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object'

export interface ToolParameter {
  name: string
  type: ToolParameterType
  description: string
  required: boolean
  default?: any
}

export interface Tool {
  name: string
  description: string
  parameters: ToolParameter[]
  requiresConfirmation: boolean
  category: 'note' | 'chat' | 'tag' | 'mark' | 'search' | 'mcp' | 'system' | 'editor'
  execute: (params: Record<string, any>) => Promise<ToolResult>
}

export interface ToolResult {
  success: boolean
  data?: any
  error?: string
  message?: string
  effectStatus?: 'none' | 'applied' | 'unknown'
}

export interface ToolCall {
  id: string
  toolName: string
  params: Record<string, any>
  result?: ToolResult
  status: 'pending' | 'running' | 'success' | 'error'
  timestamp: number
}

export interface ConfirmationRecord {
  toolName: string
  params: Record<string, any>
  status: 'pending' | 'confirmed' | 'cancelled'
  timestamp: number
  scope?: 'once' | 'session'
}

export interface AgentState {
  activeChatId?: number
  runId?: string
  status?: AgentRunStatus
  isRunning: boolean
  isThinking: boolean
  currentThought: string
  thoughtHistory: string[]
  completedSteps: AgentStep[]
  currentAction?: string
  currentObservation?: string
  toolCalls: ToolCall[]
  traceEvents?: AgentTraceEvent[]
  changes?: AgentChange[]
  maxIterations: number
  currentIteration: number
  pendingConfirmation?: {
    toolName: string
    params: Record<string, any>
    previewParams?: Record<string, any>
    originalContent?: string
    modifiedContent?: string
    filePath?: string
    canApproveForSession?: boolean
  }
  confirmationHistory: ConfirmationRecord[]
  loadedSkills?: AgentSkillSummary[]
  selectedSkills?: string[]
  currentStepStartTime?: number
  ragSources?: string[]
  ragSourceDetails?: Array<{
    filepath: string
    filename: string
    content: string
  }>
  isFinalAnswerMode?: boolean
  finalAnswerContent?: string
}

export interface AgentStep {
  thought: string
  action?: {
    tool: string
    params: Record<string, any>
  }
  observation?: string
  duration?: number
}

export type ReActStep = AgentStep
