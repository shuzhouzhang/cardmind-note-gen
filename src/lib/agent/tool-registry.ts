import type OpenAI from 'openai'
import useArticleStore from '@/stores/article'
import { useMcpStore } from '@/stores/mcp'
import { callTool as callMcpTool } from '@/lib/mcp/tools'
import { mcpServerManager } from '@/lib/mcp/server-manager'
import { skillManager } from '@/lib/skills'
import {
  getEditorContentTool,
  getEditorSelectionTool,
  replaceEditorContentTool,
  insertAtCursorTool,
} from './tools/editor-tools'
import {
  listMarkdownFilesTool,
  readMarkdownFileTool,
  openMarkdownFileTool,
  createFileTool,
  updateMarkdownFileTool,
  deleteMarkdownFileTool,
  searchMarkdownFilesTool,
  readMarkdownFilesBatchTool,
  listMarkdownFilesByDateTool,
  renameFileTool,
  moveFileTool,
  copyFileTool,
} from './tools/note-tools'
import { listFoldersTool, checkFolderExistsTool, createFolderTool, deleteFolderTool } from './tools/folder-tools'
import { listTagsTool, createTagTool, updateTagTool, deleteTagTool, searchTagsTool } from './tools/tag-tools'
import { readMarksTool, searchMarksTool, createMarkTool, updateMarkTool, deleteMarkTool } from './tools/mark-tools'
import { saveMemoryTool, listMemoriesTool, deleteMemoryTool, clearMemoriesTool } from './tools/memory-tools'
import { executeSkillScriptTool, getCurrentTimeTool, loadSkillContentTool } from './tools/system-tools'
import type {
  AgentChange,
  AgentTool,
  AgentToolResult,
  JsonSchema,
  Tool,
  ToolResult,
} from './types'
import type { EditorTransactionInput, EditorTransactionOperation } from './editor-adapter'
import { buildEditorChange } from './editor-adapter'

const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
}

function resultFromLegacy(result: ToolResult): AgentToolResult {
  return {
    ok: result.success,
    message: result.message || result.error || (result.success ? '工具执行成功' : '工具执行失败'),
    data: result.data,
    error: result.error,
  }
}

function createChangeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function buildFileChange(config: {
  target: string
  before?: string
  after?: string
  summary: string
  reversible?: boolean
}): AgentChange {
  return {
    id: createChangeId(),
    type: 'file',
    target: config.target,
    before: config.before,
    after: config.after,
    reversible: config.reversible ?? true,
    summary: config.summary,
  }
}

function buildStructuralChange(config: {
  type: AgentChange['type']
  target: string
  summary: string
  reversible?: boolean
}): AgentChange {
  return {
    id: createChangeId(),
    type: config.type,
    target: config.target,
    reversible: config.reversible ?? true,
    summary: config.summary,
  }
}

async function readEditorMarkdown() {
  const result = await getEditorContentTool.execute({})
  if (!result.success || !result.data || typeof result.data !== 'object') {
    return undefined
  }

  const data = result.data as { markdown?: string }
  return typeof data.markdown === 'string' ? data.markdown : undefined
}

function legacyInputSchema(tool: Tool): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []

  for (const parameter of tool.parameters) {
    properties[parameter.name] = {
      type: parameter.type === 'number' ? 'number' : parameter.type,
      description: parameter.description,
      default: parameter.default,
    }

    if (parameter.required) {
      required.push(parameter.name)
    }
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: true,
  }
}

function adaptLegacyTool(config: {
  name: string
  title: string
  description?: string
  category: AgentTool['category']
  risk: AgentTool['risk']
  legacy: Tool
  inputSchema?: JsonSchema
  beforeExecute?: (input: Record<string, unknown>) => AgentToolResult | undefined
  execute?: (input: Record<string, unknown>) => Promise<AgentToolResult>
}): AgentTool {
  return {
    name: config.name,
    title: config.title,
    description: config.description || config.legacy.description,
    category: config.category,
    risk: config.risk,
    legacyName: config.legacy.name,
    inputSchema: config.inputSchema || legacyInputSchema(config.legacy),
    execute: async (input) => {
      const blocked = config.beforeExecute?.(input)
      if (blocked) {
        return blocked
      }

      if (config.execute) {
        return config.execute(input)
      }

      return resultFromLegacy(await config.legacy.execute(input as Record<string, any>))
    },
  }
}

