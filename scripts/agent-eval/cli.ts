#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { configurationFailureReport, runReplaySuite } from './evaluator'
import { loadLiveSuite, loadReplaySuite } from './fixture-loader'
import { runLiveSuite } from './live-evaluator'
import { createLiveBudget, LiveModelPort, loadNoteGenProvider } from './live-model'
import { safeError } from './redaction'
import { writeReport } from './reporter'
import { writeResumeDrafts } from './resume-writer'
import type { EvalReport } from './types'

interface Options {
  mode?: 'replay' | 'live'
  suite?: string
  provider?: string
  outputDirectory?: string
  allowNetwork: boolean
  writeResume: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = { allowNetwork: false, writeResume: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if ((arg === 'replay' || arg === 'live') && !options.mode) {
      options.mode = arg
      continue
    }
    if (arg === '--allow-network') {
      options.allowNetwork = true
      continue
    }
    if (arg === '--write-resume') {
      options.writeResume = true
      continue
    }
    const value = argv[index + 1]
    if (arg === '--mode' && (value === 'replay' || value === 'live')) {
      options.mode = value
      index += 1
    } else if (arg === '--suite' && value) {
      options.suite = value
      index += 1
    } else if (arg === '--provider' && value) {
      options.provider = value
      index += 1
    } else if (arg === '--output-dir' && value) {
      options.outputDirectory = value
      index += 1
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }
  if (!options.mode) throw new Error('--mode must be replay or live')
  options.suite ||= options.mode === 'replay' ? 'reliability-v1' : 'live-smoke-v1'
  return options
}

function gitValue(args: string[]) {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) return ''
  return result.stdout.trim()
}

function fixturePath(mode: 'replay' | 'live') {
  return resolve('fixtures', 'agent', mode === 'replay' ? 'reliability-v1.json' : 'live-smoke-v1.json')
}

function sourceEvidence(mode: 'replay' | 'live') {
  const path = fixturePath(mode)
  const commit = gitValue(['rev-parse', 'HEAD']) || 'unknown'
  const dirty = Boolean(gitValue(['status', '--porcelain', '--untracked-files=normal']))
  return {
    commit,
    workingTreeDirty: dirty,
    fixtureSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

function printSummary(report: EvalReport, paths: ReturnType<typeof writeReport>) {
  const label = report.passed ? 'PASS' : report.comparable ? 'FAIL' : 'NOT_COMPARABLE'
  process.stdout.write(`agent-eval: ${label} mode=${report.mode} suite=${report.suite} exit=${report.exitCode}\n`)
  process.stdout.write(`agent-eval: report=${paths.jsonPath}\n`)
}

async function main() {
  let options: Options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`agent-eval: ${safeError(error)}\n`)
    process.exitCode = 2
    return
  }

  const mode = options.mode as 'replay' | 'live'
  let source: ReturnType<typeof sourceEvidence>
  try {
    source = sourceEvidence(mode)
  } catch (error) {
    process.stderr.write(`agent-eval: unable to load evidence source: ${safeError(error)}\n`)
    process.exitCode = 2
    return
  }
  const abort = new AbortController()
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    abort.abort()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)

  let report: EvalReport
  try {
    if (mode === 'replay') {
      report = await runReplaySuite(loadReplaySuite(options.suite as string), source)
    } else {
      if (options.provider !== 'notegen-free') {
        throw new Error('Live mode requires --provider notegen-free')
      }
      if (!options.allowNetwork || process.env.CARDMIND_AGENT_EVAL_LIVE !== '1') {
        throw new Error('Live mode requires --allow-network and CARDMIND_AGENT_EVAL_LIVE=1')
      }
      const suite = loadLiveSuite(options.suite as string)
      const budget = createLiveBudget(suite.maxModelCallsTotal, suite.maxModelCallsPerScenario)
      const model = new LiveModelPort(
        loadNoteGenProvider(),
        budget,
        suite.model,
        suite.maxOutputTokensPerCall,
      )
      report = await runLiveSuite(suite, source, model, abort.signal)
    }
  } catch (error) {
    report = configurationFailureReport(mode, options.suite as string, source, safeError(error))
    if (interrupted || (error instanceof DOMException && error.name === 'AbortError')) {
      report.exitCode = 130
      report.boundaries.unshift('The evaluation was interrupted by the user before completion.')
    }
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }

  if (interrupted && report.exitCode !== 130) {
    report.passed = false
    report.comparable = false
    report.exitCode = 130
    report.boundaries.unshift('The evaluation was interrupted by the user before completion.')
  }

  if (options.writeResume && report.passed && report.mode === 'replay') {
    try {
      writeResumeDrafts(report)
    } catch (error) {
      report = {
        ...report,
        comparable: false,
        passed: false,
        exitCode: 2,
        boundaries: [
          `Resume evidence generation failed: ${safeError(error)}`,
          ...report.boundaries,
        ],
        failures: [
          ...report.failures,
          {
            scenario: 'artifact-generation',
            assertion: 'resume-output',
            details: safeError(error),
          },
        ],
      }
    }
  }

  let paths: ReturnType<typeof writeReport>
  try {
    paths = writeReport(report, options.outputDirectory)
  } catch (error) {
    process.stderr.write(`agent-eval: unable to write evidence report: ${safeError(error)}\n`)
    process.exitCode = 2
    return
  }
  printSummary(report, paths)
  process.exitCode = report.exitCode
}

void main()
