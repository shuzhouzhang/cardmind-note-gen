'use client'

import { checkSyncRepoState, getUserInfo } from "@/lib/sync/github";
import { useEffect, useRef } from "react";
import { useState } from "react";
import { AlertTriangle, Check, CloudOff, LoaderCircle, Pause, RefreshCw } from "lucide-react";
import useSettingStore from "@/stores/setting";
import { SyncStateEnum, UserInfo } from "@/lib/sync/github.types";
import useSyncStore from "@/stores/sync";
import { getOptionalSyncRepoName } from "@/lib/sync/repo-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SyncConflictDialog } from "@/components/sync-conflict-dialog";
import { listSyncConflicts } from "@/db/note-gen-server-sync-index";
import emitter from "@/lib/emitter";
import { isMobileDevice } from "@/lib/check";
import useArticleStore from "@/stores/article";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSettingsDialogStore } from "@/stores/settings-dialog";
import { toast } from "sonner";
import {
  getNoteGenServerSyncContext,
  getNoteGenServerDiagnosticSummary,
  subscribeNoteGenServerBackgroundStatus,
  retryNoteGenServerBackgroundSync,
  triggerNoteGenServerBackgroundSync,
  type NoteGenServerBackgroundStatus,
} from "@/lib/sync/note-gen-server-background";

const TRANSIENT_STATUS_DISPLAY_DELAY_MS = 500
const delayedStatusPhases = new Set<NoteGenServerBackgroundStatus['phase']>([
  'saving',
  'pending',
  'syncing',
])