function currentOpenFileGuard(input: Record<string, unknown>, mode: 'read' | 'write') {
  const filePath = typeof input.filePath === 'string' ? input.filePath : ''
  const activeFilePath = useArticleStore.getState().activeFilePath

  if (!filePath || !activeFilePath || filePath !== activeFilePath) {
    return undefined
  }

  return {
    ok: false,
    message: mode === 'read'
      ? '当前文件已在编辑器中打开，请改用 editor_get_state 读取实时编辑器内容。'
      : '当前文件已在编辑器中打开，请改用 editor_apply_transaction 或 editor_replace_lines 修改实时编辑器内容。',
    error: 'OPEN_FILE_REQUIRES_EDITOR_TOOL',
  }
}

function editorOperationContent(operation: EditorTransactionOperation) {
  return typeof operation.content === 'string' ? operation.content : ''
}

function applyLineOperation(lines: string[], operation: EditorTransactionOperation) {
  if (operation.type === 'replace_lines') {
    const start = Math.max(1, operation.startLine || 1)
    const end = Math.max(start, operation.endLine || start)
    lines.splice(start - 1, end - start + 1, ...editorOperationContent(operation).split('\n'))
    return
  }

  if (operation.type === 'insert_after_line') {
    const line = Math.max(0, operation.line || 0)
    lines.splice(line, 0, ...editorOperationContent(operation).split('\n'))
    return
  }

  if (operation.type === 'insert_before_line') {
    const line = Math.max(1, operation.line || 1)
    lines.splice(line - 1, 0, ...editorOperationContent(operation).split('\n'))
  }
}

async function executeEditorTransaction(input: Record<string, unknown>): Promise<AgentToolResult> {
  const transaction = input as unknown as EditorTransactionInput
  if (!Array.isArray(transaction.operations) || transaction.operations.length === 0) {
    return {
      ok: false,
      message: '缺少编辑操作。',
      error: 'operations must be a non-empty array',
    }
  }

  const stateResult = await getEditorContentTool.execute({})
  if (!stateResult.success || !stateResult.data || typeof stateResult.data !== 'object') {
    return resultFromLegacy(stateResult)
  }

  const state = stateResult.data as {
    markdown?: string
    totalLines?: number
    version?: number
  }
  const before = state.markdown || ''
  let after = before

  for (const operation of transaction.operations) {
    if (operation.type === 'replace_range') {
      const from = Math.max(0, operation.from ?? 0)
      const to = Math.max(from, operation.to ?? from)
      after = `${after.slice(0, from)}${editorOperationContent(operation)}${after.slice(to)}`
      continue
    }

    const lines = after.split('\n')
    applyLineOperation(lines, operation)
    after = lines.join('\n')
  }

  if (after === before) {
    return {
      ok: true,
      message: '编辑器内容无需修改。',
      data: { unchanged: true },
    }
  }

  const replaceResult = await replaceEditorContentTool.execute({
    startLine: 1,
    endLine: state.totalLines || before.split('\n').length,
    replaceContent: after,
    version: transaction.version ?? state.version,
  })

  const normalized = resultFromLegacy(replaceResult)
  if (!normalized.ok) {
    return normalized
  }

  return {
    ...normalized,
    changes: [
      buildEditorChange(transaction.filePath || useArticleStore.getState().activeFilePath || 'current editor', before, after),
    ],
  }
}

