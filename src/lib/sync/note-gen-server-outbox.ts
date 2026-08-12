import { exists, readDir, readTextFile, remove, stat } from '@tauri-apps/plugin-fs'

import {
  deleteNoteGenServerOutboxEntry,
  enqueueNoteGenServerOutbox,
  getNoteGenServerOutboxForObject,
  getNoteGenServerSyncObject,
  listNoteGenServerSyncObjects,
} from '@/db/note-gen-server-sync'
import {
  getOrCreateSyncEntity, getSyncEntityByLocalKey, markSyncMutationQueued,
  listSyncSubtreeEntities, moveSyncEntityLocalKey, recordSyncMutation,
} from '@/db/note-gen-server-sync-index'
import { shouldExclude } from '@/config/sync-exclusions'
import { getAllMarkdownFiles } from '@/lib/files'
import { resolveImagePathFromMarkdown } from '@/lib/markdown-image-path'
import { getFilePathOptions, getWorkspacePath, normalizeWorkspaceRelativePath } from '@/lib/workspace'
import {
  getNoteGenServerSyncScopeId,
  loadServerProfile,
} from './note-gen-server'
import {
  collectNoteGenServerAssetReferences,
  type NoteGenServerAssetReference,
} from './note-gen-server-assets'
import { hasActiveNoteGenServerMarkdownEditor } from './note-gen-server-active-editors'

interface MarkdownNotePayload {
  schemaVersion: 1
  type: 'markdown-note'
  relativePath: string
  content: string
  modifiedAt: string | null
  assets?: NoteGenServerAssetReference[]
}

const suppressedRemoteWrites = new Map<string, { contentHash: string | null, expiresAt: number }>()
const suppressedRemoteFolders = new Map<string, number>()

export async function queueCurrentNoteGenServerMarkdownWorkspace(): Promise<number> {
  const profile = await loadServerProfile()
  if (!profile?.enabled || !profile.workspaceId || !profile.localWorkspaceKey) return 0
  const syncScopeId = await getNoteGenServerSyncScopeId(profile)
  const files = await getAllMarkdownFiles(false, true)
  const localPaths = new Set(files.map(file => normalizeMarkdownPath(file.relativePath)))
  const folders = await listWorkspaceFolders()
  const localFolderIds = new Set<string>()
  let queued = 0
  for (const file of files) {
    if (await queueNoteGenServerMarkdownChange(file.relativePath, true)) queued += 1
  }
  const trackedObjects = await listNoteGenServerSyncObjects(syncScopeId)
  for (const object of trackedObjects) {
    if (object.kind === 'note' && object.contentHash !== null && !localPaths.has(object.relativePath)) {
      if (await queueNoteGenServerMarkdownChange(object.relativePath, false)) queued += 1
    }
  }
  for (const relativePath of folders) {
    const objectId = (await getOrCreateSyncEntity({
      scopeId: syncScopeId, kind: 'folder', localKey: relativePath,
      stableWorkspaceId: profile.workspaceId,
    })).objectId
    localFolderIds.add(objectId)
    if (await suppressOrRemoveRemoteDeletedFolder(relativePath)) continue
    const tracked = trackedObjects.find(object => object.objectId === objectId)
    const folderPayload = { schemaVersion: 1, type: 'folder', relativePath }
    const contentHash = await hashMarkdownContent(JSON.stringify(folderPayload))
    const pending = await getNoteGenServerOutboxForObject(syncScopeId, objectId)
    if (pending?.action === 'upsert' && pending.contentHash === contentHash) continue
    if (!pending && tracked?.contentHash === contentHash) continue
    const operationId = crypto.randomUUID()
    await recordSyncMutation({
      scopeId: syncScopeId, mutationId: operationId, objectId, kind: 'folder', payload: folderPayload,
    })
    await enqueueNoteGenServerOutbox({
      workspaceId: syncScopeId,
      operationId,
      objectId,
      kind: 'folder',
      relativePath,
      action: 'upsert',
      baseRevision: tracked?.revision ?? null,
      payloadJson: JSON.stringify(folderPayload),
      contentHash,
    })
    await markSyncMutationQueued(syncScopeId, operationId)
    queued += 1
  }
  for (const tracked of trackedObjects) {
    if (tracked.kind !== 'folder' || localFolderIds.has(tracked.objectId)) continue
    const pending = await getNoteGenServerOutboxForObject(syncScopeId, tracked.objectId)
    if (pending?.action === 'delete') continue
    const operationId = crypto.randomUUID()
    const folderPayload = { schemaVersion: 1, type: 'folder', relativePath: tracked.relativePath }
    await recordSyncMutation({
      scopeId: syncScopeId, mutationId: operationId, objectId: tracked.objectId,
      kind: 'folder', payload: folderPayload,
    })
    await enqueueNoteGenServerOutbox({
      workspaceId: syncScopeId,
      operationId,
      objectId: tracked.objectId,
      kind: 'folder',
      relativePath: tracked.relativePath,
      action: 'delete',
      baseRevision: tracked.revision,
      payloadJson: JSON.stringify(folderPayload),
      contentHash: null,
    })
    await markSyncMutationQueued(syncScopeId, operationId)
    queued += 1
  }
  return queued
}

