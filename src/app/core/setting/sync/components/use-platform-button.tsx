'use client'

import { Check, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  getSyncHealthSnapshot,
  isSyncFullyConverged,
  type SyncHealthSnapshot,
} from '@/db/note-gen-server-sync-index'
import {
  getNoteGenServerSyncContext,
  syncNoteGenServerNow,
} from '@/lib/sync/note-gen-server-background'
import useSettingStore from '@/stores/setting'
import type { PrimarySyncPlatform } from '@/types/sync'

interface UsePlatformButtonProps {
  platform: PrimarySyncPlatform
  disabled?: boolean
  size?: 'default' | 'sm'
}

export function UsePlatformButton({
  platform,
  disabled = false,
  size = 'sm',
}: UsePlatformButtonProps) {
  const t = useTranslations()
  const serverT = useTranslations('settings.sync.noteGenServer.platformSwitch')
  const { primaryBackupMethod, setPrimaryBackupMethod } = useSettingStore()
  const [isSaving, setIsSaving] = useState(false)
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false)
  const [pendingHealth, setPendingHealth] = useState<SyncHealthSnapshot | null>(null)
  const [switchError, setSwitchError] = useState('')
  const isCurrent = primaryBackupMethod === platform

  async function handleClick() {
    try {
      if (primaryBackupMethod === 'noteGenServer' && platform !== 'noteGenServer') {
        const context = getNoteGenServerSyncContext()
        if (!context) {
          setSwitchError(serverT('connectionUnavailable'))
          setPendingHealth(null)
          setSwitchConfirmOpen(true)
          return
        }
        const health = await getSyncHealthSnapshot(context.syncScopeId)
        if (!isSyncFullyConverged(health)) {
          setSwitchError('')
          setPendingHealth(health)
          setSwitchConfirmOpen(true)
          return
        }
        await syncThenSwitch()
        return
      }
      await switchPlatform()
    } catch (cause) {
      showSwitchError(cause)
      if (primaryBackupMethod === 'noteGenServer' && platform !== 'noteGenServer') {
        setPendingHealth(null)
        setSwitchConfirmOpen(true)
      }
    }
  }

  async function switchPlatform(): Promise<boolean> {
    setIsSaving(true)
    try {
      await setPrimaryBackupMethod(platform)
      return true
    } catch (cause) {
      showSwitchError(cause)
      return false
    } finally {
      setIsSaving(false)
    }
  }

  async function syncThenSwitch() {
    setIsSaving(true)
    setSwitchError('')
    try {
      const context = getNoteGenServerSyncContext()
      if (!context) throw new Error(serverT('connectionUnavailable'))
      const attempt = await syncNoteGenServerNow()
      const refreshedContext = getNoteGenServerSyncContext()
      if (!refreshedContext) throw new Error(serverT('connectionUnavailable'))
      const health = await getSyncHealthSnapshot(refreshedContext.syncScopeId)
      const confirmedThisAttempt = health.lastServerConfirmedAt !== null
        && health.lastServerConfirmedAt >= attempt.startedAt
      if (!attempt.attempted || attempt.status.phase !== 'synced'
        || attempt.result?.converged !== true || !confirmedThisAttempt
        || !isSyncFullyConverged(health)) {
        setPendingHealth(health)
        setSwitchError(serverT('notConfirmed'))
        setSwitchConfirmOpen(true)
        return
      }
      await setPrimaryBackupMethod(platform)
      setPendingHealth(null)
      setSwitchConfirmOpen(false)
    } catch (cause) {
      setSwitchError(cause instanceof Error ? cause.message : String(cause))
      setSwitchConfirmOpen(true)
    } finally {
      setIsSaving(false)
    }
  }

  function showSwitchError(cause: unknown) {
    const message = errorMessage(cause)
    setSwitchError(message)
    toast.error(serverT('switchFailed'), { description: message })
  }

  return (
    <>
      <Button
        type="button"
        variant={isCurrent ? 'secondary' : 'default'}
        size={size}
        disabled={disabled || isCurrent || isSaving}
        onClick={() => void handleClick()}
      >
        {isSaving ? (
          <Loader2 data-icon="inline-start" className="animate-spin" />
        ) : isCurrent ? (
          <Check data-icon="inline-start" />
        ) : null}
        {isCurrent
          ? t('settings.sync.currentPlatform')
          : t('settings.sync.setCurrentPlatform')}
      </Button>
      <AlertDialog open={switchConfirmOpen} onOpenChange={open => {
        if (!isSaving) {
          setSwitchConfirmOpen(open)
          if (!open) setPendingHealth(null)
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{serverT('title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {serverT('description', { count: pendingHealth ? pendingWorkCount(pendingHealth) : 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingHealth ? (
            <div className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm">
              <span>{serverT('outgoing')}</span><span className="text-right">{pendingHealth.pendingMutations + pendingHealth.pendingOutbox + pendingHealth.blockedOutbox}</span>
              <span>{serverT('incoming')}</span><span className="text-right">{pendingHealth.pendingInbox + pendingHealth.failedInbox}</span>
              <span>{serverT('attachments')}</span><span className="text-right">{pendingHealth.pendingTransfers + pendingHealth.failedTransfers + pendingHealth.unresolvedConflicts}</span>
            </div>
          ) : null}
          {switchError ? <p className="text-sm text-destructive">{switchError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>{serverT('cancel')}</AlertDialogCancel>
            <Button type="button" variant="outline" disabled={isSaving} onClick={() => void (async () => {
              if (await switchPlatform()) {
                setPendingHealth(null)
                setSwitchConfirmOpen(false)
              }
            })()}>
              {serverT('keepAndSwitch')}
            </Button>
            <Button type="button" disabled={isSaving} onClick={() => void syncThenSwitch()}>
              {isSaving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              {serverT('syncAndSwitch')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function pendingWorkCount(health: SyncHealthSnapshot): number {
  return health.pendingMutations + health.pendingOutbox + health.blockedOutbox
    + health.pendingInbox + health.failedInbox + health.unresolvedConflicts
    + health.pendingTransfers + health.failedTransfers
}
