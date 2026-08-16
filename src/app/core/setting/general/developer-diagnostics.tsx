'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { Store } from '@tauri-apps/plugin-store'
import { Check, Copy, Download, RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  getNoteGenServerBackgroundReadiness,
  getNoteGenServerDiagnosticSummary,
  subscribeNoteGenServerBackgroundStatus,
  type NoteGenServerBackgroundStatus,
  type NoteGenServerDiagnosticSummary,
} from '@/lib/sync/note-gen-server-background'
import { discoverServer, loadServerProfile } from '@/lib/sync/note-gen-server'
import {
  getRuntimeLogs,
  sanitizeDiagnosticValue,
} from '@/lib/diagnostics/runtime-log-buffer'
import { writeClipboardText } from '@/lib/clipboard'
import useSettingStore from '@/stores/setting'

interface DiagnosticState {
  appVersion: string | null
  serverVersion: string | null
  deploymentMode: 'hosted' | 'self-hosted' | null
  summary: NoteGenServerDiagnosticSummary
  connected: boolean
}

export function DeveloperDiagnostics() {
  const t = useTranslations('settings.sync.noteGenServer.diagnostics')
  const enabled = useSettingStore(state => (
    state.developerMode && state.experimentalFeatures.diagnosticsAndLogs
  ))
  const [status, setStatus] = useState<NoteGenServerBackgroundStatus>({
    phase: 'idle',
    updatedAt: Date.now(),
  })
  const [diagnostics, setDiagnostics] = useState<DiagnosticState | null>(null)
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState(false)

  const refresh = useCallback(async () => {
    const [summary, appVersion, profile] = await Promise.all([
      getNoteGenServerDiagnosticSummary(),
      getVersion().catch(() => null),
      loadServerProfile(),
    ])
    const capabilities = profile
      ? await discoverServer(profile.baseUrl).catch(() => null)
      : null
    const readiness = getNoteGenServerBackgroundReadiness()
    setDiagnostics({
      appVersion,
      serverVersion: capabilities?.serverVersion ?? null,
      deploymentMode: capabilities?.deploymentMode ?? null,
      summary,
      connected: readiness.connected && readiness.unlocked,
    })
  }, [])

  useEffect(() => subscribeNoteGenServerBackgroundStatus(setStatus), [])

  useEffect(() => {
    if (!enabled) return
    void refresh().catch(error => console.warn('Failed to load diagnostics:', error))
  }, [enabled, refresh])

  const diagnosticPayload = useMemo(() => ({
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    appVersion: diagnostics?.appVersion ?? null,
    runtime: {
      phase: status.phase,
      updatedAt: status.updatedAt,
    },
    selfHostedSync: diagnostics
      ? {
          configured: diagnostics.summary.server.configured,
          connected: diagnostics.connected,
          serverVersion: diagnostics.serverVersion,
          deploymentMode: diagnostics.deploymentMode,
          summary: diagnostics.summary,
        }
      : null,
  }), [diagnostics, status.phase, status.updatedAt])

  if (!enabled) return null

  const summary = diagnostics?.summary ?? null
  const pendingSend = summary
    ? summary.queue.pendingMutations + summary.queue.pendingOutbox
      + summary.queue.blockedOutbox + summary.queue.pendingTransfers
    : 0
  const pendingReceive = summary
    ? summary.queue.pendingInbox + summary.queue.failedInbox
    : 0
  const recentError = summary?.status.error
    ?? summary?.status.problems[0]?.lastError
    ?? summary?.acknowledgement.error
    ?? null
  const connectionLabel = !summary?.server.configured
    ? t('notConfigured')
    : diagnostics?.connected
      ? t('connected')
      : t('disconnected')

  async function handleCopy() {
    const text = JSON.stringify(sanitizeDiagnosticValue(diagnosticPayload), null, 2)
    await writeClipboardText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  async function handleExportLogs() {
    setExporting(true)
    try {
      const [syncLogStore, timingLogStore] = await Promise.all([
        Store.load('sync_logs.json'),
        Store.load('sync_timing_logs.json'),
      ])
      const [syncLogs, timingLogs] = await Promise.all([
        syncLogStore.get<unknown[]>('logs'),
        timingLogStore.get<unknown[]>('entries'),
      ])
      downloadJson(`notegen-redacted-diagnostics-${Date.now()}.json`, {
        ...(sanitizeDiagnosticValue(diagnosticPayload) as object),
        runtimeLogs: getRuntimeLogs(),
        syncLogs: sanitizeDiagnosticValue(syncLogs ?? []),
        syncTimingLogs: sanitizeDiagnosticValue(timingLogs ?? []),
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('combinedTitle')}</CardTitle>
        <CardDescription>{t('combinedDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
          <span className="text-muted-foreground">{t('appVersion')}</span>
          <span className="text-right font-mono text-xs">{diagnostics?.appVersion ?? t('unknown')}</span>
          <span className="text-muted-foreground">{t('connectionStatus')}</span>
          <span className="text-right font-medium">{connectionLabel}</span>
          <span className="text-muted-foreground">{t('serverVersion')}</span>
          <span className="text-right font-mono text-xs">{diagnostics?.serverVersion ?? t('unknown')}</span>
          <span className="text-muted-foreground">{t('pendingSend')}</span>
          <span className="text-right font-medium">{pendingSend}</span>
          <span className="text-muted-foreground">{t('pendingReceive')}</span>
          <span className="text-right font-medium">{pendingReceive}</span>
          <span className="text-muted-foreground">{t('recentError')}</span>
          <span className="max-w-[320px] break-words text-right text-xs">{recentError ?? t('none')}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw data-icon="inline-start" />{t('refresh')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? t('copied') : t('copy')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleExportLogs()} disabled={exporting}>
            <Download data-icon="inline-start" />
            {exporting ? t('exporting') : t('exportLogs')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function downloadJson(fileName: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
