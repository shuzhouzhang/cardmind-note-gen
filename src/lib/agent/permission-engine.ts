import type { AgentContextSnapshot, AgentTool, AgentToolRisk } from './types'
import { assertSafeWorkspaceRelativePathInput } from '../workspace-path-safety'

export interface PermissionDecision {
  allowed: boolean
  requiresApproval: boolean
  reason?: string
  target: string
  operationKey: string
  approvalScopeKey: string
  canApproveForSession?: boolean
}

const READ_RISKS = new Set<AgentToolRisk>(['read'])
const SESSION_APPROVABLE_RISKS = new Set<AgentToolRisk>([
  'editor-write',
  'file-create',
  'file-update',
  'medium',
])
const PER_CALL_APPROVAL_TOOLS = new Set([
  // The cursor is mutable UI state and is not part of this tool's arguments,
  // so a stable session-level target cannot be proven.
  'editor_insert_at_cursor',
])

const STRUCTURAL_TOOL_PATTERN = /(delete|remove|rename|move|tag_|mark_|record_)/i
const TARGET_KEYS = [
  'filePath', 'path', 'folderPath', 'sourcePath', 'destinationPath',
  'tagId', 'markId', 'recordId', 'chatId', 'id', 'name', 'title',
]
const WORKSPACE_PATH_KEYS = [
  'filePath', 'path', 'folderPath', 'sourcePath', 'destinationPath', 'targetFolderPath',
]

const SAFE_EXTERNAL_TOOL_PATTERN = /^(get|list|read|search|find|fetch|query|lookup|describe|inspect|show)(_|-|[A-Z]|$)/i
const RISKY_EXTERNAL_TOOL_PATTERN = /(write|update|create|delete|remove|rename|move|copy|send|post|publish|deploy|execute|run|install|merge|close|open_pr|approve)/i
const READ_ONLY_INTENT_PATTERN = /(不要|别|无需|禁止|不需要).{0,8}(修改|改动|编辑|写入|保存|创建|新建|删除|插入|添加|替换|更新)|只读|仅(总结|解释|分析|回答|查看|读取)|只(总结|解释|分析|回答|查看|读取)|do not (modify|edit|write|save|create|delete|insert|update)|don't (modify|edit|write|save|create|delete|insert|update)|without (modifying|editing|writing|saving)|read[- ]only/i
const SCOPED_PRESERVE_INTENT_PATTERN = /(不要|别|无需|禁止|不需要).{0,12}(改动|修改|编辑|写入|替换|更新).{0,12}(其他|其它|其余|剩余|选区外|范围外|之外|以外|其他部分|其它部分|其余内容)|不(改动|修改|编辑).{0,12}(其他|其它|其余|剩余|选区外|范围外|之外|以外|其他部分|其它部分|其余内容)|keep .{0,20}(the rest|other parts|outside|unchanged)|do not (modify|edit|change).{0,20}(the rest|other parts|outside)/i
const CURRENT_MARKDOWN_PRESERVE_PATTERN = /(不要|别|无需|禁止|不需要).{0,12}(修改|改动|编辑|写入|保存|替换|更新).{0,12}(当前|这个|此).{0,8}(Markdown|md|笔记|文件|文档)|do not (modify|edit|write|save|update).{0,24}(current|open).{0,12}(markdown|note|file|document)/i
const WRITE_INTENT_PATTERN = /(修改|改写|编辑|润色|替换|插入|追加|添加|补充|删除|移除|创建|新建|保存|写入|更新|重命名|移动|复制|生成.{0,8}文件|整理(成|到|为|进)|记住|记录|应用|发布|发送|执行|运行|安装|部署|改(成|为|得|好|一下)|把.{0,20}(改|换|替换|写成|变成|调整|优化|润色|翻译(成|为|到)?)|将.{0,20}翻译(成|为|到)?|(?:当前|这篇|本文|笔记|文件|文档|内容|全文|全部|整篇).{0,16}翻译(成|为|到)?|让.{0,20}更(正式|专业|清晰|自然|流畅|简洁|准确)|调整|优化|完善|提升|modify|edit|change|rewrite|replace|insert|append|add|delete|remove|create|save|write|update|rename|move|copy|translate(?: .{0,20})? (?:to|into)|remember|record|apply|publish|send|execute|run|install|deploy)/i
const OUTPUT_FILE_INTENT_PATTERN = /(生成|创建|新建|输出).{0,16}(pptx|docx|xlsx|pdf|图片|图像|文件|演示文稿|幻灯片|deck|slides|presentation)|create.{0,16}(pptx|docx|xlsx|pdf|image|file|deck|slides|presentation)|generate.{0,16}(pptx|docx|xlsx|pdf|image|file|deck|slides|presentation)/i
const PORTABLE_PATH_SEGMENT_SOURCE = '[\\p{L}\\p{N}_.-]+'
const PATH_SEPARATOR_SOURCE = '[/\\\\]'
const PATH_TOKEN_PREFIX_SOURCE = "(?:^|[\\s\"'`：:，,（(])"
const PATH_TOKEN_SUFFIX_SOURCE = "(?=$|[\\s\"'`。；;，,）)])"

