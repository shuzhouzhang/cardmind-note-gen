import assert from 'node:assert/strict'
import test from 'node:test'
import type OpenAI from 'openai'
import { normalizeAgentToolTarget } from './permission-engine'
import { AgentRuntime } from './runtime'
import { AgentTraceRecorder, sanitizeAgentTraceValue } from './trace-recorder'
import type {
  AgentModelPort,
  AgentRuntimeDependencies,
  AgentTool,
  AgentToolCatalog,
} from './types'

type TurnFactory = (
  request: Parameters<AgentModelPort['createStream']>[0],
  callIndex: number
) => AsyncIterable<OpenAI.Chat.ChatCompletionChunk>

function textChunk(content: string): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chunk',
    created: 0,
    model: 'fake',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, finish_reason: 'stop', delta: { content } }],
  }
}

function toolChunk(id: string, name: string, args: Record<string, unknown>): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chunk',
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
    id: 'chunk',
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

async function *streamOf(...chunks: OpenAI.Chat.ChatCompletionChunk[]) {
  for (const chunk of chunks) yield chunk
}

function catalog(tools: AgentTool[]): AgentToolCatalog {
  return {
    listTools: () => tools,
    getTool: (name) => tools.find((tool) => tool.name === name),
    toOpenAITools: () => tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    })),
  }
}

function makeDependencies(
  turnFactories: TurnFactory[],
  tools: AgentTool[] = [],
  overrides: Partial<AgentRuntimeDependencies> = {}
) {
  let callIndex = 0
  let clock = 1000
  let id = 0
  const modelPort: AgentModelPort = {
    loadSettings: async () => ({ model: 'fake', baseURL: 'memory://' }),
    validateSettings: async () => ({ ok: true }),
    getSystemPrompt: async () => 'test prompt',
    createStream: async (request) => {
      const factory = turnFactories[Math.min(callIndex, turnFactories.length - 1)]
      if (!factory) throw new Error('No scripted model turn')
      const current = callIndex
      callIndex += 1
      return factory(request, current)
    },
  }

  return {
    modelPort,
    toolCatalog: catalog(tools),
    now: () => ++clock,
    createId: (prefix: string) => `${prefix}-${++id}`,
    sleep: async () => {},
    maxIterations: 5,
    maxModelRetries: 2,
    modelTimeoutMs: 100,
    toolTimeoutMs: 100,
    approvalTimeoutMs: 100,
    prepareMessages: (messages) => messages,
    buildCurrentUserMessage: async (text) => ({ role: 'user' as const, content: text }),
    assemblePrompt: (_context, _tools, base) => base,
    ...overrides,
  } satisfies AgentRuntimeDependencies
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

test('configuration failures are explicit failed results', async () => {
  const dependencies = makeDependencies([])
  dependencies.modelPort = {
    ...dependencies.modelPort,
    loadSettings: async () => null,
  }
  const result = await new AgentRuntime(dependencies).run({ userInput: '总结' })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.terminationReason, 'configuration_error')
  assert.notEqual(result.content, '')
  assert.equal(result.metrics.modelCalls, 0)
})

test('empty model responses terminate as failed instead of completed', async () => {
  const dependencies = makeDependencies([
    () => streamOf(textChunk('')),
  ])
  const result = await new AgentRuntime(dependencies).run({ userInput: '回答问题' })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.terminationReason, 'empty_response')
  assert.notEqual(result.content, '')
})

test('full stream consumption is retried and partial candidates are cleared', async () => {
  let cleared = 0
  const dependencies = makeDependencies([
    async function *(request) {
      assert.equal(request.attempt, 1)
      yield textChunk('partial')
      throw new Error('stream interrupted')
    },
    (request) => {
      assert.equal(request.attempt, 2)
      return streamOf(textChunk('complete'))
    },
  ])
  const result = await new AgentRuntime(dependencies).run(
    { userInput: '直接回答' },
    { onCandidateAnswerClear: () => { cleared += 1 } }
  )
  assert.equal(result.outcome, 'success')
  assert.equal(result.content, 'complete')
  assert.equal(result.metrics.retries, 1)
  assert.equal(result.metrics.modelAttempts, 2)
  assert.ok(cleared >= 1)
})

