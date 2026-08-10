'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { platform } from '@tauri-apps/plugin-os'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { AlertCircle, Check, Copy, ExternalLink, Globe, KeyRound, Loader2, LogOut, RefreshCw, ScanLine, Server, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { SyncConflictDialog } from '@/components/sync-conflict-dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  authenticateServer,
  cancelServerDeviceAuthorization,
  clearServerProfile,
  createServerDeviceAuthorization,
  discoverServer,
  enableServerWorkspaceEndToEndEncryption,
  enableServerWorkspaceManagedEncryption,
  exchangeServerDeviceAuthorization,
  exchangeServerDevicePairing,
  getOrCreateManagedServerWorkspace,
  getOrCreateServerDeviceId,
  getServerAccount,
  listServerWorkspaces,
  loadServerProfile,
  logoutServerSession,
  NoteGenServerRequestError,
  normalizeServerOrigin,
  saveServerProfile,
  unlockServerWorkspace,
  type NoteGenServerProfile,
  type ServerCapabilities,
  type ServerSession,
  type ServerWorkspace,
  type UnlockedWorkspaceKey,
} from '@/lib/sync/note-gen-server'
import {
  configureNoteGenServerBackgroundSession,
  disconnectNoteGenServerBackgroundRuntime,
  getNoteGenServerBackgroundConnection,
  getNoteGenServerLocalWorkspaceKey,
  initNoteGenServerBackgroundRuntime,
  retryNoteGenServerBackgroundSync,
  subscribeNoteGenServerBackgroundStatus,
  subscribeNoteGenServerSession,
  syncNoteGenServerNow,
  triggerNoteGenServerBackgroundSync,
  unlockNoteGenServerBackgroundWorkspace,
  type NoteGenServerBackgroundStatus,
} from '@/lib/sync/note-gen-server-background'

type BusyAction = 'authenticate' | 'browser-authorize' | 'scan-pairing' | 'restore' | 'unlock' | 'enable-e2ee' | 'enable-managed' | 'retry-sync' | null
type ConnectionMethod = 'browser' | 'password'
type WorkspaceUnlockMethod = 'passphrase' | 'recovery'
type RestoreStage = 'local' | 'server' | 'workspace'

interface PendingAuthorization {
  baseUrl: string
  deviceCode: string
  userCode: string
  verificationUriComplete: string
  expiresAt: number
}

export type NoteGenServerConnectionState = 'checking' | 'connected' | 'disconnected'

interface NoteGenServerSyncProps {
  onConnectionStateChange?: (state: NoteGenServerConnectionState) => void
}

