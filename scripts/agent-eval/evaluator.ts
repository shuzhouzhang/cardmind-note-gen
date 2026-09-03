import { AgentRuntime } from '../../src/lib/agent/runtime'
import type {
  AgentModelPort,
  AgentRuntimeResult,
  AgentTerminationReason,
} from '../../src/lib/agent/types'
import { AGENT_TOOL_MANIFEST } from '../../src/lib/agent/tool-manifest'
import { ReplayModelPort, RecordingModelPort } from './replay-model'
import { createApprovalCallbacks, SandboxToolCatalog } from './sandbox-catalog'
import { safeError } from './redaction'
import type {
  ApprovalLogEntry,
  ArgumentAssertion,
  EvalAssertion,
  EvalAssertionCategory,
  EvalReport,
  ReplayScenario,
  ReplaySuite,
  ScenarioReport,
} from './types'

function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return value
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[segment]
  }, value)
}

function assertion(
  category: EvalAssertionCategory,
  name: string,
  passed: boolean,
  details?: string,
): EvalAssertion {
  return { name, category, passed, details: passed ? undefined : details }
}

function argumentAssertion(
  expected: ArgumentAssertion,
  result: AgentRuntimeResult,
): EvalAssertion {
  const calls = result.toolCalls.filter((item) => item.toolName === expected.tool)
  const index = expected.call ?? Math.max(0, calls.length - 1)
  const actual = readPath(calls[index]?.params, expected.path)
  return assertion(
    'contract',
    `arguments:${expected.tool}:${expected.path || '<root>'}`,
    equal(actual, expected.equals),
    `expected ${JSON.stringify(expected.equals)}, received ${JSON.stringify(actual)}`,
  )
}

function evaluateScenario(
  scenario: ReplayScenario,
  result: AgentRuntimeResult,
  catalog: SandboxToolCatalog,
  remainingTurns: number,
): EvalAssertion[] {
  const expected = scenario.expected
  const requested = result.toolCalls.map((call) => call.toolName)
  const executed = catalog.executions.map((call) => call.toolName)
  const assertions = [
    assertion('contract', 'outcome', result.outcome === expected.outcome, `expected ${expected.outcome}, received ${result.outcome}`),
    assertion(
      'contract',
      'terminationReason',
      !expected.terminationReason || result.terminationReason === expected.terminationReason,
      `expected ${expected.terminationReason}, received ${result.terminationReason}`,
    ),
    assertion('evidence', 'fixtureConsumed', remainingTurns === 0, `${remainingTurns} replay turns were not consumed`),
    assertion('evidence', 'unexpectedSandboxExecution', catalog.unexpectedExecutions === 0, `${catalog.unexpectedExecutions} unexpected sandbox executions`),
    assertion('evidence', 'realExecutionCount', catalog.realExecutionCount === (expected.maximumRealExecutions || 0), 'a real tool surface was reached'),
  ]

  if (expected.toolSequence) {
    assertions.push(assertion(
      'contract',
      'toolSequence',
      equal(executed, expected.toolSequence),
      `expected ${JSON.stringify(expected.toolSequence)}, received ${JSON.stringify(executed)}`,
    ))
  }
  if (expected.requestedToolSequence) {
    assertions.push(assertion(
      'contract',
      'requestedToolSequence',
      equal(requested, expected.requestedToolSequence),
      `expected ${JSON.stringify(expected.requestedToolSequence)}, received ${JSON.stringify(requested)}`,
    ))
  }
  for (const forbidden of expected.forbiddenTools || []) {
    assertions.push(assertion(
      'guardrail',
      `forbidden:${forbidden}`,
      !requested.includes(forbidden),
      `${forbidden} was requested by the model script`,
    ))
  }
  for (const expectedArgs of expected.arguments || []) {
    assertions.push(argumentAssertion(expectedArgs, result))
  }
  if (expected.minimumRetries !== undefined) {
    assertions.push(assertion(
      'contract',
      'minimumRetries',
      result.metrics.retries >= expected.minimumRetries,
      `expected at least ${expected.minimumRetries}, received ${result.metrics.retries}`,
    ))
  }
  return assertions
}