test('observer failures cannot interrupt a retry or replace the model result', async () => {
  const dependencies = makeDependencies([
    async function *() {
      throw Object.assign(new Error('temporary 503'), { status: 503 })
    },
    () => streamOf(textChunk('recovered')),
  ])
  const result = await new AgentRuntime(dependencies).run(
    { userInput: '直接回答' },
    {
      onTrace: async (event) => {
        event.title = 'observer-mutated-title'
        throw new Error('observer failed')
      },
    }
  )
  assert.equal(result.outcome, 'success')
  assert.equal(result.content, 'recovered')
  assert.equal(result.metrics.modelAttempts, 2)
  assert.equal(result.metrics.retries, 1)
  assert.doesNotMatch(JSON.stringify(result.trace), /observer-mutated-title/)
})

test('model stream deadlines are retryable and terminate explicitly when exhausted', async () => {
  const neverCompletes = () => (async function *() {
    await new Promise(() => {})
    yield textChunk('unreachable')
  })()
  const dependencies = makeDependencies(
    [neverCompletes],
    [],
    { modelTimeoutMs: 1, maxModelRetries: 1 }
  )
  const result = await new AgentRuntime(dependencies).run({ userInput: '直接回答' })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.terminationReason, 'model_timeout')
  assert.equal(result.metrics.modelAttempts, 2)
  assert.equal(result.metrics.retries, 1)
})

test('a provider-originated AbortError is not misreported as a user stop', async () => {
  const dependencies = makeDependencies([
    () => { throw new DOMException('provider aborted its request', 'AbortError') },
  ])
  const result = await new AgentRuntime(dependencies).run({ userInput: '直接回答' })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.terminationReason, 'model_error')
  assert.equal(result.stopped, false)
  assert.equal(result.metrics.modelAttempts, 1)
  assert.equal(result.metrics.retries, 0)
})

test('the same runtime instance rejects concurrent re-entry without disturbing the active run', async () => {
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const dependencies = makeDependencies([
    (request) => {
      markStarted()
      return (async function *() {
        await new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          )
        })
      })()
    },
  ], [], { modelTimeoutMs: 1000 })
  const runtime = new AgentRuntime(dependencies)
  const active = runtime.run({ userInput: 'first' })
  await started
  const concurrent = await runtime.run({ userInput: 'second' })
  assert.equal(concurrent.outcome, 'failed')
  assert.equal(concurrent.terminationReason, 'runtime_busy')
  assert.equal(concurrent.metrics.modelCalls, 0)
  runtime.stop()
  const stopped = await active
  assert.equal(stopped.outcome, 'stopped')
  assert.equal(stopped.terminationReason, 'user_stopped')
})

test('Ajv rejects required, type, enum, array, nested and extra-field violations before approval or execution', async () => {
  const invalidInputs: Array<Record<string, unknown>> = [
    { unexpected: true },
    { operations: 'not-an-array' },
    { operations: [{ type: 'delete_everything', content: 'x' }] },
    { operations: [{ type: 'replace_range' }] },
    { operations: [{ type: 'replace_range', content: 'x', extra: true }] },
  ]

  for (const [index, args] of invalidInputs.entries()) {
    let executions = 0
    let approvals = 0
    const tool: AgentTool = {
      name: 'editor_apply_transaction',
      title: 'transaction',
      description: 'transaction',
      category: 'editor',
      risk: 'editor-write',
      inputSchema: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['replace_range', 'replace_lines'] },
                content: { type: 'string' },
              },
              required: ['type', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['operations'],
        additionalProperties: false,
      },
      execute: async () => {
        executions += 1
        return { ok: true, message: 'must not execute' }
      },
    }
    const dependencies = makeDependencies([
      () => streamOf(toolChunk(`bad-schema-${index}`, tool.name, args)),
      () => streamOf(textChunk('cannot continue')),
    ], [tool])
    const result = await new AgentRuntime(dependencies).run(
      { userInput: '执行编辑事务' },
      { requestConfirmation: async () => {
        approvals += 1
        return { approved: true }
      } }
    )
    assert.equal(executions, 0, `case ${index}`)
    assert.equal(approvals, 0, `case ${index}`)
    assert.equal(
      result.toolCalls[0]?.result?.error,
      'INVALID_TOOL_ARGUMENTS_SCHEMA',
      `case ${index}: ${JSON.stringify({ outcome: result.outcome, reason: result.terminationReason, content: result.content, toolCalls: result.toolCalls })}`,
    )
  }
})