async function executeEditorLegacyWrite(input: Record<string, unknown>, legacy: Tool): Promise<AgentToolResult> {
  const before = await readEditorMarkdown()
  const legacyResult = await legacy.execute(input as Record<string, any>)
  const normalized = resultFromLegacy(legacyResult)

  if (!normalized.ok) {
    return normalized
  }

  const after = await readEditorMarkdown()
  if (before === undefined || after === undefined || before === after) {
    return normalized
  }

  return {
    ...normalized,
    changes: [
      buildEditorChange(useArticleStore.getState().activeFilePath || 'current editor', before, after),
    ],
  }
}

async function readNoteContentForChange(filePath: string) {
  if (!filePath) {
    return undefined
  }

  const result = await readMarkdownFileTool.execute({ filePath })
  if (!result.success || !result.data || typeof result.data !== 'object') {
    return undefined
  }

  const data = result.data as { content?: string }
  return typeof data.content === 'string' ? data.content : undefined
}

function filePathFromCreateResult(input: Record<string, unknown>, result: AgentToolResult) {
  if (result.data && typeof result.data === 'object') {
    const data = result.data as { filePath?: unknown }
    if (typeof data.filePath === 'string') {
      return data.filePath
    }
  }

  const fileName = asString(input.fileName)
  const folderPath = asString(input.folderPath)
  return folderPath ? `${folderPath}/${fileName}` : fileName
}

async function executeCreateFileWithChange(input: Record<string, unknown>): Promise<AgentToolResult> {
  const normalized = resultFromLegacy(await createFileTool.execute(input as Record<string, any>))

  if (!normalized.ok) {
    return normalized
  }

  const target = filePathFromCreateResult(input, normalized)
  return {
    ...normalized,
    changes: [
      buildFileChange({
        target,
        after: asString(input.content),
        summary: `创建文件 ${target}`,
      }),
    ],
  }
}

async function executeUpdateFileWithChange(input: Record<string, unknown>): Promise<AgentToolResult> {
  const filePath = asString(input.filePath)
  const before = await readNoteContentForChange(filePath)
  const normalized = resultFromLegacy(await updateMarkdownFileTool.execute(input as Record<string, any>))

  if (!normalized.ok) {
    return normalized
  }

  return {
    ...normalized,
    changes: [
      buildFileChange({
        target: filePath,
        before,
        after: asString(input.content),
        summary: `更新文件 ${filePath}`,
      }),
    ],
  }
}

async function executeDeleteFileWithChange(input: Record<string, unknown>): Promise<AgentToolResult> {
  const filePath = asString(input.filePath)
  const before = await readNoteContentForChange(filePath)
  const normalized = resultFromLegacy(await deleteMarkdownFileTool.execute(input as Record<string, any>))

  if (!normalized.ok) {
    return normalized
  }

  return {
    ...normalized,
    changes: [
      buildFileChange({
        target: filePath,
        before,
        summary: `删除文件 ${filePath}`,
        reversible: Boolean(before),
      }),
    ],
  }
}

function resultDataPath(result: AgentToolResult, key: string) {
  if (!result.data || typeof result.data !== 'object') {
    return ''
  }

  const value = (result.data as Record<string, unknown>)[key]
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return String(value)
  }
  return ''
}

async function executeRenameFileWithChange(input: Record<string, unknown>): Promise<AgentToolResult> {
  const normalized = resultFromLegacy(await renameFileTool.execute(input as Record<string, any>))
  if (!normalized.ok) {
    return normalized
  }

  const oldPath = resultDataPath(normalized, 'oldPath') || asString(input.filePath)
  const newPath = resultDataPath(normalized, 'newPath') || asString(input.newName)
  return {
    ...normalized,
    changes: [
      buildFileChange({
        target: newPath,
        summary: `重命名文件 ${oldPath} -> ${newPath}`,
      }),
    ],
  }
}

