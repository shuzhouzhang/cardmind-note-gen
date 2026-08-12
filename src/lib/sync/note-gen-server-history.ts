import {
  enqueueSyncCommand,
  getSyncEntity,
} from '@/db/note-gen-server-sync-index'

import {
  createSyncNameBlindIndex,
  decryptSyncPayload,
  encryptSyncPayload,
  getSyncStableBlindIndexKey,
  getSyncStableBlindIndexKeyVersion,
  getSyncObjectVersion,
  type SyncHistoricalObjectVersion,
} from './note-gen-server-sync-protocol'

interface HistoricalRestoreInput {
  baseUrl: string
  accessToken: string
  workspaceId: string
  syncScopeId: string
  objectId: string
  revision: string
  expectedSyncEpoch?: string
  workspaceKeys: ReadonlyMap<number, CryptoKey>
  workspaceKey: CryptoKey
  keyVersion: number
}

/**
 * Restores an immutable historical snapshot by creating fresh lifecycle
 * revisions. Exact asset revisions are restored first, then the owner is
 * rebound to those resources. Existing history is never rewritten.
 */
export async function enqueueSyncHistoricalRestore(
  input: HistoricalRestoreInput,
): Promise<{ commandIds: string[], resourceObjectIds: string[], payload: unknown }> {
  const historical = await getSyncObjectVersion(input)
  const historicalKey = input.workspaceKeys.get(historical.object.keyVersion)
  if (!historicalKey) {
    throw new Error(`历史恢复缺少 Workspace Key v${historical.object.keyVersion}`)
  }
  const payload = await decryptSyncPayload(historicalKey, historical.object.ciphertext, {
    workspaceId: input.workspaceId,
    objectId: historical.object.objectId,
    kind: historical.object.kind,
    keyVersion: historical.object.keyVersion,
    purpose: 'object',
    identity: historical.object.objectId,
  }, false, true)
  const commandIds: string[] = []
  for (const resource of historical.resources) {
    const entity = await requireCurrentEntity(input.syncScopeId, resource)
    const commandId = crypto.randomUUID()
    await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
      commandId,
      type: 'upsert-object',
      objectId: resource.objectId,
      kind: 'asset',
      parentObjectId: null,
      nameCiphertext: resource.nameCiphertext,
      baseRevision: resource.currentRevision === undefined
        ? (entity.lifecycleRevision === '0' ? null : entity.lifecycleRevision)
        : resource.currentRevision,
      blobRefs: resource.blobRefs,
      keyVersion: resource.keyVersion,
      ciphertext: resource.ciphertext,
      ciphertextHash: resource.ciphertextHash,
    } })
    commandIds.push(commandId)
  }

  const owner = await requireCurrentEntity(input.syncScopeId, historical.object)
  const ownerCommandId = crypto.randomUUID()
  const recreatingPurgedObject = historical.object.currentRevision === null
  const currentName = owner.localKey.split('/').filter(Boolean).at(-1) ?? owner.localKey
  const nameConflictId = recreatingPurgedObject ? crypto.randomUUID() : null
  const nameConflict = nameConflictId ? await encryptSyncPayload(input.workspaceKey, {
    schemaVersion: 2,
    type: 'same-name',
    objectId: historical.object.objectId,
    parentObjectId: owner.parentObjectId,
    path: owner.localKey,
    name: currentName,
  }, {
    workspaceId: input.workspaceId,
    objectId: historical.object.objectId,
    kind: historical.object.kind,
    keyVersion: input.keyVersion,
    purpose: 'conflict',
    identity: nameConflictId,
  }) : null
  await enqueueSyncCommand({ scopeId: input.syncScopeId, command: {
    commandId: ownerCommandId,
    type: 'upsert-object',
    objectId: historical.object.objectId,
    kind: historical.object.kind,
    // History restore intentionally preserves the current location/name. It
    // restores content and resource bindings without silently undoing moves.
    baseRevision: historical.object.currentRevision === undefined
      ? (owner.lifecycleRevision === '0' ? null : owner.lifecycleRevision)
      : historical.object.currentRevision,
    ...(recreatingPurgedObject ? {
      parentObjectId: owner.parentObjectId,
      nameCiphertext: historical.object.nameCiphertext,
      ...(['note', 'folder'].includes(historical.object.kind) ? {
        nameBlindIndex: await createSyncNameBlindIndex({
          key: getSyncStableBlindIndexKey(input.workspaceKeys, input.workspaceKey),
          workspaceId: input.workspaceId,
          parentObjectId: owner.parentObjectId,
          name: currentName,
        }),
        nameBlindIndexKeyVersion: getSyncStableBlindIndexKeyVersion(input.workspaceKeys),
        nameConflictId: nameConflictId!,
        nameConflictCiphertext: nameConflict!.ciphertext,
        nameConflictCiphertextHash: nameConflict!.ciphertextHash,
      } : {}),
    } : {}),
    blobRefs: historical.object.blobRefs,
    resourceObjectIds: historical.resources.map(resource => resource.objectId),
    keyVersion: historical.object.keyVersion,
    ciphertext: historical.object.ciphertext,
    ciphertextHash: historical.object.ciphertextHash,
  } })
  commandIds.push(ownerCommandId)
  return {
    commandIds,
    resourceObjectIds: historical.resources.map(resource => resource.objectId),
    payload,
  }
}

async function requireCurrentEntity(
  syncScopeId: string,
  historical: SyncHistoricalObjectVersion,
) {
  const entity = await getSyncEntity(syncScopeId, historical.objectId)
  if (!entity) throw new Error(`历史恢复缺少当前对象索引：${historical.objectId}`)
  if (entity.kind !== historical.kind) throw new Error(`历史恢复对象类型不一致：${historical.objectId}`)
  return entity
}
