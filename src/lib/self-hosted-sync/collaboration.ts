import { getDb } from '@/db'
import { invoke } from '@tauri-apps/api/core'
import { encryptJson, decryptPackedJson, loadWorkspaceKey, objectAssociatedData } from './crypto'
import { getSelfHostedSyncRuntime } from './runtime'

interface DocumentBinding {
  workspaceId: string
  objectId: string
  documentId: string
  keyVersion: number
  kind: 'note' | 'canvas'
}

interface YjsEnvelope {
  format: 'yjs-v1'
  update: string
}

export async function openCollaborativeDocument(localRoot: string, relativePath: string) {
  const binding = await resolveDocument(localRoot, relativePath)
  return openCollaborativeBinding(binding)
}

export async function openCollaborativeObject(
  workspaceId: string,
  objectId: string,
  documentId: string,
  kind: 'note' | 'canvas',
) {
  return openCollaborativeBinding({
    workspaceId, objectId, documentId, kind, keyVersion: await latestKeyVersion(workspaceId),
  })
}

function openCollaborativeBinding(binding: DocumentBinding) {
  const runtime = getSelfHostedSyncRuntime()
  const unsubscribeDocument = runtime.subscribeDocument(binding.workspaceId, binding.documentId)
  return {
    ...binding,
    appendUpdate: (update: Uint8Array) => appendYjsUpdate(binding, update),
    checkpoint: (state: Uint8Array) => commitYjsCheckpoint(binding, state),
    consume: (apply: (update: Uint8Array, checkpoint: boolean) => void) => consumeYjsUpdates(binding, apply),
    updatePresence: (anchor: number, head: number, label: string) => {
      runtime.updatePresence(binding.workspaceId, binding.documentId, anchor, head, label)
    },
    updateCanvasPresence: (nodes: Array<{ id: string; x: number; y: number }>, label: string) => {
      runtime.updateCanvasPresence(binding.workspaceId, binding.documentId, nodes, label)
    },
    subscribePresence: (listener: (message: Record<string, unknown>) => void) => runtime.subscribeRealtime(message => {
      if (message.workspaceId === binding.workspaceId
        && (message.documentId === binding.documentId || message.type === 'workspace.changed'
          || message.type === 'inbox.applied')) listener(message)
    }),
    close: () => {
      unsubscribeDocument()
      runtime.clearPresence()
    },
  }
}

async function appendYjsUpdate(binding: DocumentBinding, update: Uint8Array) {
  const commandId = crypto.randomUUID()
  const updateId = crypto.randomUUID()
  const key = await loadWorkspaceKey(binding.workspaceId, binding.keyVersion)
  const encrypted = await encryptJson(key, {
    format: 'yjs-v1', update: bytesToBase64Url(update),
  } satisfies YjsEnvelope, objectAssociatedData(binding.workspaceId, binding.objectId, binding.kind))
  await insertCommand(binding.workspaceId, commandId, 'append-update', {
    commandId,
    type: 'append-update',
    updateId,
    documentId: binding.documentId,
    objectId: binding.objectId,
    kind: binding.kind,
    keyVersion: binding.keyVersion,
    ciphertext: encrypted.packedCiphertext,
    ciphertextHash: encrypted.packedCiphertextHash,
  })
  void getSelfHostedSyncRuntime().wake('local-change')
}

async function commitYjsCheckpoint(binding: DocumentBinding, state: Uint8Array) {
  const database = await getDb()
  const pending = await database.select<Array<{ count: number }>>(
    `select count(*) as count from self_hosted_outbox
     where workspace_id = $1 and state in ('pending', 'retry', 'blocked')
       and json_extract(payload, '$.type') = 'append-update'
       and json_extract(payload, '$.documentId') = $2`,
    [binding.workspaceId, binding.documentId]
  )
  if ((pending[0]?.count ?? 0) > 0) return
  const sequences = await database.select<Array<{ sequence: string }>>(
    `select coalesce(max(cast(document_sequence as integer)), 0) as sequence
     from self_hosted_yjs_updates where workspace_id = $1 and document_id = $2`,
    [binding.workspaceId, binding.documentId]
  )
  const revisions = await database.select<Array<{ revision: string }>>(
    `select revision from self_hosted_revisions where workspace_id = $1 and object_id = $2
     order by cast(revision as integer) desc limit 1`,
    [binding.workspaceId, binding.objectId]
  )
  const commandId = crypto.randomUUID()
  const key = await loadWorkspaceKey(binding.workspaceId, binding.keyVersion)
  const encrypted = await encryptJson(key, {
    format: 'yjs-v1', update: bytesToBase64Url(state),
  } satisfies YjsEnvelope, objectAssociatedData(binding.workspaceId, binding.objectId, binding.kind))
  await insertCommand(binding.workspaceId, commandId, 'commit-checkpoint', {
    commandId,
    type: 'commit-checkpoint',
    checkpointId: crypto.randomUUID(),
    documentId: binding.documentId,
    objectId: binding.objectId,
    kind: binding.kind,
    coversDocumentSequence: sequences[0]?.sequence ?? '0',
    materializedRevision: revisions[0]?.revision ?? null,
    keyVersion: binding.keyVersion,
    ciphertext: encrypted.packedCiphertext,
    ciphertextHash: encrypted.packedCiphertextHash,
  })
  void getSelfHostedSyncRuntime().wake('local-change')
}