function stripPathLiterals(userInput: string) {
  const pathLiteral = new RegExp(
    `${PATH_TOKEN_PREFIX_SOURCE}(?:${PORTABLE_PATH_SEGMENT_SOURCE}${PATH_SEPARATOR_SOURCE})+${PORTABLE_PATH_SEGMENT_SOURCE}${PATH_TOKEN_SUFFIX_SOURCE}`,
    'giu',
  )
  const markdownBasename = new RegExp(
    `${PATH_TOKEN_PREFIX_SOURCE}${PORTABLE_PATH_SEGMENT_SOURCE}\\.md${PATH_TOKEN_SUFFIX_SOURCE}`,
    'giu',
  )
  return userInput
    .replace(pathLiteral, ' ')
    .replace(markdownBasename, ' ')
}

export function hasReadOnlyIntent(userInput: string) {
  if (CURRENT_MARKDOWN_PRESERVE_PATTERN.test(userInput) && OUTPUT_FILE_INTENT_PATTERN.test(userInput)) {
    return false
  }

  if (SCOPED_PRESERVE_INTENT_PATTERN.test(userInput) && WRITE_INTENT_PATTERN.test(userInput)) {
    return false
  }

  return READ_ONLY_INTENT_PATTERN.test(userInput)
}

export function hasExplicitWriteIntent(userInput: string) {
  return WRITE_INTENT_PATTERN.test(stripPathLiterals(userInput)) && !hasReadOnlyIntent(userInput)
}

function normalizePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim()
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.trim() : value
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)])
  )
}

function stableHash(value: string) {
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193)
    right = Math.imul(right ^ code, 0x85ebca6b)
  }
  return [left, right]
    .map((part) => (part >>> 0).toString(16).padStart(8, '0'))
    .join('')
}

function transactionSelectionSignature(operations: unknown) {
  if (!Array.isArray(operations)) return 'invalid'
  return operations.map((operation) => {
    if (!operation || typeof operation !== 'object') return 'invalid'
    const item = operation as Record<string, unknown>
    if (item.type === 'replace_range') return `range:${String(item.from)}-${String(item.to)}`
    if (item.type === 'replace_lines') return `lines:${String(item.startLine)}-${String(item.endLine)}`
    if (item.type === 'insert_before_line') return `before:${String(item.line)}`
    if (item.type === 'insert_after_line') return `after:${String(item.line)}`
    return String(item.type || 'invalid')
  }).join(',')
}

