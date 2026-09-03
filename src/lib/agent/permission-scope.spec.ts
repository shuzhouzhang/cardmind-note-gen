import assert from 'node:assert/strict'
import test from 'node:test'
import type OpenAI from 'openai'
import { AgentPermissionEngine } from './permission-engine'
import { AgentRuntime } from './runtime'
import type {
  AgentModelPort,
  AgentRuntimeDependencies,
  AgentTool,
  AgentToolCatalog,
} from './types'

function textChunk(content: string): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'text',
    created: 0,
    model: 'fake',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, finish_reason: 'stop', delta: { content } }],
  }
}

function toolChunk(
  id: string,
  name: string,
  args: Record<string, unknown>,
): OpenAI.Chat.ChatCompletionChunk {
  return {
    id,
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
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }],
  }
}

function runtimeFor(tool: AgentTool, chunks: OpenAI.Chat.ChatCompletionChunk[]) {
  let turn = 0
  let clock = 0
  let id = 0
  const modelPort: AgentModelPort = {
    loadSettings: async () => ({ model: 'fake' }),
    validateSettings: async () => ({ ok: true }),
    getSystemPrompt: async () => 'test',
    createStream: async () => {
      const chunk = chunks[turn++]
      if (!chunk) throw new Error('No scripted turn')
      return streamOf(chunk)
    },
  }
  const dependencies: AgentRuntimeDependencies = {
    modelPort,
    toolCatalog: catalog(tool),
    now: () => ++clock,
    createId: (prefix) => `${prefix}-${++id}`,
    sleep: async () => {},
    maxIterations: chunks.length,
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

function readTool(name: string, execute: AgentTool['execute']): AgentTool {
  return {
    name,
    title: name,
    description: name,
    category: 'note',
    risk: 'read',
    inputSchema: name === 'note_read_files_batch'
      ? {
          type: 'object',
          properties: {
            filePaths: { type: 'array', items: { type: 'string' } },
          },
          required: ['filePaths'],
          additionalProperties: false,
        }
      : {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath'],
          additionalProperties: false,
        },
    execute,
  }
}

function writeTool(name: string, execute: AgentTool['execute']): AgentTool {
  return {
    name,
    title: name,
    description: name,
    category: 'note',
    risk: 'file-update',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    },
    execute,
  }
}

test('an explicit nested note target is not equal to a root basename', () => {
  const tool = readTool('note_read_file', async () => ({ ok: true, message: 'read' }))
  const decision = new AgentPermissionEngine().evaluate(
    tool,
    { filePath: 'safe.md' },
    { userInput: '只读取 notes/safe.md 并总结。' },
  )

  assert.equal(decision.allowed, false)
  assert.equal(decision.requiresApproval, false)
  assert.match(decision.reason || '', /目标越权/)
})

test('Unicode Markdown targets are scoped exactly', () => {
  const tool = readTool('note_read_file', async () => ({ ok: true, message: 'read' }))
  const decision = new AgentPermissionEngine().evaluate(
    tool,
    { filePath: '笔记/私密.md' },
    { userInput: '只读取 笔记/安全.md 并总结。' },
  )

  assert.equal(decision.allowed, false)
  assert.equal(decision.requiresApproval, false)
  assert.match(decision.reason || '', /笔记\/私密\.md/)
})

test('Windows Markdown paths are normalized before exact scope comparison', () => {
  const tool = writeTool('note_update_file', async () => ({ ok: true, message: 'updated' }))
  const permission = new AgentPermissionEngine()
  const matching = permission.evaluate(
    tool,
    { filePath: 'notes/safe.md', content: 'safe' },
    { userInput: '请修改 notes\\safe.md。' },
  )
  const mismatching = permission.evaluate(
    tool,
    { filePath: 'notes/private.md', content: 'private' },
    { userInput: '请修改 notes\\safe.md。' },
  )

  assert.equal(matching.allowed, true)
  assert.equal(matching.requiresApproval, true)
  assert.equal(mismatching.allowed, false)
  assert.equal(mismatching.requiresApproval, false)
  assert.match(mismatching.reason || '', /notes\/private\.md/)
})

test('rename, move, and copy require both source and destination to be explicit targets', () => {
  const permission = new AgentPermissionEngine()
  const cases = [
    {
      name: 'note_rename_file',
      input: { filePath: 'notes/a.md', newName: 'b.md' },
      userInput: '请把 notes/a.md 重命名为 notes/c.md。',
      validUserInput: '请把 notes/a.md 重命名为 notes/b.md。',
      blockedTarget: 'notes/b.md',
    },
    {
      name: 'note_move_file',
      input: { filePath: 'notes/a.md', targetFolderPath: 'private' },
      userInput: '请把 notes/a.md 移动到 public/a.md。',
      validUserInput: '请把 notes/a.md 移动到 private/a.md。',
      blockedTarget: 'private/a.md',
    },
    {
      name: 'note_copy_file',
      input: { filePath: 'notes/a.md', targetFolderPath: 'private', newName: 'b.md' },
      userInput: '请把 notes/a.md 复制为 public/b.md。',
      validUserInput: '请把 notes/a.md 复制为 private/b.md。',
      blockedTarget: 'private/b.md',
    },
    {
      name: 'note_copy_file',
      input: { filePath: 'notes/a.md', targetFolderPath: 'private' },
      userInput: '请把 notes/a.md 复制为 public/a.md。',
      validUserInput: '请把 notes/a.md 复制为 private/a.md。',
      blockedTarget: 'private/a.md',
    },
  ]

  for (const item of cases) {
    const tool = writeTool(item.name, async () => ({ ok: true, message: 'changed' }))
    const decision = permission.evaluate(tool, item.input, { userInput: item.userInput })
    assert.equal(decision.allowed, false, item.name)
    assert.equal(decision.requiresApproval, false, item.name)
    assert.match(decision.reason || '', new RegExp(item.blockedTarget.replace('.', '\\.')), item.name)

    const valid = permission.evaluate(tool, item.input, { userInput: item.validUserInput })
    assert.equal(valid.allowed, true, item.name)
    assert.equal(valid.requiresApproval, true, item.name)
  }
})

test('a move with an out-of-scope destination never executes or requests approval', async () => {
  let executions = 0
  let approvals = 0
  const tool = writeTool('note_move_file', async () => {
    executions += 1
    return { ok: true, message: 'moved' }
  })
  tool.inputSchema = {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      targetFolderPath: { type: 'string' },
    },
    required: ['filePath', 'targetFolderPath'],
    additionalProperties: false,
  }
  const runtime = runtimeFor(tool, [
    toolChunk('move-private', tool.name, { filePath: 'notes/a.md', targetFolderPath: 'private' }),
    textChunk('blocked'),
  ])

  const result = await runtime.run(
    { userInput: '请把 notes/a.md 移动到 public/a.md。' },
    {
      requestConfirmation: async () => {
        approvals += 1
        return { approved: true }
      },
    },
  )

  assert.equal(executions, 0)
  assert.equal(approvals, 0)
  assert.equal(result.toolCalls[0]?.result?.error, 'BLOCKED_BY_PERMISSION')
  assert.match(result.toolCalls[0]?.result?.message || '', /private\/a\.md/)
})

