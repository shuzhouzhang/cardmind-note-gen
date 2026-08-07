'use client'

import { Editor } from '@tiptap/react'
import { Code2, Eye, FileText } from 'lucide-react'
import { WordCount } from './word-count'
import { CopyButton } from './copy-button'
import { ExportButton } from './export-button'
import { SyncTools } from '../sync/sync-tools'
import { OutlineToggle } from './outline-toggle'
import { SyncButton } from '../sync/sync-button'
import { PullButton } from '../sync/pull-button'
import { HistorySheet } from '../sync/history-sheet'
import useArticleStore from '@/stores/article'
import { isMobileDevice } from '@/lib/check'
import { Button } from '@/components/ui/button'
import useSettingStore from '@/stores/setting'
import { useTranslations } from 'next-intl'

interface FooterBarProps {
  editor: Editor
  outlineOpen?: boolean
  onToggleOutline?: () => void
  viewMode?: 'visual' | 'source'
  onToggleViewMode?: () => void
  sourceMarkdown?: string
  getMarkdown?: () => string
  prepareExternalAction?: () => boolean
  onMarkdownChange?: (markdown: string) => void
  deferSourceStatistics?: boolean
}

export function FooterBar({
  editor,
  outlineOpen,
  onToggleOutline,
  viewMode = 'visual',
  onToggleViewMode,
  sourceMarkdown,
  getMarkdown,
  prepareExternalAction,
  onMarkdownChange,
  deferSourceStatistics = false,
}: FooterBarProps) {
  const activeFilePath = useArticleStore((state) => state.activeFilePath)
  const isMobile = isMobileDevice()
  const showEditorStats = useSettingStore((state) => state.showEditorStats)
  const primaryBackupMethod = useSettingStore((state) => state.primaryBackupMethod)
  const tSourceMode = useTranslations('settings.editor.sourceMode')
  const fileName = activeFilePath
    ? activeFilePath.split('/').pop() || activeFilePath
    : '未命名'

  if (isMobile) {
    return (
      <div className="mobile-editor-footer h-7 flex items-center justify-between gap-3 px-3 border-t border-border bg-background text-xs text-muted-foreground">
        <div className="min-w-0 flex-1 flex items-center gap-2 overflow-hidden">
          <FileText className="size-3.5 shrink-0" />
          <div className="min-w-0 flex items-center gap-1.5 overflow-hidden">
            <span className="block min-w-0 truncate font-medium text-foreground/90">{fileName}</span>
            {showEditorStats && !deferSourceStatistics ? (
              <div className="shrink-0">
                <WordCount editor={editor} sourceMarkdown={sourceMarkdown} compact />
              </div>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {onToggleViewMode ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title={viewMode === 'source' ? tSourceMode('visual') : tSourceMode('source')}
              aria-label={viewMode === 'source' ? tSourceMode('visual') : tSourceMode('source')}
              onClick={onToggleViewMode}
            >
              {viewMode === 'source' ? <Eye /> : <Code2 />}
            </Button>
          ) : null}
          {primaryBackupMethod !== 'noteGenServer' ? (
            <>
              <HistorySheet
                editor={editor}
                prepareExternalAction={prepareExternalAction}
                onMarkdownChange={onMarkdownChange}
              />
              <SyncButton
                getMarkdown={getMarkdown}
                prepareExternalAction={prepareExternalAction}
              />
              <PullButton
                editor={editor}
                markdown={sourceMarkdown}
                getMarkdown={getMarkdown}
                prepareExternalAction={prepareExternalAction}
                onMarkdownChange={onMarkdownChange}
              />
            </>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="h-6 flex items-center justify-between px-3 border-t border-border bg-background text-xs text-muted-foreground">
      {/* Left side: Word count, Copy, Export, Outline */}
      <div className="flex items-center gap-1">
        {showEditorStats && !deferSourceStatistics ? (
          <WordCount editor={editor} sourceMarkdown={sourceMarkdown} />
        ) : null}
        {onToggleViewMode ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={viewMode === 'source' ? tSourceMode('visual') : tSourceMode('source')}
            aria-label={viewMode === 'source' ? tSourceMode('visual') : tSourceMode('source')}
            onClick={onToggleViewMode}
          >
            {viewMode === 'source' ? <Eye /> : <Code2 />}
          </Button>
        ) : null}
        <CopyButton editor={editor} markdown={sourceMarkdown} getMarkdown={getMarkdown} />
        <ExportButton editor={editor} markdown={sourceMarkdown} getMarkdown={getMarkdown} />
        {onToggleOutline ? (
          <OutlineToggle
            editor={editor}
            outlineOpen={outlineOpen}
            onToggleOutline={onToggleOutline}
          />
        ) : null}
      </div>

      {/* Right side: Sync tools */}
      <SyncTools
        editor={editor}
        markdown={sourceMarkdown}
        getMarkdown={getMarkdown}
        prepareExternalAction={prepareExternalAction}
        onMarkdownChange={onMarkdownChange}
      />
    </div>
  )
}

export default FooterBar
