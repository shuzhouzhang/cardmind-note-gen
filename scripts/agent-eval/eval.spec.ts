import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { isTerminationReason, runReplaySuite } from './evaluator'
import { loadLiveSuite, loadReplaySuite } from './fixture-loader'
import { createLiveBudget, loadNoteGenProvider } from './live-model'
import { RecordingModelPort, ReplayModelPort } from './replay-model'
import { redactValue, safeError } from './redaction'
import { writeReport } from './reporter'
import { writeResumeDrafts } from './resume-writer'

test('loads the two schemaVersion 1 suites with ten unique scenarios', () => {
  const replay = loadReplaySuite('reliability-v1')
  const live = loadLiveSuite('live-smoke-v1')
  assert.equal(replay.schemaVersion, 1)
  assert.equal(live.schemaVersion, 1)
  assert.equal(replay.scenarios.length, 10)
  assert.equal(live.scenarios.length, 10)
  assert.equal(new Set(replay.scenarios.map((item) => item.id)).size, 10)
  assert.equal(new Set(live.scenarios.map((item) => item.id)).size, 10)
})

test('redacts nested credential keys and token-shaped strings', () => {
  const token = ['sk', 'synthetic', '0123456789abcdefghij'].join('-')
  const result = redactValue({
    apiKey: token,
    nested: { message: `Authorization: ${['Bearer', 'synthetic-token-value-12345'].join(' ')}` },
  }) as Record<string, unknown>
  assert.equal(result.apiKey, '[REDACTED]')
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token-value/)
  assert.doesNotMatch(safeError(new Error(token)), /0123456789abcdefghij/)
})

test('live provider configuration is explicit environment only', () => {
  const previousBase = process.env.CARDMIND_AGENT_EVAL_BASE_URL
  const previousKey = process.env.CARDMIND_AGENT_EVAL_API_KEY
  delete process.env.CARDMIND_AGENT_EVAL_BASE_URL
  delete process.env.CARDMIND_AGENT_EVAL_API_KEY
  try {
    assert.throws(() => loadNoteGenProvider(), /explicit/)
  } finally {
    if (previousBase === undefined) delete process.env.CARDMIND_AGENT_EVAL_BASE_URL
    else process.env.CARDMIND_AGENT_EVAL_BASE_URL = previousBase
    if (previousKey === undefined) delete process.env.CARDMIND_AGENT_EVAL_API_KEY
    else process.env.CARDMIND_AGENT_EVAL_API_KEY = previousKey
  }
})

test('live budget starts at zero and keeps the configured hard limits', () => {
  const budget = createLiveBudget(30, 3)
  assert.equal(budget.totalUsed, 0)
  assert.equal(budget.probeCalls, 0)
  assert.equal(budget.totalLimit, 30)
  assert.equal(budget.perScenarioLimit, 3)
})

test('recording model captures create and stream failures but exposes metadata only', async () => {
  const recording = new RecordingModelPort(new ReplayModelPort([
    { createError: 'SYNTHETIC_CREATE_FAILURE' },
    { content: 'internal-answer-body', streamErrorAfterChunks: 1 },
  ]))
  const settings = await recording.loadSettings()
  assert.ok(settings)
  assert.deepEqual(await recording.validateSettings(settings), { ok: true })
  await recording.getSystemPrompt()

  const request = (attempt: number) => ({
    settings,
    messages: [{ role: 'user' as const, content: 'secret-user-body' }],
    tools: [],
    toolChoice: 'auto' as const,
    iteration: 1,
    attempt,
    signal: new AbortController().signal,
  })

  await assert.rejects(recording.createStream(request(1)), /SYNTHETIC_CREATE_FAILURE/)
  const streamed: string[] = []
  const stream = await recording.createStream(request(2))
  await assert.rejects(async () => {
    for await (const item of stream) {
      streamed.push(item.choices?.[0]?.delta?.content || '')
    }
  }, /REPLAY_STREAM_INTERRUPTED/)
  assert.deepEqual(streamed, ['internal-answer-body'])
  assert.equal(recording.calls[0].errorPhase, 'create')
  assert.equal(recording.calls[1].errorPhase, 'stream')
  assert.equal(recording.calls.every((call) => call.completed), true)
  assert.doesNotMatch(JSON.stringify(recording.calls), /secret-user-body|internal-answer-body/)

  const capturedReplay = recording.createReplayPort()
  await assert.rejects(capturedReplay.createStream(request(1)), /SYNTHETIC_CREATE_FAILURE/)
  const replayed: string[] = []
  const replayedStream = await capturedReplay.createStream(request(2))
  await assert.rejects(async () => {
    for await (const item of replayedStream) {
      replayed.push(item.choices?.[0]?.delta?.content || '')
    }
  }, /REPLAY_STREAM_INTERRUPTED/)
  assert.deepEqual(replayed, streamed)
  assert.equal(capturedReplay.remainingAttempts(), 0)

  const mismatchReplay = recording.createReplayPort()
  await assert.rejects(mismatchReplay.createStream({
    ...request(1),
    messages: [{ role: 'user', content: 'different-request-body' }],
  }), /RECORDED_REPLAY_REQUEST_MISMATCH/)
})

