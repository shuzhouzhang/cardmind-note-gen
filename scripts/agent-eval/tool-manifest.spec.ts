import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_TOOL_MANIFEST,
  manifestToOpenAITools,
} from '../../src/lib/agent/tool-manifest'
import { SandboxToolCatalog } from './sandbox-catalog'

const EXPECTED_TOOL_NAMES = [
  'system_get_current_time',
  'editor_get_state',
  'editor_get_selection',
  'editor_insert_at_cursor',
  'editor_replace_range',
  'editor_replace_lines',
  'editor_apply_transaction',
  'note_list_files',
  'note_list_files_by_date',
  'note_read_file',
  'note_open_file',
  'note_read_files_batch',
  'note_search_files',
  'note_create_file',
  'note_update_file',
  'note_delete_file',
  'note_rename_file',
  'note_move_file',
  'note_copy_file',
  'folder_list',
  'folder_check_exists',
  'folder_create',
  'folder_delete',
  'tag_list',
  'tag_search',
  'tag_create',
  'tag_update',
  'tag_delete',
  'mark_list',
  'mark_search',
  'mark_create',
  'mark_update',
  'mark_delete',
]

function assertArraysHaveItems(schema: unknown, path: string): void {
  if (!schema || typeof schema !== 'object') return
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => assertArraysHaveItems(item, `${path}[${index}]`))
    return
  }
  const value = schema as Record<string, unknown>
  if (value.type === 'array') {
    assert.ok(value.items && typeof value.items === 'object', `${path} array requires items`)
  }
  if (value.type === 'object') {
    assert.equal(value.additionalProperties, false, `${path} closes extra fields`)
  }
  for (const [key, nested] of Object.entries(value)) {
    assertArraysHaveItems(nested, `${path}.${key}`)
  }
}

test('canonical manifest contains the complete v1 production tool surface', () => {
  const names = AGENT_TOOL_MANIFEST.map((tool) => tool.name)
  assert.equal(AGENT_TOOL_MANIFEST.length, 33)
  assert.deepEqual(names, EXPECTED_TOOL_NAMES)
  assert.equal(new Set(names).size, names.length)
  assert.equal(Object.isFrozen(AGENT_TOOL_MANIFEST), true)
  assert.equal(AGENT_TOOL_MANIFEST.every((tool) => Object.isFrozen(tool.inputSchema)), true)
  assert.equal(AGENT_TOOL_MANIFEST.every((tool) => (
    !['mcp', 'skill', 'memory'].includes(tool.category)
    && !/^(?:mcp|skill|memory)_/.test(tool.name)
  )), true)

  for (const tool of AGENT_TOOL_MANIFEST) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} root schema`)
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} closes extra fields`)
    assertArraysHaveItems(tool.inputSchema, tool.name)
  }
})

test('sandbox exposes the exact canonical model-facing production definitions', () => {
  const sandbox = new SandboxToolCatalog({})
  assert.deepEqual(
    sandbox.listTools().map(({ execute: _execute, ...definition }) => definition),
    AGENT_TOOL_MANIFEST,
  )
  assert.deepEqual(sandbox.toOpenAITools(), manifestToOpenAITools())
})

test('sandbox fails closed for calls without a configured in-memory response', async () => {
  const sandbox = new SandboxToolCatalog({})
  const tool = sandbox.getTool('folder_list')
  assert.ok(tool)
  const result = await tool.execute({}, {
    runId: 'manifest-contract',
    toolCallId: 'call-1',
    operationKey: 'folder_list:{}',
    attempt: 1,
    signal: new AbortController().signal,
    context: { userInput: 'list folders' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'UNEXPECTED_SANDBOX_EXECUTION')
  assert.equal(sandbox.unexpectedExecutions, 1)
  assert.equal(sandbox.realExecutionCount, 0)
})
