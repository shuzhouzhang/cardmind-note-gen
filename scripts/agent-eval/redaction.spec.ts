import assert from 'node:assert/strict'
import test from 'node:test'
import { redactString, redactValue } from './redaction'

test('redacts authorization, cookie, and quoted credential text forms', () => {
  const opaque = ['opaque', 'fixture', 'value'].join('-')
  const basic = Buffer.from(`user:${opaque}`).toString('base64')
  const apiKeyName = ['api', 'Key'].join('')
  const tokenKey = ['to', 'ken'].join('')
  const credentialKey = ['creden', 'tials'].join('')
  const input = [
    `Authorization: Basic ${basic}`,
    `Cookie: sid=${opaque}`,
    `${apiKeyName}="${opaque}"`,
    `${tokenKey}:'${opaque}'`,
    `${credentialKey} = '${opaque} with spaces'`,
  ].join('\n')
  const redacted = redactString(input)
  assert.doesNotMatch(redacted, new RegExp(opaque))
  assert.doesNotMatch(redacted, new RegExp(basic))
})

test('redacts segmented credential keys while preserving token usage metrics', () => {
  const opaque = ['opaque', 'fixture', 'value'].join('-')
  const result = redactValue({
    token: opaque,
    authToken: opaque,
    credentials: opaque,
    authorizationHeader: opaque,
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
    tokenUsageAvailability: 1,
    tokenizerModel: 'kept',
  }) as Record<string, unknown>
  assert.equal(result.token, '[REDACTED]')
  assert.equal(result.authToken, '[REDACTED]')
  assert.equal(result.credentials, '[REDACTED]')
  assert.equal(result.authorizationHeader, '[REDACTED]')
  assert.equal(result.promptTokens, 11)
  assert.equal(result.completionTokens, 7)
  assert.equal(result.totalTokens, 18)
  assert.equal(result.tokenUsageAvailability, 1)
  assert.equal(result.tokenizerModel, 'kept')
})