export function suppressNoteGenServerFolderRecreation(relativePath: string, durationMs = 5 * 60_000): void {
  suppressedRemoteFolders.set(relativePath, Date.now() + durationMs)
}

export function suppressNoteGenServerFileEvent(
  relativePath: string,
  contentHash: string | null,
  durationMs = 5_000,
): void {
  suppressedRemoteWrites.set(normalizeMarkdownPath(relativePath), {
    contentHash,
    expiresAt: Date.now() + durationMs,
  })
}

export async function queueNoteGenServerMarkdownChange(
  relativePath: string,
  expectedToExist: boolean,
  options: { allowActiveEditor?: boolean } = {},
): Promise<boolean> {
  const normalizedPath = normalizeMarkdownPath(await normalizeWorkspaceRelativePath(relativePath))
  if (!isMarkdownPath(normalizedPath) || shouldExclude(normalizedPath) || isConflictPath(normalizedPath)) return false
  const pathOptions = await getFilePathOptions(normalizedPath)
  const workspace = await getWorkspacePath()
  const fileExists = expectedToExist && (workspace.isCustom
    ? await exists(pathOptions.path)
    : await exists(pathOptions.path, { baseDir: pathOptions.baseDir }))
  // An open Tiptap editor already transports text as Yjs updates, so it must
  // not queue a legacy whole-document snapshot. Asset bindings are lifecycle
  // metadata, however, and still need to be reconciled for the active note.
  const activeEditorOwnsText = fileExists && !options.allowActiveEditor
    && hasActiveNoteGenServerMarkdownEditor(normalizedPath)

  const profile = await loadServerProfile()
  if (!profile?.enabled || !profile.workspaceId || !profile.localWorkspaceKey) return false
  const syncScopeId = await getNoteGenServerSyncScopeId(profile)

  const entity = await getOrCreateSyncEntity({
    scopeId: syncScopeId, kind: 'note', localKey: normalizedPath,
    stableWorkspaceId: profile.workspaceId,
  })
  const lifecyclePayload = (() => {
    try {
      return entity.basePayloadJson ? JSON.parse(entity.basePayloadJson) as { type?: string } : null
    } catch {
      return null
    }
  })()
  // Once a Markdown note owns durable CRDT history, whole-file snapshots must
  // never update the same object again. They replace the `crdt-object`
  // lifecycle envelope with `markdown-note`, after which reopening the editor
  // restores an older Yjs document over the freshly saved disk file.
  if (fileExists && entity.documentId
    && (entity.documentSequence !== '0' || lifecyclePayload?.type === 'crdt-object')) {
    const content = workspace.isCustom
      ? await readTextFile(pathOptions.path)
      : await readTextFile(pathOptions.path, { baseDir: pathOptions.baseDir })
    const contentHash = await hashMarkdownContent(content)
    // Suppression applies only to the text write materialized from the server.
    // A local asset may be removed while the Markdown text still has the same
    // hash (or while a stale image reference remains). Always reconcile the
    // attachment manifest so that missing files stop being referenced.
    const suppressTextImport = consumeSuppressedRemoteWrite(normalizedPath, contentHash)
    const textQueued = activeEditorOwnsText || suppressTextImport ? false : await import('./note-gen-server-collab').then(module => (
      module.importNoteGenServerMarkdownFile({
        workspaceId: profile.workspaceId!, relativePath: normalizedPath, content,
      })
    ))
    const assets = await collectMarkdownNoteAssetReferences(normalizedPath, content)
    const assetsQueued = await queueCrdtNoteAssetBinding({
      syncScopeId, normalizedPath, entity, lifecyclePayload, assets,
    })
    return textQueued || assetsQueued
  }
  const objectId = entity.objectId
  if (!fileExists && entity.documentId) {
    await import('./note-gen-server-collab').then(module => (
      module.closeNoteGenServerMarkdownSession(profile.workspaceId!, normalizedPath)
    ))
  }
  const [tracked, pending] = await Promise.all([
    getNoteGenServerSyncObject(syncScopeId, objectId),
    getNoteGenServerOutboxForObject(syncScopeId, objectId),
  ])
  let payload: MarkdownNotePayload | null = null
  let contentHash: string | null = null
  if (fileExists) {
    const [content, fileStat] = await Promise.all([
      workspace.isCustom
        ? readTextFile(pathOptions.path)
        : readTextFile(pathOptions.path, { baseDir: pathOptions.baseDir }),
      workspace.isCustom
        ? stat(pathOptions.path)
        : stat(pathOptions.path, { baseDir: pathOptions.baseDir }),
    ])
    const assets = await collectMarkdownNoteAssetReferences(normalizedPath, content)
    contentHash = await hashMarkdownPayload(content, assets)
    payload = {
      schemaVersion: 1,
      type: 'markdown-note',
      relativePath: normalizedPath,
      content,
      modifiedAt: fileStat.mtime?.toISOString() ?? null,
      ...(assets.length > 0 ? { assets } : {}),
    }
  }

  if (consumeSuppressedRemoteWrite(normalizedPath, contentHash)) return false
  if (pending?.action === (fileExists ? 'upsert' : 'delete') && pending.contentHash === contentHash) return false
  if (tracked?.contentHash === contentHash && (fileExists || tracked.contentHash === null)) return false
  const hasDurableObject = entity.lifecycleRevision !== '0' || tracked !== null
  if (!fileExists && !hasDurableObject && pending?.baseRevision === null) {
    await deleteNoteGenServerOutboxEntry(pending.id, pending.operationId)
    return false
  }
  if (!fileExists && !hasDurableObject) return false

  const operationId = crypto.randomUUID()
  const journalPayload = payload ?? {
    schemaVersion: 1, type: 'markdown-note', relativePath: normalizedPath,
    content: '', modifiedAt: null,
  } satisfies MarkdownNotePayload
  await recordSyncMutation({
    scopeId: syncScopeId, mutationId: operationId, objectId, kind: 'note', payload: journalPayload,
  })
  await enqueueNoteGenServerOutbox({
    workspaceId: syncScopeId,
    operationId,
    objectId,
    kind: 'note',
    relativePath: normalizedPath,
    action: fileExists ? 'upsert' : 'delete',
    baseRevision: tracked?.revision ?? null,
    payloadJson: JSON.stringify(journalPayload),
    contentHash,
  })
  await markSyncMutationQueued(syncScopeId, operationId)
  return true
}

