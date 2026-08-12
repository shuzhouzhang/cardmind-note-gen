import { CircleAlert, CloudCheck, CloudDownload, CloudUpload, LoaderCircle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { getSyncObjectStatus } from '@/db/note-gen-server-sync-index'
import emitter from '@/lib/emitter'
import { getNoteGenServerSyncContext, subscribeNoteGenServerBackgroundStatus } from '@/lib/sync/note-gen-server-background'

import type { FileTreeSyncStatus } from './file-tree-action-policy'

export function FileTreeDecorations({
  iconSize,
  knowledge,
  syncStatus,
  syncTitle,
  alwaysShowSynced = false,
  relativePath,
}: {
  iconSize: string
  knowledge?: ReactNode
  syncStatus: FileTreeSyncStatus
  syncTitle: string
  alwaysShowSynced?: boolean
  relativePath?: string
}) {
  const [objectSyncStatus, setObjectSyncStatus] = useState<'conflict' | 'pending' | 'synced' | null>(null)
  const isMarkdown = Boolean(relativePath && /\.(?:md|markdown)$/i.test(relativePath))
  useEffect(() => {
    if (!relativePath) return
    let refreshGeneration = 0
    let disposed = false
    const refresh = () => {
      const generation = ++refreshGeneration
      const context = getNoteGenServerSyncContext()
      if (!context) return setObjectSyncStatus(null)
      void getSyncObjectStatus(context.syncScopeId, relativePath).then(status => {
        if (!disposed && generation === refreshGeneration) setObjectSyncStatus(status)
      })
    }
    refresh()
    const unsubscribe = subscribeNoteGenServerBackgroundStatus(refresh)
    emitter.on('note-gen-server-conflict-created', refresh)
    emitter.on('note-gen-server-conflict-resolved', refresh)
    return () => {
      disposed = true
      unsubscribe()
      emitter.off('note-gen-server-conflict-created', refresh)
      emitter.off('note-gen-server-conflict-resolved', refresh)
    }
  }, [relativePath])
  const syncDecoration = (() => {
    if (syncStatus === 'loading') {
      return <LoaderCircle className={`${iconSize} animate-spin text-muted-foreground`} />
    }
    if (syncStatus === 'error') {
      return <CircleAlert className={`${iconSize} text-destructive`} />
    }
    if (syncStatus === 'dirty') {
      return <CloudUpload className={`${iconSize} text-muted-foreground`} />
    }
    if (syncStatus === 'remote-only') {
      return <CloudDownload className={`${iconSize} text-muted-foreground`} />
    }
    if (syncStatus === 'synced') {
      return (
        <CloudCheck
          className={alwaysShowSynced
            ? `${iconSize} text-muted-foreground`
            : `${iconSize} text-muted-foreground opacity-0 transition-opacity group-hover:opacity-40`}
        />
      )
    }
    return null
  })()

  return (
    <span className="ml-auto flex min-w-5 shrink-0 items-center justify-end gap-1 pr-1">
      {knowledge}
      {objectSyncStatus === 'conflict' && isMarkdown ? (
        <button type="button" title="在 Markdown 编辑器中处理同步冲突"
          className="inline-flex shrink-0 items-center justify-center rounded-sm hover:bg-destructive/10"
          onClick={() => window.setTimeout(() => {
            emitter.emit('sync-markdown-conflict-open', { path: relativePath })
          }, 100)}>
          <CircleAlert className={`${iconSize} text-destructive`} aria-label="需要解决同步冲突" />
        </button>
      ) : objectSyncStatus === 'conflict' ? (
        <CircleAlert className={`${iconSize} text-destructive`} aria-label="需要解决同步冲突" />
      ) : null}
      {objectSyncStatus === 'pending' ? <CloudUpload className={`${iconSize} text-muted-foreground`} aria-label="待同步" /> : null}
      {syncDecoration ? (
        <span
          className="inline-flex shrink-0 items-center justify-center"
          aria-label={syncTitle}
          title={syncTitle}
        >
          {syncDecoration}
        </span>
      ) : null}
    </span>
  )
}
