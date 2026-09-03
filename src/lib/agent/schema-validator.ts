import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv'
import type { AgentTool } from './types'

export interface AgentSchemaValidationResult {
  valid: boolean
  errors: Array<{
    instancePath: string
    keyword: string
    message: string
    params: Record<string, unknown>
  }>
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
})

const validatorCache = new WeakMap<AgentTool, ValidateFunction>()

function closeObjectSchemas(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closeObjectSchemas)
  if (!schema || typeof schema !== 'object') return schema

  const object = schema as Record<string, unknown>
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    normalized[key] = closeObjectSchemas(value)
  }
  if (object.type === 'object' && (object.additionalProperties === undefined || object.additionalProperties === true)) {
    normalized.additionalProperties = false
  }
  return normalized
}

function normalizeError(error: ErrorObject) {
  return {
    instancePath: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message || 'schema validation failed',
    params: error.params as Record<string, unknown>,
  }
}

export function validateAgentToolInput(
  tool: AgentTool,
  input: Record<string, unknown>
): AgentSchemaValidationResult {
  let validator = validatorCache.get(tool)
  if (!validator) {
    // Runtime tools are closed contracts: unlisted fields are never forwarded
    // to a side-effecting implementation, including legacy schemas that used
    // `additionalProperties: true` before Agent Reliability v1.
    validator = ajv.compile(closeObjectSchemas(tool.inputSchema) as AnySchema)
    validatorCache.set(tool, validator)
  }

  const valid = validator(input)
  return {
    valid: Boolean(valid),
    errors: valid ? [] : (validator.errors || []).map(normalizeError),
  }
}

export function formatAgentSchemaErrors(result: AgentSchemaValidationResult) {
  return result.errors
    .map((error) => `${error.instancePath} ${error.message}`.trim())
    .join('; ')
}