export default function AppStatus({ compact = false }: { compact?: boolean }) {
  const statusRequestRef = useRef(0)
  const {
    accessToken,
    giteeAccessToken,
    gitlabAccessToken,
    giteaAccessToken,
    primaryBackupMethod,
    workspacePath,
    githubCustomSyncRepo,
    giteeCustomSyncRepo,
    gitlabCustomSyncRepo,
    giteaCustomSyncRepo,
    setGithubUsername,
    setGitlabUsername,
    setGiteaUsername,
  } = useSettingStore()
  const { 
    setUserInfo, 
    setGiteeUserInfo,
    setGitlabUserInfo,
    setGiteaUserInfo,
    setSyncRepoState,
    setSyncRepoInfo,
    setGiteeSyncRepoState,
    setGiteeSyncRepoInfo,
    setGitlabSyncProjectState,
    setGitlabSyncProjectInfo,
    setGiteaSyncRepoState,
    setGiteaSyncRepoInfo
  } = useSyncStore()

  // 获取当前主要备份方式的用户信息
  async function handleGetUserInfo(requestId: number) {
    try {
      if (primaryBackupMethod === 'github') {
        if (accessToken) {
          setSyncRepoInfo(undefined)
          setSyncRepoState(SyncStateEnum.checking)
          const res = await getUserInfo()
          if (requestId !== statusRequestRef.current) return
          if (res) {
            setUserInfo(res.data as UserInfo)
            setGithubUsername(res.data.login)
          }
          await checkGithubRepos(requestId)
        }
      } else if (primaryBackupMethod === 'gitee') {
        if (giteeAccessToken) {
          // 获取 Gitee 用户信息
          setGiteeSyncRepoInfo(undefined)
          setGiteeSyncRepoState(SyncStateEnum.checking)
          const res = await import('@/lib/sync/gitee').then(module => module.getUserInfo())
          if (requestId !== statusRequestRef.current) return
          if (res) {
            setGiteeUserInfo(res)
          }
          // 注意：checkGiteeRepos 内部已经包含了 getUserInfo 调用，但这里保留以确保用户信息及时更新
          await checkGiteeRepos(requestId)
        }
      } else if (primaryBackupMethod === 'gitlab') {
        if (gitlabAccessToken) {
          // 获取 Gitlab 用户信息
          setGitlabSyncProjectInfo(undefined)
          setGitlabSyncProjectState(SyncStateEnum.checking)
          const { getUserInfo } = await import('@/lib/sync/gitlab')
          const res = await getUserInfo()
          if (requestId !== statusRequestRef.current) return
          if (res) {
            setGitlabUserInfo(res)
            setGitlabUsername(res.username)
          }
          await checkGitlabProjects(requestId)
        }
      } else if (primaryBackupMethod === 'gitea') {
        if (giteaAccessToken) {
          // 获取 Gitea 用户信息
          setGiteaSyncRepoInfo(undefined)
          setGiteaSyncRepoState(SyncStateEnum.checking)
          const { getUserInfo } = await import('@/lib/sync/gitea')
          const res = await getUserInfo()
          if (requestId !== statusRequestRef.current) return
          if (res) {
            setGiteaUserInfo(res)
            setGiteaUsername(res.username)
          }
          await checkGiteaRepos(requestId)
        }
      } else {
        setUserInfo(undefined)
        setGiteeUserInfo(undefined)
        setGitlabUserInfo(undefined)
        setGiteaUserInfo(undefined)
      }
    } catch (err) {
      console.error('Failed to get user info:', err)
      if (requestId !== statusRequestRef.current) return

      if (primaryBackupMethod === 'github') {
        setSyncRepoInfo(undefined)
        setSyncRepoState(SyncStateEnum.fail)
      } else if (primaryBackupMethod === 'gitee') {
        setGiteeSyncRepoInfo(undefined)
        setGiteeSyncRepoState(SyncStateEnum.fail)
      } else if (primaryBackupMethod === 'gitlab') {
        setGitlabSyncProjectInfo(undefined)
        setGitlabSyncProjectState(SyncStateEnum.fail)
      } else if (primaryBackupMethod === 'gitea') {
        setGiteaSyncRepoInfo(undefined)
        setGiteaSyncRepoState(SyncStateEnum.fail)
      }
    }
  }

  // 检查 GitHub 仓库状态（仅检查，不创建）
  async function checkGithubRepos(requestId: number) {
    try {
      // 检查同步仓库状态
      const githubRepo = await getOptionalSyncRepoName('github')
      if (requestId !== statusRequestRef.current) return
      if (!githubRepo) {
        setSyncRepoInfo(undefined)
        setSyncRepoState(SyncStateEnum.fail)
        return
      }
      const syncRepo = await checkSyncRepoState(githubRepo)
      if (requestId !== statusRequestRef.current) return
      if (syncRepo) {
        setSyncRepoInfo(syncRepo)
        setSyncRepoState(SyncStateEnum.success)
      } else {
        setSyncRepoInfo(undefined)
        setSyncRepoState(SyncStateEnum.fail)
      }
    } catch (err) {
      console.error('Failed to check GitHub repos:', err)
      if (requestId === statusRequestRef.current) setSyncRepoState(SyncStateEnum.fail)
    }
  }
  
  // 检查 Gitlab 项目状态（仅检查，不创建）
  async function checkGitlabProjects(requestId: number) {
    try {
      const { checkSyncProjectState } = await import('@/lib/sync/gitlab')
      
      // 检查同步项目状态
      const gitlabRepo = await getOptionalSyncRepoName('gitlab')
      if (requestId !== statusRequestRef.current) return
      if (!gitlabRepo) {
        setGitlabSyncProjectInfo(undefined)
        setGitlabSyncProjectState(SyncStateEnum.fail)
        return
      }
      const syncProject = await checkSyncProjectState(gitlabRepo)
      if (requestId !== statusRequestRef.current) return
      if (syncProject) {
        setGitlabSyncProjectInfo(syncProject)
        setGitlabSyncProjectState(SyncStateEnum.success)
      } else {
        setGitlabSyncProjectInfo(undefined)
        setGitlabSyncProjectState(SyncStateEnum.fail)
      }
    } catch (err) {
      console.error('Failed to check Gitlab projects:', err)
      if (requestId === statusRequestRef.current) setGitlabSyncProjectState(SyncStateEnum.fail)
    }
  }
  
  // 检查 Gitea 仓库状态（仅检查，不创建）
  async function checkGiteaRepos(requestId: number) {
    try {
      const { checkSyncRepoState } = await import('@/lib/sync/gitea')
      
      // 检查同步仓库状态
      const giteaRepo = await getOptionalSyncRepoName('gitea')
      if (requestId !== statusRequestRef.current) return
      if (!giteaRepo) {
        setGiteaSyncRepoInfo(undefined)
        setGiteaSyncRepoState(SyncStateEnum.fail)
        return
      }
      const syncRepo = await checkSyncRepoState(giteaRepo)
      if (requestId !== statusRequestRef.current) return
      if (syncRepo) {
        setGiteaSyncRepoInfo(syncRepo)
        setGiteaSyncRepoState(SyncStateEnum.success)
      } else {
        setGiteaSyncRepoInfo(undefined)
        setGiteaSyncRepoState(SyncStateEnum.fail)
      }
    } catch (err) {
      console.error('Failed to check Gitea repos:', err)
      if (requestId === statusRequestRef.current) setGiteaSyncRepoState(SyncStateEnum.fail)
    }
  }
  
  // 检查 Gitee 仓库状态（仅检查，不创建）
  async function checkGiteeRepos(requestId: number) {
    try {
      const { checkSyncRepoState, getUserInfo } = await import('@/lib/sync/gitee')
      
      // 先获取用户信息，确保 giteeUsername 已设置
      await getUserInfo();
      if (requestId !== statusRequestRef.current) return
      
      // 检查同步仓库状态
      const giteeRepo = await getOptionalSyncRepoName('gitee')
      if (requestId !== statusRequestRef.current) return
      if (!giteeRepo) {
        setGiteeSyncRepoInfo(undefined)
        setGiteeSyncRepoState(SyncStateEnum.fail)
        return
      }
      const syncRepo = await checkSyncRepoState(giteeRepo)
      if (requestId !== statusRequestRef.current) return
      if (syncRepo) {
        setGiteeSyncRepoInfo(syncRepo)
        setGiteeSyncRepoState(SyncStateEnum.success)
      } else {
        setGiteeSyncRepoInfo(undefined)
        setGiteeSyncRepoState(SyncStateEnum.fail)
      }
    } catch (err) {
      console.error('Failed to check Gitee repos:', err)
      if (requestId === statusRequestRef.current) setGiteeSyncRepoState(SyncStateEnum.fail)
    }
  }

  // 监听 token 变化，获取用户信息
  useEffect(() => {
    const requestId = ++statusRequestRef.current
    if (accessToken || giteeAccessToken || gitlabAccessToken || giteaAccessToken) {
      void handleGetUserInfo(requestId)
    }

    return () => {
      if (statusRequestRef.current === requestId) statusRequestRef.current += 1
    }
  }, [
    accessToken,
    giteeAccessToken,
    gitlabAccessToken,
    giteaAccessToken,
    primaryBackupMethod,
    workspacePath,
    githubCustomSyncRepo,
    giteeCustomSyncRepo,
    gitlabCustomSyncRepo,
    giteaCustomSyncRepo,
  ])

  return primaryBackupMethod === 'noteGenServer' ? <NoteGenServerStatus compact={compact} /> : null
}

