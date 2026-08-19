import { invoke } from '@tauri-apps/api/core'
import { readDir, readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { Store } from '@tauri-apps/plugin-store'
import { getDb } from '@/db'
import { decryptText } from './crypto'
import { authenticatedClient, secureSet, workspaceSecretKey } from './profile'
import { enqueueAssetSnapshot, enqueueFileSnapshot, enqueueFolderSnapshot } from './outbox'
import { bytesToBase64Url } from './blob'
import type { WorkspaceSummary } from './protocol'

interface EncryptedName {
  nonce: string
  ciphertext: string
}

export interface SelfHostedLibrary extends WorkspaceSummary {
  name: string
  localRoot: string | null
  bindingState: string | null
  accessMode: 'read-write' | 'read-only'
}

export async function listLibraries(profileId: string): Promise<SelfHostedLibrary[]> {
  const { client } = await authenticatedClient(profileId)
  const workspaces = (await client.workspaces()).filter(workspace => workspace.type === 'library')
  const database = await getDb()
  const bindings = await database.select<Array<{
    workspaceId: string
    localRoot: string | null
    bindingState: string
    accessMode: 'read-write' | 'read-only'
  }>>(
    `select workspace_id as workspaceId, local_root as localRoot,
       binding_state as bindingState, access_mode as accessMode
     from self_hosted_workspace_bindings where profile_id = $1`,
    [profileId]
  )
  return Promise.all(workspaces.map(async workspace => {
    const key = await ensureManagedWorkspaceKey(profileId, workspace.id, workspace.latestKeyVersion)
    const encrypted = JSON.parse(workspace.nameCiphertext) as EncryptedName
    const binding = bindings.find(item => item.workspaceId === workspace.id)
    return {
      ...workspace,
      name: await decryptText(key, encrypted.nonce, encrypted.ciphertext, 'workspace-name:v1'),
      localRoot: binding?.localRoot ?? null,
      bindingState: binding?.bindingState ?? null,
      accessMode: binding?.accessMode ?? (workspace.capabilities.includes('content.update') ? 'read-write' : 'read-only'),
    }
  }))
}

export async function createLibrary(profileId: string, name: string, localRoot: string) {
  const { client } = await authenticatedClient(profileId)
  const key = await invoke<string>('self_hosted_generate_workspace_key')
  const encryptedName = await invoke<EncryptedName>('self_hosted_encrypt', {
    key,
    plaintext: name.trim(),
    associatedData: 'workspace-name:v1',
  })
  const workspace = await client.createLibrary(
    JSON.stringify(encryptedName),
    key,
    crypto.randomUUID(),
  )
  await secureSet(workspaceSecretKey(workspace.id, 1), key)
  await bindLibrary(profileId, workspace.id, localRoot, true)
  return workspace.id
}

export async function bindLibrary(
  profileId: string,
  workspaceId: string,
  localRoot: string,
  scanLocal: boolean,
) {
  const { client } = await authenticatedClient(profileId)
  const workspace = (await client.workspaces()).find(item => item.id === workspaceId && item.type === 'library')
  if (!workspace) throw new Error('资料库不存在或当前账号无权访问')
  await ensureManagedWorkspaceKey(profileId, workspaceId, workspace.latestKeyVersion)
  const session = await client.syncSession(workspaceId, '0')
  const database = await getDb()
  const now = Date.now()
  await database.execute(
    `insert into self_hosted_workspace_bindings(
       workspace_id, profile_id, workspace_type, local_root, binding_state,
       access_mode, sync_epoch, created_at, updated_at
     ) values ($1, $2, 'library', $3, 'bound', $4, $5, $6, $6)
     on conflict(workspace_id) do update set
       profile_id = excluded.profile_id, local_root = excluded.local_root,
       binding_state = 'bound', access_mode = excluded.access_mode,
       sync_epoch = excluded.sync_epoch, updated_at = excluded.updated_at`,
    [
      workspaceId,
      profileId,
      localRoot,
      workspace.capabilities.includes('content.update') ? 'read-write' : 'read-only',
      session.syncEpoch,
      now,
    ]
  )
  const store = await Store.load('store.json')
  const deferred = await store.get<string[]>('selfHostedDeferredWorkspacePaths') ?? []
  if (deferred.includes(localRoot)) {
    await store.set('selfHostedDeferredWorkspacePaths', deferred.filter(path => path !== localRoot))
    await store.save()
  }
  if (scanLocal && workspace.capabilities.includes('content.create')) {
    for (const entry of await scanPortableEntries(localRoot, workspaceId)) {
      if (entry.kind === 'folder') await enqueueFolderSnapshot(entry.relativePath, 'upsert', workspaceId, 'import')
      else if (entry.kind === 'markdown') await enqueueFileSnapshot(entry.relativePath, 'upsert', workspaceId, 'import')
      else await enqueueAssetSnapshot(entry.relativePath, 'upsert', workspaceId, 'import')
    }
  }
}

export async function unbindLibrary(workspaceId: string) {
  const database = await getDb()
  await database.execute(
    `update self_hosted_workspace_bindings
     set binding_state = 'unbound', local_root = null, updated_at = $1 where workspace_id = $2`,
    [Date.now(), workspaceId]
  )
}

export async function reconcileLibraryFiles(workspaceId: string, localRoot: string, writable = true) {
  const database = await getDb()
  const entries = await scanPortableEntries(localRoot, workspaceId)
  const mapped = await database.select<Array<{ relativePath: string; contentHash: string | null; kind: string }>>(
    `select relative_path as relativePath, content_hash as contentHash, kind
     from self_hosted_object_mappings
     where workspace_id = $1 and relative_path is not null and deleted_at is null`,
    [workspaceId]
  )
  const mappedByPath = new Map(mapped.map(item => [item.relativePath, item]))
  const localPaths = new Set(entries.map(entry => entry.relativePath))
  for (const entry of entries) {
    const absolutePath = await join(localRoot, entry.relativePath)
    const content = entry.kind === 'markdown' ? await readTextFile(absolutePath) : null
    const hash = entry.kind === 'folder' ? null : entry.kind === 'markdown'
      ? await invoke<string>('self_hosted_sha256', { value: content! })
      : await hashFileBytes(await readFile(absolutePath))
    let current = mappedByPath.get(entry.relativePath)
    let identityMoved = false
    if (!current && hash && entry.kind !== 'folder') {
      const expectedKind = entry.kind === 'markdown' ? 'note' : 'asset'
      const moved = [...mappedByPath.entries()].filter(([oldPath, candidate]) => (
        !localPaths.has(oldPath) && candidate.kind === expectedKind && candidate.contentHash === hash
      ))
      if (moved.length === 1) {
        const [oldPath, candidate] = moved[0]!
        const portable = await invoke<{ normalized: string; caseFolded: string }>(
          'self_hosted_portable_path', { relativePath: entry.relativePath },
        )
        const domain = expectedKind === 'note' ? 'file' : 'asset'
        await database.execute(
          `update self_hosted_object_mappings set local_identity = $1, relative_path = $2,
             path_casefold = $3, updated_at = $4 where workspace_id = $5 and relative_path = $6`,
          [
            `${domain}:${portable.normalized}`, portable.normalized, portable.caseFolded,
            Date.now(), workspaceId, oldPath,
          ]
        )
        mappedByPath.delete(oldPath)
        current = candidate
        identityMoved = true
      }
    }
    if (!current || current.contentHash !== hash || identityMoved) {
      if (writable) {
        if (entry.kind === 'folder') await enqueueFolderSnapshot(entry.relativePath, 'upsert', workspaceId)
        else if (entry.kind === 'markdown') await enqueueFileSnapshot(entry.relativePath, 'upsert', workspaceId)
        else await enqueueAssetSnapshot(entry.relativePath, 'upsert', workspaceId)
      } else await recordViewerConflict(workspaceId, entry.relativePath, content)
    }
    mappedByPath.delete(entry.relativePath)
  }
  for (const [relativePath, mapping] of mappedByPath) {
    if (writable) {
      if (mapping.kind === 'folder') await enqueueFolderSnapshot(relativePath, 'delete', workspaceId)
      else if (mapping.kind === 'note') await enqueueFileSnapshot(relativePath, 'delete', workspaceId)
      else await enqueueAssetSnapshot(relativePath, 'delete', workspaceId)
    }
    else await recordViewerConflict(workspaceId, relativePath, null)
  }
}

async function recordViewerConflict(workspaceId: string, relativePath: string, localSnapshot: string | null) {
  const database = await getDb()
  const existing = await database.select<Array<{ id: string }>>(
    `select id from self_hosted_conflicts where workspace_id = $1
       and conflict_type = 'viewer-local-edit' and local_copy_path = $2 and state = 'unresolved' limit 1`,
    [workspaceId, relativePath]
  )
  if (existing.length > 0) return
  await database.execute(
    `insert into self_hosted_conflicts(
       id, workspace_id, conflict_type, local_snapshot, local_copy_path, state, created_at
     ) values ($1, $2, 'viewer-local-edit', $3, $4, 'unresolved', $5)`,
    [crypto.randomUUID(), workspaceId, localSnapshot, relativePath, Date.now()]
  )
}

export async function connectedProfileId() {
  const database = await getDb()
  const rows = await database.select<Array<{ id: string }>>(
    "select id from self_hosted_sync_profiles where state = 'connected' order by updated_at desc limit 1"
  )
  return rows[0]?.id ?? null
}

export async function ensureManagedWorkspaceKey(profileId: string, workspaceId: string, keyVersion: number) {
  const { client } = await authenticatedClient(profileId)
  const keys = await client.workspaceKeys(workspaceId)
  const managedKey = keys.find(item => item.keyVersion === keyVersion)?.envelopes
    .find(envelope => envelope.type === 'managed')?.wrappedKey
  if (!managedKey) throw new Error('该资料库没有可用的 managed key')
  const secureStorageKey = workspaceSecretKey(workspaceId, keyVersion)
  await secureSet(secureStorageKey, managedKey)
  const database = await getDb()
  await database.execute(
    `insert into self_hosted_workspace_keys(workspace_id, key_version, secure_storage_key, created_at)
     values ($1, $2, $3, $4)
     on conflict(workspace_id, key_version) do update set secure_storage_key = excluded.secure_storage_key`,
    [workspaceId, keyVersion, secureStorageKey, Date.now()]
  )
  return managedKey
}

export async function ensureManagedWorkspaceKeys(
  profileId: string,
  workspaceId: string,
  keyVersions: number[],
) {
  for (const keyVersion of keyVersions) {
    await ensureManagedWorkspaceKey(profileId, workspaceId, keyVersion)
  }
}

async function scanPortableEntries(root: string, workspaceId: string) {
  const result: Array<{ relativePath: string; kind: 'folder' | 'markdown' | 'asset' }> = []
  const caseFoldedPaths = new Map<string, string>()
  async function visit(absolute: string, prefix: string) {
    const entries = await readDir(absolute)
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymlink) {
        await recordIgnoredSymlink(workspaceId, relative)
        continue
      }
      if (entry.name === '.notegen' || entry.name === '.DS_Store' || entry.name.endsWith('.tmp')) continue
      if (entry.isDirectory) {
        const portable = await portablePath(relative, caseFoldedPaths)
        result.push({ relativePath: portable, kind: 'folder' })
        await visit(await join(absolute, entry.name), relative)
      } else if (entry.isFile) {
        const portable = await portablePath(relative, caseFoldedPaths)
        result.push({
          relativePath: portable,
          kind: portable.toLowerCase().endsWith('.md') ? 'markdown' : 'asset',
        })
      }
    }
  }
  await visit(root, '')
  return result
}