async function queueCrdtNoteAssetBinding(input: {
  syncScopeId: string
  normalizedPath: string
  entity: Awaited<ReturnType<typeof getOrCreateSyncEntity>>
  lifecyclePayload: { type?: string } | null
  assets: NoteGenServerAssetReference[]
}): Promise<boolean> {
  const previousAssets = normalizeAssetManifest(
    (input.lifecyclePayload as { assets?: NoteGenServerAssetReference[] } | null)?.assets ?? [],
  )
  const nextAssets = normalizeAssetManifest(input.assets)
  const previousBinding = input.lifecyclePayload && '$assetBinding' in input.lifecyclePayload
    ? (input.lifecyclePayload as Record<string, unknown>).$assetBinding
    : null
  const retryFailedBinding = previousBinding !== null
    && typeof previousBinding === 'object'
    && (previousBinding as Record<string, unknown>).state === 'failed'
  if (JSON.stringify(previousAssets) === JSON.stringify(nextAssets) && !retryFailedBinding) return false

  const operationId = crypto.randomUUID()
  const payload: Record<string, unknown> = {
    ...(input.lifecyclePayload ?? {
      schemaVersion: 2,
      type: 'crdt-object',
      localKey: input.normalizedPath,
      documentId: input.entity.documentId,
    }),
  }
  Reflect.deleteProperty(payload, '$assetBinding')
  if (input.assets.length > 0) payload.assets = input.assets
  else Reflect.deleteProperty(payload, 'assets')
  const manifestHash = await hashMarkdownContent(JSON.stringify(nextAssets))
  const pending = await getNoteGenServerOutboxForObject(input.syncScopeId, input.entity.objectId)
  if (pending?.action === 'upsert' && pending.contentHash === manifestHash) return false

  await recordSyncMutation({
    scopeId: input.syncScopeId, mutationId: operationId,
    objectId: input.entity.objectId, kind: 'note', payload,
  })
  await enqueueNoteGenServerOutbox({
    workspaceId: input.syncScopeId,
    operationId,
    objectId: input.entity.objectId,
    kind: 'note',
    relativePath: input.normalizedPath,
    action: 'upsert',
    baseRevision: input.entity.lifecycleRevision,
    payloadJson: JSON.stringify(payload),
    contentHash: manifestHash,
  })
  await markSyncMutationQueued(input.syncScopeId, operationId)
  return true
}

