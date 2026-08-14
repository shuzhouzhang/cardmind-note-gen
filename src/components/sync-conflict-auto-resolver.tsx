'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import {
  dismissPendingSyncConflict,
  enqueueSyncCommand,
  listSyncConflicts,
  type SyncConflict,
} from '@/db/note-gen-server-sync-index'
import emitter from '@/lib/emitter'
import { materializeMerge, mergeMarkdownThreeWay } from '@/lib/sync/markdown-three-way-merge'
import {
  getNoteGenServerSyncContext,
  syncNoteGenServerNow,
  subscribeNoteGenServerBackgroundStatus,
} from '@/lib/sync/note-gen-server-background'
import { resolveMarkdownSyncConflict } from '@/components/sync-conflict-dialog'

const AUTOMATIC_MARKDOWN_CONFLICT_TYPES = new Set([
  'markdown-three-way',
  'initial-import',
])

interface MarkdownConflictPayload {
  base: string
  local: string
  remote: string | null
}

/**
 * Personal workspaces should not stop syncing for ordinary text conflicts.
 * Only non-overlapping edits are safe to merge automatically. Overlapping
 * blocks stay durable and visible until the user explicitly reviews them.
 */
export function SyncConflictAutoResolver() {
  const running = useRef(false)
  const rerun = useRef(false)
  const attempted = useRef(new Set<string>())

  useEffect(() => {
    let disposed = false

    const resolvePending = async () => {
      if (running.current) {
        rerun.current = true
        return
      }
      running.current = true
      try {
        do {
          rerun.current = false
          const context = getNoteGenServerSyncContext()
          if (!context) return
          const conflicts = await listSyncConflicts(context.syncScopeId)
          const candidates = conflicts.filter(conflict => (
            isAutomaticMarkdownConflict(conflict) && !attempted.current.has(conflict.conflictId)
          ))
          const automaticallyDismissed = conflicts.filter(conflict => (
            (conflict.type === 'structured-concurrent'
              || conflict.type === 'reference-target-deleted'
              || isLocalDeleteVsEdit(conflict))
            && conflict.createdSequence !== '0'
            && !attempted.current.has(conflict.conflictId)
          ))
          const locallyDismissed = conflicts.filter(conflict => (
            conflict.type === 'structured-concurrent'
            && conflict.createdSequence === '0'
            && !attempted.current.has(conflict.conflictId)
          ))
          const handledObjects = new Set<string>()

          try {
            for (const conflict of locallyDismissed) {
              attempted.current.add(conflict.conflictId)
              await dismissPendingSyncConflict(context.syncScopeId, conflict.conflictId)
            }
            for (const conflict of automaticallyDismissed) {
              attempted.current.add(conflict.conflictId)
              await enqueueSyncCommand({ scopeId: context.syncScopeId, command: {
                type: 'resolve-conflict', commandId: crypto.randomUUID(),
                conflictId: conflict.conflictId,
                expectedCreatedSequence: conflict.createdSequence,
              } })
            }
            if (automaticallyDismissed.length > 0) await syncNoteGenServerNow()
          } catch (error) {
            console.warn('Automatic structured conflict cleanup deferred:', error)
          }

          for (const conflict of [...candidates].reverse()) {
            if (disposed || handledObjects.has(conflict.objectId)) continue
            handledObjects.add(conflict.objectId)
            attempted.current.add(conflict.conflictId)
            const objectConflicts = candidates.filter(item => item.objectId === conflict.objectId)
            const hasUnsafeConflict = objectConflicts.some(item => {
              const candidatePayload = parseMarkdownPayload(item.payloadJson)
              return !candidatePayload || candidatePayload.remote === null
                || mergeMarkdownThreeWay(
                  candidatePayload.base, candidatePayload.local, candidatePayload.remote,
                ).some(part => part.type === 'conflict')
            })
            if (hasUnsafeConflict) continue
            const payload = parseMarkdownPayload(conflict.payloadJson)
            if (!payload || payload.remote === null) continue

            const parts = mergeMarkdownThreeWay(payload.base, payload.local, payload.remote)
            const localChoices: Record<string, string> = {}
            const content = materializeMerge(parts, localChoices)
            const related = objectConflicts.filter(item => (
              item.objectId === conflict.objectId && item.conflictId !== conflict.conflictId
            ))

            try {
              await resolveMarkdownSyncConflict({ conflict, content, relatedConflicts: related })
              const remaining = await listSyncConflicts(context.syncScopeId)
              const resolved = !remaining.some(item => item.conflictId === conflict.conflictId)
              if (!disposed && resolved) {
                toast.success('已自动合并来自其他设备的修改')
              }
            } catch (error) {
              // Leave the durable conflict untouched. The existing conflict UI
              // remains the fallback when keys/documents are not ready yet.
              console.warn('Automatic Markdown conflict resolution deferred:', error)
            }
          }
        } while (!disposed && rerun.current)
      } finally {
        running.current = false
      }
    }

    const handleConflictCreated = (event: unknown) => {
      if (event && typeof event === 'object' && 'conflictId' in event) {
        attempted.current.delete(String((event as { conflictId: unknown }).conflictId))
      }
      void resolvePending()
    }
    emitter.on('note-gen-server-conflict-created', handleConflictCreated)
    const unsubscribeStatus = subscribeNoteGenServerBackgroundStatus(status => {
      if (status.phase !== 'idle' && status.phase !== 'syncing') void resolvePending()
    })
    void resolvePending()
    return () => {
      disposed = true
      emitter.off('note-gen-server-conflict-created', handleConflictCreated)
      unsubscribeStatus()
    }
  }, [])

  return null
}

function isAutomaticMarkdownConflict(conflict: SyncConflict): boolean {
  return conflict.kind === 'note'
    && conflict.createdSequence !== '0'
    && AUTOMATIC_MARKDOWN_CONFLICT_TYPES.has(conflict.type)
}

function parseMarkdownPayload(value: string): MarkdownConflictPayload | null {
  try {
    const payload = JSON.parse(value) as Record<string, unknown>
    return {
      base: String(payload.base ?? ''),
      local: String(payload.local ?? ''),
      remote: payload.remote === null ? null : String(payload.remote ?? ''),
    }
  } catch {
    return null
  }
}

function isLocalDeleteVsEdit(conflict: SyncConflict): boolean {
  if (conflict.type !== 'delete-vs-edit') return false
  try {
    const payload = JSON.parse(conflict.payloadJson) as Record<string, unknown>
    return payload.deletionRequestedLocally === true
  } catch {
    return false
  }
}