test('recording refuses to replay a stream that was never fully consumed', async () => {
  const recording = new RecordingModelPort(new ReplayModelPort([{ content: 'not-consumed' }]))
  const settings = await recording.loadSettings()
  assert.ok(settings)
  await recording.validateSettings(settings)
  await recording.getSystemPrompt()
  await recording.createStream({
    settings,
    messages: [{ role: 'user', content: 'request' }],
    tools: [],
    toolChoice: 'auto',
    iteration: 1,
    attempt: 1,
    signal: new AbortController().signal,
  })
  assert.throws(() => recording.createReplayPort(), /RECORDING_INCOMPLETE/)
})

test('termination reason validation includes timeout and concurrent-runtime outcomes', () => {
  assert.equal(isTerminationReason('model_timeout'), true)
  assert.equal(isTerminationReason('runtime_busy'), true)
  assert.equal(isTerminationReason('not-a-runtime-reason'), false)
})

test('CLI writes a non-comparable report and exits 2 when live configuration is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'cardmind-agent-cli-config-'))
  try {
    const env = { ...process.env }
    delete env.CARDMIND_AGENT_EVAL_LIVE
    delete env.CARDMIND_AGENT_EVAL_BASE_URL
    delete env.CARDMIND_AGENT_EVAL_API_KEY
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'scripts/agent-eval/cli.ts',
      '--mode',
      'live',
      '--provider',
      'notegen-free',
      '--suite',
      'live-smoke-v1',
      '--allow-network',
      '--output-dir',
      root,
    ], { cwd: process.cwd(), env, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 2, result.stderr)
    const report = JSON.parse(readFileSync(join(root, 'agent-live-smoke-v1.json'), 'utf8'))
    assert.equal(report.exitCode, 2)
    assert.equal(report.comparable, false)
    assert.equal(report.passed, false)
    assert.equal(report.scenarios.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI converts evidence output failures to exit 2 without an unhandled stack', () => {
  const root = mkdtempSync(join(tmpdir(), 'cardmind-agent-cli-output-'))
  const fileInsteadOfDirectory = join(root, 'not-a-directory')
  writeFileSync(fileInsteadOfDirectory, 'sentinel', 'utf8')
  try {
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'scripts/agent-eval/cli.ts',
      '--mode',
      'replay',
      '--suite',
      'reliability-v1',
      '--output-dir',
      fileInsteadOfDirectory,
    ], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /unable to write evidence report/)
    assert.doesNotMatch(result.stderr, /\n\s+at\s/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('replay suite passes only through injected model and sandbox tools', async () => {
  const report = await runReplaySuite(loadReplaySuite('reliability-v1'), {
    commit: '0123456789abcdef',
    workingTreeDirty: false,
    fixtureSha256: 'a'.repeat(64),
  })
  assert.equal(report.passed, true)
  assert.equal(report.exitCode, 0)
  assert.equal(report.metrics.scenarioPassCount, 10)
  assert.equal(report.metrics.unexpectedRealExecutionCount, 0)
  assert.equal(report.metrics.recordingConsumedCount, 10)
  assert.equal(report.metrics.recordReplayEquivalentCount, 10)
  assert.equal(report.scenarios.every((scenario) => scenario.passed), true)
  assert.equal(report.scenarios.every((scenario) =>
    scenario.assertions.find((item) => item.name === 'recordingConsumed')?.passed === true
    && scenario.assertions.find((item) => item.name === 'recordReplayEquivalent')?.passed === true
  ), true)
  assert.equal(report.scenarios.flatMap((scenario) => scenario.assertions)
    .every((item) => ['contract', 'guardrail', 'evidence'].includes(item.category)), true)
  assert.equal(report.scenarios.flatMap((scenario) => scenario.assertions)
    .filter((item) => item.name.startsWith('arguments:'))
    .every((item) => item.category === 'contract'), true)
  assert.equal(report.denominator.guardrailAssertions, report.metrics.guardrailAssertionCount)
  assert.equal(report.denominator.assertions, report.metrics.assertionCount)
  assert.equal(report.denominator.totalAssertions, report.metrics.assertionCount)
})

test('report and resume writers persist only evidence-backed summaries', async () => {
  const report = await runReplaySuite(loadReplaySuite('reliability-v1'), {
    commit: '0123456789abcdef',
    workingTreeDirty: false,
    fixtureSha256: 'b'.repeat(64),
  })
  const root = mkdtempSync(join(tmpdir(), 'cardmind-agent-eval-'))
  try {
    const reports = writeReport(report, join(root, 'evidence'))
    const resumes = writeResumeDrafts(report, join(root, 'resume'))
    const json = readFileSync(reports.jsonPath, 'utf8')
    const markdown = readFileSync(reports.markdownPath, 'utf8')
    const agentResume = readFileSync(resumes.agentPath, 'utf8')
    const systemsResume = readFileSync(resumes.systemsPath, 'utf8')
    assert.match(json, /"unexpectedRealExecutionCount": 0/)
    assert.equal(markdown.endsWith('\n'), true)
    assert.equal(markdown.endsWith('\n\n'), false)
    assert.match(agentResume, /基于开源 NoteGen/)
    assert.match(agentResume, /10\/10/)
    assert.match(systemsResume, /Tauri\/Rust/)
    assert.match(agentResume, new RegExp(`${report.metrics.guardrailAssertionPassCount}/${report.denominator.guardrailAssertions}`))
    assert.doesNotMatch(systemsResume, /30 秒/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