export function normalizeAgentToolTarget(
  tool: AgentTool,
  input: Record<string, unknown>,
  context?: AgentContextSnapshot
) {
  if (tool.category === 'editor') {
    const filePath = typeof input.filePath === 'string'
      ? input.filePath
      : context?.activeFilePath || context?.currentQuote?.fileName || '(current-editor)'
    const base = normalizePath(filePath)
    if (tool.name === 'editor_replace_range') {
      return `${base}#chars:${String(input.from)}-${String(input.to)}`
    }
    if (tool.name === 'editor_replace_lines') {
      return `${base}#lines:${String(input.startLine)}-${String(input.endLine)}`
    }
    if (tool.name === 'editor_apply_transaction') {
      return `${base}#transaction:${transactionSelectionSignature(input.operations)}`
    }
    return base
  }

  if (tool.name === 'note_copy_file' && typeof input.filePath === 'string') {
    const source = normalizePath(input.filePath)
    const sourceName = source.split('/').filter(Boolean).pop() || '(unnamed)'
    const targetFolder = typeof input.targetFolderPath === 'string'
      ? normalizePath(input.targetFolderPath)
      : ''
    const requestedName = typeof input.newName === 'string' && input.newName.trim()
      ? input.newName.trim()
      : sourceName
    const targetName = requestedName.endsWith('.md') ? requestedName : `${requestedName}.md`
    const destination = normalizePath([targetFolder, targetName].filter(Boolean).join('/'))
    return `${source}->${destination}`
  }

  if (tool.name === 'note_rename_file' && typeof input.filePath === 'string') {
    const source = normalizePath(input.filePath)
    const sourceParts = source.split('/').filter(Boolean)
    sourceParts.pop()
    const newName = typeof input.newName === 'string' ? input.newName.trim() : '(unspecified)'
    const destination = normalizePath([...sourceParts, newName].filter(Boolean).join('/'))
    return `${source}->${destination}`
  }

  if (tool.name === 'note_move_file' && typeof input.filePath === 'string') {
    const source = normalizePath(input.filePath)
    const sourceName = source.split('/').filter(Boolean).pop() || '(unnamed)'
    const targetFolder = typeof input.targetFolderPath === 'string'
      ? normalizePath(input.targetFolderPath)
      : '(unspecified)'
    const destination = normalizePath([targetFolder, sourceName].filter(Boolean).join('/'))
    return `${source}->${destination}`
  }

  if (typeof input.filePath === 'string' || typeof input.path === 'string') {
    return normalizePath(String(input.filePath || input.path))
  }
  if (typeof input.fileName === 'string') {
    const folder = typeof input.folderPath === 'string' ? normalizePath(input.folderPath) : ''
    return normalizePath([folder, input.fileName].filter(Boolean).join('/'))
  }

  const parts = TARGET_KEYS.flatMap((key) => {
    const value = input[key]
    if (typeof value !== 'string' && typeof value !== 'number') {
      return []
    }
    const normalized = typeof value === 'string' && /path/i.test(key)
      ? normalizePath(value)
      : String(value).trim()
    return normalized ? [`${key}=${normalized}`] : []
  })

  return `${tool.category}:${parts.join('|') || '(unspecified)'}`
}

function selectionScope(tool: AgentTool, input: Record<string, unknown>) {
  if (tool.name === 'editor_replace_range') {
    return `range:${String(input.from)}-${String(input.to)}`
  }
  if (tool.name === 'editor_replace_lines') {
    return `lines:${String(input.startLine)}-${String(input.endLine)}`
  }
  if (tool.name === 'editor_apply_transaction') {
    return `transaction:${transactionSelectionSignature(input.operations)}`
  }
  return 'whole-target'
}

export function createAgentOperationKey(
  tool: AgentTool,
  input: Record<string, unknown>,
  context?: AgentContextSnapshot
) {
  const canonicalInput = JSON.stringify(stableValue(input))
  return `${tool.name}|${normalizeAgentToolTarget(tool, input, context)}|sig:${stableHash(canonicalInput)}`
}

export function createAgentApprovalScopeKey(
  tool: AgentTool,
  input: Record<string, unknown>,
  context?: AgentContextSnapshot
) {
  return `${tool.name}|${normalizeAgentToolTarget(tool, input, context)}|${selectionScope(tool, input)}`
}

function sameFile(left: string, right: string) {
  return normalizePath(left) === normalizePath(right)
}

function explicitMarkdownTargets(userInput: string) {
  const pattern = new RegExp(
    `${PATH_TOKEN_PREFIX_SOURCE}((?:${PORTABLE_PATH_SEGMENT_SOURCE}${PATH_SEPARATOR_SOURCE})+${PORTABLE_PATH_SEGMENT_SOURCE}\\.md|${PORTABLE_PATH_SEGMENT_SOURCE}\\.md)${PATH_TOKEN_SUFFIX_SOURCE}`,
    'giu',
  )
  const targets: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(userInput)) !== null) {
    if (match[1]) targets.push(normalizePath(match[1]))
  }
  return [...new Set(targets)]
}

