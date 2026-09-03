import assert from 'node:assert/strict'
import test from 'node:test'
import type OpenAI from 'openai'
import {
  bindAgentToolImplementation,
  getAgentToolDefinition,
} from './tool-manifest'
import { AgentRuntime } from './runtime'
import { validateAgentToolInput } from './schema-validator'
import type {
  AgentModelPort,
  AgentRuntimeDependencies,
  AgentTool,
  AgentToolCatalog,
} from './types'

interface TransactionCase {
  label: string
  input: Record<string, unknown>
}

const VALID_TRANSACTIONS: TransactionCase[] = [
  {
    label: 'replace_range',
    input: {
      operations: [{ type: 'replace_range', from: 2, to: 5, content: 'range' }],
    },
  },
  {
    label: 'replace_lines',
    input: {
      operations: [{ type: 'replace_lines', startLine: 2, endLine: 4, content: 'lines' }],
    },
  },
  {
    label: 'insert_after_line',
    input: {
      operations: [{ type: 'insert_after_line', line: 3, content: 'after' }],
    },
  },
  {
    label: 'insert_before_line',
    input: {
      operations: [{ type: 'insert_before_line', line: 3, content: 'before' }],
    },
  },
]

const INVALID_TRANSACTIONS: TransactionCase[] = [
  {
    label: 'operations is empty',
    input: { operations: [] },
  },
  {
    label: 'replace_range missing from',
    input: { operations: [{ type: 'replace_range', to: 5, content: 'range' }] },
  },
  {
    label: 'replace_range missing to',
    input: { operations: [{ type: 'replace_range', from: 2, content: 'range' }] },
  },
  {
    label: 'replace_range missing content',
    input: { operations: [{ type: 'replace_range', from: 2, to: 5 }] },
  },
  {
    label: 'replace_lines missing startLine',
    input: { operations: [{ type: 'replace_lines', endLine: 4, content: 'lines' }] },
  },
  {
    label: 'replace_lines missing endLine',
    input: { operations: [{ type: 'replace_lines', startLine: 2, content: 'lines' }] },
  },
  {
    label: 'replace_lines missing content',
    input: { operations: [{ type: 'replace_lines', startLine: 2, endLine: 4 }] },
  },
  {
    label: 'insert_after_line missing line',
    input: { operations: [{ type: 'insert_after_line', content: 'after' }] },
  },
  {
    label: 'insert_after_line missing content',
    input: { operations: [{ type: 'insert_after_line', line: 3 }] },
  },
  {
    label: 'insert_before_line missing line',
    input: { operations: [{ type: 'insert_before_line', content: 'before' }] },
  },
  {
    label: 'insert_before_line missing content',
    input: { operations: [{ type: 'insert_before_line', line: 3 }] },
  },
]

function textChunk(content: string): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chunk-final',
    created: 0,
    model: 'fake',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, finish_reason: 'stop', delta: { content } }],
  }
}

function transactionChunk(input: Record<string, unknown>): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chunk-tool',
    created: 0,
    model: 'fake',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      delta: {
        tool_calls: [{
          index: 0,
          id: 'transaction-call',
          type: 'function',
          function: {
            name: 'editor_apply_transaction',
            arguments: JSON.stringify(input),
          },
        }],
      },
    }],
  }
}

async function *streamOf(chunk: OpenAI.Chat.ChatCompletionChunk) {
  yield chunk
}

function catalog(tool: AgentTool): AgentToolCatalog {
  return {
    listTools: () => [tool],
    getTool: (name) => name === tool.name ? tool : undefined,
    toOpenAITools: () => [{
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as OpenAI.FunctionParameters,
      },
    }],
  }
}

function dependenciesFor(tool: AgentTool, input: Record<string, unknown>): AgentRuntimeDependencies {
  let modelCall = 0
  let clock = 0
  let id = 0
  const modelPort: AgentModelPort = {
    loadSettings: async () => ({ model: 'fake', baseURL: 'memory://' }),
    validateSettings: async () => ({ ok: true }),
    getSystemPrompt: async () => 'test prompt',
    createStream: async () => {
      const chunk = modelCall === 0 ? transactionChunk(input) : textChunk('done')
      modelCall += 1
      return streamOf(chunk)
    },
  }

  return {
    modelPort,
    toolCatalog: catalog(tool),
    now: () => ++clock,
    createId: (prefix) => `${prefix}-${++id}`,
    sleep: async () => {},
    maxIterations: 3,
    maxModelRetries: 0,
    modelTimeoutMs: 100,
    toolTimeoutMs: 100,
    approvalTimeoutMs: 100,
    prepareMessages: (messages) => messages,
    buildCurrentUserMessage: async (content) => ({ role: 'user', content }),
    assemblePrompt: (_context, _tools, basePrompt) => basePrompt,
  }
}

test('transaction operation variants require their own coordinates and content', () => {
  const definition = getAgentToolDefinition('editor_apply_transaction')
  assert.ok(definition)

  const tool = bindAgentToolImplementation(definition.name, async () => ({
    ok: true,
    message: 'not executed by direct schema validation',
  }))
  assert.equal(tool.inputSchema, definition.inputSchema)

  for (const scenario of VALID_TRANSACTIONS) {
    assert.equal(
      validateAgentToolInput(tool, scenario.input).valid,
      true,
      `${scenario.label} should satisfy the canonical schema`,
    )
  }

  for (const scenario of INVALID_TRANSACTIONS) {
    assert.equal(
      validateAgentToolInput(tool, scenario.input).valid,
      false,
      `${scenario.label} should fail the canonical schema`,
    )
  }
})

test('missing transaction coordinates are rejected before approval and execution', async () => {
  for (const scenario of INVALID_TRANSACTIONS) {
    let approvals = 0
    let executions = 0
    const tool = bindAgentToolImplementation('editor_apply_transaction', async () => {
      executions += 1
      return { ok: true, message: 'must not execute', effectStatus: 'applied' }
    })
    const result = await new AgentRuntime(dependenciesFor(tool, scenario.input)).run(
      { userInput: '执行编辑事务' },
      {
        requestConfirmation: async () => {
          approvals += 1
          return { approved: true, scope: 'once' }
        },
      },
    )

    assert.equal(approvals, 0, scenario.label)
    assert.equal(executions, 0, scenario.label)
    assert.equal(result.toolCalls[0]?.result?.error, 'INVALID_TOOL_ARGUMENTS_SCHEMA', scenario.label)
  }
})

test('each valid transaction operation reaches approval and the bound executor', async () => {
  for (const scenario of VALID_TRANSACTIONS) {
    let approvals = 0
    let executions = 0
    const tool = bindAgentToolImplementation('editor_apply_transaction', async () => {
      executions += 1
      return { ok: true, message: 'applied', effectStatus: 'applied' }
    })
    const result = await new AgentRuntime(dependenciesFor(tool, scenario.input)).run(
      { userInput: '执行编辑事务' },
      {
        requestConfirmation: async () => {
          approvals += 1
          return { approved: true, scope: 'once' }
        },
      },
    )

    assert.equal(approvals, 1, scenario.label)
    assert.equal(executions, 1, scenario.label)
    assert.equal(result.outcome, 'success', scenario.label)
  }
})
