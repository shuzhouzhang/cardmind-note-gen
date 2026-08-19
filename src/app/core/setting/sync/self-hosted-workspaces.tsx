'use client'

import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { exists, readFile } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'
import { Check, FolderOpen, Link2, Loader2, Plus, RefreshCw, Trash2, UserPlus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { getDb } from '@/db'
import { refreshSelfHostedSyncRuntime } from '@/lib/self-hosted-sync/lifecycle'
import { authenticatedClient, getProfile, updateDomainToggle } from '@/lib/self-hosted-sync/profile'
import type { WorkspaceCapability, WorkspaceInvitation, WorkspaceMember } from '@/lib/self-hosted-sync/protocol'
import {
  bindLibrary, createLibrary, listLibraries, unbindLibrary, type SelfHostedLibrary,
} from '@/lib/self-hosted-sync/workspaces'
import { bytesToBase64Url, hashBytes } from '@/lib/self-hosted-sync/blob'
import { enqueueAssetSnapshot, enqueueFileSnapshot } from '@/lib/self-hosted-sync/outbox'

const ROLE_CAPABILITIES: Record<'viewer' | 'editor' | 'manager', WorkspaceCapability[]> = {
  viewer: ['content.read', 'history.view'],
  editor: ['content.read', 'content.create', 'content.update', 'content.delete', 'history.view'],
  manager: [
    'content.read', 'content.create', 'content.update', 'content.delete',
    'history.view', 'history.restore', 'member.invite', 'member.update',
    'member.remove', 'workspace.rename',
  ],
}

const CAPABILITIES = Object.keys({
  'content.read': true, 'content.create': true, 'content.update': true, 'content.delete': true,
  'history.view': true, 'history.restore': true, 'member.invite': true,
  'member.update': true, 'member.remove': true, 'workspace.rename': true,
  'workspace.delete': true,
}) as WorkspaceCapability[]

const DOMAINS = ['tags', 'marks', 'conversations', 'messages', 'memories', 'settings', 'attachments'] as const
const CONFLICT_TRANSLATION_KEYS: Record<string, 'snapshot-diverged' | 'remote-delete-local-edit' | 'viewer-local-edit' | 'protocol-conflict' | 'symlink-ignored'> = {
  'snapshot-diverged': 'snapshot-diverged',
  'remote-delete-local-edit': 'remote-delete-local-edit',
  'viewer-local-edit': 'viewer-local-edit',
  'protocol-conflict': 'protocol-conflict',
  'symlink-ignored': 'symlink-ignored',
}

interface ConflictRow {
  id: string
  workspaceId: string
  conflictType: string
  localCopyPath: string | null
  createdAt: number
}

export function SelfHostedWorkspaces({ profileId }: { profileId: string }) {
  const t = useTranslations('settings.sync.selfHosted')
  const [libraries, setLibraries] = useState<SelfHostedLibrary[]>([])
  const [pendingInvitations, setPendingInvitations] = useState<WorkspaceInvitation[]>([])
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [conflicts, setConflicts] = useState<ConflictRow[]>([])
  const [toggles, setToggles] = useState<Record<string, boolean>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [libraryName, setLibraryName] = useState('')
  const [inviteLogin, setInviteLogin] = useState('')
  const [role, setRole] = useState<'viewer' | 'editor' | 'manager'>('editor')
  const [capabilities, setCapabilities] = useState<WorkspaceCapability[]>(ROLE_CAPABILITIES.editor)
  const [busy, setBusy] = useState(false)
  const [conflictTargetId, setConflictTargetId] = useState('')

  const refresh = useCallback(async () => {
    const [{ client }, profile, nextLibraries, conflictRows] = await Promise.all([
      authenticatedClient(profileId),
      getProfile(profileId),
      listLibraries(profileId),
      (await getDb()).select<ConflictRow[]>(
        `select id, workspace_id as workspaceId, conflict_type as conflictType,
           local_copy_path as localCopyPath, created_at as createdAt
         from self_hosted_conflicts where state = 'unresolved' order by created_at desc`
      ),
    ])
    setLibraries(nextLibraries)
    setToggles(profile?.domainToggles ?? {})
    setConflicts(conflictRows)
    setPendingInvitations(await client.pendingInvitations())
    const nextSelected = selectedId ?? nextLibraries[0]?.id ?? null
    setSelectedId(nextSelected)
    setMembers(nextSelected ? await client.members(nextSelected).catch(() => []) : [])
  }, [profileId, selectedId])

  useEffect(() => { void refresh() }, [refresh])

  async function chooseDirectory() {
    const store = await Store.load('store.json')
    const suggested = await store.get<string>('selfHostedSuggestedRoot')
    if (suggested) {
      await store.delete('selfHostedSuggestedRoot')
      await store.save()
      return suggested
    }
    const selected = await open({ directory: true, multiple: false })
    return typeof selected === 'string' ? selected : null
  }

  async function createNewLibrary() {
    const localRoot = await chooseDirectory()
    if (!localRoot) return
    setBusy(true)
    try {
      await createLibrary(profileId, libraryName || t('newLibraryDefaultName'), localRoot)
      setLibraryName('')
      await refreshSelfHostedSyncRuntime()
      await refresh()
      toast.success(t('libraryCreated'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('operationFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function bind(workspaceId: string) {
    const localRoot = await chooseDirectory()
    if (!localRoot) return
    setBusy(true)
    try {
      await bindLibrary(profileId, workspaceId, localRoot, true)
      await refreshSelfHostedSyncRuntime()
      await refresh()
      toast.success(t('libraryBound'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('operationFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function unbind(workspaceId: string) {
    await unbindLibrary(workspaceId)
    await refreshSelfHostedSyncRuntime()
    await refresh()
    toast.success(t('libraryUnbound'))
  }

  async function accept(invitationId: string) {
    const { client } = await authenticatedClient(profileId)
    await client.acceptInvitation(invitationId)
    await refresh()
  }

  async function inviteAccount() {
    if (!selectedId || !inviteLogin.trim()) return
    const { client } = await authenticatedClient(profileId)
    await client.inviteAccount(selectedId, { login: inviteLogin.trim(), role, capabilities })
    setInviteLogin('')
    await refresh()
    toast.success(t('invitationCreated'))
  }

  async function createLink() {
    if (!selectedId) return
    const { client } = await authenticatedClient(profileId)
    const invitation = await client.createInvitationLink(selectedId, { role, capabilities })
    if (invitation.token) {
      const server = await client.capabilities()
      const link = new URL('/invitations/accept', server.web.accountUrl)
      link.searchParams.set('token', invitation.token)
      await writeText(link.toString())
    }
    toast.success(t('linkCopied'))
  }

  async function changeMemberRole(member: WorkspaceMember, nextRole: 'viewer' | 'editor' | 'manager') {
    if (!selectedId) return
    const { client } = await authenticatedClient(profileId)
    await client.updateMember(selectedId, member.accountId, {
      role: nextRole,
      capabilities: ROLE_CAPABILITIES[nextRole],
    })
    await refresh()
  }

  async function removeMember(accountId: string) {
    if (!selectedId) return
    const { client } = await authenticatedClient(profileId)
    await client.removeMember(selectedId, accountId)
    await refresh()
  }

  async function resolveConflict(id: string) {
    const database = await getDb()
    await database.execute(
      "update self_hosted_conflicts set state = 'resolved-local-kept', resolved_at = $1 where id = $2",
      [Date.now(), id]
    )
    await refresh()
  }

  async function transferViewerConflict(conflict: ConflictRow) {
    if (!conflict.localCopyPath || !conflictTargetId) return
    const source = libraries.find(library => library.id === conflict.workspaceId)
    const target = libraries.find(library => library.id === conflictTargetId)
    if (!source?.localRoot || !target?.localRoot || !target.owner || target.accessMode !== 'read-write') {
      toast.error(t('transferTargetUnavailable'))
      return
    }
    try {
      const bytes = await readFile(await join(source.localRoot, conflict.localCopyPath))
      let targetPath = conflict.localCopyPath
      if (await exists(await join(target.localRoot, targetPath))) {
        const dot = targetPath.lastIndexOf('.')
        const suffix = `.viewer-copy-${Date.now()}`
        targetPath = dot > targetPath.lastIndexOf('/')
          ? `${targetPath.slice(0, dot)}${suffix}${targetPath.slice(dot)}`
          : `${targetPath}${suffix}`
      }
      const expectedHash = await hashBytes(bytes)
      await invoke('self_hosted_atomic_write', {
        workspaceId: target.id,
        objectId: null,
        workspaceRoot: target.localRoot,
        relativePath: targetPath,
        contents: bytesToBase64Url(bytes),
        expectedHash,
      })
      if (targetPath.toLowerCase().endsWith('.md')) {
        await enqueueFileSnapshot(targetPath, 'upsert', target.id)
      } else await enqueueAssetSnapshot(targetPath, 'upsert', target.id)
      await resolveConflict(conflict.id)
      toast.success(t('transferredToLibrary', { name: target.name }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('operationFailed'))
    }
  }

  function changeRole(nextRole: 'viewer' | 'editor' | 'manager') {
    setRole(nextRole)
    setCapabilities(ROLE_CAPABILITIES[nextRole])
  }

  function conflictLabel(conflictType: string) {
    const translationKey = CONFLICT_TRANSLATION_KEYS[conflictType]
    return translationKey ? t(`conflictTypes.${translationKey}`) : conflictType
  }

  const selected = libraries.find(library => library.id === selectedId)

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('personalDataTitle')}</CardTitle>
          <CardDescription>{t('personalDataDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {DOMAINS.map(domain => (
              <Field key={domain} orientation="horizontal">
                <div className="flex-1">
                  <FieldLabel htmlFor={`self-hosted-domain-${domain}`}>{t(`domains.${domain}.title`)}</FieldLabel>
                  <FieldDescription>{t(`domains.${domain}.description`)}</FieldDescription>
                </div>
                <Switch
                  id={`self-hosted-domain-${domain}`}
                  checked={toggles[domain] !== false}
                  onCheckedChange={enabled => void (async () => {
                    setToggles(await updateDomainToggle(profileId, domain, enabled))
                    await refreshSelfHostedSyncRuntime()
                  })()}
                />
              </Field>
            ))}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('librariesTitle')}</CardTitle>
          <CardDescription>{t('librariesDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingInvitations.map(invitation => (
            <div key={invitation.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{t('invitedBy', { login: invitation.inviterLogin ?? '' })}</p>
                <p className="text-xs text-muted-foreground">{t('invitationRole', { role: invitation.role })}</p>
              </div>
              <Button size="sm" onClick={() => void accept(invitation.id)}>
                <Check data-icon="inline-start" />{t('accept')}
              </Button>
            </div>
          ))}

          {libraries.map(library => (
            <div
              key={library.id}
              role="button"
              tabIndex={0}
              className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left hover:bg-muted/50"
              onClick={() => setSelectedId(library.id)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') setSelectedId(library.id)
              }}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{library.name}</p>
                <p className="truncate text-xs text-muted-foreground">{library.localRoot ?? t('notBound')}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={library.accessMode === 'read-only' ? 'secondary' : 'outline'}>
                  {library.accessMode === 'read-only' ? t('readOnly') : t('readWrite')}
                </Badge>
                {!library.localRoot ? (
                  <Button asChild size="sm" variant="outline">
                    <span onClick={event => { event.stopPropagation(); void bind(library.id) }}>
                      <FolderOpen data-icon="inline-start" />{t('bind')}
                    </span>
                  </Button>
                ) : (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('unbind')}
                    onClick={event => { event.stopPropagation(); void unbind(library.id) }}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            </div>
          ))}

          <Separator />
          <Field>
            <FieldLabel htmlFor="self-hosted-library-name">{t('newLibraryName')}</FieldLabel>
            <Input
              id="self-hosted-library-name"
              value={libraryName}
              onChange={event => setLibraryName(event.target.value)}
              placeholder={t('newLibraryDefaultName')}
            />
          </Field>
        </CardContent>
        <CardFooter>
          <Button disabled={busy} onClick={() => void createNewLibrary()}>
            {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}
            {t('createLibrary')}
          </Button>
          <Button className="ml-2" variant="outline" onClick={() => void refresh()}>
            <RefreshCw data-icon="inline-start" />{t('refresh')}
          </Button>
        </CardFooter>
      </Card>

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('membersTitle', { name: selected.name })}</CardTitle>
            <CardDescription>{t('membersDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {members.map(member => (
              <div key={member.accountId} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">{member.login}</p>
                  <p className="text-xs text-muted-foreground">{member.role}</p>
                </div>
                <div className="flex items-center gap-2">
                  {member.role !== 'owner' && selected.capabilities.includes('member.update') ? (
                    <Select value={member.role} onValueChange={value => void changeMemberRole(member, value as 'viewer' | 'editor' | 'manager')}>
                      <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="viewer">Viewer</SelectItem>
                        <SelectItem value="editor">Editor</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : null}
                  {member.role !== 'owner' && selected.capabilities.includes('member.remove') ? (
                    <Button size="icon-sm" variant="ghost" aria-label={t('removeMember')} onClick={() => void removeMember(member.accountId)}>
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}

            {selected.capabilities.includes('member.invite') ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="self-hosted-invite-login">{t('accountLogin')}</FieldLabel>
                  <Input id="self-hosted-invite-login" value={inviteLogin} onChange={event => setInviteLogin(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel>{t('roleTemplate')}</FieldLabel>
                  <Select value={role} onValueChange={value => changeRole(value as typeof role)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="editor">Editor</SelectItem>
                      <SelectItem value="manager">Manager</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>{t('capabilities')}</FieldLabel>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {CAPABILITIES.map(capability => (
                      <label key={capability} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs">
                        {capability}
                        <Switch
                          checked={capabilities.includes(capability)}
                          onCheckedChange={enabled => setCapabilities(current => enabled
                            ? [...new Set([...current, capability])]
                            : current.filter(item => item !== capability))}
                        />
                      </label>
                    ))}
                  </div>
                </Field>
              </FieldGroup>
            ) : null}
          </CardContent>
          {selected.capabilities.includes('member.invite') ? (
            <CardFooter className="flex-wrap gap-2">
              <Button disabled={!inviteLogin.trim()} onClick={() => void inviteAccount()}>
                <UserPlus data-icon="inline-start" />{t('inviteAccount')}
              </Button>
              <Button variant="outline" onClick={() => void createLink()}>
                <Link2 data-icon="inline-start" />{t('copyInviteLink')}
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('conflictsTitle')}</CardTitle>
          <CardDescription>{t('conflictsDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {libraries.some(library => library.owner && library.localRoot && library.accessMode === 'read-write') ? (
            <Select value={conflictTargetId} onValueChange={setConflictTargetId}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('transferTarget')} /></SelectTrigger>
              <SelectContent>
                {libraries.filter(library => library.owner && library.localRoot && library.accessMode === 'read-write').map(library => (
                  <SelectItem key={library.id} value={library.id}>{library.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {conflicts.length === 0 ? <p className="text-sm text-muted-foreground">{t('noConflicts')}</p> : null}
          {conflicts.map(conflict => (
            <div key={conflict.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{conflictLabel(conflict.conflictType)}</p>
                <p className="truncate text-xs text-muted-foreground">{conflict.localCopyPath ?? new Date(conflict.createdAt).toLocaleString()}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {conflict.conflictType === 'viewer-local-edit' ? (
                  <Button size="sm" disabled={!conflictTargetId} onClick={() => void transferViewerConflict(conflict)}>
                    {t('transferToLibrary')}
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => void resolveConflict(conflict.id)}>
                  <Check data-icon="inline-start" />{t('keepLocalCopy')}
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  )
}
