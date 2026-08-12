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
  clearPendingServerWorkspaceRecoverySecret,
  clearServerProfile,
  createServerWorkspaceRecoveryKey,
  createServerWorkspace,
  createServerDeviceAuthorization,
  discoverServer,
  enableServerWorkspaceEndToEndEncryption,
  enableServerWorkspaceManagedEncryption,
  exchangeServerDeviceAuthorization,
  exchangeServerDevicePairing,
  getOrCreateManagedServerWorkspace,
  getOrCreateServerDeviceId,
  getServerAccount,
  getServerAccountContext,
  findServerWorkspaceCreation,
  listServerWorkspaces,
  loadPendingServerWorkspaceRecoverySecret,
  loadServerProfile,
  logoutServerSession,
  NoteGenServerRequestError,
  normalizeServerOrigin,
  replaceServerWorkspaceRecoveryKey,
  saveServerProfile,
  savePendingServerWorkspaceRecoverySecret,
  unlockServerWorkspace,
  type NoteGenServerProfile,
  type ServerCapabilities,
  type ResolvedServerCapabilities,
  type ServerAccountContext,
  type ServerSession,
  type ServerWorkspace,
  type UnlockedWorkspaceKey,
} from '@/lib/sync/note-gen-server'
import {
  configureNoteGenServerBackgroundSession,
  acceptNoteGenServerRestoreEpoch,
  disconnectNoteGenServerBackgroundRuntime,
  getNoteGenServerBackgroundConnection,
  getNoteGenServerLocalWorkspaceKey,
  initNoteGenServerBackgroundRuntime,
  pauseNoteGenServerForRestoreEpoch,
  retryNoteGenServerBackgroundSync,
  subscribeNoteGenServerBackgroundStatus,
  subscribeNoteGenServerSession,
  syncNoteGenServerNow,
  triggerNoteGenServerBackgroundSync,
  unlockNoteGenServerBackgroundWorkspace,
  type NoteGenServerBackgroundStatus,
} from '@/lib/sync/note-gen-server-background'
import { useNoteGenServerPairingStore } from '@/stores/note-gen-server-pairing'

type BusyAction = 'authenticate' | 'browser-authorize' | 'open-account-portal' | 'scan-pairing' | 'pairing-link' | 'discover' | 'restore' | 'unlock' | 'create-e2ee' | 'enable-e2ee' | 'enable-managed' | 'retry-sync' | 'accept-restore-epoch' | null
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