async function executeMoveFileWithChange(input: Record<string, unknown>): Promise<AgentToolResult> {
  const normalized = resultFromLegacy(await moveFileTool.execute(input as Record<string, any>))
  if (!normalized.ok) {
    return normalized
  }

  const oldPath = resultDataPath(normalized, 'oldPath') || asString(input.filePath)
  const newPath = resultDataPath(normalized, 'newPath') || asString(input.targetFolderPath)
  return {
    ...normalized,
    changes: [
      buildFileChange({
        target: newPath,
        summary: `移动文件 ${oldPath} -> ${newPath}`,
      }),
    ],
  }
}

async function executeCopyFileWithChange(input: Record<string, unknown>): Promise<AgentToolResult> {
  const sourcePath = asString(input.filePath)
  const before = await readNoteContentForChange(sourcePath)
  const normalized = resultFromLegacy(await copyFileTool.execute(input as Record<string, any>))
  if (!normalized.ok) {
    return normalized
  }

  const newPath = resultDataPath(normalized, 'newPath') || asString(input.newName) || sourcePath
  return {
    ...normalized,
    changes: [
      buildFileChange({
        target: newPath,
        after: before,
        summary: `复制文件 ${sourcePath} -> ${newPath}`,
      }),
    ],
  }
}

async function executeFolderCreateWithChange(input: Record<string, unknown>): Promise<AgentToolResult> {
  const normalized = resultFromLegacy(await createFolderTool.execute(input as Record<string, any>))
  if (!normalized.ok) {
    return normalized
  }

  const target = resultDataPath(normalized, 'folderPath') || asString(input.folderPath)
  return {
    ...normalized,
    changes: [
      buildStructuralChange({
        type: 'folder',
        target,
        summary: `创建文件夹 ${target}`,
      }),
    ],
  }
}

async function executeFolderDeleteWithChange(input: Record<string, unknown>): Promise<AgentToolResult> {
  const normalized = resultFromLegacy(await deleteFolderTool.execute(input as Record<string, any>))
  if (!normalized.ok) {
    return normalized
  }

  const target = asString(input.folderPath)
  return {
    ...normalized,
    changes: [
      buildStructuralChange({
        type: 'folder',
        target,
        summary: `删除文件夹 ${target}`,
        reversible: false,
      }),
    ],
  }
}

async function executeStructuralToolWithChange(
  input: Record<string, unknown>,
  legacy: Tool,
  type: AgentChange['type'],
  summary: (input: Record<string, unknown>, result: AgentToolResult) => string,
  target: (input: Record<string, unknown>, result: AgentToolResult) => string,
  reversible = true
): Promise<AgentToolResult> {
  const normalized = resultFromLegacy(await legacy.execute(input as Record<string, any>))
  if (!normalized.ok) {
    return normalized
  }

  return {
    ...normalized,
    changes: [
      buildStructuralChange({
        type,
        target: target(input, normalized),
        summary: summary(input, normalized),
        reversible,
      }),
    ],
  }
}

const editorApplyTransactionTool: AgentTool = {
  name: 'editor_apply_transaction',
  title: '应用编辑器事务',
  description: 'Apply one or more precise edits to the current Markdown editor using the latest editor snapshot.',
  category: 'editor',
  risk: 'editor-write',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Current editor file path, if known.' },
      version: { type: 'number', description: 'Editor version from editor_get_state.' },
      operations: {
        type: 'array',
        description: 'Ordered edit operations.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['replace_range', 'replace_lines', 'insert_after_line', 'insert_before_line'],
            },
            from: { type: 'number' },
            to: { type: 'number' },
            startLine: { type: 'number' },
            endLine: { type: 'number' },
            line: { type: 'number' },
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
  execute: executeEditorTransaction,
}

function buildSkillListTool(): AgentTool {
  return {
    name: 'skill_list',
    title: '列出 Skills',
    description: 'List available skills with descriptions.',
    category: 'skill',
    risk: 'read',
    inputSchema: EMPTY_SCHEMA,
    execute: async () => {
      const enabledSkills = await skillManager.getEnabledSkills()
      return {
        ok: true,
        message: `找到 ${enabledSkills.length} 个可用 Skills`,
        data: enabledSkills.map((skill) => ({
          id: skill.metadata.id,
          name: skill.metadata.name,
          description: skill.metadata.description,
        })),
      }
    },
  }
}

