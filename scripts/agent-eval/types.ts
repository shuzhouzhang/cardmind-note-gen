import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentChange,
  AgentModelUsage,
  AgentRuntimeInput,
  AgentRuntimeOutcome,
  AgentTerminationReason,
  AgentToolResult,
} from '../../src/lib/agent/types'

export interface ReplayToolCall {
  id: string
  name: string
  arguments: Record<string, unknown> | string
}

export interface ReplayTurn {
  content?: string
  toolCalls?: ReplayToolCall[]
  fragmentToolCalls?: boolean
  usage?: AgentModelUsage
  createError?: string
  streamErrorAfterChunks?: number
}

export interface SandboxToolResponse extends AgentToolResult {
  throw?: string
  delayMs?: number
}

export interface ApprovalFixture extends AgentApprovalDecision {
  toolName?: string
  target?: string
}

export interface ArgumentAssertion {
  tool: string
  call?: number
  path: string
  equals: unknown
}

export interface ReplayExpectation {
  outcome: AgentRuntimeOutcome
  terminationReason?: AgentTerminationReason
  toolSequence?: string[]
  requestedToolSequence?: string[]
  forbiddenTools?: string[]
  arguments?: ArgumentAssertion[]
  minimumRetries?: number
  maximumRealExecutions?: number
}

export interface ReplayScenario {
  id: string
  description: string
  input: AgentRuntimeInput
  replayTurns: ReplayTurn[]
  sandbox: {
    toolResponses: Record<string, SandboxToolResponse[]>
  }
  approvalDecisions: ApprovalFixture[]
  expected: ReplayExpectation
}

export interface ReplaySuite {
  schemaVersion: 1
  suite: 'reliability-v1'
  mode: 'replay'
  scenarios: ReplayScenario[]
}

export type EvalAssertionCategory = 'contract' | 'guardrail' | 'evidence'

export interface EvalAssertion {
  name: string
  category: EvalAssertionCategory
  passed: boolean
  details?: string
}

export interface ScenarioReport {
  id: string
  description: string
  passed: boolean
  durationMs: number
  outcome: AgentRuntimeOutcome
  terminationReason: AgentTerminationReason
  requestedToolSequence: string[]
  executedToolSequence: string[]
  retries: number
  modelCalls: number
  modelAttempts: number
  approvalCount: number
  realExecutionCount: number
  unexpectedSandboxExecutions: number
  syntheticMutationCount: number
  usage?: AgentModelUsage
  assertions: EvalAssertion[]
}

export interface LiveToolCallExpectation {
  tool: string
  arguments?: ArgumentAssertion[]
}

export interface LiveScenario {
  id: string
  description: string
  input: AgentRuntimeInput
  sandbox: {
    toolResponses: Record<string, SandboxToolResponse[]>
  }
  approvalDecisions: ApprovalFixture[]
  expected: {
    route: string[]
    arguments?: ArgumentAssertion[]
    forbiddenTools?: string[]
    safety?: boolean
    approval?: boolean
  }
}

export interface LiveSuite {
  schemaVersion: 1
  suite: 'live-smoke-v1'
  mode: 'live'
  model: 'Qwen/Qwen3-8B'
  temperature: 0
  maxOutputTokensPerCall: 256
  maxModelCallsPerScenario: 3
  maxModelCallsTotal: 30
  scenarios: LiveScenario[]
}

export interface EvalReport {
  schemaVersion: 1
  generatedAt: string
  mode: 'replay' | 'live'
  suite: string
  commit: string
  workingTreeDirty: boolean
  fixtureSha256: string
  model: string
  provider?: {
    id: string
    endpointHost: string
  }
  comparable: boolean
  passed: boolean
  exitCode: 0 | 1 | 2 | 130
  execution: {
    plannedScenarios: number
    attemptedScenarios: number
    completedScenarios: number
    modelCalls: number
    modelAttempts: number
  }
  boundaries: string[]
  denominator: {
    scenarios: number
    assertions: number
    totalAssertions?: number
    guardrailAssertions?: number
    contractAssertions?: number
    evidenceAssertions?: number
    safetyAssertions?: number
    approvalAssertions?: number
  }
  metrics: Record<string, number | boolean | null>
  failures: Array<{ scenario: string; assertion: string; details?: string }>
  scenarios: ScenarioReport[]
}

export interface ApprovalLogEntry {
  request: AgentApprovalRequest
  decision: AgentApprovalDecision
}

export interface SandboxExecution {
  toolName: string
  args: Record<string, unknown>
  operationKey: string
  toolCallId: string
  result?: AgentToolResult
  changes?: AgentChange[]
}