function normalizeAssetManifest(assets: NoteGenServerAssetReference[]): Array<{
  localPath: string
  contentHash: string
  scope: 'appData' | 'workspace'
}> {
  return assets.map(asset => ({
    localPath: asset.localPath,
    contentHash: asset.contentHash,
    scope: asset.scope ?? 'appData',
  })).sort((left, right) => left.localPath.localeCompare(right.localPath))
}

export async function recordNoteGenServerPathMove(oldPath: string, newPath: string): Promise<void> {
  const profile = await loadServerProfile()
  if (!profile?.enabled || !profile.workspaceId || !profile.localWorkspaceKey) return
  const scopeId = await getNoteGenServerSyncScopeId(profile)
  const oldKey = await normalizeWorkspaceRelativePath(oldPath)
  const newKey = await normalizeWorkspaceRelativePath(newPath)
  if (oldKey === newKey) return
  await import('./note-gen-server-collab').then(module => (
    module.moveNoteGenServerMarkdownDocs(profile.workspaceId!, oldKey, newKey)
  ))
  if (!await moveSyncEntityLocalKey(scopeId, oldKey, newKey)) return
  const entity = await getSyncEntityByLocalKey(scopeId, newKey)
  if (entity?.kind === 'note') {
    await import('./note-gen-server-collab').then(module => (
      module.refreshNoteGenServerMarkdownEntity(profile.workspaceId!, entity)
    ))
    await queueNoteGenServerMarkdownChange(newKey, true)
  }
  else if (entity?.kind === 'folder') {
    const subtree = await listSyncSubtreeEntities(scopeId, entity.objectId)
    await import('./note-gen-server-collab').then(async module => {
      for (const child of subtree) {
        if (child.kind === 'note') {
          await module.refreshNoteGenServerMarkdownEntity(profile.workspaceId!, child)
        }
      }
    })
    await queueNoteGenServerFolderChange(scopeId, entity.objectId, newKey)
  }
}

async function queueNoteGenServerFolderChange(
  scopeId: string,
  objectId: string,
  relativePath: string,
): Promise<void> {
  const [tracked, pending] = await Promise.all([
    getNoteGenServerSyncObject(scopeId, objectId),
    getNoteGenServerOutboxForObject(scopeId, objectId),
  ])
  const payload = { schemaVersion: 1, type: 'folder', relativePath }
  const payloadJson = JSON.stringify(payload)
  const contentHash = await hashMarkdownContent(payloadJson)
  if (pending?.action === 'upsert' && pending.contentHash === contentHash) return
  if (!pending && tracked?.contentHash === contentHash) return
  const operationId = crypto.randomUUID()
  await recordSyncMutation({
    scopeId, mutationId: operationId, objectId, kind: 'folder', payload,
  })
  await enqueueNoteGenServerOutbox({
    workspaceId: scopeId, operationId, objectId, kind: 'folder', relativePath,
    action: 'upsert', baseRevision: tracked?.revision ?? null,
    payloadJson, contentHash,
  })
  await markSyncMutationQueued(scopeId, operationId)
}

