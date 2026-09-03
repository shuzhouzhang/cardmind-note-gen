import { DEFAULT_SYSTEM_PROMPT } from '@/lib/ai/system-prompt'
import type { AgentContextSnapshot, AgentTool } from './types'

function formatToolCatalog(tools: AgentTool[]) {
  return tools
    .map((tool) => `- ${tool.name}: ${tool.title}. ${tool.description}`)
    .join('\n')
}

function formatActiveFile(context: AgentContextSnapshot) {
  if (!context.activeFilePath) {
    return ''
  }

  return [
    '## Current Open File',
    `The current editor file is "${context.activeFilePath}".`,
    'Use editor tools only for this current open file. If the user explicitly names a different Markdown file path, use note_read_file and note_update_file for that target file instead of editor tools.',
  ].join('\n')
}

function formatQuote(context: AgentContextSnapshot) {
  const quote = context.currentQuote
  if (!quote) {
    return ''
  }

  const lineText = quote.startLine === quote.endLine
    ? `line ${quote.startLine}`
    : `lines ${quote.startLine}-${quote.endLine}`

  return [
    '## Current Editor Selection',
    `The user selected content in "${quote.fileName}" at ${lineText}.`,
    quote.from >= 0 && quote.to >= quote.from
      ? `Selection range: from=${quote.from}, to=${quote.to}. For explicit edits to the selection, use editor_replace_range or editor_apply_transaction and keep the edit inside this range unless the user explicitly asks for a larger scope.`
      : 'Exact selection offsets are unavailable. Use editor_replace_lines for explicit edits when line numbers are valid.',
    'When editing a selection, the replacement content must be ONLY the rewritten selected text. Do not include surrounding headings, list items, unchanged paragraphs, separators, or any content outside the selected range.',
    'If the selection is a single body line, the replacement content must also be one body line. Never include Markdown headings such as "## 目标", blank lines, or adjacent paragraphs.',
    'When the user asks to rewrite, formalize, polish, optimize, or improve selected text, the replacement must be meaningfully different from the selected text. Never call an editor write tool with unchanged content.',
    quote.fullContent
      ? `Selected content:\n---\n${quote.fullContent}\n---`
      : '',
  ].filter(Boolean).join('\n')
}

export class AgentPromptAssembler {
  assemble(context: AgentContextSnapshot, tools: AgentTool[], systemPrompt = DEFAULT_SYSTEM_PROMPT) {
    const sections = [
      systemPrompt.trim(),
      '',
      '## Available Tools',
      formatToolCatalog(tools),
      formatActiveFile(context),
      formatQuote(context),
    ].filter((section) => section.trim().length > 0)

    return sections.join('\n\n')
  }
}
