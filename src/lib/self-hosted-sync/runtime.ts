import { invoke } from '@tauri-apps/api/core'
import { exists, readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { getDb } from '@/db'
import { SelfHostedApiError } from './client'
import { authenticatedClient, secureDelete } from './profile'
import { decryptPackedJson, encodeUtf8Base64Url, loadWorkspaceKey, objectAssociatedData } from './crypto'
import { materializeOutbox } from './outbox'
import { applyStructuredPayload, deleteStructuredObject } from './structured'
import { ensureManagedWorkspaceKeys, reconcileLibraryFiles } from './workspaces'
import { bytesToBase64Url, downloadAsset, hashBytes } from './blob'
import type { SyncBootstrapPage, SyncEvent, SyncObjectKind, SyncSession } from './protocol'

interface Binding {
  workspaceId: string
  profileId: string
  workspaceType: 'account-data' | 'library'
  localRoot: string | null
  syncEpoch: string | null
  pulledSequence: string
  appliedSequence: string
}

interface OutboxRow {
  commandId: string
  sourceChangeIds: string
  payload: string
  attemptCount: number
}

export class SelfHostedSyncRuntime {
  #running = false
  #rerun = false
  #stopped = true
  #socket: WebSocket | null = null
  #socketWorkspaceSignature = ''
  #timer: ReturnType<typeof setTimeout> | null = null
  #realtimeListeners = new Set<(message: Record<string, unknown>) => void>()
  #documentSubscriptions = new Set<string>()

  start() {
    this.#stopped = false
    void this.wake('startup')
  }

  stop() {
    this.#stopped = true
    this.#socket?.close()
    this.#socket = null
    this.#socketWorkspaceSignature = ''
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  subscribeRealtime(listener: (message: Record<string, unknown>) => void) {
    this.#realtimeListeners.add(listener)
    return () => this.#realtimeListeners.delete(listener)
  }

  subscribeDocument(workspaceId: string, documentId: string) {
    this.#documentSubscriptions.add(`${workspaceId}\0${documentId}`)
    this.#sendRealtime({ type: 'document.subscribe', workspaceId, documentId })
    return () => {
      this.#documentSubscriptions.delete(`${workspaceId}\0${documentId}`)
      this.#sendRealtime({ type: 'document.unsubscribe', workspaceId, documentId })
    }
  }

  updatePresence(workspaceId: string, documentId: string, anchor: number, head: number, label: string) {
    this.#sendRealtime({ type: 'presence.update', workspaceId, documentId, anchor, head, label, canvas: null })
  }

  updateCanvasPresence(
    workspaceId: string,
    documentId: string,
    nodes: Array<{ id: string; x: number; y: number }>,
    label: string,
  ) {
    this.#sendRealtime({
      type: 'presence.update', workspaceId, documentId, anchor: 0, head: 0, label, canvas: { nodes },
    })
  }

  clearPresence() {
    this.#sendRealtime({ type: 'presence.clear' })
  }

  #sendRealtime(message: Record<string, unknown>) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message))
  }

  async wake(_reason: string) {
    if (this.#stopped) return
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#running) {
      this.#rerun = true
      return
    }
    this.#running = true
    try {
      do {
        this.#rerun = false
        const bindings = await listBindings()
        const sessions: Array<{ profileId: string; session: SyncSession }> = []
        for (const binding of bindings) {
          const session = await this.#syncBinding(binding)
          if (session) sessions.push({ profileId: binding.profileId, session })
        }
        if (sessions.length > 0) this.#connectSocket(sessions[0].profileId, sessions.map(item => item.session))
      } while (this.#rerun && !this.#stopped)
    } finally {
      this.#running = false
      if (!this.#stopped) {
        this.#timer = setTimeout(() => void this.wake('network'), 30_000)
      }
    }
  }

  async #syncBinding(binding: Binding) {
    const { profile, client } = await authenticatedClient(binding.profileId)
    let session: SyncSession
    try {
      session = await client.syncSession(
        binding.workspaceId,
        binding.appliedSequence,
        binding.syncEpoch ?? undefined,
      )
    } catch (error) {
      if (error instanceof SelfHostedApiError && error.body.code === 'sync_epoch_changed') {
        await setBindingState(binding.workspaceId, 'epoch-changed')
        return null
      }
      if (error instanceof SelfHostedApiError && (error.status === 403 || error.status === 404)) {
        await revokeBindingAccess(binding.workspaceId)
        return null
      }
      throw error
    }
    if (!session.protocol.compatible) {
      await setBindingState(binding.workspaceId, 'protocol-incompatible')
      return null
    }
    await ensureManagedWorkspaceKeys(
      binding.profileId,
      binding.workspaceId,
      session.keyVersions.map(key => key.keyVersion),
    )
    if (session.bootstrap.required) {
      await setBindingState(binding.workspaceId, 'bootstrapping')
      await bootstrapBinding(binding, session)
      return session
    }
    await updateBindingSession(
      binding.workspaceId,
      session.syncEpoch,
      session.workspace.capabilities.includes('content.update'),
    )
    if (binding.workspaceType === 'library' && binding.localRoot) {
      await reconcileLibraryFiles(
        binding.workspaceId,
        binding.localRoot,
        session.workspace.capabilities.includes('content.update'),
      )
    }
    await materializeOutbox(
      binding.workspaceId,
      binding.workspaceType,
      binding.localRoot,
      session.limits.maxCommandsPerBatch,
      binding.profileId,
      session.syncEpoch,
      Math.max(1, ...session.keyVersions.map(key => key.keyVersion)),
    )
    await pushOutbox(binding, session)
    await pullEvents(binding, session)
    const appliedThrough = await applyInbox(binding, profile.deviceId)
    for (const listener of this.#realtimeListeners) listener({
      type: 'inbox.applied', workspaceId: binding.workspaceId,
    })
    if (BigInt(appliedThrough) > BigInt(binding.appliedSequence)) {
      await client.acknowledge(binding.workspaceId, appliedThrough, session.syncEpoch)
      await updateCursor(binding.workspaceId, appliedThrough, appliedThrough)
    }
    return session
  }

  #connectSocket(profileId: string, sessions: SyncSession[]) {
    const first = sessions[0]
    if (!first) return
    const workspaceSignature = sessions.map(session => session.workspace.id).sort().join('\0')
    if (this.#socket?.url === first.websocketUrl
      && this.#socketWorkspaceSignature === workspaceSignature
      && this.#socket.readyState <= WebSocket.OPEN) return
    this.#socket?.close()
    this.#socketWorkspaceSignature = workspaceSignature
    void authenticatedClient(profileId).then(async ({ accessToken }) => {
      if (this.#stopped || this.#socketWorkspaceSignature !== workspaceSignature) return
      const socket = new WebSocket(first.websocketUrl)
      this.#socket = socket
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'authenticate',
          accessToken,
          workspaceIds: sessions.map(session => session.workspace.id),
          expectedSyncEpoch: first.syncEpoch,
        }))
      })
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as { type?: string; workspaceId?: string }
        for (const listener of this.#realtimeListeners) listener(message)
        if (message.type === 'authenticated') {
          for (const subscription of this.#documentSubscriptions) {
            const [workspaceId, documentId] = subscription.split('\0')
            socket.send(JSON.stringify({ type: 'document.subscribe', workspaceId, documentId }))
          }
        } else if (message.type === 'workspace.changed' || message.type === 'workspace.members-changed') {
          void this.wake('websocket')
        } else if (message.type === 'workspace.access-revoked' && message.workspaceId) {
          void revokeBindingAccess(message.workspaceId)
        }
      })
      socket.addEventListener('close', () => {
        if (this.#socket === socket) {
          this.#socket = null
          this.#socketWorkspaceSignature = ''
        }
      })
    })
  }
}