async function recordIgnoredSymlink(workspaceId: string, relativePath: string) {
  const database = await getDb()
  const existing = await database.select<Array<{ id: string }>>(
    `select id from self_hosted_conflicts where workspace_id = $1
       and conflict_type = 'symlink-ignored' and local_copy_path = $2 and state = 'unresolved' limit 1`,
    [workspaceId, relativePath]
  )
  if (existing.length > 0) return
  await database.execute(
    `insert into self_hosted_conflicts(
       id, workspace_id, conflict_type, local_copy_path, state, created_at
     ) values ($1, $2, 'symlink-ignored', $3, 'unresolved', $4)`,
    [crypto.randomUUID(), workspaceId, relativePath, Date.now()]
  )
}

async function portablePath(relativePath: string, seen: Map<string, string>) {
  const portable = await invoke<{ normalized: string; caseFolded: string }>(
    'self_hosted_portable_path', { relativePath },
  )
  const duplicate = seen.get(portable.caseFolded)
  if (duplicate && duplicate !== portable.normalized) {
    throw new Error(`同一目录存在跨平台重名路径：${duplicate} / ${portable.normalized}`)
  }
  seen.set(portable.caseFolded, portable.normalized)
  return portable.normalized
}

async function hashFileBytes(value: Uint8Array) {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer))
  return bytesToBase64Url(digest)
}