test('workspace path violations are blocked before any executor or approval starts', async () => {
  const cases: Array<{
    tool: Omit<AgentTool, 'execute'>
    args: Record<string, unknown>
    input: string
  }> = [
    {
      tool: {
        name: 'note_read_file',
        title: 'read',
        description: 'read',
        category: 'note' as const,
        risk: 'read' as const,
        inputSchema: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath'],
          additionalProperties: false,
        },
      },
      args: { filePath: 'C:\\Users\\example\\outside.md' },
      input: '读取指定笔记',
    },
    {
      tool: {
        name: 'note_rename_file',
        title: 'rename',
        description: 'rename',
        category: 'note' as const,
        risk: 'file-update' as const,
        inputSchema: {
          type: 'object',
          properties: { filePath: { type: 'string' }, newName: { type: 'string' } },
          required: ['filePath', 'newName'],
          additionalProperties: false,
        },
      },
      args: { filePath: 'notes/source.md', newName: '../outside.md' },
      input: '重命名指定笔记',
    },
  ]

  for (const entry of cases) {
    let executions = 0
    let approvals = 0
    const tool: AgentTool = {
      ...entry.tool,
      execute: async () => {
        executions += 1
        return { ok: true, message: 'must not execute' }
      },
    }
    const dependencies = makeDependencies([
      () => streamOf(toolChunk(`unsafe-${tool.name}`, tool.name, entry.args)),
      () => streamOf(textChunk('blocked')),
    ], [tool])
    const result = await new AgentRuntime(dependencies).run(
      { userInput: entry.input },
      { requestConfirmation: async () => {
        approvals += 1
        return { approved: true }
      } },
    )
    assert.equal(executions, 0, tool.name)
    assert.equal(approvals, 0, tool.name)
    assert.equal(result.toolCalls[0]?.result?.error, 'BLOCKED_BY_PERMISSION')
    assert.match(result.toolCalls[0]?.result?.message || '', /工作区目标无效|目标文件名/)
  }
})

test('selection scope blocks line writes outside the user selection', async () => {
  let executions = 0
  const tool: AgentTool = {
    name: 'editor_replace_lines',
    title: 'replace',
    description: 'replace',
    category: 'editor',
    risk: 'editor-write',
    inputSchema: {
      type: 'object',
      properties: {
        startLine: { type: 'number' },
        endLine: { type: 'number' },
        replaceContent: { type: 'string' },
      },
      required: ['startLine', 'endLine', 'replaceContent'],
      additionalProperties: false,
    },
    execute: async () => {
      executions += 1
      return { ok: true, message: 'updated' }
    },
  }
  const dependencies = makeDependencies([
    () => streamOf(toolChunk('range-1', tool.name, { startLine: 1, endLine: 9, replaceContent: 'x' })),
    () => streamOf(textChunk('blocked')),
  ], [tool])
  const result = await new AgentRuntime(dependencies).run({
    userInput: '修改选中内容',
    activeFilePath: 'a.md',
    currentQuote: { fileName: 'a.md', startLine: 4, endLine: 6, from: -1, to: -1 },
  })
  assert.equal(executions, 0)
  assert.equal(result.toolCalls[0]?.result?.error, 'BLOCKED_BY_PERMISSION')
})