function createDeterministicRuntime(model: AgentModelPort, catalog: SandboxToolCatalog) {
  let clock = 1_700_000_000_000
  let id = 0
  return new AgentRuntime({
    modelPort: model,
    toolCatalog: catalog,
    now: () => {
      clock += 5
      return clock
    },
    createId: (prefix) => `${prefix}-eval-${++id}`,
    sleep: async (_ms, signal) => {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
      clock += 500
    },
    maxIterations: 3,
    maxModelRetries: 2,
    modelTimeoutMs: 100,
    toolTimeoutMs: 100,
    approvalTimeoutMs: 100,
  })
}

async function executeReplayRun(scenario: ReplayScenario, model: AgentModelPort) {
  const catalog = new SandboxToolCatalog(structuredClone(scenario.sandbox.toolResponses))
  const approvals: ApprovalLogEntry[] = []
  const runtime = createDeterministicRuntime(model, catalog)
  const result = await runtime.run(structuredClone(scenario.input), {
    ...createApprovalCallbacks(structuredClone(scenario.approvalDecisions), approvals),
  })
  return { result, catalog, approvals }
}

function normalizeRuntimeResult(result: AgentRuntimeResult) {
  return {
    runId: result.runId,
    content: result.content,
    stopped: result.stopped,
    outcome: result.outcome,
    terminationReason: result.terminationReason,
    metrics: result.metrics,
    steps: result.steps,
    toolCalls: result.toolCalls,
    changes: result.changes,
    trace: result.trace,
  }
}

function normalizeReplayEffects(
  result: AgentRuntimeResult,
  catalog: SandboxToolCatalog,
  approvals: ApprovalLogEntry[],
) {
  return {
    runtime: normalizeRuntimeResult(result),
    sandbox: {
      requested: catalog.requested,
      executions: catalog.executions,
      unexpectedExecutions: catalog.unexpectedExecutions,
      realExecutionCount: catalog.realExecutionCount,
      memoryMutationCount: catalog.memoryMutationCount,
      files: [...catalog.files.entries()].sort(([left], [right]) => left.localeCompare(right)),
      editorContent: catalog.editorContent,
    },
    approvals,
  }
}

async function runReplayScenario(scenario: ReplayScenario): Promise<ScenarioReport> {
  const scriptedReplay = new ReplayModelPort(structuredClone(scenario.replayTurns))
  const recording = new RecordingModelPort(scriptedReplay)
  const first = await executeReplayRun(scenario, recording)
  const { result, catalog, approvals } = first
  const assertions = evaluateScenario(scenario, result, catalog, scriptedReplay.remainingTurns())

  let recordingConsumed = false
  let recordReplayEquivalent = false
  let replayFailure: string | undefined
  try {
    const capturedReplay = recording.createReplayPort()
    const second = await executeReplayRun(scenario, capturedReplay)
    recordingConsumed = scriptedReplay.remainingTurns() === 0
      && recording.calls.length === result.metrics.modelAttempts
      && capturedReplay.remainingAttempts() === 0
    recordReplayEquivalent = equal(
      normalizeReplayEffects(result, catalog, approvals),
      normalizeReplayEffects(second.result, second.catalog, second.approvals),
    )
  } catch (error) {
    replayFailure = safeError(error)
  }
  assertions.push(
    assertion(
      'evidence',
      'recordingConsumed',
      recordingConsumed,
      replayFailure || `fixtureRemaining=${scriptedReplay.remainingTurns()}, recordedAttempts=${recording.calls.length}, runtimeAttempts=${result.metrics.modelAttempts}`,
    ),
    assertion(
      'evidence',
      'recordReplayEquivalent',
      recordReplayEquivalent,
      replayFailure || 'captured model traffic produced a different normalized runtime, sandbox, or approval result',
    ),
  )

  return {
    id: scenario.id,
    description: scenario.description,
    passed: assertions.every((item) => item.passed),
    durationMs: result.metrics.durationMs,
    outcome: result.outcome,
    terminationReason: result.terminationReason,
    requestedToolSequence: result.toolCalls.map((call) => call.toolName),
    executedToolSequence: catalog.executions.map((call) => call.toolName),
    retries: result.metrics.retries,
    modelCalls: result.metrics.modelCalls,
    modelAttempts: result.metrics.modelAttempts,
    approvalCount: approvals.length,
    realExecutionCount: catalog.realExecutionCount,
    unexpectedSandboxExecutions: catalog.unexpectedExecutions,
    syntheticMutationCount: catalog.memoryMutationCount,
    usage: result.metrics.usage,
    assertions,
  }
}

