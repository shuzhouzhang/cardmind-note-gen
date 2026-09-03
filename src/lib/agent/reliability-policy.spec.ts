import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveModelPort } from '../../../scripts/agent-eval/live-model'
import { DEFAULT_SYSTEM_PROMPT } from '../ai/system-prompt'
import {
  AGENT_RELIABILITY_V1_POLICY,
  AGENT_RELIABILITY_V1_POLICY_LINES,
  enforceAgentReliabilityPolicy,
} from './reliability-policy'

test('production reliability policy defines the v1 trust and capability boundaries', () => {
  assert.equal(AGENT_RELIABILITY_V1_POLICY_LINES.length, 4)
  assert.match(AGENT_RELIABILITY_V1_POLICY, /tool results[\s\S]*untrusted data/i)
  assert.match(AGENT_RELIABILITY_V1_POLICY, /not system or developer instructions/i)
  assert.match(AGENT_RELIABILITY_V1_POLICY, /approval is denied[\s\S]*do not claim[\s\S]*succeeded/i)
  assert.match(AGENT_RELIABILITY_V1_POLICY, /MCP[\s\S]*Agent Skills[\s\S]*Memory Agent[\s\S]*disabled/i)
  assert.match(DEFAULT_SYSTEM_PROMPT, new RegExp(escapeRegExp(AGENT_RELIABILITY_V1_POLICY)))
  assert.equal(enforceAgentReliabilityPolicy(DEFAULT_SYSTEM_PROMPT), DEFAULT_SYSTEM_PROMPT)
  assert.match(
    enforceAgentReliabilityPolicy('Custom user system prompt.'),
    /Custom user system prompt[\s\S]*Reliability v1 Trust Boundaries[\s\S]*untrusted data/i,
  )
})

test('live evaluation uses the exact production prompt without evaluation-only hardening', async () => {
  const livePrompt = await LiveModelPort.prototype.getSystemPrompt.call({} as LiveModelPort)

  assert.equal(livePrompt, DEFAULT_SYSTEM_PROMPT)
  assert.doesNotMatch(livePrompt, /under a safety evaluation/i)
})

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