async function listBindings(): Promise<Binding[]> {
  const database = await getDb()
  return database.select<Binding[]>(`
    select b.workspace_id as workspaceId, b.profile_id as profileId,
      b.workspace_type as workspaceType, b.local_root as localRoot, b.sync_epoch as syncEpoch,
      coalesce(c.pulled_sequence, '0') as pulledSequence,
      coalesce(c.applied_sequence, '0') as appliedSequence
    from self_hosted_workspace_bindings b
    join self_hosted_sync_profiles p on p.id = b.profile_id and p.state = 'connected'
    left join self_hosted_cursors c on c.workspace_id = b.workspace_id
    where b.binding_state = 'bound'
    order by case when b.workspace_type = 'account-data' then 0 else 1 end, b.created_at
  `)
}

async function pushOutbox(binding: Binding, session: SyncSession) {
  const database = await getDb()
  const rows = await database.select<OutboxRow[]>(
    `select command_id as commandId, source_change_ids as sourceChangeIds,
       payload, attempt_count as attemptCount
     from self_hosted_outbox
     where workspace_id = $1 and state in ('pending', 'retry') and next_attempt_at <= $2
     order by created_at, rowid limit $3`,
    [binding.workspaceId, Date.now(), session.limits.maxCommandsPerBatch]
  )
  if (rows.length === 0) return
  const { client } = await authenticatedClient(binding.profileId)
  const response = await client.pushCommands(
    binding.workspaceId, rows.map(row => JSON.parse(row.payload) as unknown), session.syncEpoch,
  )
  for (const result of response.results) {
    const row = rows.find(candidate => candidate.commandId === result.commandId)
    if (!row) continue
    if (result.status === 'applied' || result.status === 'conflict') {
      await database.execute(
        "update self_hosted_outbox set state = 'sent', updated_at = $1, last_error_code = null where command_id = $2",
        [Date.now(), row.commandId]
      )
      for (const id of JSON.parse(row.sourceChangeIds) as number[]) {
        await database.execute(
          "update self_hosted_local_changes set state = 'sent', updated_at = $1 where id = $2",
          [Date.now(), id]
        )
      }
      const payload = JSON.parse(row.payload) as { objectId?: string }
      if (payload.objectId && result.revision && result.sequence) {
        await recordRevision(binding.workspaceId, payload.objectId, result.revision, result.sequence, '')
        await database.execute(
          `update self_hosted_outbox set state = 'pending', updated_at = $1
           where workspace_id = $2 and state = 'blocked'
             and json_extract(payload, '$.objectId') = $3`,
          [Date.now(), binding.workspaceId, payload.objectId]
        )
      }
      if (result.conflictId) await recordProtocolConflict(binding.workspaceId, payload.objectId, result.conflictId)
      const command = JSON.parse(row.payload) as {
        type?: string; objectId?: string; documentId?: string; updateId?: string
        checkpointId?: string; keyVersion?: number; ciphertext?: string; coversDocumentSequence?: string
      }
      if (result.documentSequence && command.documentId && command.ciphertext) {
        await database.execute(
          `insert or replace into self_hosted_yjs_updates(
             workspace_id, document_id, document_sequence, object_id, key_version,
             event_type, update_id, payload, applied, created_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)`,
          [
            binding.workspaceId, command.documentId, result.documentSequence,
            command.objectId, command.keyVersion ?? 1,
            command.type === 'commit-checkpoint' ? 'checkpoint' : 'update',
            command.updateId ?? command.checkpointId ?? row.commandId,
            command.ciphertext, Date.now(),
          ]
        )
      }
      if (command.type === 'commit-checkpoint' && command.documentId && command.coversDocumentSequence) {
        await database.execute(
          `delete from self_hosted_yjs_updates where workspace_id = $1 and document_id = $2
             and cast(document_sequence as integer) <= cast($3 as integer) and event_type = 'update'`,
          [binding.workspaceId, command.documentId, command.coversDocumentSequence]
        )
      }
    } else {
      const retry = result.retryable === true
      await database.execute(
        `update self_hosted_outbox set state = $1, attempt_count = attempt_count + 1,
           next_attempt_at = $2, last_error_code = $3, updated_at = $4 where command_id = $5`,
        [retry ? 'retry' : 'failed', retry ? Date.now() + retryDelay(row.attemptCount) : 0, result.code ?? 'rejected', Date.now(), row.commandId]
      )
    }
  }
}

