'use client'
import { Editor } from '@tiptap/react'
import { useTranslations } from 'next-intl'
import { SyncButton } from './sync-button'
import { PullButton } from './pull-button'
import { HistorySheet } from './history-sheet'
import { isSyncConfigured } from '@/lib/sync/sync-manager'
import { useEffect, useState } from 'react'
import { useSettingsDialogStore } from '@/stores/settings-dialog'
import useSettingStore from '@/stores/setting'
import { useShallow } from 'zustand/react/shallow'

interface SyncToolsProps {
  editor: Editor
  markdown?: string
  getMarkdown?: () => string
  prepareExternalAction?: () => boolean
  onMarkdownChange?: (markdown: string) => void
}

export function SyncTools({ editor, markdown, getMarkdown, prepareExternalAction, onMarkdownChange }: SyncToolsProps) {
  const t = useTranslations('common')
  const { openSettings } = useSettingsDialogStore()
  const [configured, setConfigured] = useState(false)
  const syncContext = useSettingStore(useShallow(state => ({
    workspacePath: state.workspacePath,
    primaryBackupMethod: state.primaryBackupMethod,
    githubCustomSyncRepo: state.githubCustomSyncRepo,
    giteeCustomSyncRepo: state.giteeCustomSyncRepo,
    gitlabCustomSyncRepo: state.gitlabCustomSyncRepo,
    giteaCustomSyncRepo: state.giteaCustomSyncRepo,
  })))

  useEffect(() => {
    isSyncConfigured().then(setConfigured)
  }, [syncContext])

  const handleConfigureSync = () => {
    openSettings('sync')
  }

  if (syncContext.primaryBackupMethod === 'noteGenServer') return null

  if (configured) {
    return (
      <div className="flex items-center gap-1">
        <HistorySheet editor={editor} prepareExternalAction={prepareExternalAction} onMarkdownChange={onMarkdownChange} />
        <SyncButton getMarkdown={getMarkdown} prepareExternalAction={prepareExternalAction} />
        <PullButton
          editor={editor}
          markdown={markdown}
          getMarkdown={getMarkdown}
          prepareExternalAction={prepareExternalAction}
          onMarkdownChange={onMarkdownChange}
        />
      </div>
    )
  }

  return (
    <button
      onClick={handleConfigureSync}
      className="flex items-center gap-0.5 px-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
      title={t('configureSync')}
    >
      <span>{t('configureSync')}</span>
    </button>
  )
}

export default SyncTools