test('successful side-effect signatures are deduplicated inside one run', async () => {
  let executions = 0
  const tool = writeTool('note_update_file', async (input, context) => {
    executions += 1
    assert.ok(context.toolCallId)
    assert.ok(context.operationKey)
    assert.equal(context.attempt, 1)
    return {
      ok: true,
      message: 'updated',
      changes: [{ id: 'change-1', type: 'file', target: String(input.filePath), reversible: true }],
    }
  })
  const args = { filePath: 'a.md', content: 'next' }
  const dependencies = makeDependencies([
    () => streamOf(multiToolChunk([
      { id: 'write-1', name: tool.name, args },
      { id: 'write-2', name: tool.name, args },
    ])),
    () => streamOf(textChunk('done')),
  ], [tool])
  const result = await new AgentRuntime(dependencies).run(
    { userInput: '修改笔记内容' },
    { requestConfirmation: async () => ({ approved: true, scope: 'session' }) }
  )
  assert.equal(executions, 1)
  assert.equal(result.outcome, 'success')
  assert.equal(result.metrics.deduplicatedTools, 1)
})

test('session approvals apply only to the same tool and normalized target', async () => {
  let executions = 0
  let approvals = 0
  const tool = writeTool('note_update_file', async (input) => ({
    ok: true,
    message: 'updated',
    changes: [{
      id: `change-${++executions}`,
      type: 'file',
      target: String(input.filePath),
      reversible: true,
    }],
  }))
  const dependencies = makeDependencies([
    () => streamOf(multiToolChunk([
      { id: 'scope-a1', name: tool.name, args: { filePath: 'a.md', content: 'first' } },
      { id: 'scope-a2', name: tool.name, args: { filePath: 'a.md', content: 'second' } },
      { id: 'scope-b1', name: tool.name, args: { filePath: 'b.md', content: 'third' } },
    ])),
  ], [tool])
  const result = await new AgentRuntime(dependencies).run(
    { userInput: '修改 a.md 和 b.md' },
    {
      requestConfirmation: async () => {
        approvals += 1
        return approvals === 1
          ? { approved: true, scope: 'session' }
          : { approved: false, reason: 'denied' }
      },
    }
  )
  assert.equal(approvals, 2)
  assert.equal(executions, 2)
  assert.equal(result.outcome, 'partial')
  assert.equal(result.terminationReason, 'approval_denied')
})

test('copy-file session approval is bound to its destination path and name', async () => {
  let approvals = 0
  let executions = 0
  const tool: AgentTool = {
    name: 'note_copy_file',
    title: 'copy',
    description: 'copy',
    category: 'note',
    risk: 'file-create',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        targetFolderPath: { type: 'string' },
        newName: { type: 'string', minLength: 4, pattern: '^[^/\\\\]+\\.md$' },
      },
      required: ['filePath', 'targetFolderPath', 'newName'],
      additionalProperties: false,
    },
    execute: async (input) => {
      executions += 1
      return {
        ok: true,
        message: 'copied',
        changes: [{
          id: `copy-${executions}`,
          type: 'file',
          target: `${input.targetFolderPath}/${input.newName}`,
          reversible: true,
        }],
      }
    },
  }
  const dependencies = makeDependencies([
    () => streamOf(multiToolChunk([
      { id: 'copy-a', name: tool.name, args: { filePath: 'source.md', targetFolderPath: 'a', newName: 'copy.md' } },
      { id: 'copy-b', name: tool.name, args: { filePath: 'source.md', targetFolderPath: 'b', newName: 'copy.md' } },
    ])),
    () => streamOf(textChunk('done')),
  ], [tool])
  const result = await new AgentRuntime(dependencies).run(
    { userInput: '复制 source.md 到 a/copy.md 和 b/copy.md' },
    {
      requestConfirmation: async () => {
        approvals += 1
        return { approved: true, scope: 'session' }
      },
    }
  )
  assert.equal(result.outcome, 'success')
  assert.equal(approvals, 2)
  assert.equal(executions, 2)
  assert.equal(
    normalizeAgentToolTarget(tool, { filePath: 'folder/source.md' }),
    'folder/source.md->source.md'
  )
  assert.equal(
    normalizeAgentToolTarget(tool, { filePath: 'source.md', targetFolderPath: 'dest', newName: 'renamed' }),
    'source.md->dest/renamed.md'
  )
  assert.equal(
    normalizeAgentToolTarget({ ...tool, name: 'note_rename_file' }, { filePath: 'folder/source.md', newName: 'renamed.md' }),
    'folder/source.md->folder/renamed.md'
  )
  assert.equal(
    normalizeAgentToolTarget({ ...tool, name: 'note_move_file' }, { filePath: 'folder/source.md', targetFolderPath: 'archive' }),
    'folder/source.md->archive/source.md'
  )
})