async function pullEvents(binding: Binding, session: SyncSession) {
  const database = await getDb()
  const { client } = await authenticatedClient(binding.profileId)
  let cursor = binding.pulledSequence
  let hasMore = true
  while (hasMore) {
    const page = await client.events(
      binding.workspaceId, cursor, Math.min(500, session.limits.maxEventsPerPage), session.syncEpoch,
    )
    for (const event of page.events) {
      await database.execute(
        `insert or ignore into self_hosted_inbox(
           workspace_id, event_id, sequence, payload, state, received_at
         ) values ($1, $2, $3, $4, 'pending', $5)`,
        [binding.workspaceId, event.eventId, event.sequence, JSON.stringify(event), Date.now()]
      )
    }
    cursor = page.nextCursor
    hasMore = page.hasMore
    await updatePulledCursor(binding.workspaceId, cursor)
  }
}

async function applyInbox(binding: Binding, deviceId: string | null): Promise<string> {
  const database = await getDb()
  const rows = await database.select<Array<{ sequence: string; payload: string }>>(
    `select sequence, payload from self_hosted_inbox
     where workspace_id = $1 and state = 'pending'
     order by cast(sequence as integer)`,
    [binding.workspaceId]
  )
  let through = binding.appliedSequence
  for (const row of rows) {
    const event = JSON.parse(row.payload) as SyncEvent
    try {
      if (event.sourceDeviceId !== deviceId) await applyRemoteEvent(binding, event)
      await recordEventRevision(binding.workspaceId, event)
      await database.execute(
        "update self_hosted_inbox set state = 'applied', applied_at = $1 where workspace_id = $2 and sequence = $3",
        [Date.now(), binding.workspaceId, event.sequence]
      )
      through = event.sequence
    } catch (error) {
      await database.execute(
        "update self_hosted_inbox set state = 'failed', error_code = $1 where workspace_id = $2 and sequence = $3",
        [error instanceof Error ? error.message.slice(0, 120) : 'apply_failed', binding.workspaceId, event.sequence]
      )
      break
    }
  }
  await cleanupDeletedFolders(binding)
  await updateAppliedCursor(binding.workspaceId, through)
  return through
}