function buildSkillLoadTool(): AgentTool {
  return {
    name: 'skill_load',
    title: '加载 Skill',
    description: 'Load the complete guidance and support files for a skill by ID.',
    category: 'skill',
    risk: 'read',
    legacyName: loadSkillContentTool.name,
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Skill ID to load.' },
        file_type: { type: 'string', description: 'Optional support filename or file type.' },
      },
      required: ['skill_id'],
      additionalProperties: false,
    },
    execute: async (input) => resultFromLegacy(await loadSkillContentTool.execute(input as Record<string, any>)),
  }
}

function buildMcpCallTool(): AgentTool {
  return {
    name: 'mcp_call_tool',
    title: '调用 MCP 工具',
    description: 'Call a selected MCP server tool. Use serverId and toolName exactly as shown in the MCP catalog.',
    category: 'mcp',
    risk: 'external',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'Selected MCP server ID.' },
        toolName: { type: 'string', description: 'MCP tool name.' },
        args: {
          type: 'object',
          description: 'Arguments passed to the MCP tool.',
          additionalProperties: true,
        },
      },
      required: ['serverId', 'toolName'],
      additionalProperties: false,
    },
    execute: async (input) => {
      const serverId = typeof input.serverId === 'string' ? input.serverId : ''
      const toolName = typeof input.toolName === 'string' ? input.toolName : ''
      const args = asObject(input.args)

      if (!serverId || !toolName) {
        return {
          ok: false,
          message: '缺少 MCP serverId 或 toolName。',
          error: 'serverId and toolName are required',
        }
      }

      const result = await callMcpTool(serverId, toolName, args)
      const text = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')

      return {
        ok: !result.isError,
        message: text || (result.isError ? 'MCP 工具执行失败' : 'MCP 工具执行成功'),
        data: result.content,
        error: result.isError ? text || 'MCP tool failed' : undefined,
      }
    },
  }
}

function buildMcpListToolsTool(): AgentTool {
  return {
    name: 'mcp_list_tools',
    title: '列出 MCP 工具',
    description: 'List configured MCP servers, selected servers, connection state, tools, and resources. This is read-only.',
    category: 'mcp',
    risk: 'read',
    inputSchema: EMPTY_SCHEMA,
    execute: async () => {
      const store = useMcpStore.getState()
      await store.initMcpData()
      const latestStore = useMcpStore.getState()
      const servers = latestStore.servers.map((server) => {
        const state = latestStore.serverStates.get(server.id)
        const tools = mcpServerManager.getServerTools(server.id)
        const resources = mcpServerManager.getServerResources(server.id)

        return {
          id: server.id,
          name: server.name,
          type: server.type,
          enabled: server.enabled,
          selected: latestStore.selectedServerIds.includes(server.id),
          status: state?.status || 'disconnected',
          error: state?.error,
          toolCount: tools.length,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description || '',
            required: tool.inputSchema?.required || [],
          })),
          resourceCount: resources.length,
          resources: resources.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            description: resource.description || '',
            mimeType: resource.mimeType || '',
          })),
        }
      })

      return {
        ok: true,
        message: servers.length
          ? `找到 ${servers.length} 个 MCP 服务，其中 ${servers.filter((server) => server.selected).length} 个已选中。`
          : '当前没有配置 MCP 服务。',
        data: {
          servers,
          selectedServerIds: latestStore.selectedServerIds,
        },
      }
    },
  }
}

