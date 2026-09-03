import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EvalReport } from './types'
import { redactValue } from './redaction'

function percent(value: unknown) {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'n/a'
}

function reportStem(report: EvalReport) {
  return report.mode === 'replay' ? 'agent-eval-v1' : 'agent-live-smoke-v1'
}

function toMarkdown(report: EvalReport) {
  const lines = [
    `# CardMind Agent ${report.mode === 'replay' ? 'Replay Eval' : 'Live Smoke'} v1`,
    '',
    `- Status: ${report.passed ? 'PASS' : report.comparable ? 'FAIL' : 'NOT COMPARABLE'}`,
    `- Suite: \`${report.suite}\``,
    `- Mode/model: \`${report.mode}\` / \`${report.model}\``,
    `- Tested commit: \`${report.commit}\``,
    `- Working tree: ${report.workingTreeDirty ? 'DIRTY (not reproducible from commit alone)' : 'clean'}`,
    `- Generated: ${report.generatedAt}`,
    `- Exit code: ${report.exitCode}`,
    '',
    '## Metrics',
    '',
  ]

  if (report.mode === 'replay') {
    const guardrailDenominator = report.denominator.guardrailAssertions
      ?? report.metrics.guardrailAssertionCount
      ?? 0
    lines.push(
      `- Scenario pass: ${report.metrics.scenarioPassCount}/${report.denominator.scenarios} (${percent(report.metrics.scenarioPassRate)})`,
      `- Guardrail assertions: ${report.metrics.guardrailAssertionPassCount}/${guardrailDenominator} (${percent(report.metrics.guardrailAssertionPassRate)})`,
      `- Unexpected real executions: ${report.metrics.unexpectedRealExecutionCount}`,
      `- Production tool manifest: ${report.metrics.toolManifestCount ?? 'n/a'} tools`,
    )
  } else {
    lines.push(
      `- Routing accuracy: ${percent(report.metrics.routingAccuracy)}`,
      `- Task success: ${percent(report.metrics.taskSuccessRate)}`,
      `- Argument conformance: ${percent(report.metrics.argumentConformance)}`,
      `- Safety pass rate: ${percent(report.metrics.safetyPassRate)}`,
      `- Approval enforcement: ${percent(report.metrics.approvalEnforcement)}`,
      `- p50/p95 latency: ${report.metrics.p50LatencyMs ?? 'n/a'} / ${report.metrics.p95LatencyMs ?? 'n/a'} ms`,
      `- Token usage availability: ${percent(report.metrics.tokenUsageAvailability)}`,
      `- Unexpected real executions: ${report.metrics.unexpectedRealExecutionCount}`,
      `- Production tool manifest: ${report.metrics.toolManifestCount ?? 'n/a'} tools`,
    )
  }

  lines.push('', '## Scenarios', '')
  if (report.scenarios.length === 0) {
    lines.push('- No comparable scenarios ran.')
  } else {
    for (const scenario of report.scenarios) {
      lines.push(
        `- ${scenario.passed ? 'PASS' : 'FAIL'} \`${scenario.id}\`: ${scenario.outcome} / ${scenario.terminationReason}; requested [${scenario.requestedToolSequence.join(', ')}]; executed [${scenario.executedToolSequence.join(', ')}]`,
      )
    }
  }

  lines.push('', '## Failures', '')
  if (report.failures.length === 0) {
    lines.push('- None.')
  } else {
    for (const failure of report.failures) {
      lines.push(`- \`${failure.scenario}\` / \`${failure.assertion}\`: ${failure.details || 'assertion failed'}`)
    }
  }

  lines.push('', '## Evidence boundaries', '')
  for (const boundary of report.boundaries) {
    lines.push(`- ${boundary}`)
  }
  return lines.join('\n')
}

export function writeReport(report: EvalReport, outputDirectory?: string) {
  const directory = resolve(outputDirectory || resolve('docs', 'evidence'))
  mkdirSync(directory, { recursive: true })
  const stem = reportStem(report)
  const jsonPath = resolve(directory, `${stem}.json`)
  const markdownPath = resolve(directory, `${stem}.md`)
  const safeReport = redactValue(report) as EvalReport
  writeFileSync(jsonPath, `${JSON.stringify(safeReport, null, 2)}\n`, 'utf8')
  writeFileSync(markdownPath, `${toMarkdown(safeReport)}\n`, 'utf8')
  return { jsonPath, markdownPath }
}
