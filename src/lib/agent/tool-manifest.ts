import type OpenAI from 'openai'
import type { AgentTool, JsonSchema } from './types'

export type AgentToolDefinition = Omit<AgentTool, 'execute' | 'legacyName'>

const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const string = (description: string): JsonSchema => ({ type: 'string', description })
const number = (description: string): JsonSchema => ({ type: 'number', description })
const boolean = (description: string): JsonSchema => ({ type: 'boolean', description })
const stringArray = (description: string): JsonSchema => ({
  type: 'array',
  description,
  items: { type: 'string' },
})

/**
 * Side-effect-free, canonical model-facing tool definitions.
 * Production binds these definitions to real executors; eval binds the exact
 * same definitions to an in-memory sandbox so routing sees the production set.
 */
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

const TOOL_MANIFEST: AgentToolDefinition[] = [
  {
    name: 'system_get_current_time',
    title: '获取当前日期',
    description: 'Get the current date in YYYY-MM-DD format for safe filename use.',
    category: 'system',
    risk: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'editor_get_state',
    title: '读取编辑器状态',
    description: 'Read the current Markdown editor content including unsaved changes, numberedLines, totalLines, and version. Use precise editor tools for edits.',
    category: 'editor',
    risk: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'editor_get_selection',
    title: '读取编辑器选区',
    description: 'Read the current editor selection with text, from/to offsets, and 1-based line numbers.',
    category: 'editor',
    risk: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'editor_insert_at_cursor',
    title: '在光标处插入',
    description: 'Insert Markdown at the current cursor. Use only when the user explicitly requests insertion at the cursor.',
    category: 'editor',
    risk: 'editor-write',
    inputSchema: objectSchema({
      content: string('Markdown content to insert.'),
      replaceSelection: boolean('Whether to replace the current selection.'),
    }, ['content']),
  },
  {
    name: 'editor_replace_range',
    title: '替换编辑器选区',
    description: 'Replace an exact editor character range using from/to offsets. Prefer this for an explicit quoted selection.',
    category: 'editor',
    risk: 'editor-write',
    inputSchema: objectSchema({
      from: number('Zero-based inclusive start offset.'),
      to: number('Zero-based exclusive end offset.'),
      content: string('Replacement Markdown content.'),
      version: number('Editor version returned by editor_get_state.'),
    }, ['from', 'to', 'content']),
  },
  {
    name: 'editor_replace_lines',
    title: '替换编辑器行',
    description: 'Replace exact 1-based editor lines. Prefer this for a current-document section when line numbers are available.',
    category: 'editor',
    risk: 'editor-write',
    inputSchema: objectSchema({
      startLine: number('One-based inclusive start line.'),
      endLine: number('One-based inclusive end line.'),
      replaceContent: string('Replacement Markdown content.'),
      version: number('Editor version returned by editor_get_state.'),
    }, ['startLine', 'endLine', 'replaceContent']),
  },
  {
    name: 'editor_apply_transaction',
    title: '应用编辑器事务',
    description: 'Apply one or more ordered, precise edits to the current Markdown editor using the latest editor snapshot.',
    category: 'editor',
    risk: 'editor-write',
    inputSchema: objectSchema({
      filePath: string('Current editor file path, if known.'),
      version: number('Editor version returned by editor_get_state.'),
      operations: {
        type: 'array',
        description: 'Ordered edit operations.',
        minItems: 1,
        items: {
          oneOf: [
            objectSchema({
              type: { const: 'replace_range' },
              from: number('Zero-based inclusive start offset.'),
              to: number('Zero-based exclusive end offset.'),
              content: string('Replacement Markdown content.'),
            }, ['type', 'from', 'to', 'content']),
            objectSchema({
              type: { const: 'replace_lines' },
              startLine: number('One-based inclusive start line.'),
              endLine: number('One-based inclusive end line.'),
              content: string('Replacement Markdown content.'),
            }, ['type', 'startLine', 'endLine', 'content']),
            objectSchema({
              type: { const: 'insert_after_line' },
              line: number('One-based anchor line.'),
              content: string('Markdown content to insert.'),
            }, ['type', 'line', 'content']),
            objectSchema({
              type: { const: 'insert_before_line' },
              line: number('One-based anchor line.'),
              content: string('Markdown content to insert.'),
            }, ['type', 'line', 'content']),
          ],
        },
      },
    }, ['operations']),
  },
  {
    name: 'note_list_files',
    title: '列出笔记文件',
    description: 'List all Markdown files in the workspace.',
    category: 'note',
    risk: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'note_list_files_by_date',
    title: '按时间列出笔记文件',
    description: 'List Markdown files by a relative or absolute modified-time range.',
    category: 'note',
    risk: 'read',
    inputSchema: objectSchema({
      lastNDays: number('Files modified within the last N days.'),
      olderThanDays: number('Files modified more than N days ago.'),
      startDate: string('Optional ISO-8601 range start.'),
      endDate: string('Optional ISO-8601 range end.'),
    }),
  },
  {
    name: 'note_read_file',
    title: '读取笔记文件',
    description: 'Read the saved content of one Markdown note by workspace-relative path. Use editor_get_state for the currently open note.',
    category: 'note',
    risk: 'read',
    inputSchema: objectSchema({ filePath: string('Workspace-relative Markdown file path.') }, ['filePath']),
  },
  {
    name: 'note_open_file',
    title: '打开笔记文件',
    description: 'Open one workspace-relative Markdown file in the editor.',
    category: 'note',
    risk: 'read',
    inputSchema: objectSchema({ filePath: string('Workspace-relative Markdown file path.') }, ['filePath']),
  },
  {
    name: 'note_read_files_batch',
    title: '批量读取笔记文件',
    description: 'Read the saved contents of multiple Markdown notes by workspace-relative paths.',
    category: 'note',
    risk: 'read',
    inputSchema: objectSchema({ filePaths: stringArray('Workspace-relative Markdown file paths.') }, ['filePaths']),
  },
  {
    name: 'note_search_files',
    title: '搜索笔记文件',
    description: 'Search Markdown files only when the user explicitly requests search. Use keyword mode by default and rag only for an explicit semantic-search request.',
    category: 'note',
    risk: 'read',
    inputSchema: objectSchema({
      query: string('Keyword or natural-language query.'),
      mode: { type: 'string', enum: ['keyword', 'rag'], description: 'Search mode.' },
      folderPath: string('Optional workspace-relative folder scope.'),
    }, ['query']),
  },
  {
    name: 'note_create_file',
    title: '创建文件',
    description: 'Create a new file at an explicit workspace-relative target. Never overwrite an existing file.',
    category: 'note',
    risk: 'file-create',
    inputSchema: objectSchema({
      fileName: string('Explicit filename including extension.'),
      content: string('Plain-text file content.'),
      folderPath: string('Optional workspace-relative folder; omit for root.'),
    }, ['fileName', 'content']),
  },
  {
    name: 'note_update_file',
    title: '更新笔记文件',
    description: 'Replace the saved content of a non-current Markdown file. Optionally enforce its last-known modified time.',
    category: 'note',
    risk: 'file-update',
    inputSchema: objectSchema({
      filePath: string('Workspace-relative Markdown file path.'),
      content: string('New Markdown content.'),
      expectedModifiedAt: string('Optional ISO timestamp from the prior read.'),
    }, ['filePath', 'content']),
  },
  {
    name: 'note_delete_file',
    title: '删除笔记文件',
    description: 'Delete one explicitly named workspace-relative Markdown file.',
    category: 'note',
    risk: 'delete',
    inputSchema: objectSchema({ filePath: string('Workspace-relative Markdown file path.') }, ['filePath']),
  },
  {
    name: 'note_rename_file',
    title: '重命名笔记文件',
    description: 'Rename a Markdown file without changing its containing folder.',
    category: 'note',
    risk: 'file-update',
    inputSchema: objectSchema({
      filePath: string('Current workspace-relative Markdown file path.'),
      newName: {
        type: 'string',
        minLength: 4,
        pattern: '^[^/\\\\]+\\.md$',
        description: 'New basename including .md; path separators are forbidden.',
      },
    }, ['filePath', 'newName']),
  },
  {
    name: 'note_move_file',
    title: '移动笔记文件',
    description: 'Move a Markdown file to an explicit workspace-relative folder while retaining its filename.',
    category: 'note',
    risk: 'file-update',
    inputSchema: objectSchema({
      filePath: string('Source workspace-relative Markdown file path.'),
      targetFolderPath: string('Explicit destination folder; empty string means root.'),
    }, ['filePath', 'targetFolderPath']),
  },
  {
    name: 'note_copy_file',
    title: '复制笔记文件',
    description: 'Copy a Markdown file to an explicit, non-existing workspace-relative target.',
    category: 'note',
    risk: 'file-create',
    inputSchema: objectSchema({
      filePath: { type: 'string', minLength: 1, description: 'Source workspace-relative Markdown file path.' },
      targetFolderPath: string('Explicit destination folder; empty string means root.'),
      newName: {
        type: 'string',
        minLength: 4,
        pattern: '^[^/\\\\]+\\.md$',
        description: 'Explicit destination basename including .md.',
      },
    }, ['filePath', 'targetFolderPath', 'newName']),
  },
  {
    name: 'folder_list',
    title: '列出文件夹',
    description: 'List folders under a workspace-relative path; omit folderPath for the root.',
    category: 'folder',
    risk: 'read',
    inputSchema: objectSchema({ folderPath: string('Optional workspace-relative folder path.') }),
  },
  {
    name: 'folder_check_exists',
    title: '检查文件夹',
    description: 'Check whether one workspace-relative folder exists.',
    category: 'folder',
    risk: 'read',
    inputSchema: objectSchema({ folderPath: string('Workspace-relative folder path.') }, ['folderPath']),
  },
  {
    name: 'folder_create',
    title: '创建文件夹',
    description: 'Create one explicitly named workspace-relative folder.',
    category: 'folder',
    risk: 'file-create',
    inputSchema: objectSchema({ folderPath: string('Workspace-relative folder path.') }, ['folderPath']),
  },
  {
    name: 'folder_delete',
    title: '删除文件夹',
    description: 'Delete one explicitly named workspace-relative folder and its contents.',
    category: 'folder',
    risk: 'delete',
    inputSchema: objectSchema({ folderPath: string('Workspace-relative folder path.') }, ['folderPath']),
  },
  {
    name: 'tag_list',
    title: '列出标签',
    description: 'List all tags used to organize records.',
    category: 'tag',
    risk: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'tag_search',
    title: '搜索标签',
    description: 'Search tags by name.',
    category: 'tag',
    risk: 'read',
    inputSchema: objectSchema({ query: string('Tag-name search query.') }, ['query']),
  },
  {
    name: 'tag_create',
    title: '创建标签',
    description: 'Create one tag used to organize records.',
    category: 'tag',
    risk: 'medium',
    inputSchema: objectSchema({ name: string('New tag name.') }, ['name']),
  },
  {
    name: 'tag_update',
    title: '更新标签',
    description: 'Update the name or pin state of one tag.',
    category: 'tag',
    risk: 'medium',
    inputSchema: objectSchema({
      id: number('Tag ID.'),
      name: string('Optional new tag name.'),
      isPin: boolean('Optional pin state.'),
    }, ['id']),
  },
  {
    name: 'tag_delete',
    title: '删除标签',
    description: 'Delete one tag and all records under it.',
    category: 'tag',
    risk: 'delete',
    inputSchema: objectSchema({ id: number('Tag ID.') }, ['id']),
  },
  {
    name: 'mark_list',
    title: '读取记录',
    description: 'Read active records under a tag, or under the currently selected tag when tagId is omitted.',
    category: 'mark',
    risk: 'read',
    inputSchema: objectSchema({ tagId: number('Optional tag ID.') }),
  },
  {
    name: 'mark_search',
    title: '搜索记录',
    description: 'Search record content under a tag, or the selected tag when tagId is omitted.',
    category: 'mark',
    risk: 'read',
    inputSchema: objectSchema({
      query: string('Record search query.'),
      tagId: number('Optional tag ID.'),
      type: { type: 'string', enum: ['scan', 'text', 'image', 'link', 'file', 'recording'] },
    }, ['query']),
  },
  {
    name: 'mark_create',
    title: '创建记录',
    description: 'Create one content record under an explicit tag.',
    category: 'mark',
    risk: 'medium',
    inputSchema: objectSchema({
      tagId: number('Tag ID.'),
      type: { type: 'string', enum: ['scan', 'text', 'image', 'link', 'file', 'recording'] },
      content: string('Optional record content.'),
      url: string('Optional URL or file path.'),
      desc: string('Optional description or title.'),
    }, ['tagId', 'type']),
  },
  {
    name: 'mark_update',
    title: '更新记录',
    description: 'Update one existing record and optionally move it to another tag.',
    category: 'mark',
    risk: 'medium',
    inputSchema: objectSchema({
      id: number('Record ID.'),
      content: string('Optional new content.'),
      desc: string('Optional new description.'),
      tagId: number('Optional destination tag ID.'),
    }, ['id']),
  },
  {
    name: 'mark_delete',
    title: '删除记录',
    description: 'Soft-delete one explicitly identified record.',
    category: 'mark',
    risk: 'delete',
    inputSchema: objectSchema({ id: number('Record ID.') }, ['id']),
  },
]

export const AGENT_TOOL_MANIFEST: readonly AgentToolDefinition[] = deepFreeze(TOOL_MANIFEST)

const manifestByName = new Map(
  AGENT_TOOL_MANIFEST.map((definition) => [definition.name, definition]),
)

export function getAgentToolDefinition(name: string) {
  return manifestByName.get(name)
}

export function bindAgentToolImplementation(
  name: string,
  execute: AgentTool['execute'],
): AgentTool {
  const definition = getAgentToolDefinition(name)
  if (!definition) {
    throw new Error(`Missing canonical Agent tool definition for ${name}`)
  }
  return { ...definition, execute }
}

export function isMutatingAgentTool(name: string) {
  const definition = getAgentToolDefinition(name)
  return Boolean(definition && definition.risk !== 'read')
}

export function manifestToOpenAITools(
  manifest: readonly AgentToolDefinition[] = AGENT_TOOL_MANIFEST,
): OpenAI.Chat.ChatCompletionTool[] {
  return manifest.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: `${tool.title}. ${tool.description}`,
      parameters: tool.inputSchema as OpenAI.FunctionParameters,
    },
  }))
}