export function NoteGenServerSync({ onConnectionStateChange }: NoteGenServerSyncProps = {}) {
  const t = useTranslations('settings.sync.noteGenServer')
  const syncT = useTranslations('settings.sync')
  const authorizationAttempt = useRef(0)
  const [connectionMethod, setConnectionMethod] = useState<ConnectionMethod>('browser')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:3789')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [syncPassphrase, setSyncPassphrase] = useState('')
  const [syncPassphraseConfirm, setSyncPassphraseConfirm] = useState('')
  const [workspaceUnlockMethod, setWorkspaceUnlockMethod] = useState<WorkspaceUnlockMethod>('passphrase')
  const [workspaceRecoveryKey, setWorkspaceRecoveryKey] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [profile, setProfile] = useState<NoteGenServerProfile | null>(null)
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null)
  const [session, setSession] = useState<ServerSession | null>(null)
  const [workspaces, setWorkspaces] = useState<ServerWorkspace[]>([])
  const [workspaceKey, setWorkspaceKey] = useState<UnlockedWorkspaceKey | null>(null)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [recoveryCopied, setRecoveryCopied] = useState(false)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState('')
  const [pendingAuthorization, setPendingAuthorization] = useState<PendingAuthorization | null>(null)
  const [connectionInitialized, setConnectionInitialized] = useState(false)
  const [restoreStage, setRestoreStage] = useState<RestoreStage>('local')
  const [backgroundStatus, setBackgroundStatus] = useState<NoteGenServerBackgroundStatus>({
    phase: 'idle',
    updatedAt: Date.now(),
  })
  const [conflictsOpen, setConflictsOpen] = useState(false)

  useEffect(() => {
    const attempt = ++authorizationAttempt.current
    void (async () => {
      const saved = await loadServerProfile()
      if (!saved || authorizationAttempt.current !== attempt) {
        if (authorizationAttempt.current === attempt) setConnectionInitialized(true)
        return
      }
      setProfile(saved)
      setBaseUrl(saved.baseUrl)
      setLogin(saved.login)
      setWorkspaceId(saved.workspaceId ?? '')

      setBusy('restore')
      setRestoreStage('local')
      try {
        await initNoteGenServerBackgroundRuntime()
        const connection = getNoteGenServerBackgroundConnection()
        if (!connection || connection.profile.instanceId !== saved.instanceId) return
        setRestoreStage('server')
        const nextSession = connection.session
        const [nextCapabilities, account, nextWorkspaces] = await Promise.all([
          discoverServer(saved.baseUrl),
          getServerAccount(saved.baseUrl, nextSession.accessToken),
          listServerWorkspaces(saved.baseUrl, nextSession.accessToken),
        ])
        if (nextCapabilities.instanceId !== saved.instanceId) throw new Error(t('instanceChanged'))
        setRestoreStage('workspace')
        if (authorizationAttempt.current !== attempt) return
        const selected = nextWorkspaces.find(workspace => (
          workspace.id === (connection.profile.workspaceId ?? saved.workspaceId)
        ))
        if (selected?.encryptionMode === 'e2ee' && connection.profile.encryptionMode === 'e2ee') {
          const nextProfile = { ...connection.profile, login: account.login, workspaceId: selected.id }
          await saveServerProfile(nextProfile)
          await configureNoteGenServerBackgroundSession(nextProfile, nextSession)
          setProfile(nextProfile)
          setLogin(account.login)
          setCapabilities(nextCapabilities)
          setSession(nextSession)
          setWorkspaces(nextWorkspaces)
          setWorkspaceId(selected.id)
        } else {
          await activateAutomaticSync(
            saved.baseUrl,
            nextCapabilities,
            nextSession,
            saved.deviceId,
            account.login,
          )
        }
      } catch (cause) {
        if (authorizationAttempt.current === attempt) {
          setError(/timed out/i.test(errorMessage(cause)) ? t('restoreTimeout') : errorMessage(cause))
        }
        console.error('Failed to restore NoteGen server session:', cause)
      } finally {
        if (authorizationAttempt.current === attempt) {
          setBusy(null)
          setConnectionInitialized(true)
        }
      }
    })().catch(error => {
      if (authorizationAttempt.current === attempt) setConnectionInitialized(true)
      console.error('Failed to load NoteGen server profile:', error)
    })
    return () => {
      authorizationAttempt.current += 1
    }
  }, [])

  useEffect(() => subscribeNoteGenServerBackgroundStatus(nextStatus => {
    setBackgroundStatus(nextStatus)
    if (nextStatus.phase === 'workspace-mismatch') setWorkspaceKey(null)
  }), [])

  useEffect(() => {
    return subscribeNoteGenServerSession(nextSession => {
      setSession(nextSession)
      if (!nextSession) {
        setCapabilities(null)
        setWorkspaceKey(null)
      }
    })
  }, [])

  const selectedWorkspace = useMemo(
    () => workspaces.find(workspace => workspace.id === workspaceId) ?? null,
    [workspaceId, workspaces],
  )
  const authenticated = session !== null && capabilities !== null
  const unlocked = authenticated && workspaceKey !== null && workspaceId.length > 0
  const mobile = isMobileRuntime()

  useEffect(() => {
    onConnectionStateChange?.(
      !connectionInitialized || busy === 'restore'
        ? 'checking'
        : unlocked
          ? 'connected'
          : 'disconnected',
    )
  }, [busy, connectionInitialized, onConnectionStateChange, unlocked])

  async function completeAuthentication(
    normalizedBaseUrl: string,
    nextCapabilities: ServerCapabilities,
    nextSession: ServerSession,
    deviceId: string,
  ) {
    const account = await getServerAccount(normalizedBaseUrl, nextSession.accessToken)
    const provisionalProfile: NoteGenServerProfile = profile?.instanceId === nextCapabilities.instanceId
      ? { ...profile, login: account.login, deviceId, enabled: true }
      : {
          baseUrl: normalizedBaseUrl,
          instanceId: nextCapabilities.instanceId,
          serverName: nextCapabilities.serverName,
          login: account.login,
          deviceId,
          enabled: true,
        }
    await saveServerProfile(provisionalProfile)
    await configureNoteGenServerBackgroundSession(provisionalProfile, nextSession)
    setProfile(provisionalProfile)
    setSession(nextSession)
    setCapabilities(nextCapabilities)
    await activateAutomaticSync(
      normalizedBaseUrl,
      nextCapabilities,
      nextSession,
      deviceId,
      account.login,
    )
    setPassword('')
    setSetupToken('')
  }

  async function activateAutomaticSync(
    normalizedBaseUrl: string,
    nextCapabilities: ServerCapabilities,
    nextSession: ServerSession,
    deviceId: string,
    accountLogin: string,
  ) {
    if (nextCapabilities.features?.managedDefaultWorkspace !== true) {
      throw new Error(t('serverUpgradeRequired'))
    }
    const provisioned = await getOrCreateManagedServerWorkspace({
      baseUrl: normalizedBaseUrl,
      accessToken: nextSession.accessToken,
    })
    const nextWorkspaces = await listServerWorkspaces(normalizedBaseUrl, nextSession.accessToken)
    const localWorkspaceKey = await getNoteGenServerLocalWorkspaceKey()
    const nextProfile: NoteGenServerProfile = {
      baseUrl: normalizedBaseUrl,
      instanceId: nextCapabilities.instanceId,
      serverName: nextCapabilities.serverName,
      login: accountLogin,
      deviceId,
      enabled: true,
      localWorkspaceKey,
      workspaceId: provisioned.workspace.id,
      encryptionMode: provisioned.workspace.encryptionMode,
    }
    await saveServerProfile(nextProfile)
    await configureNoteGenServerBackgroundSession(nextProfile, nextSession)
    if (provisioned.unlocked) {
      unlockNoteGenServerBackgroundWorkspace({
        workspaceKey: provisioned.unlocked.key,
        workspaceKeys: provisioned.unlocked.keys,
        keyVersion: provisioned.unlocked.keyVersion,
      })
    }
    setBaseUrl(normalizedBaseUrl)
    setLogin(accountLogin)
    setCapabilities(nextCapabilities)
    setSession(nextSession)
    setWorkspaces(nextWorkspaces)
    setWorkspaceId(provisioned.workspace.id)
    setWorkspaceKey(provisioned.unlocked)
    setWorkspaceUnlockMethod('passphrase')
    setWorkspaceRecoveryKey('')
    setProfile(nextProfile)
  }

  async function handleBrowserConnect() {
    const attempt = ++authorizationAttempt.current
    setBusy('browser-authorize')
    setError('')
    resetConnectionResults()
    try {
      const normalizedBaseUrl = normalizeServerOrigin(baseUrl)
      const nextCapabilities = await discoverServer(normalizedBaseUrl)
      if (profile?.baseUrl === normalizedBaseUrl && profile.instanceId !== nextCapabilities.instanceId) {
        throw new Error(t('instanceChanged'))
      }
      if (nextCapabilities.features?.deviceAuthorization !== true) {
        throw new Error(t('browserAuthorizationUnsupported'))
      }
      const deviceId = await getOrCreateServerDeviceId()
      const authorization = await createServerDeviceAuthorization({
        baseUrl: normalizedBaseUrl,
        deviceId,
        deviceName: getServerDeviceName(),
      })
      const pending: PendingAuthorization = {
        baseUrl: normalizedBaseUrl,
        deviceCode: authorization.deviceCode,
        userCode: authorization.userCode,
        verificationUriComplete: authorization.verificationUriComplete,
        expiresAt: Date.now() + authorization.expiresIn * 1_000,
      }
      setBaseUrl(normalizedBaseUrl)
      setPendingAuthorization(pending)
      try {
        await openAuthorizationPage(authorization.verificationUriComplete)
      } catch (cause) {
        console.error('Failed to open NoteGen server authorization page:', cause)
      }

      while (Date.now() < pending.expiresAt && authorizationAttempt.current === attempt) {
        await delay(Math.max(authorization.interval, 1) * 1_000)
        if (authorizationAttempt.current !== attempt) return
        let nextSession: ServerSession
        try {
          nextSession = await exchangeServerDeviceAuthorization(normalizedBaseUrl, authorization.deviceCode)
        } catch (cause) {
          if (cause instanceof NoteGenServerRequestError && cause.code === 'authorization_pending') continue
          if (cause instanceof NoteGenServerRequestError && cause.code === 'authorization_denied') {
            throw new Error(t('browserAuthorizationDenied'))
          }
          if (cause instanceof NoteGenServerRequestError && cause.code === 'authorization_expired') {
            throw new Error(t('browserAuthorizationExpired'))
          }
          if (isTransientConnectionError(cause)) continue
          throw cause
        }
        await completeAuthentication(normalizedBaseUrl, nextCapabilities, nextSession, deviceId)
        setPendingAuthorization(null)
        return
      }
      if (authorizationAttempt.current === attempt) throw new Error(t('browserAuthorizationExpired'))
    } catch (cause) {
      if (authorizationAttempt.current === attempt) {
        setPendingAuthorization(null)
        setError(errorMessage(cause))
      }
    } finally {
      if (authorizationAttempt.current === attempt) setBusy(null)
    }
  }

  async function handleCancelAuthorization() {
    const pending = pendingAuthorization
    authorizationAttempt.current += 1
    setPendingAuthorization(null)
    setBusy(null)
    if (!pending) return
    try {
      await cancelServerDeviceAuthorization(pending.baseUrl, pending.deviceCode)
    } catch (cause) {
      console.error('Failed to cancel NoteGen server authorization:', cause)
    }
  }

  async function handleScanPairing() {
    const attempt = ++authorizationAttempt.current
    setBusy('scan-pairing')
    setError('')
    resetConnectionResults()
    try {
      const scanner = await import('@tauri-apps/plugin-barcode-scanner')
      let permission = await scanner.checkPermissions()
      if (permission !== 'granted') permission = await scanner.requestPermissions()
      if (permission !== 'granted') throw new Error(t('scanCameraPermissionDenied'))

      const result = await scanner.scan({ cameraDirection: 'back', formats: [scanner.Format.QRCode] })
      if (authorizationAttempt.current !== attempt) return
      const pairing = parseDevicePairingUri(result.content, t('scanInvalidCode'))
      const nextCapabilities = await discoverServer(pairing.baseUrl)
      if (nextCapabilities.instanceId !== pairing.instanceId) throw new Error(t('scanServerMismatch'))
      if (profile?.baseUrl === pairing.baseUrl && profile.instanceId !== nextCapabilities.instanceId) {
        throw new Error(t('instanceChanged'))
      }
      const deviceId = await getOrCreateServerDeviceId()
      const nextSession = await exchangeServerDevicePairing({
        baseUrl: pairing.baseUrl,
        pairingToken: pairing.pairingToken,
        deviceId,
        deviceName: getServerDeviceName(),
      })
      if (authorizationAttempt.current !== attempt) return
      await completeAuthentication(pairing.baseUrl, nextCapabilities, nextSession, deviceId)
    } catch (cause) {
      if (authorizationAttempt.current !== attempt) return
      if (isScannerCancellation(cause)) return
      if (cause instanceof NoteGenServerRequestError && cause.code === 'pairing_expired') {
        setError(t('scanPairingExpired'))
      } else {
        setError(errorMessage(cause))
      }
    } finally {
      if (authorizationAttempt.current === attempt) setBusy(null)
    }
  }

  async function handleAuthenticate() {
    setBusy('authenticate')
    setError('')
    resetConnectionResults()
    try {
      const normalizedBaseUrl = normalizeServerOrigin(baseUrl)
      const nextCapabilities = await discoverServer(normalizedBaseUrl)
      if (profile?.baseUrl === normalizedBaseUrl && profile.instanceId !== nextCapabilities.instanceId) {
        throw new Error(t('instanceChanged'))
      }
      const deviceId = await getOrCreateServerDeviceId()
      const nextSession = await authenticateServer({
        baseUrl: normalizedBaseUrl,
        action: mode,
        login,
        password,
        ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}),
        deviceId,
        deviceName: getServerDeviceName(),
      })
      await completeAuthentication(normalizedBaseUrl, nextCapabilities, nextSession, deviceId)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function handleUnlockWorkspace() {
    if (!session || !workspaceId) return
    setBusy('unlock')
    setError('')
    try {
      const key = await unlockServerWorkspace({
        baseUrl,
        accessToken: session.accessToken,
        workspaceId,
        ...(workspaceUnlockMethod === 'recovery'
          ? { recoveryKey: workspaceRecoveryKey.trim() }
          : { syncPassphrase }),
      })
      const nextProfile = {
        ...profile!,
        workspaceId,
        localWorkspaceKey: await getNoteGenServerLocalWorkspaceKey(),
        encryptionMode: 'e2ee' as const,
      }
      await saveServerProfile(nextProfile)
      await configureNoteGenServerBackgroundSession(nextProfile, session)
      setProfile(nextProfile)
      setWorkspaceKey(key)
      unlockNoteGenServerBackgroundWorkspace({
        workspaceKey: key.key,
        workspaceKeys: key.keys,
        keyVersion: key.keyVersion,
      })
      await syncNoteGenServerNow()
      setSyncPassphrase('')
      setWorkspaceRecoveryKey('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function handleEnableEndToEndEncryption() {
    if (!session || !workspaceKey || !workspaceId || syncPassphrase.length < 12) return
    setBusy('enable-e2ee')
    setError('')
    try {
      const nextRecoveryKey = await enableServerWorkspaceEndToEndEncryption({
        baseUrl,
        accessToken: session.accessToken,
        workspaceId,
        workspaceKey: workspaceKey.key,
        keyVersion: workspaceKey.keyVersion,
        syncPassphrase,
      })
      setWorkspaces(current => current.map(workspace => workspace.id === workspaceId
        ? { ...workspace, encryptionMode: 'e2ee' }
        : workspace))
      if (profile) {
        const nextProfile = { ...profile, encryptionMode: 'e2ee' as const }
        await saveServerProfile(nextProfile)
        setProfile(nextProfile)
      }
      setRecoveryKey(nextRecoveryKey)
      setRecoveryCopied(false)
      setSyncPassphrase('')
      setSyncPassphraseConfirm('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function handleEnableManagedEncryption() {
    if (!session || !workspaceKey || !workspaceId) return
    setBusy('enable-managed')
    setError('')
    try {
      await enableServerWorkspaceManagedEncryption({
        baseUrl,
        accessToken: session.accessToken,
        workspaceId,
        workspaceKeys: workspaceKey.keys,
      })
      setWorkspaces(current => current.map(workspace => workspace.id === workspaceId
        ? { ...workspace, encryptionMode: 'managed' }
        : workspace))
      if (profile) {
        const nextProfile = { ...profile, encryptionMode: 'managed' as const }
        await saveServerProfile(nextProfile)
        setProfile(nextProfile)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function handleCopyRecoveryKey() {
    if (!recoveryKey) return
    try {
      if ('__TAURI_INTERNALS__' in globalThis) await writeText(recoveryKey)
      else await navigator.clipboard.writeText(recoveryKey)
      setRecoveryCopied(true)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function handleRetrySync() {
    if (busy !== null) return
    setBusy('retry-sync')
    setError('')
    try {
      await retryNoteGenServerBackgroundSync()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  function resetConnectionResults() {
    setRecoveryKey('')
    setRecoveryCopied(false)
  }

  async function handleReset() {
    authorizationAttempt.current += 1
    const backgroundConnection = await disconnectNoteGenServerBackgroundRuntime()
    const logoutProfile = backgroundConnection?.profile ?? profile
    const logoutSession = backgroundConnection?.session ?? session
    if (logoutSession && logoutProfile) {
      try {
        await logoutServerSession({
          baseUrl: logoutProfile.baseUrl,
          refreshToken: logoutSession.refreshToken,
          deviceId: logoutProfile.deviceId,
        })
      } catch (cause) {
        console.error('Failed to revoke NoteGen server session:', cause)
      }
    }
    await clearServerProfile()
    setProfile(null)
    setCapabilities(null)
    setSession(null)
    setWorkspaces([])
    setWorkspaceId('')
    setWorkspaceKey(null)
    setRecoveryKey('')
    setRecoveryCopied(false)
    setSyncPassphrase('')
    setSyncPassphraseConfirm('')
    setWorkspaceRecoveryKey('')
    setWorkspaceUnlockMethod('passphrase')
    setPendingAuthorization(null)
    setBusy(null)
    setError('')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')} {syncT('settings')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {backgroundStatus.phase === 'syncing' ? (
          <Alert>
            <Loader2 className="animate-spin" />
            <AlertTitle>{t('initialSyncTitle')}</AlertTitle>
            <AlertDescription>
              {backgroundStatus.result
                ? t('syncSummary', {
                    pushed: backgroundStatus.result.pushed,
                    pulled: backgroundStatus.result.pulled,
                    conflicts: backgroundStatus.result.conflicts.length,
                  })
                : t('initialSyncDescription')}
            </AlertDescription>
          </Alert>
        ) : null}

        {busy === 'restore' ? (
          <Alert>
            <Loader2 className="animate-spin" />
            <AlertTitle>{t('restoringSession')}</AlertTitle>
            <AlertDescription>
              {restoreStage === 'local'
                ? t('restoreStages.local')
                : restoreStage === 'server'
                  ? t('restoreStages.server')
                  : t('restoreStages.workspace')}
            </AlertDescription>
          </Alert>
        ) : null}

        {!authenticated ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="note-gen-server-url">{t('serverUrl')}</FieldLabel>
              <Input
                id="note-gen-server-url"
                value={baseUrl}
                onChange={event => setBaseUrl(event.target.value)}
                disabled={pendingAuthorization !== null || busy === 'restore'}
                placeholder="https://sync.example.com"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <FieldDescription>{t('serverUrlDescription')}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t('connectionMethod')}</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={connectionMethod}
                disabled={pendingAuthorization !== null || busy === 'restore'}
                onValueChange={value => {
                  if (value === 'browser' || value === 'password') setConnectionMethod(value)
                }}
              >
                <ToggleGroupItem value="browser">
                  <Globe data-icon="inline-start" />
                  {t('browserConnect')}
                </ToggleGroupItem>
                <ToggleGroupItem value="password">
                  <KeyRound data-icon="inline-start" />
                  {t('passwordConnect')}
                </ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                {connectionMethod === 'browser' ? t('browserConnectDescription') : t('passwordConnectDescription')}
              </FieldDescription>
            </Field>
            {connectionMethod === 'browser' ? (
              pendingAuthorization ? (
                <Alert>
                  <Loader2 className="animate-spin" />
                  <AlertTitle>{t('waitingForAuthorization')}</AlertTitle>
                  <AlertDescription className="flex flex-col gap-3">
                    <span>{t('browserAuthorizationDescription')}</span>
                    <span className="font-mono text-2xl font-semibold tracking-[0.2em] text-foreground">
                      {pendingAuthorization.userCode}
                    </span>
                    <span>{t('browserAuthorizationCodeDescription')}</span>
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <Globe />
                  <AlertTitle>{t('browserAuthorizationTitle')}</AlertTitle>
                  <AlertDescription>{t('browserAuthorizationReady')}</AlertDescription>
                </Alert>
              )
            ) : (
              <>
                <Field>
                  <FieldLabel>{t('accountAction')}</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={mode}
                    onValueChange={value => {
                      if (value === 'login' || value === 'register') setMode(value)
                    }}
                  >
                    <ToggleGroupItem value="login">{t('login')}</ToggleGroupItem>
                    <ToggleGroupItem value="register">{t('register')}</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel htmlFor="note-gen-server-login">{t('account')}</FieldLabel>
                  <Input
                    id="note-gen-server-login"
                    value={login}
                    onChange={event => setLogin(event.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="note-gen-server-password">{t('password')}</FieldLabel>
                  <Input
                    id="note-gen-server-password"
                    type="password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                  />
                  <FieldDescription>{t('passwordDescription')}</FieldDescription>
                </Field>
                {mode === 'register' ? (
                  <Field>
                    <FieldLabel htmlFor="note-gen-server-setup-token">{t('setupToken')}</FieldLabel>
                    <Input
                      id="note-gen-server-setup-token"
                      type="password"
                      value={setupToken}
                      onChange={event => setSetupToken(event.target.value)}
                    />
                    <FieldDescription>{t('setupTokenDescription')}</FieldDescription>
                  </Field>
                ) : null}
              </>
            )}
          </FieldGroup>
        ) : (
          <div className="flex flex-col gap-4">
            {selectedWorkspace?.encryptionMode === 'e2ee' && !unlocked ? (
              <details open className="rounded-lg border p-4">
                <summary className="cursor-pointer font-medium">{t('advancedEncryption')}</summary>
                <div className="mt-4 flex flex-col gap-4">
                  <FieldDescription>{t('legacyEncryptedDescription')}</FieldDescription>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>{t('workspaceUnlockMethod')}</FieldLabel>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        value={workspaceUnlockMethod}
                        onValueChange={value => {
                          if (value === 'passphrase' || value === 'recovery') setWorkspaceUnlockMethod(value)
                        }}
                      >
                        <ToggleGroupItem value="passphrase">{t('unlockWithPassphrase')}</ToggleGroupItem>
                        <ToggleGroupItem value="recovery">{t('unlockWithRecoveryKey')}</ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="note-gen-workspace-secret">
                        {workspaceUnlockMethod === 'recovery' ? t('recoveryKey') : t('syncPassphrase')}
                      </FieldLabel>
                      <Input
                        id="note-gen-workspace-secret"
                        type="password"
                        value={workspaceUnlockMethod === 'recovery' ? workspaceRecoveryKey : syncPassphrase}
                        onChange={event => workspaceUnlockMethod === 'recovery'
                          ? setWorkspaceRecoveryKey(event.target.value)
                          : setSyncPassphrase(event.target.value)}
                      />
                    </Field>
                  </FieldGroup>
                  <Button
                    className="self-start"
                    onClick={() => void handleUnlockWorkspace()}
                    disabled={busy !== null || (workspaceUnlockMethod === 'passphrase'
                      ? syncPassphrase.length < 12
                      : workspaceRecoveryKey.trim().length < 40)}
                  >
                    {busy === 'unlock' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                    {t('unlockWorkspace')}
                  </Button>
                </div>
              </details>
            ) : unlocked ? (
              <details className="rounded-lg border p-4">
                <summary className="cursor-pointer font-medium">{t('advancedEncryption')}</summary>
                <div className="mt-4 flex flex-col gap-4">
                  {selectedWorkspace?.encryptionMode === 'e2ee' ? (
                    <>
                      <Alert>
                        <Check />
                        <AlertTitle>{t('e2eeEnabled')}</AlertTitle>
                        <AlertDescription>{t('e2eeEnabledDescription')}</AlertDescription>
                      </Alert>
                      <FieldDescription>{t('enableManagedDescription')}</FieldDescription>
                      <Button
                        variant="outline"
                        className="self-start"
                        onClick={() => void handleEnableManagedEncryption()}
                        disabled={busy !== null}
                      >
                        {busy === 'enable-managed' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                        {busy === 'enable-managed' ? t('enablingManaged') : t('enableManaged')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <FieldDescription>{t('enableE2eeDescription')}</FieldDescription>
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor="note-gen-advanced-passphrase">{t('syncPassphrase')}</FieldLabel>
                          <Input
                            id="note-gen-advanced-passphrase"
                            type="password"
                            value={syncPassphrase}
                            onChange={event => setSyncPassphrase(event.target.value)}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="note-gen-advanced-passphrase-confirm">{t('syncPassphraseConfirm')}</FieldLabel>
                          <Input
                            id="note-gen-advanced-passphrase-confirm"
                            type="password"
                            value={syncPassphraseConfirm}
                            onChange={event => setSyncPassphraseConfirm(event.target.value)}
                          />
                          {syncPassphraseConfirm && syncPassphrase !== syncPassphraseConfirm ? (
                            <FieldDescription className="text-destructive">{t('syncPassphraseMismatch')}</FieldDescription>
                          ) : null}
                        </Field>
                      </FieldGroup>
                      <Button
                        className="self-start"
                        onClick={() => void handleEnableEndToEndEncryption()}
                        disabled={busy !== null || syncPassphrase.length < 12 || syncPassphrase !== syncPassphraseConfirm}
                      >
                        {busy === 'enable-e2ee' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                        {busy === 'enable-e2ee' ? t('enablingE2ee') : t('enableE2ee')}
                      </Button>
                    </>
                  )}
                </div>
              </details>
            ) : null}
          </div>
        )}

        {recoveryKey ? (
          <Alert variant="warning">
            <AlertCircle />
            <AlertTitle>{t('recoveryTitle')}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <span className="break-all font-mono">{recoveryKey}</span>
              <Button variant="outline" size="sm" onClick={() => void handleCopyRecoveryKey()}>
                {recoveryCopied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                {recoveryCopied ? t('recoveryCopied') : t('copyRecoveryKey')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{t('failed')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {(backgroundStatus.phase === 'error' || backgroundStatus.phase === 'needs-attention')
          && backgroundStatus.error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{t('syncError')}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <span>{backgroundStatus.error}</span>
              {backgroundStatus.problems?.length ? (
                <ul className="flex w-full flex-col gap-2 text-sm">
                  {backgroundStatus.problems.map(problem => (
                    <li
                      key={`${problem.category}:${problem.identity}`}
                      className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
                    >
                      <div className="font-medium">
                        {problem.category === 'outbox'
                          ? t('problemCategory.outbox')
                          : problem.category === 'inbox'
                            ? t('problemCategory.inbox')
                            : t('problemCategory.transfer')}
                      </div>
                      {problem.lastError ? (
                        <div className="mt-1 break-words text-xs text-muted-foreground">
                          {problem.lastError === 'command_id_reused'
                            ? t('problemReason.commandIdReused')
                            : problem.lastError}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {backgroundStatus.result?.unresolvedConflicts ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConflictsOpen(true)}
                >
                  {t('resolveConflicts', {
                    count: backgroundStatus.result.unresolvedConflicts,
                  })}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleRetrySync()}
                  disabled={busy !== null}
                >
                  {busy === 'retry-sync'
                    ? <Loader2 data-icon="inline-start" className="animate-spin" />
                    : <RefreshCw data-icon="inline-start" />}
                  {busy === 'retry-sync' ? t('syncingNow') : t('syncNow')}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        {backgroundStatus.phase === 'offline' && backgroundStatus.error ? (
          <Alert variant="warning">
            <AlertCircle />
            <AlertTitle>{t('offline')}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <span>{backgroundStatus.error}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void triggerNoteGenServerBackgroundSync()}
              >
                <RefreshCw data-icon="inline-start" />
                {t('syncNow')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {backgroundStatus.phase === 'workspace-mismatch' ? (
          <Alert variant="warning">
            <AlertCircle />
            <AlertTitle>{t('workspaceMismatch')}</AlertTitle>
            <AlertDescription>{t('workspaceMismatchDescription')}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {!authenticated ? (
          <>
          {mobile ? (
            <Button
              onClick={() => void handleScanPairing()}
              disabled={busy !== null}
            >
              {busy === 'scan-pairing'
                ? <Loader2 data-icon="inline-start" className="animate-spin" />
                : <ScanLine data-icon="inline-start" />}
              {busy === 'scan-pairing' ? t('scanningPairing') : t('scanPairing')}
            </Button>
          ) : null}
          {connectionMethod === 'browser' ? (
            pendingAuthorization ? (
              <>
                <Button variant="outline" onClick={() => void openAuthorizationPage(pendingAuthorization.verificationUriComplete)}>
                  <ExternalLink data-icon="inline-start" />
                  {t('reopenBrowser')}
                </Button>
                <Button variant="outline" onClick={() => void handleCancelAuthorization()}>
                  <X data-icon="inline-start" />
                  {t('cancelAuthorization')}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => void handleBrowserConnect()}
                disabled={busy !== null || !baseUrl.trim()}
              >
                {busy === 'browser-authorize' || busy === 'restore'
                  ? <Loader2 data-icon="inline-start" className="animate-spin" />
                  : <Globe data-icon="inline-start" />}
                {busy === 'restore' ? t('restoringSession') : busy === 'browser-authorize' ? t('openingBrowser') : t('browserConnect')}
              </Button>
            )
          ) : (
            <Button
              onClick={() => void handleAuthenticate()}
              disabled={busy !== null || !baseUrl.trim() || !login.trim() || password.length < 12}
            >
              {busy === 'authenticate' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Server data-icon="inline-start" />}
              {busy === 'authenticate' ? t('connecting') : t('connect')}
            </Button>
          )}
          </>
        ) : null}
        {profile ? (
          <Button variant="destructive" onClick={() => void handleReset()} disabled={busy !== null}>
            <LogOut data-icon="inline-start" />
            {t('reset')}
          </Button>
        ) : null}
      </CardFooter>
      <SyncConflictDialog open={conflictsOpen} onOpenChange={setConflictsOpen} />
    </Card>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTransientConnectionError(error: unknown): boolean {
  if (error instanceof NoteGenServerRequestError) {
    return error.retryable || error.status === 408 || error.status === 429 || error.status >= 500
  }
  if (error instanceof TypeError) return true
  return /fetch|network|connection|timed? out|offline|无法连接|网络|连接失败/i.test(errorMessage(error))
}

async function openAuthorizationPage(url: string): Promise<void> {
  if ('__TAURI_INTERNALS__' in globalThis) {
    await openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => window.setTimeout(resolve, milliseconds))
}

function getServerDeviceName(): string {
  if (!('__TAURI_INTERNALS__' in globalThis)) return 'NoteGen Web'
  const names: Partial<Record<ReturnType<typeof platform>, string>> = {
    macos: 'NoteGen on macOS',
    windows: 'NoteGen on Windows',
    linux: 'NoteGen on Linux',
    ios: 'NoteGen on iOS',
    android: 'NoteGen on Android',
  }
  return names[platform()] ?? 'NoteGen'
}

function isMobileRuntime(): boolean {
  if (!('__TAURI_INTERNALS__' in globalThis)) return false
  const currentPlatform = platform()
  return currentPlatform === 'ios' || currentPlatform === 'android'
}

function parseDevicePairingUri(value: string, invalidMessage: string): {
  baseUrl: string
  pairingToken: string
  instanceId: string
} {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(invalidMessage)
  }
  const pairingToken = url.searchParams.get('token') ?? ''
  const instanceId = url.searchParams.get('instance') ?? ''
  if (url.protocol !== 'notegen:' || url.hostname !== 'sync' || url.pathname !== '/pair'
    || url.searchParams.get('v') !== '1' || pairingToken.length < 40 || pairingToken.length > 100
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) {
    throw new Error(invalidMessage)
  }
  try {
    return {
      baseUrl: normalizeServerOrigin(url.searchParams.get('server') ?? ''),
      pairingToken,
      instanceId,
    }
  } catch {
    throw new Error(invalidMessage)
  }
}

function isScannerCancellation(cause: unknown): boolean {
  return /cancel|cancelled|canceled|取消/i.test(errorMessage(cause))
}