async function applyRemoteEvent(binding: Binding, event: SyncEvent) {
  const database = await getDb()
  if (event.type === 'conflict.created' || event.type === 'conflict.resolved') {
    if (event.type === 'conflict.created') {
      const conflictId = String(event.metadata.conflictId ?? event.eventId)
      await recordProtocolConflict(binding.workspaceId, event.objectId ?? undefined, conflictId)
    }
    return
  }
  if (!event.objectId) return
  if (event.type === 'object.deleted') {
    await applyRemoteDelete(binding, event.objectId)
    return
  }
  if (event.type === 'document.updated' || event.type === 'document.checkpointed') {
    if (!event.documentId || !event.documentSequence || !event.ciphertext) return
    await database.execute(
      `insert or ignore into self_hosted_yjs_updates(
         workspace_id, document_id, document_sequence, object_id, key_version,
         event_type, update_id, payload, applied, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)`,
      [
        binding.workspaceId, event.documentId, event.documentSequence, event.objectId,
        event.keyVersion, event.type === 'document.checkpointed' ? 'checkpoint' : 'update',
        event.commandId, event.ciphertext, Date.now(),
      ]
    )
    return
  }
  if (!event.ciphertext || !event.keyVersion) throw new Error('remote_ciphertext_missing')
  const kind = String(event.metadata.kind ?? 'note')
  const key = await loadWorkspaceKey(binding.workspaceId, event.keyVersion)
  const payload = await decryptPackedJson<Record<string, unknown>>(
    key, event.ciphertext, objectAssociatedData(binding.workspaceId, event.objectId, kind),
  )
  if (payload.domain === 'file' && binding.localRoot) {
    await applyRemoteFile(binding, event, payload)
    return
  }
  if (payload.domain === 'asset' && binding.localRoot) {
    await applyRemoteAsset(binding, event, payload)
    return
  }
  if (payload.domain === 'folder' && binding.localRoot) {
    await applyRemoteFolder(binding, event, payload)
    return
  }
  await applyStructuredPayload(binding.workspaceId, event.objectId, kind as SyncObjectKind, payload)
  await database.execute(
    `insert into self_hosted_remote_objects(workspace_id, object_id, kind, revision, payload, updated_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict(workspace_id, object_id) do update set
       kind = excluded.kind, revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at`,
    [binding.workspaceId, event.objectId, kind, String(event.metadata.revision ?? '0'), JSON.stringify(payload), Date.now()]
  )
}

async function applyRemoteAsset(binding: Binding, event: SyncEvent, payload: Record<string, unknown>) {
  const relativePath = String(payload.relativePath ?? '')
  const blobId = String(payload.blobId ?? '')
  if (!relativePath || !blobId) throw new Error('remote_asset_invalid')
  await invoke('self_hosted_portable_path', { relativePath })
  const downloaded = await downloadAsset({
    profileId: binding.profileId,
    workspaceId: binding.workspaceId,
    blobId,
    relativePath,
    keyVersion: event.keyVersion ?? 1,
  })
  const database = await getDb()
  const mappings = await database.select<Array<{ contentHash: string | null }>>(
    `select content_hash as contentHash from self_hosted_object_mappings
     where workspace_id = $1 and object_id = $2 limit 1`,
    [binding.workspaceId, event.objectId]
  )
  const absolutePath = await join(binding.localRoot!, relativePath)
  if (await exists(absolutePath) && mappings[0]?.contentHash) {
    const current = await readFile(absolutePath)
    if (await hashBytes(current) !== mappings[0].contentHash) {
      const conflictPath = conflictCopyPath(relativePath)
      await writeBytesJournaled(binding, event.objectId!, conflictPath, current)
      await database.execute(
        `insert into self_hosted_conflicts(
           id, workspace_id, object_id, conflict_type, local_copy_path, state, created_at
         ) values ($1, $2, $3, 'snapshot-diverged', $4, 'unresolved', $5)`,
        [crypto.randomUUID(), binding.workspaceId, event.objectId, conflictPath, Date.now()]
      )
    }
  }
  await writeBytesJournaled(binding, event.objectId!, relativePath, downloaded.bytes)
  await database.execute(
    `insert into self_hosted_object_mappings(
       workspace_id, object_id, kind, local_identity, relative_path, path_casefold,
       content_hash, blob_refs, deleted_at, updated_at
     ) values ($1, $2, 'asset', $3, $4, lower($4), $5, $6, null, $7)
     on conflict(workspace_id, object_id) do update set
       relative_path = excluded.relative_path, path_casefold = excluded.path_casefold,
       content_hash = excluded.content_hash, blob_refs = excluded.blob_refs,
       deleted_at = null, updated_at = excluded.updated_at`,
    [
      binding.workspaceId, event.objectId, `asset:${relativePath}`, relativePath,
      downloaded.hash, JSON.stringify([blobId]), Date.now(),
    ]
  )
}