async function consumeYjsUpdates(
  binding: DocumentBinding,
  apply: (update: Uint8Array, checkpoint: boolean) => void,
) {
  const database = await getDb()
  const rows = await database.select<Array<{
    sequence: string
    payload: string
    eventType: string
    keyVersion: number | null
  }>>(
    `select document_sequence as sequence, payload, event_type as eventType, key_version as keyVersion
     from self_hosted_yjs_updates where workspace_id = $1 and document_id = $2 and applied = 0
     order by cast(document_sequence as integer)`,
    [binding.workspaceId, binding.documentId]
  )
  for (const row of rows) {
    const key = await loadWorkspaceKey(binding.workspaceId, row.keyVersion ?? binding.keyVersion)
    const value = await decryptPackedJson<YjsEnvelope>(
      key, row.payload, objectAssociatedData(binding.workspaceId, binding.objectId, binding.kind),
    )
    apply(base64UrlToBytes(value.update), row.eventType === 'checkpoint')
    await database.execute(
      `update self_hosted_yjs_updates set applied = 1
       where workspace_id = $1 and document_id = $2 and document_sequence = $3`,
      [binding.workspaceId, binding.documentId, row.sequence]
    )
  }
}

async function resolveDocument(localRoot: string, relativePath: string): Promise<DocumentBinding> {
  const database = await getDb()
  const rows = await database.select<Array<{ workspaceId: string; objectId: string }>>(
    `select b.workspace_id as workspaceId, m.object_id as objectId
     from self_hosted_workspace_bindings b join self_hosted_object_mappings m
       on m.workspace_id = b.workspace_id
     where b.local_root = $1 and m.relative_path = $2 and b.binding_state = 'bound' limit 1`,
    [localRoot, relativePath]
  )
  const row = rows[0]
  if (row) return {
    ...row, documentId: row.objectId, kind: 'note', keyVersion: await latestKeyVersion(row.workspaceId),
  }
  const bindings = await database.select<Array<{ workspaceId: string }>>(
    `select workspace_id as workspaceId from self_hosted_workspace_bindings
     where local_root = $1 and binding_state = 'bound' limit 1`,
    [localRoot]
  )
  const workspaceId = bindings[0]?.workspaceId
  if (!workspaceId) throw new Error('文档尚未绑定到自托管资料库')
  const objectId = await invoke<string>('self_hosted_import_object_id', {
    workspaceId, relativePath: `file/${relativePath}`,
  })
  const portable = await invoke<{ normalized: string; caseFolded: string }>('self_hosted_portable_path', {
    relativePath,
  })
  await database.execute(
    `insert or ignore into self_hosted_object_mappings(
       workspace_id, object_id, kind, local_identity, relative_path, path_casefold, updated_at
     ) values ($1, $2, 'note', $3, $4, $5, $6)`,
    [workspaceId, objectId, `file:${relativePath}`, portable.normalized, portable.caseFolded, Date.now()]
  )
  return {
    workspaceId, objectId, documentId: objectId, kind: 'note',
    keyVersion: await latestKeyVersion(workspaceId),
  }
}

async function latestKeyVersion(workspaceId: string) {
  const database = await getDb()
  const rows = await database.select<Array<{ keyVersion: number }>>(
    `select max(key_version) as keyVersion from self_hosted_workspace_keys where workspace_id = $1`,
    [workspaceId]
  )
  return rows[0]?.keyVersion ?? 1
}

async function insertCommand(workspaceId: string, commandId: string, type: string, payload: object) {
  const database = await getDb()
  const now = Date.now()
  const objectId = 'objectId' in payload && typeof payload.objectId === 'string' ? payload.objectId : null
  const revisions = objectId ? await database.select<Array<{ revision: string }>>(
    `select revision from self_hosted_revisions where workspace_id = $1 and object_id = $2 limit 1`,
    [workspaceId, objectId]
  ) : []
  const state = objectId && revisions.length === 0 ? 'blocked' : 'pending'
  await database.execute(
    `insert into self_hosted_outbox(
       command_id, workspace_id, source_change_ids, command_type, payload, state, created_at, updated_at
     ) values ($1, $2, '[]', $3, $4, $5, $6, $6)`,
    [commandId, workspaceId, type, JSON.stringify(payload), state, now]
  )
}

function bytesToBase64Url(value: Uint8Array) {
  let binary = ''
  value.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0))
}