function scopedMarkdownInputPaths(tool: AgentTool, input: Record<string, unknown>) {
  if (tool.name === 'note_read_files_batch' && Array.isArray(input.filePaths)) {
    return input.filePaths.filter((value): value is string => typeof value === 'string')
  }

  const sourcePath = typeof input.filePath === 'string'
    ? normalizePath(input.filePath)
    : typeof input.path === 'string'
      ? normalizePath(input.path)
      : undefined

  if (tool.name === 'note_rename_file' && sourcePath && typeof input.newName === 'string') {
    const sourceParts = sourcePath.split('/').filter(Boolean)
    sourceParts.pop()
    const destination = normalizePath([...sourceParts, input.newName.trim()].filter(Boolean).join('/'))
    return [sourcePath, destination]
  }

  if (tool.name === 'note_move_file' && sourcePath && typeof input.targetFolderPath === 'string') {
    const sourceName = sourcePath.split('/').filter(Boolean).pop() || ''
    const destination = normalizePath([input.targetFolderPath, sourceName].filter(Boolean).join('/'))
    return [sourcePath, destination]
  }

  if (tool.name === 'note_copy_file' && sourcePath && typeof input.targetFolderPath === 'string') {
    const sourceName = sourcePath.split('/').filter(Boolean).pop() || ''
    const requestedName = typeof input.newName === 'string' && input.newName.trim()
      ? input.newName.trim()
      : sourceName
    const targetName = requestedName.endsWith('.md') ? requestedName : `${requestedName}.md`
    const destination = normalizePath([input.targetFolderPath, targetName].filter(Boolean).join('/'))
    return [sourcePath, destination]
  }

  if (sourcePath) return [sourcePath]
  if (typeof input.fileName === 'string') {
    return [[typeof input.folderPath === 'string' ? input.folderPath : '', input.fileName]
      .filter(Boolean)
      .join('/')]
  }
  return []
}

function validateTransactionSelection(
  operations: unknown,
  quote: NonNullable<AgentContextSnapshot['currentQuote']>
) {
  if (!Array.isArray(operations)) {
    return false
  }

  return operations.every((operation) => {
    if (!operation || typeof operation !== 'object') return false
    const item = operation as Record<string, unknown>
    if (item.type === 'replace_range') {
      return typeof item.from === 'number' && typeof item.to === 'number' &&
        item.from >= quote.from && item.to <= quote.to && item.to >= item.from
    }
    if (item.type === 'replace_lines') {
      return typeof item.startLine === 'number' && typeof item.endLine === 'number' &&
        item.startLine >= quote.startLine && item.endLine <= quote.endLine && item.endLine >= item.startLine
    }
    if (item.type === 'insert_before_line' || item.type === 'insert_after_line') {
      return typeof item.line === 'number' && item.line >= quote.startLine && item.line <= quote.endLine
    }
    return false
  })
}