test('approval timeouts fail without starting the tool', async () => {
  let executions = 0
  const tool = writeTool('note_update_file', async () => {
    executions += 1
    return { ok: true, message: 'updated' }
  })
  const dependencies = makeDependencies([
    () => streamOf(toolChunk('approval-timeout', tool.name, { filePath: 'a.md', content: 'a' })),
  ], [tool], { approvalTimeoutMs: 1 })
  const result = await new AgentRuntime(dependencies).run(
    { userInput: '修改 a.md' },
    { requestConfirmation: async () => new Promise(() => {}) }
  )
  assert.equal(result.outcome, 'failed')
  assert.equal(result.terminationReason, 'approval_timeout')
  assert.equal(executions, 0)
})

test('stopping during approval aborts the wait and starts no tool', async () => {
  let executions = 0
  let approvalStarted!: () => void
  const started = new Promise<void>((resolve) => { approvalStarted = resolve })
  const tool = writeTool('note_update_file', async () => {
    executions += 1
    return { ok: true, message: 'updated' }
  })
  const dependencies = makeDependencies([
    () => streamOf(toolChunk('approval-stop', tool.name, { filePath: 'a.md', content: 'a' })),
  ], [tool], { approvalTimeoutMs: 1000 })
  const runtime = new AgentRuntime(dependencies)
  const running = runtime.run(
    { userInput: '修改 a.md' },
    {
      requestConfirmation: async (_request, signal) => {
        approvalStarted()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      },
    }
  )
  await started
  runtime.stop()
  const result = await running
  assert.equal(result.outcome, 'stopped')
  assert.equal(result.terminationReason, 'user_stopped')
  assert.equal(executions, 0)
})

test('an unstructured write throw yields truthful partial effect_unknown', async () => {
  const first = writeTool('note_update_file', async () => ({
    ok: true,
    message: 'first done',
    changes: [{ id: 'change-1', type: 'file', target: 'a.md', reversible: true }],
  }))
  const second = writeTool('note_copy_file', async () => {
    throw new Error('disk failure')
  })
  const dependencies = makeDependencies([
    () => streamOf(multiToolChunk([
      { id: 'partial-1', name: first.name, args: { filePath: 'a.md', content: 'a' } },
      { id: 'partial-2', name: second.name, args: { filePath: 'b.md', content: 'b' } },
    ])),
  ], [first, second])
  const result = await new AgentRuntime(dependencies).run(
    { userInput: '修改这些笔记' },
    { requestConfirmation: async () => ({ approved: true }) }
  )
  assert.equal(result.outcome, 'partial')
  assert.equal(result.terminationReason, 'effect_unknown')
  assert.match(result.content, /无法确认/)
  assert.equal(result.changes.length, 1)
  assert.equal(result.metrics.effectUnknownCount, 1)
})

test('timed out writes are effect_unknown and never reported as unmodified', async () => {
  const tool = writeTool('note_update_file', async () => new Promise(() => {}))
  const dependencies = makeDependencies([
    () => streamOf(toolChunk('timeout-1', tool.name, { filePath: 'a.md', content: 'a' })),
  ], [tool], { toolTimeoutMs: 1 })
  const result = await new AgentRuntime(dependencies).run(
    { userInput: '修改笔记内容' },
    { requestConfirmation: async () => ({ approved: true }) }
  )
  assert.equal(result.terminationReason, 'effect_unknown')
  assert.equal(result.metrics.effectUnknownCount, 1)
  assert.match(result.content, /无法确认/)
  assert.doesNotMatch(result.content, /未修改/)
})