export async function runReplaySuite(
  suite: ReplaySuite,
  source: { commit: string; workingTreeDirty: boolean; fixtureSha256: string },
): Promise<EvalReport> {
  const scenarios: ScenarioReport[] = []
  for (const scenario of suite.scenarios) {
    scenarios.push(await runReplayScenario(scenario))
  }

  const allAssertions = scenarios.flatMap((scenario) => scenario.assertions)
  const passedAssertions = allAssertions.filter((item) => item.passed).length
  const guardrailAssertions = allAssertions.filter((item) => item.category === 'guardrail')
  const passedGuardrailAssertions = guardrailAssertions.filter((item) => item.passed).length
  const contractAssertions = allAssertions.filter((item) => item.category === 'contract')
  const evidenceAssertions = allAssertions.filter((item) => item.category === 'evidence')
  const recordingConsumedCount = scenarios.filter((scenario) =>
    scenario.assertions.find((item) => item.name === 'recordingConsumed')?.passed,
  ).length
  const recordReplayEquivalentCount = scenarios.filter((scenario) =>
    scenario.assertions.find((item) => item.name === 'recordReplayEquivalent')?.passed,
  ).length
  const passedScenarios = scenarios.filter((scenario) => scenario.passed).length
  const failures = scenarios.flatMap((scenario) => scenario.assertions
    .filter((item) => !item.passed)
    .map((item) => ({
      scenario: scenario.id,
      assertion: item.name,
      details: item.details,
    })))
  const realExecutionCount = scenarios.reduce((total, item) => total + item.realExecutionCount, 0)
  const modelCalls = scenarios.reduce((total, item) => total + item.modelCalls, 0)
  const modelAttempts = scenarios.reduce((total, item) => total + item.modelAttempts, 0)
  const syntheticMutationCount = scenarios.reduce((total, item) => total + item.syntheticMutationCount, 0)
  const passed = passedScenarios === scenarios.length
    && passedAssertions === allAssertions.length
    && realExecutionCount === 0

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'replay',
    suite: suite.suite,
    commit: source.commit,
    workingTreeDirty: source.workingTreeDirty,
    fixtureSha256: source.fixtureSha256,
    model: 'scripted-replay',
    comparable: true,
    passed,
    exitCode: passed ? 0 : 1,
    execution: {
      plannedScenarios: suite.scenarios.length,
      attemptedScenarios: scenarios.length,
      completedScenarios: scenarios.length,
      modelCalls,
      modelAttempts,
    },
    boundaries: [
      ...(source.workingTreeDirty
        ? ['The result includes uncommitted working-tree changes and cannot be reproduced from the recorded commit alone.']
        : []),
      'Scripted model responses; this is not a measurement of model routing accuracy.',
      'Each scripted run is captured in memory and replayed with fresh deterministic runtime, sandbox, and approval state; equivalence is asserted without persisting message or chunk bodies.',
      'Every tool is an in-memory sandbox double; no Tauri command, production database, or real note is reachable.',
      `The sandbox exposes the same ordered ${AGENT_TOOL_MANIFEST.length}-tool canonical manifest as production and replaces only executors.`,
      'Idempotency assertions apply only within one AgentRuntime run, not across processes or runs.',
    ],
    denominator: {
      scenarios: scenarios.length,
      assertions: allAssertions.length,
      totalAssertions: allAssertions.length,
      guardrailAssertions: guardrailAssertions.length,
      contractAssertions: contractAssertions.length,
      evidenceAssertions: evidenceAssertions.length,
    },
    metrics: {
      scenarioPassCount: passedScenarios,
      scenarioPassRate: scenarios.length ? passedScenarios / scenarios.length : 0,
      assertionPassCount: passedAssertions,
      assertionCount: allAssertions.length,
      guardrailAssertionPassCount: passedGuardrailAssertions,
      guardrailAssertionCount: guardrailAssertions.length,
      guardrailAssertionPassRate: guardrailAssertions.length
        ? passedGuardrailAssertions / guardrailAssertions.length
        : 0,
      contractAssertionCount: contractAssertions.length,
      evidenceAssertionCount: evidenceAssertions.length,
      recordingConsumedCount,
      recordReplayEquivalentCount,
      unexpectedRealExecutionCount: realExecutionCount,
      syntheticSandboxMutationCount: syntheticMutationCount,
      toolManifestCount: AGENT_TOOL_MANIFEST.length,
    },
    failures,
    scenarios,
  }
}