test('batch reads validate every path and block an out-of-scope file before execution', async () => {
  let executions = 0
  let approvals = 0
  const tool = readTool('note_read_files_batch', async () => {
    executions += 1
    return { ok: true, message: 'read' }
  })
  const runtime = runtimeFor(tool, [
    toolChunk('batch-private', tool.name, { filePaths: ['notes/safe.md', 'notes/private.md'] }),
    textChunk('blocked'),
  ])

  const result = await runtime.run(
    { userInput: '只读取 notes/safe.md 并总结。' },
    {
      requestConfirmation: async () => {
        approvals += 1
        return { approved: true }
      },
    },
  )

  assert.equal(executions, 0)
  assert.equal(approvals, 0)
  assert.equal(result.toolCalls[0]?.result?.error, 'BLOCKED_BY_PERMISSION')
  assert.match(result.toolCalls[0]?.result?.message || '', /notes\/private\.md/)
})

test('batch reads reject traversal in every array item before execution or approval', async () => {
  let executions = 0
  let approvals = 0
  const tool = readTool('note_read_files_batch', async () => {
    executions += 1
    return { ok: true, message: 'read' }
  })
  const runtime = runtimeFor(tool, [
    toolChunk('batch-traversal', tool.name, { filePaths: ['notes/safe.md', '../private.md'] }),
    textChunk('blocked'),
  ])

  const result = await runtime.run(
    { userInput: '读取这些笔记。' },
    {
      requestConfirmation: async () => {
        approvals += 1
        return { approved: true }
      },
    },
  )

  assert.equal(executions, 0)
  assert.equal(approvals, 0)
  assert.equal(result.toolCalls[0]?.result?.error, 'BLOCKED_BY_PERMISSION')
  assert.match(result.toolCalls[0]?.result?.message || '', /路径/)
})

test('cursor insertion requires approval for every call in the same run', async () => {
  let executions = 0
  let approvals = 0
  const tool: AgentTool = {
    name: 'editor_insert_at_cursor',
    title: 'insert',
    description: 'insert',
    category: 'editor',
    risk: 'editor-write',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    },
    execute: async () => {
      executions += 1
      return { ok: true, message: 'inserted' }
    },
  }
  const runtime = runtimeFor(tool, [
    toolChunk('insert-a', tool.name, { content: 'A' }),
    toolChunk('insert-b', tool.name, { content: 'B' }),
    textChunk('done'),
  ])

  const result = await runtime.run(
    { userInput: '在当前光标处依次插入 A 和 B。', activeFilePath: 'notes/current.md' },
    {
      requestConfirmation: async () => {
        approvals += 1
        return { approved: true, scope: 'session' }
      },
    },
  )

  assert.equal(result.outcome, 'success')
  assert.equal(executions, 2)
  assert.equal(approvals, 2)
})