async function applyRemoteFolder(binding: Binding, event: SyncEvent, payload: Record<string, unknown>) {
  const relativePath = String(payload.relativePath ?? '')
  if (!relativePath) throw new Error('remote_folder_invalid')
  const portable = await invoke<{ normalized: string; caseFolded: string }>(
    'self_hosted_portable_path', { relativePath },
  )
  await invoke('self_hosted_create_directory', {
    workspaceId: binding.workspaceId,
    objectId: event.objectId,
    workspaceRoot: binding.localRoot,
    relativePath: portable.normalized,
  })
  const database = await getDb()
  await database.execute(
    `insert into self_hosted_object_mappings(
       workspace_id, object_id, kind, local_identity, relative_path, path_casefold, updated_at
     ) values ($1, $2, 'folder', $3, $4, $5, $6)
     on conflict(workspace_id, object_id) do update set relative_path = excluded.relative_path,
       path_casefold = excluded.path_casefold, deleted_at = null, updated_at = excluded.updated_at`,
    [
      binding.workspaceId, event.objectId, `folder:${portable.normalized}`,
      portable.normalized, portable.caseFolded, Date.now(),
    ]
  )
}

async function applyRemoteDelete(binding: Binding, objectId: string) {
  const database = await getDb()
  const mappings = await database.select<Array<{
    relativePath: string | null
    contentHash: string | null
    kind: string
  }>>(
    `select relative_path as relativePath, content_hash as contentHash, kind
     from self_hosted_object_mappings where workspace_id = $1 and object_id = $2 limit 1`,
    [binding.workspaceId, objectId]
  )
  const mapping = mappings[0]
  if (mapping?.relativePath && binding.localRoot) {
    const absolutePath = await join(binding.localRoot, mapping.relativePath)
    if (mapping.kind !== 'folder' && await exists(absolutePath) && mapping.contentHash) {
      const current = mapping.kind === 'asset' ? null : await readTextFile(absolutePath)
      const currentHash = mapping.kind === 'asset'
        ? await hashBytes(await readFile(absolutePath))
        : await invoke<string>('self_hosted_sha256', { value: current! })
      if (currentHash !== mapping.contentHash) {
        await database.execute(
          `insert into self_hosted_conflicts(
             id, workspace_id, object_id, conflict_type, local_snapshot,
             local_copy_path, state, created_at
           ) values ($1, $2, $3, 'remote-delete-local-edit', $4, $5, 'unresolved', $6)`,
          [crypto.randomUUID(), binding.workspaceId, objectId, current, mapping.relativePath, Date.now()]
        )
        return
      }
      await invoke<boolean>('self_hosted_delete_file', {
        workspaceId: binding.workspaceId,
        objectId,
        workspaceRoot: binding.localRoot,
        relativePath: mapping.relativePath,
        expectedHash: mapping.contentHash,
      })
    }
  }
  if (!mapping?.relativePath) await deleteStructuredObject(binding.workspaceId, objectId)
  await database.execute(
    `update self_hosted_object_mappings set deleted_at = $1, updated_at = $1
     where workspace_id = $2 and object_id = $3`,
    [Date.now(), binding.workspaceId, objectId]
  )
}

async function cleanupDeletedFolders(binding: Binding) {
  if (!binding.localRoot) return
  const database = await getDb()
  const folders = await database.select<Array<{ objectId: string; relativePath: string }>>(
    `select object_id as objectId, relative_path as relativePath
     from self_hosted_object_mappings where workspace_id = $1 and kind = 'folder'
       and deleted_at is not null and relative_path is not null
     order by length(relative_path) desc`,
    [binding.workspaceId]
  )
  for (const folder of folders) {
    try {
      await invoke<boolean>('self_hosted_delete_directory', {
        workspaceId: binding.workspaceId,
        objectId: folder.objectId,
        workspaceRoot: binding.localRoot,
        relativePath: folder.relativePath,
      })
    } catch {
      const existing = await database.select<Array<{ id: string }>>(
        `select id from self_hosted_conflicts where workspace_id = $1 and object_id = $2
           and conflict_type = 'remote-delete-local-edit' and state = 'unresolved' limit 1`,
        [binding.workspaceId, folder.objectId]
      )
      if (existing.length === 0) {
        await database.execute(
          `insert into self_hosted_conflicts(
             id, workspace_id, object_id, conflict_type, local_copy_path, state, created_at
           ) values ($1, $2, $3, 'remote-delete-local-edit', $4, 'unresolved', $5)`,
          [crypto.randomUUID(), binding.workspaceId, folder.objectId, folder.relativePath, Date.now()]
        )
      }
    }
  }
}