export type NoteGenServerConnectionState = 'checking' | 'connected' | 'action-required' | 'disconnected'

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
  const [totpCode, setTotpCode] = useState('')
  const [totpRequired, setTotpRequired] = useState(false)
  const [setupToken, setSetupToken] = useState('')
  const [syncPassphrase, setSyncPassphrase] = useState('')
  const [syncPassphraseConfirm, setSyncPassphraseConfirm] = useState('')
  const [workspaceName, setWorkspaceName] = useState('NoteGen')
  const [workspaceUnlockMethod, setWorkspaceUnlockMethod] = useState<WorkspaceUnlockMethod>('passphrase')
  const [workspaceRecoveryKey, setWorkspaceRecoveryKey] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [profile, setProfile] = useState<NoteGenServerProfile | null>(null)
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null)
  const [discoveredCapabilities, setDiscoveredCapabilities] = useState<ResolvedServerCapabilities | null>(null)
  const [session, setSession] = useState<ServerSession | null>(null)
  const [accountContext, setAccountContext] = useState<ServerAccountContext | null>(null)
  const [workspaces, setWorkspaces] = useState<ServerWorkspace[]>([])
  const [workspaceKey, setWorkspaceKey] = useState<UnlockedWorkspaceKey | null>(null)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [recoveryCopied, setRecoveryCopied] = useState(false)
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('')
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
  const pendingPairingUri = useNoteGenServerPairingStore(state => state.pendingUri)
  const consumePairingUri = useNoteGenServerPairingStore(state => state.consume)

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
        const [nextCapabilities, account, nextWorkspaces, nextAccountContext] = await Promise.all([
          discoverServer(saved.baseUrl),
          getServerAccount(saved.baseUrl, nextSession.accessToken),
          listServerWorkspaces(saved.baseUrl, nextSession.accessToken),
          loadAccountContext(saved.baseUrl, nextSession.accessToken),
        ])
        if (nextCapabilities.instanceId !== saved.instanceId) throw new Error(t('instanceChanged'))
        setRestoreStage('workspace')
        if (authorizationAttempt.current !== attempt) return
        let selectedWorkspaceId = connection.profile.workspaceId ?? saved.workspaceId
        if (!selectedWorkspaceId && saved.onboarding) {
          const recovered = await findServerWorkspaceCreation({
            baseUrl: saved.baseUrl,
            accessToken: nextSession.accessToken,
            creationIdempotencyKey: saved.onboarding.creationIdempotencyKey,
          })
          selectedWorkspaceId = recovered?.id ?? ''
        }
        const selected = nextWorkspaces.find(workspace => workspace.id === selectedWorkspaceId)
        if (selected?.encryptionMode === 'e2ee' && connection.profile.encryptionMode === 'e2ee') {
          const nextProfile = { ...connection.profile, login: account.login, workspaceId: selected.id, onboarding: saved.onboarding }
          await saveServerProfile(nextProfile)
          if (nextProfile.onboarding === undefined) {
            await configureNoteGenServerBackgroundSession(nextProfile, nextSession)
          }
          setProfile(nextProfile)
          setLogin(account.login)
          setCapabilities(nextCapabilities)
          setSession(nextSession)
          setAccountContext(nextAccountContext)
          setWorkspaces(nextWorkspaces)
          setWorkspaceId(selected.id)
          if (nextProfile.onboarding) {
            const pendingRecoveryKey = await loadPendingServerWorkspaceRecoverySecret({ profile: nextProfile, accountId: nextSession.accountId })
            if (pendingRecoveryKey !== null) {
              try {
                const pendingWorkspaceKey = await unlockServerWorkspace({
                  baseUrl: nextProfile.baseUrl, accessToken: nextSession.accessToken,
                  workspaceId: selected.id, recoveryKey: pendingRecoveryKey,
                })
                setWorkspaceKey(pendingWorkspaceKey)
                setRecoveryKey(pendingRecoveryKey)
                setRecoveryCopied(false)
                setRecoveryConfirmation('')
              } catch {
                // A lost/revoked record is handled by the existing passphrase
                // unlock + recovery-envelope replacement flow below.
                await clearPendingServerWorkspaceRecoverySecret({
                  instanceId: nextProfile.instanceId, accountId: nextSession.accountId, deviceId: nextProfile.deviceId,
                }).catch(() => undefined)
              }
            }
          }
        } else if (nextCapabilities.features?.managedDefaultWorkspace === true) {
          await activateAutomaticSync(
            saved.baseUrl,
            nextCapabilities,
            nextSession,
            saved.deviceId,
            account.login,
          )
          setAccountContext(nextAccountContext)
        } else {
          setProfile({ ...connection.profile, login: account.login, onboarding: saved.onboarding })
          setLogin(account.login)
          setCapabilities(nextCapabilities)
          setSession(nextSession)
          setAccountContext(nextAccountContext)
          setWorkspaces(nextWorkspaces)
          setWorkspaceId(selectedWorkspaceId ?? '')
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
        setAccountContext(null)
        setWorkspaceKey(null)
      }
    })
  }, [])

  const selectedWorkspace = useMemo(
    () => workspaces.find(workspace => workspace.id === workspaceId) ?? null,
    [workspaceId, workspaces],
  )
  const authorized = session !== null
  const authenticated = authorized && capabilities !== null
  const unlocked = authenticated && workspaceKey !== null && workspaceId.length > 0
  const syncPushDecision = accountContext?.actions['sync.push']
  const discoveredRegistration = discoveredCapabilities?.registration
  const passwordRegistrationAvailable = discoveredRegistration === undefined
    || discoveredRegistration.methods.includes('password')
  const setupRequired = discoveredRegistration?.methods.includes('setup') === true
  const browserRegistrationRequired = discoveredRegistration?.methods.includes('email-password') === true
    || discoveredRegistration?.methods.includes('invitation') === true
  const browserAuthorizationAvailable = discoveredCapabilities?.features?.deviceAuthorization !== false
  const storageBytes = accountContext === null ? null : sumAccountMetrics(
    accountContext.usage.metrics,
    ['activeObjectBytes', 'activeCrdtBytes', 'activeBlobBytes'],
  )
  const storageLimit = accountContext?.entitlements.limits.storage_bytes
  const monthlyIngressBytes = accountContext?.usage.metrics.monthlyIngressBytes
  const monthlyEgressBytes = accountContext?.usage.metrics.monthlyEgressBytes
  const mobile = isMobileRuntime()

  useEffect(() => {
    const checkingConnection = !connectionInitialized
      || busy === 'restore'
      || busy === 'authenticate'
      || busy === 'browser-authorize'
      || busy === 'pairing-link'
    onConnectionStateChange?.(
      checkingConnection
        ? 'checking'
        : unlocked
          ? 'connected'
          : authorized
            ? 'action-required'
            : 'disconnected',
    )
  }, [authorized, busy, connectionInitialized, onConnectionStateChange, unlocked])

  async function completeAuthentication(
    normalizedBaseUrl: string,
    nextCapabilities: ServerCapabilities,
    nextSession: ServerSession,
    deviceId: string,
  ) {
    const account = await getServerAccount(normalizedBaseUrl, nextSession.accessToken)
    const nextAccountContext = await loadAccountContext(normalizedBaseUrl, nextSession.accessToken)
    const awaitingRestoreEpochAcceptance = profile?.instanceId === nextCapabilities.instanceId
      && profile.syncEpoch !== undefined && nextCapabilities.syncEpoch !== undefined
      && profile.syncEpoch !== nextCapabilities.syncEpoch
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
    setAccountContext(nextAccountContext)
    if (awaitingRestoreEpochAcceptance) {
      // Preserve the last accepted epoch and durable local evidence. A new
      // credential alone must not unlock watchers or replay old commands.
      pauseNoteGenServerForRestoreEpoch()
      setBaseUrl(normalizedBaseUrl)
      setLogin(account.login)
      setPassword('')
      setSetupToken('')
      return
    }
    if (nextCapabilities.features?.managedDefaultWorkspace !== true) {
      // Hosted internal-test can deliberately require foreground E2EE setup.
      // Do not reinterpret that policy as a server-version failure or call the
      // managed-default endpoint as a fallback.
      const existing = await listServerWorkspaces(normalizedBaseUrl, nextSession.accessToken)
      setBaseUrl(normalizedBaseUrl)
      setLogin(account.login)
      setWorkspaces(existing)
      setWorkspaceId(existing.length === 1 ? existing[0]!.id : '')
      setPassword('')
      setSetupToken('')
      return
    }
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
      const deviceId = await getOrCreateServerDeviceId(
        nextCapabilities.instanceId,
        profile?.instanceId === nextCapabilities.instanceId ? profile.deviceId : undefined,
      )
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
      await completeDevicePairing(result.content, attempt)
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

  async function completeDevicePairing(value: string, attempt: number) {
    const pairing = parseDevicePairingUri(value, t('scanInvalidCode'))
    const nextCapabilities = await discoverServer(pairing.baseUrl)
    if (nextCapabilities.instanceId !== pairing.instanceId) throw new Error(t('scanServerMismatch'))
    if (profile?.baseUrl === pairing.baseUrl && profile.instanceId !== nextCapabilities.instanceId) {
      throw new Error(t('instanceChanged'))
    }
    const deviceId = await getOrCreateServerDeviceId(
      nextCapabilities.instanceId,
      profile?.instanceId === nextCapabilities.instanceId ? profile.deviceId : undefined,
    )
    const nextSession = await exchangeServerDevicePairing({
      baseUrl: pairing.baseUrl,
      pairingToken: pairing.pairingToken,
      deviceId,
      deviceName: getServerDeviceName(),
    })
    if (authorizationAttempt.current !== attempt) return
    await completeAuthentication(pairing.baseUrl, nextCapabilities, nextSession, deviceId)
  }

  async function handlePairingLink(value: string) {
    const attempt = ++authorizationAttempt.current
    setBusy('pairing-link')
    setError('')
    resetConnectionResults()
    try {
      await completeDevicePairing(value, attempt)
    } catch (cause) {
      if (authorizationAttempt.current !== attempt) return
      if (cause instanceof NoteGenServerRequestError && cause.code === 'pairing_expired') {
        setError(t('scanPairingExpired'))
      } else {
        setError(errorMessage(cause))
      }
    } finally {
      if (authorizationAttempt.current === attempt) setBusy(null)
    }
  }

  useEffect(() => {
    if (!pendingPairingUri) return
    const pairingUri = consumePairingUri()
    if (pairingUri) void handlePairingLink(pairingUri)
    // Pairing links are one-shot bearer credentials. Consume each received URI once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consumePairingUri, pendingPairingUri])

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
      setDiscoveredCapabilities(nextCapabilities)
      if (mode === 'register' && nextCapabilities.registration.methods.includes('email-password')) {
        throw new Error(t('hostedRegistrationInBrowser'))
      }
      if (mode === 'register' && nextCapabilities.registration.methods.includes('setup')) {
        throw new Error(t('setupInControlPlane'))
      }
      if (mode === 'register' && !nextCapabilities.registration.methods.includes('password')) {
        throw new Error(t('registrationUnavailable'))
      }
      const deviceId = await getOrCreateServerDeviceId(
        nextCapabilities.instanceId,
        profile?.instanceId === nextCapabilities.instanceId ? profile.deviceId : undefined,
      )
      const nextSession = await authenticateServer({
        baseUrl: normalizedBaseUrl,
        action: mode,
        login,
        password,
        ...(totpRequired ? { totpCode: totpCode.trim() } : {}),
        ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}),
        deviceId,
        deviceName: getServerDeviceName(),
      })
      await completeAuthentication(normalizedBaseUrl, nextCapabilities, nextSession, deviceId)
      setTotpCode('')
      setTotpRequired(false)
    } catch (cause) {
      if (cause instanceof NoteGenServerRequestError && cause.code === 'totp_required') {
        setTotpRequired(true)
        setError(t('totpRequired'))
      } else {
        setError(errorMessage(cause))
      }
    } finally {
      setBusy(null)
    }
  }

  async function handleDiscover() {
    setBusy('discover')
    setError('')
    try {
      const normalizedBaseUrl = normalizeServerOrigin(baseUrl)
      const nextCapabilities = await discoverServer(normalizedBaseUrl)
      if (profile?.baseUrl === normalizedBaseUrl && profile.instanceId !== nextCapabilities.instanceId) {
        throw new Error(t('instanceChanged'))
      }
      setDiscoveredCapabilities(nextCapabilities)
      if (nextCapabilities.features?.deviceAuthorization === false) setConnectionMethod('password')
      if (!nextCapabilities.registration.methods.includes('password')) setMode('login')
    } catch (cause) {
      setDiscoveredCapabilities(null)
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function handleOpenAccountPortal() {
    setBusy('open-account-portal')
    setError('')
    try {
      const nextCapabilities = discoveredCapabilities ?? await discoverServer(normalizeServerOrigin(baseUrl))
      setDiscoveredCapabilities(nextCapabilities)
      const accountUrl = nextCapabilities.web?.accountUrl
      const requiresBrowser = nextCapabilities.registration.methods.includes('email-password')
        || nextCapabilities.registration.methods.includes('invitation')
      if (!requiresBrowser || accountUrl === undefined) throw new Error(t('registrationUnavailable'))
      await openAuthorizationPage(accountUrl)
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
      if (profile?.onboarding) {
        // A process may have exited after the server created the workspace but
        // before its original recovery key was confirmed. Prove possession of
        // the passphrase first, then invalidate that unknown recovery route.
        const recoveryReplacementIdempotencyKey = profile.onboarding.recoveryReplacementIdempotencyKey ?? crypto.randomUUID()
        const pendingProfile: NoteGenServerProfile = {
          ...profile,
          onboarding: { ...profile.onboarding, recoveryReplacementIdempotencyKey },
        }
        // The opaque request key is durable before the request. On Android/iOS
        // the candidate secret is also journaled before send, so a crash can
        // retry the identical envelope rather than creating another route.
        await saveServerProfile(pendingProfile)
        setProfile(pendingProfile)
        const pendingRecoveryKey = await loadPendingServerWorkspaceRecoverySecret({
          profile: pendingProfile, accountId: session.accountId,
        }) ?? createServerWorkspaceRecoveryKey()
        await savePendingServerWorkspaceRecoverySecret({
          profile: pendingProfile, accountId: session.accountId, recoveryKey: pendingRecoveryKey,
        })
        const replacement = await replaceServerWorkspaceRecoveryKey({
          baseUrl,
          accessToken: session.accessToken,
          workspaceId,
          keyVersion: key.keyVersion,
          workspaceKey: key.key,
          idempotencyKey: recoveryReplacementIdempotencyKey,
          recoveryKey: pendingRecoveryKey,
        })
        setWorkspaceKey(key)
        setRecoveryKey(replacement.recoveryKey)
        await savePendingServerWorkspaceRecoverySecret({ profile: pendingProfile, accountId: session.accountId, recoveryKey: replacement.recoveryKey })
        setRecoveryCopied(false)
        setRecoveryConfirmation('')
        setSyncPassphrase('')
        setWorkspaceRecoveryKey('')
        return
      }
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

  async function handleCreateEndToEndWorkspace() {
    if (!session || !profile || syncPassphrase.length < 12 || syncPassphrase !== syncPassphraseConfirm) return
    const name = workspaceName.trim()
    if (!name) return
    setBusy('create-e2ee')
    setError('')
    try {
      const creationIdempotencyKey = crypto.randomUUID()
      // Only the opaque creation key is durable. The passphrase, recovery key
      // and workspace key remain in memory until recovery-key confirmation.
      const pendingProfile: NoteGenServerProfile = {
        ...profile,
        workspaceId: undefined,
        encryptionMode: undefined,
        onboarding: { creationIdempotencyKey },
      }
      await saveServerProfile(pendingProfile)
      setProfile(pendingProfile)
      const created = await createServerWorkspace({
        baseUrl,
        accessToken: session.accessToken,
        name,
        syncPassphrase,
        creationIdempotencyKey,
      })
      const nextProfile: NoteGenServerProfile = {
        ...pendingProfile,
        workspaceId: created.workspace.id,
        encryptionMode: 'e2ee',
      }
      await saveServerProfile(nextProfile)
      const nextWorkspaces = await listServerWorkspaces(baseUrl, session.accessToken)
      setProfile(nextProfile)
      setWorkspaces(nextWorkspaces)
      setWorkspaceId(created.workspace.id)
      setWorkspaceKey({ key: created.workspaceKey, keys: created.workspaceKeys, keyVersion: 1 })
      setRecoveryKey(created.recoveryKey)
      await savePendingServerWorkspaceRecoverySecret({ profile: nextProfile, accountId: session.accountId, recoveryKey: created.recoveryKey })
      setRecoveryCopied(false)
      setRecoveryConfirmation('')
      setSyncPassphrase('')
      setSyncPassphraseConfirm('')
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
      setRecoveryConfirmation('')
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

  async function handleConfirmRecoveryKey() {
    if (!session || !profile || !workspaceKey || !recoveryKey || !recoveryCopied
      || recoveryConfirmation.trim() !== recoveryKey.slice(-6)) return
    setError('')
    try {
      const nextProfile = { ...profile, onboarding: undefined }
      await clearPendingServerWorkspaceRecoverySecret({
        instanceId: profile.instanceId, accountId: session.accountId, deviceId: profile.deviceId,
      })
      await saveServerProfile(nextProfile)
      await configureNoteGenServerBackgroundSession(nextProfile, session)
      unlockNoteGenServerBackgroundWorkspace({
        workspaceKey: workspaceKey.key,
        workspaceKeys: workspaceKey.keys,
        keyVersion: workspaceKey.keyVersion,
      })
      setProfile(nextProfile)
      setRecoveryKey('')
      setRecoveryCopied(false)
      setRecoveryConfirmation('')
      await syncNoteGenServerNow()
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

  async function handleAcceptRestoreEpoch() {
    if (busy !== null) return
    setBusy('accept-restore-epoch')
    setError('')
    try {
      if (!await acceptNoteGenServerRestoreEpoch()) throw new Error(t('restoreEpochUnavailable'))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  function resetConnectionResults() {
    setRecoveryKey('')
    setRecoveryCopied(false)
    setRecoveryConfirmation('')
  }

  async function loadAccountContext(nextBaseUrl: string, accessToken: string): Promise<ServerAccountContext | null> {
    try {
      return await getServerAccountContext(nextBaseUrl, accessToken)
    } catch (cause) {
      // Context is an additive UI projection. A temporary outage must never
      // turn a valid authorization or existing sync session into a failed
      // connection; server-side operation enforcement remains authoritative.
      console.warn('Failed to load NoteGen Server account context:', cause)
      return null
    }
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
    if (logoutSession && logoutProfile) {
      await clearPendingServerWorkspaceRecoverySecret({
        instanceId: logoutProfile.instanceId, accountId: logoutSession.accountId, deviceId: logoutProfile.deviceId,
      }).catch(() => undefined)
    }
    await clearServerProfile()
    setProfile(null)
    setCapabilities(null)
    setSession(null)
    setAccountContext(null)
    setWorkspaces([])
    setWorkspaceId('')
    setWorkspaceKey(null)
    setRecoveryKey('')
    setRecoveryCopied(false)
    setRecoveryConfirmation('')
    setSyncPassphrase('')
    setSyncPassphraseConfirm('')
    setWorkspaceRecoveryKey('')
    setWorkspaceUnlockMethod('passphrase')
    setTotpCode('')
    setTotpRequired(false)
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

        {syncPushDecision?.effect === 'deny' ? (
          <Alert variant="warning">
            <AlertCircle />
            <AlertTitle>{t('syncError')}</AlertTitle>
            <AlertDescription>{`${t('syncPausedDescription')} (${syncPushDecision.reasonCode})`}</AlertDescription>
          </Alert>
        ) : null}

        {authenticated && accountContext && storageBytes !== null ? (
          <Alert>
            <Server />
            <AlertTitle>{t('accountUsage')}</AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              <span>{storageLimit === undefined || storageLimit === null
                ? t('storageUsageUnlimited', { used: formatAccountBytes(storageBytes) })
                : t('storageUsage', { used: formatAccountBytes(storageBytes), limit: formatAccountBytes(storageLimit) })}</span>
              {monthlyIngressBytes !== undefined || monthlyEgressBytes !== undefined ? (
                <span>{t('monthlyTransfer', {
                  ingress: formatAccountBytes(monthlyIngressBytes ?? '0'),
                  egress: formatAccountBytes(monthlyEgressBytes ?? '0'),
                })}</span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {!authorized && connectionInitialized && busy !== 'restore' ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="note-gen-server-url">{t('serverUrl')}</FieldLabel>
              <Input
                id="note-gen-server-url"
                value={baseUrl}
                onChange={event => {
                  setBaseUrl(event.target.value)
                  setDiscoveredCapabilities(null)
                }}
                disabled={pendingAuthorization !== null}
                placeholder="https://sync.example.com"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <FieldDescription>{t('serverUrlDescription')}</FieldDescription>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 self-start"
                onClick={() => void handleDiscover()}
                disabled={busy !== null || !baseUrl.trim()}
              >
                {busy === 'discover' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Server data-icon="inline-start" />}
                {busy === 'discover' ? t('discoveringServer') : t('discoverServer')}
              </Button>
              {discoveredCapabilities ? (
                <FieldDescription>
                  {discoveredCapabilities.readiness === 'ready'
                    ? t('discoveryReady', {
                        server: discoveredCapabilities.serverName,
                        policy: discoveredCapabilities.registration.policy,
                      })
                    : t('discoveryUnavailable', { server: discoveredCapabilities.serverName })}
                </FieldDescription>
              ) : null}
            </Field>
            <Field>
              <FieldLabel>{t('connectionMethod')}</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={connectionMethod}
                disabled={pendingAuthorization !== null}
                onValueChange={value => {
                  if (value === 'browser' || value === 'password') setConnectionMethod(value)
                }}
              >
                <ToggleGroupItem value="browser" disabled={!browserAuthorizationAvailable}>
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
                      if (value === 'login' || value === 'register') {
                        setMode(value)
                        setTotpCode('')
                        setTotpRequired(false)
                      }
                    }}
                  >
                    <ToggleGroupItem value="login">{t('login')}</ToggleGroupItem>
                    {passwordRegistrationAvailable ? <ToggleGroupItem value="register">{t('register')}</ToggleGroupItem> : null}
                  </ToggleGroup>
                </Field>
                {mode === 'login' && totpRequired ? (
                  <Field>
                    <FieldLabel htmlFor="note-gen-server-totp">{t('totpCode')}</FieldLabel>
                    <Input
                      id="note-gen-server-totp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={totpCode}
                      onChange={event => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    />
                  </Field>
                ) : null}
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
                {mode === 'register' && setupRequired ? (
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
            {workspaces.length > 1 ? (
              <Field>
                <FieldLabel htmlFor="note-gen-workspace-select">{t('selectWorkspace')}</FieldLabel>
                <select
                  id="note-gen-workspace-select"
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={workspaceId}
                  onChange={event => {
                    setWorkspaceId(event.target.value)
                    setWorkspaceKey(null)
                    setRecoveryKey('')
                    setRecoveryConfirmation('')
                  }}
                >
                  <option value="">{t('selectWorkspace')}</option>
                  {workspaces.map((workspace, index) => (
                    <option key={workspace.id} value={workspace.id}>
                      {t('workspaceOption', { index: index + 1, id: workspace.id })}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            {workspaces.length === 0 && profile?.onboarding === undefined ? (
              <details open className="rounded-lg border p-4">
                <summary className="cursor-pointer font-medium">{t('createWorkspace')}</summary>
                <div className="mt-4 flex flex-col gap-4">
                  <FieldDescription>{t('syncPassphraseDescription')}</FieldDescription>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="note-gen-first-workspace-name">{t('workspaceName')}</FieldLabel>
                      <Input
                        id="note-gen-first-workspace-name"
                        value={workspaceName}
                        onChange={event => setWorkspaceName(event.target.value)}
                        autoComplete="off"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="note-gen-first-workspace-passphrase">{t('syncPassphrase')}</FieldLabel>
                      <Input
                        id="note-gen-first-workspace-passphrase"
                        type="password"
                        value={syncPassphrase}
                        onChange={event => setSyncPassphrase(event.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="note-gen-first-workspace-passphrase-confirm">{t('syncPassphraseConfirm')}</FieldLabel>
                      <Input
                        id="note-gen-first-workspace-passphrase-confirm"
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
                    onClick={() => void handleCreateEndToEndWorkspace()}
                    disabled={busy !== null || !workspaceName.trim() || syncPassphrase.length < 12 || syncPassphrase !== syncPassphraseConfirm}
                  >
                    {busy === 'create-e2ee' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                    {t('createWorkspace')}
                  </Button>
                </div>
              </details>
            ) : null}

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
              {profile?.onboarding ? (
                <>
                  <Field className="w-full">
                    <FieldLabel htmlFor="note-gen-recovery-confirmation">
                      {t('recoveryConfirmLabel', { suffix: recoveryKey.slice(-6) })}
                    </FieldLabel>
                    <Input
                      id="note-gen-recovery-confirmation"
                      value={recoveryConfirmation}
                      onChange={event => setRecoveryConfirmation(event.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                      autoComplete="off"
                    />
                  </Field>
                  <Button
                    size="sm"
                    onClick={() => void handleConfirmRecoveryKey()}
                    disabled={!recoveryCopied || recoveryConfirmation.trim() !== recoveryKey.slice(-6)}
                  >
                    {t('activateAndSync')}
                  </Button>
                </>
              ) : null}
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
              {backgroundStatus.reason === undefined ? <span>{backgroundStatus.error}</span> : null}
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
        {backgroundStatus.phase === 'paused' && backgroundStatus.error ? (
          <Alert variant="warning">
            <AlertCircle />
            <AlertTitle>{t('syncError')}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <span>{backgroundStatus.error}</span>
              <span>{t(pausedReasonTranslationKey(backgroundStatus.reason))}</span>
              {backgroundStatus.reason === 'sync_epoch_changed' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleAcceptRestoreEpoch()}
                  disabled={busy !== null}
                >
                  {busy === 'accept-restore-epoch'
                    ? <Loader2 data-icon="inline-start" className="animate-spin" />
                    : <RefreshCw data-icon="inline-start" />}
                  {busy === 'accept-restore-epoch' ? t('syncingNow') : t('restoreEpochAccept')}
                </Button>
              ) : null}
              {backgroundStatus.reason === 'restore_reauthorization_required' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleBrowserConnect()}
                  disabled={busy !== null || !baseUrl.trim()}
                >
                  {busy === 'browser-authorize'
                    ? <Loader2 data-icon="inline-start" className="animate-spin" />
                    : <Globe data-icon="inline-start" />}
                  {busy === 'browser-authorize' ? t('openingBrowser') : t('browserConnect')}
                </Button>
              ) : null}
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
        {!authorized && connectionInitialized && busy !== 'restore' ? (
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
                {busy === 'browser-authorize'
                  ? <Loader2 data-icon="inline-start" className="animate-spin" />
                  : <Globe data-icon="inline-start" />}
                {busy === 'browser-authorize' ? t('openingBrowser') : t('browserConnect')}
              </Button>
            )
          ) : (
            <Button
              onClick={() => void handleAuthenticate()}
              disabled={busy !== null || !baseUrl.trim() || !login.trim() || password.length < 12
                || (mode === 'login' && totpRequired && totpCode.length !== 6)}
            >
              {busy === 'authenticate' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Server data-icon="inline-start" />}
              {busy === 'authenticate' ? t('connecting') : t('connect')}
            </Button>
          )}
          {browserRegistrationRequired ? (
            <Button
              variant="outline"
              onClick={() => void handleOpenAccountPortal()}
              disabled={busy !== null || !baseUrl.trim()}
            >
              {busy === 'open-account-portal'
                ? <Loader2 data-icon="inline-start" className="animate-spin" />
                : <ExternalLink data-icon="inline-start" />}
              {busy === 'open-account-portal' ? t('openingAccountPortal') : t('openAccountPortal')}
            </Button>
          ) : null}
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

function pausedReasonTranslationKey(reason: string | undefined): string {
  switch (reason) {
    case 'email_verification_required': return 'pauseReason.emailVerification'
    case 'policy_acceptance_required':
    case 'policy_reacceptance_required': return 'pauseReason.policyAcceptance'
    case 'risk_challenge_required':
    case 'risk_temporarily_locked':
    case 'risk_review_required':
    case 'risk_denied': return 'pauseReason.securityReview'
    case 'quota_exceeded': return 'pauseReason.quota'
    case 'device_limit_exceeded': return 'pauseReason.deviceLimit'
    case 'workspace_limit_exceeded': return 'pauseReason.workspaceLimit'
    case 'account_read_only': return 'pauseReason.readOnly'
    case 'credential_review_required': return 'pauseReason.credentialReview'
    case 'server_maintenance': return 'pauseReason.maintenance'
    case 'cursor_expired': return 'pauseReason.cursorExpired'
    case 'sync_epoch_changed': return 'pauseReason.syncEpochChanged'
    case 'instance_auth_epoch_invalid': return 'pauseReason.reauthorize'
    case 'restore_reauthorization_required': return 'pauseReason.reauthorize'
    default: return 'syncPausedDescription'
  }
}

function sumAccountMetrics(metrics: Record<string, string>, keys: readonly string[]): string {
  return keys.reduce((sum, key) => sum + parseAccountBytes(metrics[key]), BigInt(0)).toString()
}

function formatAccountBytes(value: string | number): string {
  let bytes = parseAccountBytes(value)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let unit = 0
  while (bytes >= BigInt(1024) && unit < units.length - 1) {
    bytes /= BigInt(1024)
    unit += 1
  }
  return `${bytes.toString()} ${units[unit]}`
}

function parseAccountBytes(value: string | number | undefined): bigint {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : BigInt(0)
  return value !== undefined && /^(?:0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : BigInt(0)
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