function validateScopedTarget(
  tool: AgentTool,
  input: Record<string, unknown>,
  context?: AgentContextSnapshot
): string | undefined {
  if (!context) return undefined

  const explicitTargets = explicitMarkdownTargets(context.userInput)
  const editorInputPath = typeof input.filePath === 'string'
    ? input.filePath
    : typeof input.path === 'string'
      ? input.path
      : typeof input.fileName === 'string'
        ? [typeof input.folderPath === 'string' ? input.folderPath : '', input.fileName].filter(Boolean).join('/')
        : undefined
  const inputPaths = scopedMarkdownInputPaths(tool, input)

  const outOfScopePaths = explicitTargets.length
    ? inputPaths.filter((path) => !explicitTargets.some((target) => sameFile(target, path)))
    : []
  if (outOfScopePaths.length) {
    return `工具目标越权：用户指定 ${explicitTargets.join('、')}，但工具参数指向 ${outOfScopePaths.map(normalizePath).join('、')}。`
  }

  const activeFilePath = context.activeFilePath
  if (
    tool.category === 'editor' &&
    explicitTargets.length &&
    activeFilePath &&
    !explicitTargets.some((target) => sameFile(target, activeFilePath))
  ) {
    return `编辑器工具只能作用于当前文件 ${activeFilePath}，不能用于用户指定的其他文件 ${explicitTargets.join('、')}。`
  }

  if (tool.category === 'editor' && context.activeFilePath && editorInputPath && !sameFile(context.activeFilePath, editorInputPath)) {
    return `编辑器工具只能作用于当前文件 ${context.activeFilePath}。`
  }

  const quote = context.currentQuote
  if (!quote || tool.category !== 'editor') return undefined

  if (tool.name === 'editor_replace_range') {
    if (input.from !== quote.from || input.to !== quote.to) {
      return `替换范围必须严格等于用户选区 from=${quote.from}, to=${quote.to}。`
    }
    const content = typeof input.content === 'string' ? input.content : ''
    const selected = quote.fullContent || ''
    if (!content.trim()) return '选区替换内容不能为空。'
    if (content.replace(/\r\n/g, '\n').trim() === selected.replace(/\r\n/g, '\n').trim()) {
      return '选区替换内容与原文相同，已阻止无效写入。'
    }
    if (quote.startLine === quote.endLine && content.includes('\n')) {
      return '单行选区不能扩展为多行内容。'
    }
    if (!/^#{1,6}\s/m.test(selected) && /^#{1,6}\s/m.test(content)) {
      return '用户没有选中 Markdown 标题，替换内容不能引入标题。'
    }
  } else if (tool.name === 'editor_replace_lines') {
    if (
      typeof input.startLine !== 'number' || typeof input.endLine !== 'number' ||
      input.startLine < quote.startLine || input.endLine > quote.endLine || input.endLine < input.startLine
    ) {
      return `替换行必须落在用户选区 ${quote.startLine}-${quote.endLine} 内。`
    }
  } else if (tool.name === 'editor_apply_transaction' && !validateTransactionSelection(input.operations, quote)) {
    return '事务中的每个编辑操作都必须落在用户选区内。'
  }

  return undefined
}

function validateToolChoiceForIntent(
  tool: AgentTool,
  context?: AgentContextSnapshot
): string | undefined {
  if (!context) return undefined
  const userInput = context.userInput

  const createOnly = !/(新建|创建).{0,20}(文件夹|目录)|create.{0,20}(folder|directory)|mkdir/i.test(userInput) &&
    (/(新建|创建|create)\s+[^\s]+\.md|(?:新建|创建).{0,20}文件|create.{0,20}file/i.test(userInput)) &&
    !/(更新|覆盖|替换|改写|改成|改为|如果.{0,8}存在|若.{0,8}存在|不存在.{0,8}则|update|overwrite|replace|upsert)/i.test(userInput)
  if (createOnly && tool.risk !== 'read' && tool.name !== 'note_create_file') {
    return '用户只要求新建文件；不能改用更新、替换或编辑器工具覆盖已有内容。'
  }

  if (
    tool.name === 'editor_insert_at_cursor' &&
    /(在.{0,30}(上面|下面|前面|后面|之前|之后)|放到|移动到|插入到|追加到|补充到|结论|标题|段落|章节|小节|列表|第\s*\d+\s*行|line\s*\d+)/i.test(userInput) &&
    !/(光标|当前位置|当前光标|cursor|caret)/i.test(userInput)
  ) {
    return '用户指定了文档位置但没有要求使用当前光标；请先读取编辑器状态并使用精确行号或事务。'
  }

  return undefined
}

function validateWorkspaceTargetInput(
  tool: AgentTool,
  input: Record<string, unknown>,
): string | undefined {
  const values = WORKSPACE_PATH_KEYS.flatMap((key) => (
    typeof input[key] === 'string' && String(input[key]).trim()
      ? [{ key, value: String(input[key]) }]
      : []
  ))
  if (tool.name === 'note_create_file' && typeof input.fileName === 'string') {
    values.push({ key: 'fileName', value: input.fileName })
  }
  if (tool.name === 'note_read_files_batch' && Array.isArray(input.filePaths)) {
    for (const value of input.filePaths) {
      if (typeof value === 'string') {
        values.push({ key: 'filePaths', value })
      }
    }
  }

  try {
    for (const { value } of values) {
      assertSafeWorkspaceRelativePathInput(value)
    }
  } catch (error) {
    return `工作区目标无效：${error instanceof Error ? error.message : String(error)}`
  }

  if (
    (tool.name === 'note_rename_file' || tool.name === 'note_copy_file')
    && typeof input.newName === 'string'
    && /[\\/]/.test(input.newName)
  ) {
    return '目标文件名必须是单个文件名，不能包含路径分隔符。'
  }
  return undefined
}