function buildTools(): AgentTool[] {
  return [
    adaptLegacyTool({
      name: 'system_get_current_time',
      title: '获取当前日期',
      category: 'system',
      risk: 'read',
      legacy: getCurrentTimeTool,
      inputSchema: EMPTY_SCHEMA,
    }),
    adaptLegacyTool({
      name: 'editor_get_state',
      title: '读取编辑器状态',
      description: 'Read the current Markdown editor content including unsaved changes, numberedLines, totalLines, and version. Use editor_replace_range, editor_replace_lines, or editor_apply_transaction for edits.',
      category: 'editor',
      risk: 'read',
      legacy: getEditorContentTool,
      inputSchema: EMPTY_SCHEMA,
    }),
    adaptLegacyTool({
      name: 'editor_get_selection',
      title: '读取编辑器选区',
      description: 'Read the current editor selection with text, from/to offsets, and line numbers.',
      category: 'editor',
      risk: 'read',
      legacy: getEditorSelectionTool,
      inputSchema: EMPTY_SCHEMA,
    }),
    adaptLegacyTool({
      name: 'editor_insert_at_cursor',
      title: '在光标处插入',
      description: 'Insert Markdown at the current editor cursor. Avoid this for quoted chat selections because chat focus can make cursor position unreliable.',
      category: 'editor',
      risk: 'editor-write',
      legacy: insertAtCursorTool,
      execute: (input) => executeEditorLegacyWrite(input, insertAtCursorTool),
    }),
    adaptLegacyTool({
      name: 'editor_replace_range',
      title: '替换编辑器选区',
      description: 'Replace an exact editor character range using from/to offsets and content. Prefer this for explicit quoted selections.',
      category: 'editor',
      risk: 'editor-write',
      legacy: replaceEditorContentTool,
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'number' },
          to: { type: 'number' },
          content: { type: 'string' },
          version: { type: 'number' },
        },
        required: ['from', 'to', 'content'],
        additionalProperties: false,
      },
      execute: (input) => executeEditorLegacyWrite(input, replaceEditorContentTool),
    }),
    adaptLegacyTool({
      name: 'editor_replace_lines',
      title: '替换编辑器行',
      description: 'Replace exact 1-based editor lines with replaceContent. Prefer this for current-document section or block edits when line numbers are available.',
      category: 'editor',
      risk: 'editor-write',
      legacy: replaceEditorContentTool,
      inputSchema: {
        type: 'object',
        properties: {
          startLine: { type: 'number' },
          endLine: { type: 'number' },
          replaceContent: { type: 'string' },
          version: { type: 'number' },
        },
        required: ['startLine', 'endLine', 'replaceContent'],
        additionalProperties: false,
      },
      execute: (input) => executeEditorLegacyWrite(input, replaceEditorContentTool),
    }),
    editorApplyTransactionTool,
    adaptLegacyTool({
      name: 'note_list_files',
      title: '列出笔记文件',
      category: 'note',
      risk: 'read',
      legacy: listMarkdownFilesTool,
      inputSchema: EMPTY_SCHEMA,
    }),
    adaptLegacyTool({
      name: 'note_list_files_by_date',
      title: '按时间列出笔记文件',
      category: 'note',
      risk: 'read',
      legacy: listMarkdownFilesByDateTool,
    }),
    adaptLegacyTool({
      name: 'note_read_file',
      title: '读取笔记文件',
      category: 'note',
      risk: 'read',
      legacy: readMarkdownFileTool,
      beforeExecute: (input) => currentOpenFileGuard(input, 'read'),
    }),
    adaptLegacyTool({
      name: 'note_open_file',
      title: '打开笔记文件',
      category: 'note',
      risk: 'read',
      legacy: openMarkdownFileTool,
    }),
    adaptLegacyTool({
      name: 'note_read_files_batch',
      title: '批量读取笔记文件',
      category: 'note',
      risk: 'read',
      legacy: readMarkdownFilesBatchTool,
    }),
    adaptLegacyTool({
      name: 'note_search_files',
      title: '搜索笔记文件',
      category: 'note',
      risk: 'read',
      legacy: searchMarkdownFilesTool,
    }),
    adaptLegacyTool({
      name: 'note_create_file',
      title: '创建文件',
      category: 'note',
      risk: 'file-create',
      legacy: createFileTool,
      execute: executeCreateFileWithChange,
    }),
    adaptLegacyTool({
      name: 'note_update_file',
      title: '更新笔记文件',
      category: 'note',
      risk: 'file-update',
      legacy: updateMarkdownFileTool,
      beforeExecute: (input) => currentOpenFileGuard(input, 'write'),
      execute: executeUpdateFileWithChange,
    }),
    adaptLegacyTool({
      name: 'note_delete_file',
      title: '删除笔记文件',
      category: 'note',
      risk: 'delete',
      legacy: deleteMarkdownFileTool,
      execute: executeDeleteFileWithChange,
    }),
    adaptLegacyTool({
      name: 'note_rename_file',
      title: '重命名笔记文件',
      category: 'note',
      risk: 'file-update',
      legacy: renameFileTool,
      execute: executeRenameFileWithChange,
    }),
    adaptLegacyTool({
      name: 'note_move_file',
      title: '移动笔记文件',
      category: 'note',
      risk: 'file-update',
      legacy: moveFileTool,
      execute: executeMoveFileWithChange,
    }),
    adaptLegacyTool({
      name: 'note_copy_file',
      title: '复制笔记文件',
      category: 'note',
      risk: 'file-create',
      legacy: copyFileTool,
      execute: executeCopyFileWithChange,
    }),
    adaptLegacyTool({ name: 'folder_list', title: '列出文件夹', category: 'folder', risk: 'read', legacy: listFoldersTool }),
    adaptLegacyTool({ name: 'folder_check_exists', title: '检查文件夹', category: 'folder', risk: 'read', legacy: checkFolderExistsTool }),
    adaptLegacyTool({ name: 'folder_create', title: '创建文件夹', category: 'folder', risk: 'file-create', legacy: createFolderTool, execute: executeFolderCreateWithChange }),
    adaptLegacyTool({ name: 'folder_delete', title: '删除文件夹', category: 'folder', risk: 'delete', legacy: deleteFolderTool, execute: executeFolderDeleteWithChange }),
    adaptLegacyTool({ name: 'tag_list', title: '列出标签', category: 'tag', risk: 'read', legacy: listTagsTool }),
    adaptLegacyTool({ name: 'tag_search', title: '搜索标签', category: 'tag', risk: 'read', legacy: searchTagsTool }),
    adaptLegacyTool({
      name: 'tag_create',
      title: '创建标签',
      category: 'tag',
      risk: 'medium',
      legacy: createTagTool,
      execute: (input) => executeStructuralToolWithChange(
        input,
        createTagTool,
        'tag',
        (params) => `创建标签 ${asString(params.name)}`,
        (params, result) => resultDataPath(result, 'id') || asString(params.name)
      ),
    }),
    adaptLegacyTool({
      name: 'tag_update',
      title: '更新标签',
      category: 'tag',
      risk: 'medium',
      legacy: updateTagTool,
      execute: (input) => executeStructuralToolWithChange(
        input,
        updateTagTool,
        'tag',
        (params) => `更新标签 ${String(params.id ?? '')}`,
        (params) => String(params.id ?? '')
      ),
    }),
    adaptLegacyTool({
      name: 'tag_delete',
      title: '删除标签',
      category: 'tag',
      risk: 'delete',
      legacy: deleteTagTool,
      execute: (input) => executeStructuralToolWithChange(
        input,
        deleteTagTool,
        'tag',
        (params) => `删除标签 ${String(params.id ?? '')}`,
        (params) => String(params.id ?? ''),
        false
      ),
    }),
    adaptLegacyTool({ name: 'mark_list', title: '读取记录', category: 'mark', risk: 'read', legacy: readMarksTool }),
    adaptLegacyTool({ name: 'mark_search', title: '搜索记录', category: 'mark', risk: 'read', legacy: searchMarksTool }),
    adaptLegacyTool({
      name: 'mark_create',
      title: '创建记录',
      category: 'mark',
      risk: 'medium',
      legacy: createMarkTool,
      execute: (input) => executeStructuralToolWithChange(
        input,
        createMarkTool,
        'mark',
        (params) => `创建记录 ${asString(params.desc) || asString(params.content).slice(0, 24)}`,
        (params, result) => resultDataPath(result, 'id') || asString(params.desc) || asString(params.content).slice(0, 24)
      ),
    }),
    adaptLegacyTool({
      name: 'mark_update',
      title: '更新记录',
      category: 'mark',
      risk: 'medium',
      legacy: updateMarkTool,
      execute: (input) => executeStructuralToolWithChange(
        input,
        updateMarkTool,
        'mark',
        (params) => `更新记录 ${String(params.id ?? '')}`,
        (params) => String(params.id ?? '')
      ),
    }),
    adaptLegacyTool({
      name: 'mark_delete',
      title: '删除记录',
      category: 'mark',
      risk: 'delete',
      legacy: deleteMarkTool,
      execute: (input) => executeStructuralToolWithChange(
        input,
        deleteMarkTool,
        'mark',
        (params) => `删除记录 ${String(params.id ?? '')}`,
        (params) => String(params.id ?? ''),
        false
      ),
    }),
    adaptLegacyTool({ name: 'memory_list', title: '列出记忆', category: 'memory', risk: 'read', legacy: listMemoriesTool }),
    adaptLegacyTool({
      name: 'memory_create',
      title: '创建记忆',
      category: 'memory',
      risk: 'medium',
      legacy: saveMemoryTool,
      execute: (input) => executeStructuralToolWithChange(
        input,
        saveMemoryTool,
        'memory',
        (params) => `创建记忆 ${asString(params.content).slice(0, 24)}`,
        (params) => asString(params.content).slice(0, 48)
      ),
    }),
    adaptLegacyTool({
      name: 'memory_delete',
      title: '删除记忆',
      category: 'memory',
      risk: 'delete',
      legacy: deleteMemoryTool,
      execute: (input) => executeStructuralToolWithChange(
        input,
        deleteMemoryTool,
        'memory',
        (params) => `删除记忆 ${String(params.id ?? '')}`,
        (params) => String(params.id ?? ''),
        false
      ),
    }),
    adaptLegacyTool({
      name: 'memory_clear_all',
      title: '清空全部记忆',
      category: 'memory',
      risk: 'delete',
      legacy: clearMemoriesTool,
      execute: (input) => executeStructuralToolWithChange(
        input,
        clearMemoriesTool,
        'memory',
        () => '清空全部记忆',
        () => 'all',
        false
      ),
    }),
    buildSkillListTool(),
    buildSkillLoadTool(),
    adaptLegacyTool({
      name: 'skill_execute_script',
      title: '执行 Skill 脚本',
      description: 'Execute an approved runtime script for a loaded Skill. If long script content is needed, create the script first with note_create_file, then execute it.',
      category: 'skill',
      risk: 'script',
      legacy: executeSkillScriptTool,
    }),
    buildMcpListToolsTool(),
    buildMcpCallTool(),
  // CardMind 当前只开放核心笔记工作流；这些上游能力保留实现，但不进入活动 Agent 工具面。
  ].filter((tool) => !['memory', 'skill', 'mcp'].includes(tool.category))
}

export class AgentToolRegistry {
  private tools = buildTools()
  private toolMap = new Map(this.tools.map((tool) => [tool.name, tool]))

  listTools() {
    return [...this.tools]
  }

  getTool(name: string) {
    return this.toolMap.get(name)
  }

  toOpenAITools(): OpenAI.Chat.ChatCompletionTool[] {
    return this.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: `${tool.title}. ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }))
  }
}

export const agentToolRegistry = new AgentToolRegistry()