export async function hashMarkdownContent(content: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashMarkdownPayload(
  content: string,
  assets: NoteGenServerAssetReference[] = [],
): Promise<string> {
  const normalizedAssets = assets.map(asset => ({
    localPath: asset.localPath,
    contentHash: asset.contentHash,
    scope: asset.scope ?? 'appData',
  })).sort((left, right) => left.localPath.localeCompare(right.localPath))
  return await hashMarkdownContent(`${content}\0${JSON.stringify(normalizedAssets)}`)
}

export async function collectMarkdownNoteAssetReferences(
  relativePath: string,
  content: string,
): Promise<NoteGenServerAssetReference[]> {
  const candidates = new Set<string>()
  const patterns = [
    /!\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+['"][^'"]*['"])?\)/g,
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
  ]
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const source = match[1]?.trim()
      if (!source || /^(?:https?:|data:|blob:|asset:|tauri:|file:|#)/i.test(source)) continue
      const resolved = resolveImagePathFromMarkdown(relativePath, source)
      if (resolved && !shouldExclude(resolved)) candidates.add(resolved)
    }
  }
  return await collectNoteGenServerAssetReferences(Array.from(candidates), 'workspace')
}

function consumeSuppressedRemoteWrite(relativePath: string, contentHash: string | null): boolean {
  const suppressed = suppressedRemoteWrites.get(relativePath)
  if (!suppressed) return false
  if (suppressed.expiresAt <= Date.now()) {
    suppressedRemoteWrites.delete(relativePath)
    return false
  }
  if (suppressed.contentHash !== contentHash) {
    suppressedRemoteWrites.delete(relativePath)
    return false
  }
  return true
}

function normalizeMarkdownPath(relativePath: string): string {
  return relativePath.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/').normalize('NFC')
}

function isMarkdownPath(relativePath: string): boolean {
  return /\.(?:md|markdown)$/i.test(relativePath)
}

function isConflictPath(relativePath: string): boolean {
  return /\.conflict-[^/]+\.(?:md|markdown)$/i.test(relativePath)
}

async function listWorkspaceFolders(): Promise<string[]> {
  const folders: string[] = []
  const visit = async (relativePath: string): Promise<void> => {
    const pathOptions = await getFilePathOptions(relativePath)
    const entries = pathOptions.baseDir
      ? await readDir(pathOptions.path, { baseDir: pathOptions.baseDir })
      : await readDir(pathOptions.path)
    for (const entry of entries) {
      if (!entry.isDirectory || entry.name.startsWith('.')) continue
      const child = (relativePath ? `${relativePath}/${entry.name}` : entry.name).normalize('NFC')
      if (shouldExclude(`${child}/`)) continue
      folders.push(child)
      await visit(child)
    }
  }
  await visit('')
  return folders.sort()
}

async function suppressOrRemoveRemoteDeletedFolder(relativePath: string): Promise<boolean> {
  const expiresAt = suppressedRemoteFolders.get(relativePath)
  if (!expiresAt) return false
  if (expiresAt <= Date.now()) {
    suppressedRemoteFolders.delete(relativePath)
    return false
  }
  const pathOptions = await getFilePathOptions(relativePath)
  const entries = pathOptions.baseDir
    ? await readDir(pathOptions.path, { baseDir: pathOptions.baseDir })
    : await readDir(pathOptions.path)
  if (entries.length === 0) {
    if (pathOptions.baseDir) await remove(pathOptions.path, { baseDir: pathOptions.baseDir })
    else await remove(pathOptions.path)
    suppressedRemoteFolders.delete(relativePath)
  }
  return true
}
