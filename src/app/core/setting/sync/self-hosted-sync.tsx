'use client'

import { useEffect, useState } from 'react'
import { Store } from '@tauri-apps/plugin-store'
import { AlertTriangle, Loader2, LogIn, LogOut, Server } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { getDb } from '@/db'
import { connectWithBrowser, connectWithPassword, disconnectProfile } from '@/lib/self-hosted-sync/profile'
import { refreshSelfHostedSyncRuntime } from '@/lib/self-hosted-sync/lifecycle'
import { normalizeServerUrl } from '@/lib/self-hosted-sync/client'
import useSyncStore from '@/stores/sync'
import { SelfHostedWorkspaces } from './self-hosted-workspaces'

export function SelfHostedSync() {
  const t = useTranslations('settings.sync.selfHosted')
  const [experimental, setExperimental] = useState(false)
  const [serverUrl, setServerUrl] = useState('')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [showPasswordLogin, setShowPasswordLogin] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [insecureHttp, setInsecureHttp] = useState(false)
  const [profileId, setProfileId] = useState<string | null>(null)
  const { selfHostedConnected, setSelfHostedConnected } = useSyncStore()

  useEffect(() => {
    void (async () => {
      const store = await Store.load('store.json')
      setExperimental(await store.get<boolean>('experimentalSelfHostedSync') === true)
      const database = await getDb()
      const profiles = await database.select<Array<{ id: string; serverUrl: string }>>(
        "select id, server_url as serverUrl from self_hosted_sync_profiles where state = 'connected' limit 1"
      )
      if (profiles[0]) {
        setProfileId(profiles[0].id)
        setServerUrl(profiles[0].serverUrl)
        setSelfHostedConnected(true)
        setInsecureHttp(normalizeServerUrl(profiles[0].serverUrl).insecureHttp)
      }
    })()
  }, [setSelfHostedConnected])

  async function updateExperimental(enabled: boolean) {
    const store = await Store.load('store.json')
    await store.set('experimentalSelfHostedSync', enabled)
    await store.save()
    setExperimental(enabled)
    await refreshSelfHostedSyncRuntime()
  }

  function updateServerUrl(value: string) {
    setServerUrl(value)
    try {
      setInsecureHttp(normalizeServerUrl(value).insecureHttp)
    } catch {
      setInsecureHttp(false)
    }
  }

  async function connect(mode: 'browser' | 'password') {
    setConnecting(true)
    try {
      if (!experimental) await updateExperimental(true)
      if (mode === 'browser') {
        const profile = await connectWithBrowser({ serverUrl, deviceName: 'NoteGen' })
        setProfileId(profile.id)
      } else {
        const profile = await connectWithPassword({
          serverUrl, login, password,
          ...(totpCode.trim() ? { totpCode: totpCode.trim() } : {}),
          deviceName: 'NoteGen',
        })
        setProfileId(profile.id)
      }
      setSelfHostedConnected(true)
      await refreshSelfHostedSyncRuntime()
      toast.success(t('connectedToast'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('connectionFailed'))
    } finally {
      setConnecting(false)
    }
  }

  async function disconnect() {
    if (!profileId) return
    await disconnectProfile(profileId)
    setProfileId(null)
    setSelfHostedConnected(false)
    await refreshSelfHostedSyncRuntime()
    toast.success(t('disconnectedToast'))
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('experimentalTitle')}</CardTitle>
          <CardDescription>{t('experimentalDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Field orientation="horizontal">
            <div className="flex-1">
              <FieldLabel htmlFor="self-hosted-experimental">{t('experimentalLabel')}</FieldLabel>
              <FieldDescription>{t('experimentalHint')}</FieldDescription>
            </div>
            <Switch
              id="self-hosted-experimental"
              checked={experimental}
              onCheckedChange={enabled => void updateExperimental(enabled)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('connectionTitle')}</CardTitle>
          <CardDescription>{t('connectionDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="self-hosted-server-url">{t('serverUrl')}</FieldLabel>
              <Input
                id="self-hosted-server-url"
                type="url"
                value={serverUrl}
                onChange={event => updateServerUrl(event.target.value)}
                placeholder="https://sync.example.com"
                disabled={connecting || selfHostedConnected}
              />
              <FieldDescription>{t('httpsNoDowngrade')}</FieldDescription>
            </Field>
          </FieldGroup>

          {insecureHttp ? (
            <Alert className="mt-4">
              <AlertTriangle />
              <AlertTitle>{t('insecureTitle')}</AlertTitle>
              <AlertDescription>{t('insecureDescription')}</AlertDescription>
            </Alert>
          ) : null}

          {showPasswordLogin && !selfHostedConnected ? (
            <FieldGroup className="mt-4">
              <Field>
                <FieldLabel htmlFor="self-hosted-login">{t('login')}</FieldLabel>
                <Input id="self-hosted-login" value={login} onChange={event => setLogin(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="self-hosted-password">{t('password')}</FieldLabel>
                <Input id="self-hosted-password" type="password" value={password} onChange={event => setPassword(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="self-hosted-totp">{t('totp')}</FieldLabel>
                <Input id="self-hosted-totp" inputMode="numeric" maxLength={6} value={totpCode} onChange={event => setTotpCode(event.target.value)} />
              </Field>
            </FieldGroup>
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          {selfHostedConnected ? (
            <Button variant="secondary" disabled>
              <Server data-icon="inline-start" />
              {t('connected')}
            </Button>
          ) : (
            <>
              <Button disabled={connecting || !serverUrl.trim()} onClick={() => void connect('browser')}>
                {connecting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <LogIn data-icon="inline-start" />}
                {t('browserAuthorization')}
              </Button>
              {showPasswordLogin ? (
                <Button variant="outline" disabled={connecting || !login.trim() || !password} onClick={() => void connect('password')}>
                  {t('passwordLogin')}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setShowPasswordLogin(true)}>{t('usePassword')}</Button>
              )}
            </>
          )}
        </CardFooter>
      </Card>
      {selfHostedConnected && profileId ? (
        <>
          <SelfHostedWorkspaces profileId={profileId} />
          <Card>
            <CardHeader>
              <CardTitle>{t('disconnectTitle')}</CardTitle>
              <CardDescription>{t('disconnectDescription')}</CardDescription>
            </CardHeader>
            <CardFooter>
              <Button variant="outline" onClick={() => void disconnect()}>
                <LogOut data-icon="inline-start" />{t('disconnect')}
              </Button>
            </CardFooter>
          </Card>
        </>
      ) : null}
    </div>
  )
}
