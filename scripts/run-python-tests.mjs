#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const command = process.env.PYTHON || 'python'
const result = spawnSync(
  command,
  ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/tests', '-p', 'test_*.py'],
  { encoding: 'utf8', windowsHide: true },
)

process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')

if (result.error || result.status !== 0) {
  process.stderr.write('knowledge-engine-tests: Python test process failed\n')
  process.exit(1)
}

const output = `${result.stdout || ''}\n${result.stderr || ''}`
if (!/Ran 5 tests\b/.test(output)) {
  process.stderr.write('knowledge-engine-tests: expected exactly 5 tests\n')
  process.exit(1)
}

process.stdout.write('knowledge-engine-tests: verified 5 tests\n')