export class AgentPermissionEngine {
  evaluate(
    tool: AgentTool,
    input: Record<string, unknown>,
    context?: AgentContextSnapshot
  ): PermissionDecision {
    const target = normalizeAgentToolTarget(tool, input, context)
    const operationKey = createAgentOperationKey(tool, input, context)
    const approvalScopeKey = createAgentApprovalScopeKey(tool, input, context)
    const base = { target, operationKey, approvalScopeKey }

    const workspaceTargetError = validateWorkspaceTargetInput(tool, input)
    if (workspaceTargetError) {
      return {
        ...base,
        allowed: false,
        requiresApproval: false,
        reason: workspaceTargetError,
      }
    }

    const toolChoiceError = validateToolChoiceForIntent(tool, context)
    if (toolChoiceError) {
      return {
        ...base,
        allowed: false,
        requiresApproval: false,
        reason: toolChoiceError,
      }
    }

    const scopedTargetError = validateScopedTarget(tool, input, context)
    if (scopedTargetError) {
      return {
        ...base,
        allowed: false,
        requiresApproval: false,
        reason: scopedTargetError,
      }
    }

    if (READ_RISKS.has(tool.risk)) {
      return {
        ...base,
        allowed: true,
        requiresApproval: false,
      }
    }

    if (tool.risk === 'delete') {
      const writeIntentDecision = this.evaluateWriteIntent(context)
      if (writeIntentDecision) {
        return { ...base, ...writeIntentDecision }
      }

      return {
        ...base,
        allowed: true,
        requiresApproval: true,
        canApproveForSession: false,
      }
    }

    if (tool.risk === 'script') {
      return {
        ...base,
        allowed: false,
        requiresApproval: false,
        reason: 'CAPABILITY_DISABLED: Agent Skill 脚本执行在 Reliability v1 中已禁用。',
      }
    }

    if (tool.risk === 'external') {
      const externalToolName = typeof input.toolName === 'string' ? input.toolName : ''
      if (externalToolName && SAFE_EXTERNAL_TOOL_PATTERN.test(externalToolName) && !RISKY_EXTERNAL_TOOL_PATTERN.test(externalToolName)) {
        return {
          ...base,
          allowed: true,
          requiresApproval: false,
        }
      }

      const writeIntentDecision = this.evaluateWriteIntent(context)
      if (writeIntentDecision) {
        return { ...base, ...writeIntentDecision }
      }

      return {
        ...base,
        allowed: true,
        requiresApproval: true,
        canApproveForSession: false,
      }
    }

    const writeIntentDecision = this.evaluateWriteIntent(context)
    if (writeIntentDecision) {
      return { ...base, ...writeIntentDecision }
    }

    return {
      ...base,
      allowed: true,
      requiresApproval: true,
      canApproveForSession: SESSION_APPROVABLE_RISKS.has(tool.risk)
        && !STRUCTURAL_TOOL_PATTERN.test(tool.name)
        && !PER_CALL_APPROVAL_TOOLS.has(tool.name),
    }
  }

  private evaluateWriteIntent(context?: AgentContextSnapshot): Omit<PermissionDecision, 'target' | 'operationKey' | 'approvalScopeKey'> | null {
    const userInput = context?.userInput?.trim() || ''

    if (!userInput) {
      return null
    }

    if (hasReadOnlyIntent(userInput)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: '用户明确要求不要修改内容。本次请求只能使用只读工具或直接回答。',
      }
    }

    if (!hasExplicitWriteIntent(userInput)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: '用户没有明确要求写入、修改、创建或删除。本次请求只能使用只读工具或直接回答。',
      }
    }

    return null
  }
}

export function isWriteLikeRisk(risk: AgentToolRisk) {
  return SESSION_APPROVABLE_RISKS.has(risk)
}