test('stopping an in-flight non-cancellable write reports effect_unknown', async () => {
  let toolStarted!: () => void
  const started = new Promise<void>((resolve) => { toolStarted = resolve })
  const tool = writeTool('note_update_file', async () => {
    toolStarted()
    return new Promise(() => {})
  })
  const dependencies = makeDependencies([
    () => streamOf(toolChunk('write-stop', tool.name, { filePath: 'a.md', content: 'a' })),
  ], [tool], { toolTimeoutMs: 1000 })
  const runtime = new AgentRuntime(dependencies)
  const running = runtime.run(
    { userInput: '修改 a.md' },
    { requestConfirmation: async () => ({ approved: true }) }
  )
  await started
  runtime.stop()
  const result = await running
  assert.equal(result.outcome, 'stopped')
  assert.equal(result.terminationReason, 'effect_unknown')
  assert.equal(result.metrics.effectUnknownCount, 1)
  assert.match(result.content, /无法确认/)
})

test('trace persistence redacts content, diffs and credentials recursively', () => {
  const pluralCredential = ['plural', 'credential', 'value'].join(' ')
  const sessionToken = ['session', 'token', 'value'].join(' ')
  const authorizationHeader = ['authorization', 'header', 'value'].join(' ')
  const recorder = new AgentTraceRecorder('run-1', { now: () => 1, createId: () => 'event-1' })
  const bearerValue = ['Bear', 'er ', 'opaque-test-value'].join('')
  const openAiShapedValue = ['s', 'k-', 'opaque-test-value'].join('')
  recorder.add({
    type: 'tool_result',
    title: 'result',
    status: 'success',
    output: {
      content: 'private note body',
      observation: 'identity 110101199001011234',
      nested: {
        Authorization: bearerValue,
        credentials: pluralCredential,
        sessionToken,
        authorizationHeader,
        diff: 'full diff',
        value: openAiShapedValue,
      },
    },
  })
  const serialized = JSON.stringify(recorder.all())
  assert.doesNotMatch(
    serialized,
    /private note body|full diff|opaque-test-value|110101199001011234|plural credential value|session token value|authorization header value/
  )
  assert.match(serialized, /REDACTED/)
  assert.equal(recorder.all()[0]?.schemaVersion, 1)
})

test('persisted runtime history removes final prose, tool observations and change summaries', async () => {
  const tool = writeTool('note_update_file', async () => ({
    ok: true,
    message: 'updated identity 110101199001011234',
    data: { content: 'private tool body', nested: { text: 'private nested text' } },
    changes: [{
      id: 'private-change',
      type: 'file',
      target: 'private/person.md',
      summary: 'replaced private diagnosis',
      reversible: true,
    }],
  }))
  const dependencies = makeDependencies([
    () => streamOf(toolChunk('private-tool', tool.name, { filePath: 'private/person.md', content: 'private input body' })),
    () => streamOf(textChunk('private final answer')),
  ], [tool])
  const result = await new AgentRuntime(dependencies).run(
    { userInput: '修改 private/person.md' },
    { requestConfirmation: async () => ({ approved: true }) }
  )
  const persisted = sanitizeAgentTraceValue({
    steps: result.steps,
    toolCalls: result.toolCalls,
    changes: result.changes,
    traceEvents: result.trace,
  })
  const serialized = JSON.stringify(persisted)
  assert.doesNotMatch(
    serialized,
    /110101199001011234|private tool body|private nested text|private input body|private diagnosis|private final answer|private\/person\.md/
  )
  assert.match(serialized, /REDACTED_CONTENT/)
  assert.match(serialized, /note_update_file/)
})

test('disabled capabilities fail before any model call', async () => {
  let calls = 0
  const dependencies = makeDependencies([
    () => {
      calls += 1
      return streamOf(textChunk('unexpected'))
    },
  ])
  const result = await new AgentRuntime(dependencies).run({ userInput: '请使用 MCP 调用工具' })
  assert.equal(result.terminationReason, 'capability_disabled')
  assert.match(result.content, /CAPABILITY_DISABLED/)
  assert.equal(calls, 0)
})

test('negated disabled-capability mentions do not block a normal model answer', async () => {
  let calls = 0
  const dependencies = makeDependencies([
    () => {
      calls += 1
      return streamOf(textChunk('normal answer'))
    },
  ])
  const result = await new AgentRuntime(dependencies).run({
    userInput: '不要使用 MCP，也不要调用 Agent Skill 或读取 Memory Agent，直接回答。',
  })
  assert.equal(result.outcome, 'success')
  assert.equal(result.content, 'normal answer')
  assert.equal(calls, 1)
})