function NoteGenServerStatus({ compact }: { compact: boolean }) {
  const t = useTranslations('settings.sync.noteGenServer.statusPanel')
  const router = useRouter()
  const isMobile = isMobileDevice()
  const [status, setStatus] = useState<NoteGenServerBackgroundStatus>({ phase: 'idle', updatedAt: Date.now() })
  const [conflictsOpen, setConflictsOpen] = useState(false)
  const [mobileConflictMessage, setMobileConflictMessage] = useState<string | null>(null)
  useEffect(() => {
    let delayedStatusTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeNoteGenServerBackgroundStatus(nextStatus => {
      if (delayedStatusTimer) {
        clearTimeout(delayedStatusTimer)
        delayedStatusTimer = null
      }
      if (delayedStatusPhases.has(nextStatus.phase)) {
        delayedStatusTimer = setTimeout(() => {
          delayedStatusTimer = null
          setStatus(nextStatus)
        }, TRANSIENT_STATUS_DISPLAY_DELAY_MS)
        return
      }
      setStatus(nextStatus)
    })
    return () => {
      if (delayedStatusTimer) clearTimeout(delayedStatusTimer)
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    const toastId = 'note-gen-server-sync-action-required'
    const actionable = status.phase === 'needs-attention' || status.phase === 'error'
      || status.phase === 'workspace-mismatch' || status.phase === 'paused'
    if (!actionable) {
      toast.dismiss(toastId)
      return
    }
    const timer = setTimeout(() => {
      toast.error(t('actionRequired'), {
        id: toastId,
        description: status.error ?? (status.phase === 'workspace-mismatch'
          ? t('workspaceMismatch') : t('unsafeChanges')),
        duration: Infinity,
        action: {
          label: t('view'),
          onClick: () => useSettingsDialogStore.getState().openSettings('sync'),
        },
      })
    }, 10_000)
    return () => clearTimeout(timer)
  }, [status.error, status.phase, t])
  const presentation = statusPresentation(status.phase, t)
  const ResultIcon = presentation.icon
  const result = status.result
  const pending = (result?.pendingMutations ?? 0) + (result?.pendingOutbox ?? 0)
    + (result?.pendingInbox ?? 0) + (result?.pendingTransfers ?? 0)
  const problems = (result?.blockedOutbox ?? 0) + (result?.failedInbox ?? 0)
    + (result?.failedTransfers ?? 0) + (result?.unresolvedConflicts ?? 0)

  const handleViewProblems = async () => {
    if (!isMobile) {
      setConflictsOpen(true)
      return
    }
    const context = getNoteGenServerSyncContext()
    if (!context) {
      setMobileConflictMessage(t('workspaceLocked'))
      return
    }
    const conflicts = await listSyncConflicts(context.syncScopeId)
    const markdownConflict = conflicts
      .filter(conflict => conflict.kind === 'note')
      .sort((left, right) => BigInt(left.createdSequence) < BigInt(right.createdSequence) ? 1 : -1)
      .find(conflict => Boolean(markdownConflictPath(conflict.payloadJson)))
    const path = markdownConflict ? markdownConflictPath(markdownConflict.payloadJson) : ''
    if (!path) {
      setMobileConflictMessage(null)
      setConflictsOpen(true)
      return
    }
    setMobileConflictMessage(null)
    await useArticleStore.getState().setActiveFilePath(path)
    router.push('/mobile/writing')
    window.setTimeout(() => emitter.emit('sync-markdown-conflict-open', { path }), 150)
  }

  return (
    <>
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('ariaLabel', { label: presentation.label, count: pending })}
          className={compact
            ? 'relative flex size-8 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            : undefined}
        >
          {compact ? (
            <>
              <ResultIcon className={`size-4 ${status.phase === 'syncing' || status.phase === 'rebuilding' ? 'animate-spin' : ''}`} />
              {problems > 0 ? (
                <span className="absolute right-1 top-1 size-2 rounded-full bg-destructive" />
              ) : pending > 0 ? (
                <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />
              ) : null}
            </>
          ) : (
            <Badge variant={presentation.variant} className="cursor-pointer">
              <ResultIcon data-icon="inline-start" className={status.phase === 'syncing' || status.phase === 'rebuilding' ? 'animate-spin' : undefined} />
              {presentation.label}{pending > 0 ? ` · ${pending}` : ''}
            </Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side={compact ? 'right' : 'bottom'} align="start" className="w-80 gap-3">
        <div className="flex items-center gap-2">
          <ResultIcon />
          <div className="font-medium">{presentation.label}</div>
        </div>
        {status.error ? <p className="text-sm text-destructive">{status.error}</p> : null}
        {status.phase === 'rebuilding' ? (
          <p className="text-xs text-muted-foreground">
            {t('rebuildProgress', {
              count: status.progress?.processedObjects ?? 0,
              restarted: status.progress?.restarted ? t('rebuildRestarted') : '',
            })}
          </p>
        ) : null}
        {mobileConflictMessage ? <p className="text-xs text-muted-foreground">{mobileConflictMessage}</p> : null}
        {status.problems?.slice(0, 3).map(problem => (
          <div key={`${problem.category}:${problem.identity}`} className="rounded-md border p-2 text-xs">
            <div className="font-medium">{problem.category === 'outbox' ? t('problemOutbox') : problem.category === 'inbox' ? t('problemInbox') : t('problemTransfer')}</div>
            {problem.lastError ? <div className="mt-1 text-muted-foreground">{compactSyncProblemMessage(problem.lastError, t)}</div> : null}
          </div>
        ))}
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <span>{t('pendingMutations')}</span><span className="text-right text-foreground">{result?.pendingMutations ?? 0}</span>
          <span>{t('pendingOutbox')}</span><span className="text-right text-foreground">{result?.pendingOutbox ?? 0}</span>
          <span>{t('pendingInbox')}</span><span className="text-right text-foreground">{result?.pendingInbox ?? 0}</span>
          <span>{t('transfers')}</span><span className="text-right text-foreground">
            {status.transferProgress ? t('inProgress') : (result?.pendingTransfers ?? 0)}{status.transferProgress
              ? formatTransferProgress(String(status.transferProgress.completedBytes), String(status.transferProgress.totalBytes))
              : formatTransferProgress(result?.transferCompletedBytes, result?.transferTotalBytes)}
          </span>
          <span>{t('problems')}</span><span className="text-right text-foreground">{problems}</span>
          <span>{t('serverConfirmed')}</span><span className="text-right text-foreground">{formatSyncTime(result?.lastServerConfirmedAt, t('notConfirmed'))}</span>
          <span>{t('fullySynced')}</span><span className="text-right text-foreground">{formatSyncTime(result?.lastFullyConvergedAt, t('notConfirmed'))}</span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void (
            problems > 0 ? retryNoteGenServerBackgroundSync() : triggerNoteGenServerBackgroundSync()
          )}>
            <RefreshCw data-icon="inline-start" />{t('retry')}
          </Button>
          {result?.unresolvedConflicts ? (
            <Button size="sm" variant="destructive" onClick={() => void handleViewProblems()}>
              {t('viewProblems')}
            </Button>
          ) : null}
          {problems > 0 && !result?.unresolvedConflicts ? (
            <Button size="sm" variant="destructive" onClick={() => useSettingsDialogStore.getState().openSettings('sync')}>
              {t('viewResolution')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void exportDiagnostics(status)}>
            {t('exportDiagnostics')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
    <SyncConflictDialog open={conflictsOpen} onOpenChange={setConflictsOpen} />
    </>
  )
}

function markdownConflictPath(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>
    return String(payload.path ?? payload.relativePath ?? payload.logicalKey ?? '')
      .trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').normalize('NFC')
  } catch {
    return ''
  }
}

type StatusTranslationKey =
  | 'synced' | 'saving' | 'syncing' | 'rebuilding' | 'pending'
  | 'offline' | 'attention' | 'paused' | 'idle'

function statusPresentation(
  phase: NoteGenServerBackgroundStatus['phase'],
  translate: (key: StatusTranslationKey) => string,
): {
  label: string
  icon: typeof Check
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
} {
  if (phase === 'synced') return { label: translate('synced'), icon: Check, variant: 'secondary' }
  if (phase === 'syncing' || phase === 'saving') return { label: translate(phase === 'saving' ? 'saving' : 'syncing'), icon: LoaderCircle, variant: 'outline' }
  if (phase === 'rebuilding') return { label: translate('rebuilding'), icon: LoaderCircle, variant: 'outline' }
  if (phase === 'pending') return { label: translate('pending'), icon: RefreshCw, variant: 'outline' }
  if (phase === 'offline') return { label: translate('offline'), icon: CloudOff, variant: 'outline' }
  if (phase === 'needs-attention' || phase === 'error') return { label: translate('attention'), icon: AlertTriangle, variant: 'destructive' }
  if (phase === 'paused' || phase === 'workspace-mismatch') return { label: translate('paused'), icon: Pause, variant: 'destructive' }
  return { label: translate('idle'), icon: Pause, variant: 'outline' }
}

function formatSyncTime(value: number | null | undefined, fallback: string): string {
  return value ? new Date(value).toLocaleString() : fallback
}

function formatTransferProgress(completedValue?: string, totalValue?: string): string {
  const completed = Number(completedValue ?? '0')
  const total = Number(totalValue ?? '0')
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return ''
  const percent = Math.max(0, Math.min(100, Math.round(completed / total * 100)))
  return ` · ${percent}% (${formatBytes(completed)} / ${formatBytes(total)})`
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

type ProblemTranslationKey =
  | 'objectTooLarge' | 'resourceNotReady' | 'quotaExceeded'
  | 'keyVersionNotFound' | 'folderNotEmpty'

function compactSyncProblemMessage(
  code: string,
  translate: (key: ProblemTranslationKey) => string,
): string {
  if (code === 'object_too_large') return translate('objectTooLarge')
  if (code === 'blob_not_ready' || code === 'resource_not_ready') return translate('resourceNotReady')
  if (code === 'quota_exceeded') return translate('quotaExceeded')
  if (code === 'key_version_not_found') return translate('keyVersionNotFound')
  if (code === 'folder_not_empty') return translate('folderNotEmpty')
  return code
}

async function exportDiagnostics(status: NoteGenServerBackgroundStatus): Promise<void> {
  const summary = await getNoteGenServerDiagnosticSummary()
  const payload = JSON.stringify({
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    summary,
    status: {
      phase: status.phase,
      reason: status.reason ?? null,
      error: status.error ?? null,
      result: status.result ?? null,
      problems: (status.problems ?? []).map(problem => ({
        category: problem.category,
        operation: problem.operation,
        lastError: problem.lastError,
      })),
      progress: status.progress ?? null,
      transferProgress: status.transferProgress ?? null,
      updatedAt: status.updatedAt,
    },
  }, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `notegen-sync-diagnostics-${Date.now()}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
