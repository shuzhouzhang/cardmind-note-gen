import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import type { AnySchema, ErrorObject } from 'ajv'
import type { LiveSuite, ReplaySuite } from './types'

const fixturesRoot = resolve(process.cwd(), 'fixtures', 'agent')

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function formatErrors(errors: ErrorObject[] | null | undefined) {
  if (!errors?.length) return 'unknown fixture validation error'
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
    .join('; ')
}

function assertUniqueIds(suite: { scenarios: Array<{ id: string }> }) {
  const ids = suite.scenarios.map((scenario) => scenario.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('Fixture scenario IDs must be unique')
  }
}

function assertSafeRelativePath(value: unknown, label: string) {
  if (typeof value !== 'string' || !value) return
  const normalized = value.replaceAll('\\', '/')
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`${label} must be a repository-independent relative path`)
  }
}

function assertInputsArePortable(suite: ReplaySuite | LiveSuite) {
  for (const scenario of suite.scenarios) {
    assertSafeRelativePath(scenario.input.activeFilePath, `${scenario.id}.input.activeFilePath`)
    assertSafeRelativePath(scenario.input.currentQuote?.fileName, `${scenario.id}.input.currentQuote.fileName`)
  }
}

function validateWithSchema<T>(fixtureName: string, schemaName: string): T {
  const fixture = loadJson(resolve(fixturesRoot, fixtureName))
  const schema = loadJson(resolve(fixturesRoot, schemaName)) as AnySchema
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  const validate = ajv.compile(schema)
  if (!validate(fixture)) {
    throw new Error(`Invalid ${fixtureName}: ${formatErrors(validate.errors)}`)
  }
  return fixture as T
}

export function loadReplaySuite(name: string): ReplaySuite {
  if (name !== 'reliability-v1') {
    throw new Error(`Unknown replay suite: ${name}`)
  }
  const suite = validateWithSchema<ReplaySuite>(
    'reliability-v1.json',
    'reliability-v1.schema.json',
  )
  if (suite.scenarios.length !== 10) {
    throw new Error('The official reliability-v1 suite must contain exactly 10 scenarios')
  }
  assertUniqueIds(suite)
  assertInputsArePortable(suite)
  return suite
}

export function loadLiveSuite(name: string): LiveSuite {
  if (name !== 'live-smoke-v1') {
    throw new Error(`Unknown live suite: ${name}`)
  }
  const suite = validateWithSchema<LiveSuite>(
    'live-smoke-v1.json',
    'live-smoke-v1.schema.json',
  )
  if (suite.scenarios.length !== 10) {
    throw new Error('The official live-smoke-v1 suite must contain exactly 10 scenarios')
  }
  assertUniqueIds(suite)
  assertInputsArePortable(suite)
  return suite
}
