import assert from 'node:assert/strict'
import test from 'node:test'
import type OpenAI from 'openai'
import { SandboxToolCatalog } from '../../../scripts/agent-eval/sandbox-catalog'
import { AgentRuntime } from './runtime'
import type {
  AgentModelPort,
  AgentRuntimeDependencies,
  AgentTool,
  AgentToolCatalog,
  AgentToolResult,
} from './types'

function toolChunk(id: string, name: string, args: Record<string, unknown>): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: `chunk-${id}`,
    created: 0,
    model: 'fake',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  }
}

function multiToolChunk(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chunk-tools',
    created: 0,
    model: 'fake',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      delta: {
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
    }],
  }
}

function textChunk(content: string): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chunk-text',
    created: 0,
    model: 'fake',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, finish_reason: 'stop', delta: { content } }],
  }
}

async function* streamOf(...chunks: OpenAI.Chat.ChatCompletionChunk[]) {
  for (const chunk of chunks) yield chunk
}

function createCatalog(tool: AgentTool): AgentToolCatalog {
  return {
    listTools: () => [tool],
    getTool: (name) => name === tool.name ? tool : undefined,
    toOpenAITools: () => [{
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }],
  }
}

function createRuntime(
  tool: AgentTool,
  turns: Array<() => AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>,
) {
  let turn = 0
  let clock = 0
  let id = 0
  const modelPort: AgentModelPort = {
    loadSettings: async () => ({ model: 'fake' }),
    validateSettings: async () => ({ ok: true }),
    getSystemPrompt: async () => 'test',
    createStream: async () => {
      const factory = turns[turn++]
      if (!factory) throw new Error('No scripted turn')
      return factory()
    },
  }
  const dependencies: AgentRuntimeDependencies = {
    modelPort,
    toolCatalog: createCatalog(tool),
    now: () => ++clock,
    createId: (prefix) => `${prefix}-${++id}`,
    sleep: async () => {},
    maxIterations: 4,
    maxModelRetries: 0,
    modelTimeoutMs: 100,
    toolTimeoutMs: 100,
    approvalTimeoutMs: 100,
    prepareMessages: (messages) => messages,
    buildCurrentUserMessage: async (content) => ({ role: 'user', content }),
    assemblePrompt: (_context, _tools, prompt) => prompt,
  }
  return new AgentRuntime(dependencies)
}

function createWriteTool(execute: AgentTool['execute']): AgentTool {
  return {
    name: 'note_update_file',
    title: 'update',
    description: 'update',
    category: 'note',
    risk: 'file-update',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['filePath', 'content'],
      additionalProperties: false,
    },
    execute,
  }
}

test('legacy-style mutating failure becomes effect_unknown and a new toolCallId is not replayed', async () => {
  let executions = 0
  const tool = createWriteTool(async (): Promise<AgentToolResult> => {
    executions += 1
    return {
      ok: false,
      message: 'legacy structured write failure',
      error: 'LEGACY_WRITE_FAILURE',
    }
  })
  const args = { filePath: 'target.md', content: 'replacement' }
  const runtime = createRuntime(tool, [
    () => streamOf(multiToolChunk([
      { id: 'write-first', name: tool.name, args },
      { id: 'write-new-id', name: tool.name, args },
    ])),
  ])

  const result = await runtime.run(
    { userInput: '更新 target.md' },
    { requestConfirmation: async () => ({ approved: true, scope: 'session' }) },
  )

  assert.equal(executions, 1)
  assert.equal(result.outcome, 'failed')
  assert.equal(result.terminationReason, 'effect_unknown')
  assert.equal(result.metrics.effectUnknownCount, 1)
  assert.equal(result.toolCalls[0]?.result?.effectStatus, 'unknown')
  assert.equal(result.toolCalls[0]?.result?.error, 'EFFECT_UNKNOWN')
  assert.match(result.content, /不要自动重试/)
})

test("explicit effectStatus 'none' remains a deterministic replayable pre-side-effect failure", async () => {
  let executions = 0
  const tool = createWriteTool(async (): Promise<AgentToolResult> => {
    executions += 1
    if (executions === 1) {
      return {
        ok: false,
        message: 'precondition rejected before write',
        error: 'PRECONDITION_FAILED',
        effectStatus: 'none',
      }
    }
    return { ok: true, message: 'updated', effectStatus: 'applied' }
  })
  const args = { filePath: 'target.md', content: 'replacement' }
  const runtime = createRuntime(tool, [
    () => streamOf(toolChunk('precondition-first', tool.name, args)),
    () => streamOf(toolChunk('precondition-second', tool.name, args)),
    () => streamOf(textChunk('done')),
  ])

  const result = await runtime.run(
    { userInput: '更新 target.md' },
    { requestConfirmation: async () => ({ approved: true, scope: 'session' }) },
  )

  assert.equal(executions, 2)
  assert.equal(result.outcome, 'success')
  assert.equal(result.terminationReason, 'final_answer')
  assert.equal(result.toolCalls[0]?.result?.effectStatus, 'none')
  assert.equal(result.toolCalls[0]?.result?.error, 'PRECONDITION_FAILED')
})

test("Eval sandbox marks deterministic configured failures as effectStatus 'none'", async () => {
  const catalog = new SandboxToolCatalog({
    note_update_file: [{
      ok: false,
      message: 'deterministic sandbox rejection',
      error: 'SANDBOX_PRECONDITION',
    }],
  })
  const tool = catalog.getTool('note_update_file')
  assert.ok(tool)

  const result = await tool.execute(
    { filePath: 'target.md', content: 'replacement' },
    {
      signal: new AbortController().signal,
      runId: 'sandbox-run',
      toolCallId: 'sandbox-call',
      operationKey: 'sandbox-operation',
      attempt: 1,
      context: { userInput: '更新 target.md' },
    },
  )

  assert.equal(result.ok, false)
  assert.equal(result.effectStatus, 'none')
  assert.equal(result.error, 'SANDBOX_PRECONDITION')
})