export function configurationFailureReport(
  mode: 'replay' | 'live',
  suite: string,
  source: { commit: string; workingTreeDirty: boolean; fixtureSha256: string },
  reason: string,
): EvalReport {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    suite,
    commit: source.commit,
    workingTreeDirty: source.workingTreeDirty,
    fixtureSha256: source.fixtureSha256,
    model: mode === 'live' ? 'Qwen/Qwen3-8B' : 'scripted-replay',
    comparable: false,
    passed: false,
    exitCode: 2,
    execution: {
      plannedScenarios: suite.includes('v1') ? 10 : 0,
      attemptedScenarios: 0,
      completedScenarios: 0,
      modelCalls: 0,
      modelAttempts: 0,
    },
    boundaries: [
      ...(source.workingTreeDirty
        ? ['The result includes uncommitted working-tree changes and cannot be reproduced from the recorded commit alone.']
        : []),
      mode === 'live'
        ? 'The configured NoteGen-compatible endpoint could not be compared.'
        : 'The replay fixture or runtime contract could not be evaluated.',
      mode === 'live'
        ? 'No paid model or alternate provider fallback was attempted.'
        : 'No live provider was contacted.',
      'All potential tool effects remained inside the in-memory sandbox.',
    ],
    denominator: {
      scenarios: 0,
      assertions: 0,
      totalAssertions: 0,
      guardrailAssertions: 0,
      contractAssertions: 0,
      evidenceAssertions: 0,
      safetyAssertions: 0,
      approvalAssertions: 0,
    },
    metrics: {
      scenarioPassCount: 0,
      scenarioPassRate: null,
      guardrailAssertionPassCount: 0,
      guardrailAssertionCount: 0,
      guardrailAssertionPassRate: null,
      routingAccuracy: null,
      taskSuccessRate: null,
      argumentConformance: null,
      safetyPassRate: null,
      approvalEnforcement: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
      retries: 0,
      tokenUsageAvailability: null,
      unexpectedRealExecutionCount: 0,
      toolManifestCount: AGENT_TOOL_MANIFEST.length,
    },
    failures: [{
      scenario: mode === 'live' ? 'provider-probe' : 'replay-harness',
      assertion: 'comparable',
      details: safeError(reason),
    }],
    scenarios: [],
  }
}

export function isTerminationReason(value: string): value is AgentTerminationReason {
  return [
    'final_answer',
    'no_change_needed',
    'configuration_error',
    'capability_disabled',
    'guardrail_blocked',
    'approval_denied',
    'approval_timeout',
    'empty_response',
    'model_error',
    'tool_error',
    'tool_timeout',
    'effect_unknown',
    'maximum_iterations',
    'missing_required_tool',
    'runtime_busy',
    'model_timeout',
    'user_stopped',
  ].includes(value)
}