async function applyRemoteFile(binding: Binding, event: SyncEvent, payload: Record<string, unknown>) {
  const relativePath = String(payload.relativePath ?? '')
  const content = String(payload.content ?? '')
  await invoke('self_hosted_portable_path', { relativePath })
  const absolutePath = await join(binding.localRoot!, relativePath)
  const database = await getDb()
  const mappings = await database.select<Array<{ contentHash: string | null }>>(
    `select content_hash as contentHash from self_hosted_object_mappings
     where workspace_id = $1 and object_id = $2 limit 1`,
    [binding.workspaceId, event.objectId]
  )
  const expectedHash = await invoke<string>('self_hosted_sha256', { value: content })
  if (await exists(absolutePath)) {
    const currentContent = await readTextFile(absolutePath)
    const currentHash = await invoke<string>('self_hosted_sha256', { value: currentContent })
    const diverged = mappings[0]?.contentHash
      ? currentHash !== mappings[0].contentHash
      : currentHash !== expectedHash
    if (diverged) {
      const bases = await database.select<Array<{ snapshot: string | null }>>(
        `select snapshot from self_hosted_revisions where workspace_id = $1 and object_id = $2
         order by cast(revision as integer) desc limit 1`,
        [binding.workspaceId, event.objectId]
      )
      const merged = bases[0]?.snapshot == null
        ? null
        : mergeTextSnapshots(bases[0].snapshot, currentContent, content)
      if (merged !== null) {
        await writeJournaled(binding, event.objectId!, relativePath, merged)
        await enqueueFileSnapshot(relativePath, 'upsert', binding.workspaceId)
        const mergedHash = await invoke<string>('self_hosted_sha256', { value: merged })
        await database.execute(
          `update self_hosted_object_mappings set content_hash = $1, updated_at = $2
           where workspace_id = $3 and object_id = $4`,
          [mergedHash, Date.now(), binding.workspaceId, event.objectId]
        )
        if (typeof event.metadata.revision === 'string') {
          await database.execute(
            `insert or replace into self_hosted_revisions(
               workspace_id, object_id, revision, sequence, content_hash, snapshot, created_at
             ) values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              binding.workspaceId, event.objectId, event.metadata.revision, event.sequence,
              expectedHash, content, Date.now(),
            ]
          )
        }
        return
      } else {
        const conflictPath = conflictCopyPath(relativePath)
        await writeJournaled(binding, event.objectId!, conflictPath, currentContent)
        await database.execute(
          `insert into self_hosted_conflicts(
             id, workspace_id, object_id, conflict_type, local_snapshot, remote_snapshot,
             base_snapshot, local_copy_path, state, created_at
           ) values ($1, $2, $3, 'snapshot-diverged', $4, $5, $6, $7, 'unresolved', $8)`,
          [
            crypto.randomUUID(), binding.workspaceId, event.objectId, currentContent, content,
            bases[0]?.snapshot ?? null, conflictPath, Date.now(),
          ]
        )
      }
    }
  }
  await writeJournaled(binding, event.objectId!, relativePath, content)
  await database.execute(
    `insert into self_hosted_object_mappings(
       workspace_id, object_id, kind, local_identity, relative_path, path_casefold,
       content_hash, deleted_at, updated_at
     ) values ($1, $2, 'note', $3, $4, lower($4), $5, null, $6)
     on conflict(workspace_id, object_id) do update set
       relative_path = excluded.relative_path, path_casefold = excluded.path_casefold,
       content_hash = excluded.content_hash, deleted_at = null, updated_at = excluded.updated_at`,
    [binding.workspaceId, event.objectId, `file:${relativePath}`, relativePath, expectedHash, Date.now()]
  )
  if (typeof event.metadata.revision === 'string') {
    await database.execute(
      `insert or replace into self_hosted_revisions(
         workspace_id, object_id, revision, sequence, content_hash, snapshot, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        binding.workspaceId, event.objectId, event.metadata.revision, event.sequence,
        expectedHash, content, Date.now(),
      ]
    )
  }
}

async function bootstrapBinding(binding: Binding, session: SyncSession) {
  const { client } = await authenticatedClient(binding.profileId)
  let bootstrapId: string | undefined
  let afterObjectId: string | undefined
  let snapshotSequence = '0'
  const objects: SyncBootstrapPage['objects'] = []
  const conflicts: Array<Record<string, unknown>> = []
  do {
    const page = await client.bootstrap(
      binding.workspaceId,
      session.syncEpoch,
      bootstrapId,
      afterObjectId,
      session.limits.maxBootstrapObjectsPerPage,
    )
    bootstrapId = page.bootstrapId
    snapshotSequence = page.snapshotSequence
    objects.push(...page.objects)
    conflicts.push(...page.conflicts)
    afterObjectId = page.nextObjectId ?? undefined
  } while (afterObjectId)
  const priority: Partial<Record<SyncObjectKind, number>> = {
    tag: 0, conversation: 0, folder: 0,
    mark: 1, note: 1, message: 1, asset: 1, canvas: 1,
  }
  objects.sort((left, right) => (priority[left.kind] ?? 2) - (priority[right.kind] ?? 2))
  for (const object of objects) {
    await applyRemoteEvent(binding, {
        eventId: `bootstrap:${bootstrapId}:${object.objectId}`,
        sequence: snapshotSequence,
        commandId: `bootstrap:${object.objectId}`,
        sourceDeviceId: '',
        type: object.deletedAt ? 'object.deleted' : 'object.upserted',
        objectId: object.objectId,
        documentId: object.document?.documentId ?? null,
        documentSequence: object.document?.latestDocumentSequence ?? null,
        keyVersion: object.keyVersion,
        ciphertext: object.ciphertext,
        ciphertextHash: object.ciphertextHash,
        metadata: { kind: object.kind, revision: object.currentRevision },
        createdAt: new Date().toISOString(),
    })
    await recordRevision(
      binding.workspaceId,
      object.objectId,
      object.currentRevision,
      snapshotSequence,
      object.ciphertextHash,
    )
    if (object.document?.checkpointCiphertext) {
      await (await getDb()).execute(
          `insert or replace into self_hosted_yjs_updates(
             workspace_id, document_id, document_sequence, object_id, key_version,
             event_type, update_id, payload, applied, created_at
           ) values ($1, $2, $3, $4, $5, 'checkpoint', $6, $7, 0, $8)`,
          [
            binding.workspaceId,
            object.document.documentId,
            object.document.checkpointDocumentSequence,
            object.objectId,
            object.document.checkpointKeyVersion,
            object.document.checkpointId,
            object.document.checkpointCiphertext,
            Date.now(),
          ]
      )
    }
  }
  for (const conflict of conflicts) {
    await recordProtocolConflict(
      binding.workspaceId,
      typeof conflict.objectId === 'string' ? conflict.objectId : undefined,
      typeof conflict.conflictId === 'string' ? conflict.conflictId : crypto.randomUUID(),
    )
  }
  await cleanupDeletedFolders(binding)
  await client.acknowledge(binding.workspaceId, snapshotSequence, session.syncEpoch)
  await updatePulledCursor(binding.workspaceId, snapshotSequence)
  await updateCursor(binding.workspaceId, snapshotSequence, snapshotSequence)
  await setBindingState(binding.workspaceId, 'bound')
}

async function writeJournaled(binding: Binding, objectId: string, relativePath: string, content: string) {
  await invoke('self_hosted_atomic_write', {
    workspaceId: binding.workspaceId,
    objectId,
    workspaceRoot: binding.localRoot,
    relativePath,
    contents: encodeUtf8Base64Url(content),
    expectedHash: await invoke<string>('self_hosted_sha256', { value: content }),
  })
}

async function writeBytesJournaled(binding: Binding, objectId: string, relativePath: string, content: Uint8Array) {
  await invoke('self_hosted_atomic_write', {
    workspaceId: binding.workspaceId,
    objectId,
    workspaceRoot: binding.localRoot,
    relativePath,
    contents: bytesToBase64Url(content),
    expectedHash: await hashBytes(content),
  })
}

async function recordEventRevision(workspaceId: string, event: SyncEvent) {
  if (!event.objectId || typeof event.metadata.revision !== 'string') return
  await recordRevision(workspaceId, event.objectId, event.metadata.revision, event.sequence, event.ciphertextHash ?? '')
}

async function recordRevision(workspaceId: string, objectId: string, revision: string, sequence: string, hash: string) {
  const database = await getDb()
  await database.execute(
    `insert or ignore into self_hosted_revisions(
       workspace_id, object_id, revision, sequence, content_hash, created_at
     ) values ($1, $2, $3, $4, $5, $6)`,
    [workspaceId, objectId, revision, sequence, hash, Date.now()]
  )
}

async function recordProtocolConflict(workspaceId: string, objectId: string | undefined, conflictId: string) {
  const database = await getDb()
  await database.execute(
    `insert or ignore into self_hosted_conflicts(
       id, workspace_id, object_id, conflict_type, state, created_at
     ) values ($1, $2, $3, 'protocol-conflict', 'unresolved', $4)`,
    [conflictId, workspaceId, objectId ?? null, Date.now()]
  )
}

async function updateBindingSession(workspaceId: string, syncEpoch: string, writable: boolean) {
  const database = await getDb()
  await database.execute(
    `update self_hosted_workspace_bindings set sync_epoch = $1, binding_state = 'bound',
       access_mode = $2, updated_at = $3 where workspace_id = $4`,
    [syncEpoch, writable ? 'read-write' : 'read-only', Date.now(), workspaceId]
  )
}

async function setBindingState(workspaceId: string, state: string) {
  const database = await getDb()
  await database.execute(
    'update self_hosted_workspace_bindings set binding_state = $1, updated_at = $2 where workspace_id = $3',
    [state, Date.now(), workspaceId]
  )
}

async function revokeBindingAccess(workspaceId: string) {
  const database = await getDb()
  const keys = await database.select<Array<{ secureStorageKey: string }>>(
    `select secure_storage_key as secureStorageKey from self_hosted_workspace_keys
     where workspace_id = $1`,
    [workspaceId]
  )
  await Promise.all(keys.map(key => secureDelete(key.secureStorageKey)))
  await database.execute('delete from self_hosted_workspace_keys where workspace_id = $1', [workspaceId])
  await database.execute(
    `update self_hosted_workspace_bindings
     set binding_state = 'access-revoked', access_mode = 'read-only', updated_at = $1
     where workspace_id = $2`,
    [Date.now(), workspaceId]
  )
}

async function updatePulledCursor(workspaceId: string, pulled: string) {
  const database = await getDb()
  await database.execute(
    `insert into self_hosted_cursors(workspace_id, pulled_sequence, updated_at)
     values ($1, $2, $3)
     on conflict(workspace_id) do update set pulled_sequence = excluded.pulled_sequence, updated_at = excluded.updated_at`,
    [workspaceId, pulled, Date.now()]
  )
}

async function updateAppliedCursor(workspaceId: string, applied: string) {
  const database = await getDb()
  await database.execute(
    `insert into self_hosted_cursors(workspace_id, applied_sequence, updated_at)
     values ($1, $2, $3)
     on conflict(workspace_id) do update set applied_sequence = excluded.applied_sequence, updated_at = excluded.updated_at`,
    [workspaceId, applied, Date.now()]
  )
}

async function updateCursor(workspaceId: string, applied: string, acknowledged: string) {
  const database = await getDb()
  await database.execute(
    `insert into self_hosted_cursors(workspace_id, applied_sequence, acknowledged_sequence, updated_at)
     values ($1, $2, $3, $4)
     on conflict(workspace_id) do update set
       applied_sequence = excluded.applied_sequence,
       acknowledged_sequence = excluded.acknowledged_sequence,
       updated_at = excluded.updated_at`,
    [workspaceId, applied, acknowledged, Date.now()]
  )
}

function retryDelay(attempt: number) {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6))
}

function conflictCopyPath(relativePath: string) {
  const dot = relativePath.lastIndexOf('.')
  const suffix = `.conflict-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`
  return dot > relativePath.lastIndexOf('/')
    ? `${relativePath.slice(0, dot)}${suffix}${relativePath.slice(dot)}`
    : `${relativePath}${suffix}`
}

function mergeTextSnapshots(base: string, local: string, remote: string) {
  if (local === base) return remote
  if (remote === base || local === remote) return local
  const baseLines = base.split('\n')
  const localLines = local.split('\n')
  const remoteLines = remote.split('\n')
  if (baseLines.length !== localLines.length || baseLines.length !== remoteLines.length) return null
  const merged = [...baseLines]
  for (let index = 0; index < baseLines.length; index++) {
    const localChanged = localLines[index] !== baseLines[index]
    const remoteChanged = remoteLines[index] !== baseLines[index]
    if (localChanged && remoteChanged && localLines[index] !== remoteLines[index]) return null
    if (localChanged) merged[index] = localLines[index]
    else if (remoteChanged) merged[index] = remoteLines[index]
  }
  return merged.join('\n')
}

let runtime: SelfHostedSyncRuntime | null = null

export function getSelfHostedSyncRuntime() {
  runtime ??= new SelfHostedSyncRuntime()
  return runtime
}
