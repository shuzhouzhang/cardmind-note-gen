import { exists, readDir, readTextFile, remove, stat } from '@tauri-apps/plugin-fs'

import {
  deleteNoteGenServerOutboxEntry,
  enqueueNoteGenServerOutbox,
  getNoteGenServerOutboxForObject,
  getNoteGenServerSyncObject,
  listNoteGenServerSyncObjects,
} from '@/db/note-gen-server-sync'
import { shouldExclude } from '@/config/sync-exclusions'
import { getAllMarkdownFiles } from '@/lib/files'
import { resolveImagePathFromMarkdown } from '@/lib/markdown-image-path'
import { getFilePathOptions, getWorkspacePath, normalizeWorkspaceRelativePath } from '@/lib/workspace'
import {
  createDeterministicNoteObjectId,
  createDeterministicServerObjectId,
  getNoteGenServerSyncScopeId,
  loadServerProfile,
} from './note-gen-server'
import {
  collectNoteGenServerAssetReferences,
  type NoteGenServerAssetReference,
} from './note-gen-server-assets'

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
    const objectId = await createDeterministicServerObjectId(profile.workspaceId, 'folder', relativePath)
    localFolderIds.add(objectId)
    if (await suppressOrRemoveRemoteDeletedFolder(relativePath)) continue
    const tracked = trackedObjects.find(object => object.objectId === objectId)
    const contentHash = await hashMarkdownContent(relativePath)
    const pending = await getNoteGenServerOutboxForObject(syncScopeId, objectId)
    if (pending?.action === 'upsert' && pending.contentHash === contentHash) continue
    if (!pending && tracked?.contentHash === contentHash) continue
    await enqueueNoteGenServerOutbox({
      workspaceId: syncScopeId,
      operationId: crypto.randomUUID(),
      objectId,
      kind: 'folder',
      relativePath,
      action: 'upsert',
      baseRevision: tracked?.revision ?? null,
      payloadJson: JSON.stringify({ schemaVersion: 1, type: 'folder', relativePath }),
      contentHash,
    })
    queued += 1
  }
  for (const tracked of trackedObjects) {
    if (tracked.kind !== 'folder' || localFolderIds.has(tracked.objectId)) continue
    const pending = await getNoteGenServerOutboxForObject(syncScopeId, tracked.objectId)
    if (pending?.action === 'delete') continue
    await enqueueNoteGenServerOutbox({
      workspaceId: syncScopeId,
      operationId: crypto.randomUUID(),
      objectId: tracked.objectId,
      kind: 'folder',
      relativePath: tracked.relativePath,
      action: 'delete',
      baseRevision: tracked.revision,
      payloadJson: JSON.stringify({ schemaVersion: 1, type: 'folder', relativePath: tracked.relativePath }),
      contentHash: null,
    })
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
): Promise<boolean> {
  const normalizedPath = normalizeMarkdownPath(await normalizeWorkspaceRelativePath(relativePath))
  if (!isMarkdownPath(normalizedPath) || shouldExclude(normalizedPath) || isConflictPath(normalizedPath)) return false

  const profile = await loadServerProfile()
  if (!profile?.enabled || !profile.workspaceId || !profile.localWorkspaceKey) return false
  const syncScopeId = await getNoteGenServerSyncScopeId(profile)

  const objectId = await createDeterministicNoteObjectId(profile.workspaceId, normalizedPath)
  const [tracked, pending] = await Promise.all([
    getNoteGenServerSyncObject(syncScopeId, objectId),
    getNoteGenServerOutboxForObject(syncScopeId, objectId),
  ])
  const pathOptions = await getFilePathOptions(normalizedPath)
  const workspace = await getWorkspacePath()
  const fileExists = expectedToExist && (workspace.isCustom
    ? await exists(pathOptions.path)
    : await exists(pathOptions.path, { baseDir: pathOptions.baseDir }))

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
  if (!fileExists && !tracked && pending?.baseRevision === null) {
    await deleteNoteGenServerOutboxEntry(pending.id, pending.operationId)
    return false
  }
  if (!fileExists && !tracked) return false

  await enqueueNoteGenServerOutbox({
    workspaceId: syncScopeId,
    operationId: crypto.randomUUID(),
    objectId,
    kind: 'note',
    relativePath: normalizedPath,
    action: fileExists ? 'upsert' : 'delete',
    baseRevision: tracked?.revision ?? null,
    payloadJson: JSON.stringify(payload ?? {
      schemaVersion: 1,
      type: 'markdown-note',
      relativePath: normalizedPath,
      content: '',
      modifiedAt: null,
    } satisfies MarkdownNotePayload),
    contentHash,
  })
  return true
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
