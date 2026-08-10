'use client'

import { Check, GitMerge, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import * as Y from 'yjs'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'

import {
  enqueueSyncV2Command,
  getLocalSyncV2Document,
  getSyncV2Entity,
  listSyncV2SubtreeEntities,
  listSyncV2Conflicts,
  type SyncV2Conflict,
} from '@/db/note-gen-server-sync-index'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import {
  getNoteGenServerBackgroundConnection,
  getNoteGenServerBackgroundV2Context,
  syncNoteGenServerNow,
} from '@/lib/sync/note-gen-server-background'
import {
  decryptSyncV2Payload,
  createSyncV2NameBlindIndex,
  getSyncV2StableBlindIndexKey,
  getSyncV2StableBlindIndexKeyVersion,
  encryptSyncV2Payload,
  pullSyncV2DocumentUpdates,
} from '@/lib/sync/note-gen-server-sync-protocol'
import { materializeMerge, mergeMarkdownThreeWay, type MergePart } from '@/lib/sync/markdown-three-way-merge'
import {
  collectNoteGenServerAssetReferences,
  getNoteGenServerPayloadResourceReferences,
  prepareNoteGenServerPayloadAssets,
  restoreNoteGenServerPayloadAssets,
} from '@/lib/sync/note-gen-server-assets'
import useArticleStore from '@/stores/article'
import emitter from '@/lib/emitter'

interface ConflictPayload {
  type: 'markdown-three-way' | 'delete-vs-edit' | 'delete-subtree' | 'delete-subtree-vs-edit'
    | 'initial-import' | 'concurrent-rename' | 'same-name' | 'asset-content'
    | 'reference-target-deleted'
  path: string
  base: string
  local: string
  remote: string | null
  deletionRequestedLocally?: boolean
}

export function SyncConflictDialog({ open, onOpenChange, presentation = 'dialog' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presentation?: 'dialog' | 'page'
}) {
  const router = useRouter()
  const pathname = usePathname()
  const context = getNoteGenServerBackgroundV2Context()
  const [conflicts, setConflicts] = useState<SyncV2Conflict[]>([])
  const [index, setIndex] = useState(0)
  const [resolutions, setResolutions] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [resolutionError, setResolutionError] = useState('')
  const [markdownPath, setMarkdownPath] = useState('')
  const openingMarkdownConflictRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !context) return
    void listSyncV2Conflicts(context.syncScopeId).then(setConflicts)
  }, [open, context?.syncScopeId])
  const conflict = conflicts[index]
  const payload = conflict ? parsePayload(conflict.payloadJson) : null
  const rawPayload = conflict ? parseRawPayload(conflict.payloadJson) : null
  const payloadMarkdownPath = normalizeConflictPath(payload?.path ?? '')
  const effectiveMarkdownPath = payloadMarkdownPath || markdownPath
  const parts = useMemo(() => payload?.remote === null ? []
    : mergeMarkdownThreeWay(payload?.base ?? '', payload?.local ?? '', payload?.remote ?? ''),
  [payload?.base, payload?.local, payload?.remote])
  const unresolved = parts.filter((part): part is Extract<MergePart, { type: 'conflict' }> => part.type === 'conflict')

  useEffect(() => {
    let cancelled = false
    if (!conflict || conflict.kind !== 'note') {
      setMarkdownPath('')
      return
    }
    if (payloadMarkdownPath) {
      setMarkdownPath(payloadMarkdownPath)
      return
    }
    if (!context) return
    void getSyncV2Entity(context.syncScopeId, conflict.objectId).then(entity => {
      if (cancelled) return
      const entityPath = normalizeConflictPath(entity?.localKey ?? '')
      setMarkdownPath(entityPath.startsWith('__sync_') ? '' : entityPath)
    })
    return () => {
      cancelled = true
    }
  }, [conflict?.conflictId, context?.syncScopeId, payloadMarkdownPath])

  const resolveSameName = async (nextName: string) => {
    if (!context || !conflict || conflict.type !== 'same-name' || conflict.createdSequence === '0') return
    const name = nextName.normalize('NFC').trim()
    if (!name || /[\\/]/.test(name)) return
    const currentPath = payload?.path ?? entityPathFromRawPayload(rawPayload)
    const parentPath = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : ''
    const normalizedPath = parentPath ? `${parentPath}/${name}` : name
    if (normalizedPath === currentPath) return
    setSaving(true)
    try {
      const entity = await getSyncV2Entity(context.syncScopeId, conflict.objectId)
      if (!entity) throw new Error('冲突对象不存在')
      const basePayload = parseRawPayload(entity.basePayloadJson ?? '') ?? {}
      const objectPayload = {
        ...basePayload,
        ...('relativePath' in basePayload ? { relativePath: normalizedPath } : { localKey: normalizedPath }),
      }
      const encrypted = await encryptSyncV2Payload(context.workspaceKey, objectPayload, {
        workspaceId: context.workspaceId, objectId: entity.objectId, kind: entity.kind,
        keyVersion: context.keyVersion, purpose: 'object', identity: entity.objectId,
      })
      await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
        type: 'resolve-conflict', commandId: crypto.randomUUID(), conflictId: conflict.conflictId,
        expectedCreatedSequence: conflict.createdSequence,
        objectResolution: {
          objectId: entity.objectId, kind: entity.kind, parentObjectId: entity.parentObjectId,
          nameCiphertext: encrypted.ciphertext,
          nameBlindIndex: await createSyncV2NameBlindIndex({
            key: getSyncV2StableBlindIndexKey(context.workspaceKeys, context.workspaceKey),
            workspaceId: context.workspaceId,
            parentObjectId: entity.parentObjectId, name,
          }),
          nameBlindIndexKeyVersion: getSyncV2StableBlindIndexKeyVersion(context.workspaceKeys),
          keyVersion: context.keyVersion, ...encrypted,
        },
      } })
      await syncNoteGenServerNow()
      const next = await listSyncV2Conflicts(context.syncScopeId)
      setConflicts(next)
      setIndex(Math.min(index, Math.max(0, next.length - 1)))
      setResolutions({})
      if (next.length === 0) onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const resolve = async (
    content: string | null,
    chosenPayload?: unknown,
    forceDelete = false,
    keepExisting = false,
  ) => {
    if (!context || !conflict || !payload || conflict.createdSequence === '0') return
    setSaving(true)
    setResolutionError('')
    try {
      if (conflict.kind === 'note' && content !== null) {
        await resolveMarkdownSyncConflict({ conflict, content })
        const next = await listSyncV2Conflicts(context.syncScopeId)
        setConflicts(next)
        setIndex(Math.min(index, Math.max(0, next.length - 1)))
        setResolutions({})
        if (next.length === 0) onOpenChange(false)
        return
      }
      const entity = await getSyncV2Entity(context.syncScopeId, conflict.objectId)
      if (!entity) throw new Error('冲突对象不存在，无法应用所选版本')
      if (conflict.type === 'delete-subtree-vs-edit' && content === null) {
        const subtree = await listSyncV2SubtreeEntities(context.syncScopeId, conflict.objectId)
        const retryCommandId = crypto.randomUUID()
        const retryConflictId = crypto.randomUUID()
        const retryConflictEnvelope = await encryptSyncV2Payload(context.workspaceKey, {
          ...(rawPayload ?? {}), retryOfConflictId: conflict.conflictId,
          objectIds: subtree.map(item => item.objectId),
        }, {
          workspaceId: context.workspaceId, objectId: conflict.objectId, kind: 'folder',
          keyVersion: context.keyVersion, purpose: 'conflict', identity: retryConflictId,
        })
        const objects = []
        for (const item of subtree) {
          const objectPayload = parseRawPayload(item.basePayloadJson ?? '') ?? {
            schemaVersion: 2, type: 'deleted-object', localKey: item.localKey,
          }
          const envelope = await encryptSyncV2Payload(context.workspaceKey, objectPayload, {
            workspaceId: context.workspaceId, objectId: item.objectId, kind: item.kind,
            keyVersion: context.keyVersion, purpose: 'object', identity: item.objectId,
          })
          objects.push({
            objectId: item.objectId, kind: item.kind, baseRevision: item.lifecycleRevision,
            expectedDocumentSequence: item.documentSequence, blobRefs: [],
            keyVersion: context.keyVersion, ...envelope,
          })
        }
        await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
          type: 'delete-subtree', commandId: retryCommandId, rootObjectId: conflict.objectId,
          conflictId: retryConflictId, conflictKeyVersion: context.keyVersion,
          conflictCiphertext: retryConflictEnvelope.ciphertext,
          conflictCiphertextHash: retryConflictEnvelope.ciphertextHash, objects,
        } })
        await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
          type: 'resolve-conflict', commandId: crypto.randomUUID(), conflictId: conflict.conflictId,
          expectedCreatedSequence: conflict.createdSequence, requiresCommandId: retryCommandId,
        } })
        await syncNoteGenServerNow()
        const remaining = await listSyncV2Conflicts(context.syncScopeId)
        setConflicts(remaining)
        setIndex(Math.min(index, Math.max(0, remaining.length - 1)))
        if (remaining.length === 0) onOpenChange(false)
        return
      }
      let resolution: Record<string, unknown> | undefined
      const durableDocument = entity.documentId
        ? await getLocalSyncV2Document(context.syncScopeId, entity.documentId) : null
      if (content !== null && durableDocument) {
        const loadedDocument = conflict.kind === 'note' ? null : await loadDurableYDoc({
          context, entity, document: durableDocument,
        })
        const document = loadedDocument?.document ?? null
        let update: Uint8Array
        let expectedDocumentSequence: string
        if (conflict.kind === 'note') {
          const encoded = await encodeMarkdownCheckpoint({ content, context, entity, document: durableDocument })
          update = encoded.update
          expectedDocumentSequence = encoded.documentSequence
        }
        else {
          if (!loadedDocument || !document) throw new Error('无法创建结构化冲突文档')
          expectedDocumentSequence = loadedDocument.documentSequence
          const fields = document.getMap<unknown>('fields')
          const raw = chosenPayload && typeof chosenPayload === 'object'
            ? chosenPayload as Record<string, unknown> : {}
          const source = raw.value && typeof raw.value === 'object' && !Array.isArray(raw.value)
            ? { ...(raw.value as Record<string, unknown>) } : { ...raw }
          const type = String(raw.type ?? conflict.kind)
          const schemaVersion = raw.schemaVersion === 2 ? 2 : 1
          const messages = type === 'conversation' && Array.isArray(source.messages) ? source.messages : null
          const canvasDocument = type === 'canvas' && source.document && typeof source.document === 'object'
            ? { ...(source.document as Record<string, unknown>) } : null
          delete source.messages
          if (canvasDocument) {
            const nodes = Array.isArray(canvasDocument.nodes) ? canvasDocument.nodes : []
            const edges = Array.isArray(canvasDocument.edges) ? canvasDocument.edges : []
            delete canvasDocument.nodes
            delete canvasDocument.edges
            source.document = canvasDocument
            replaceStructuredMap(document.getMap('canvas-nodes'), nodes)
            replaceStructuredMap(document.getMap('canvas-edges'), edges)
            replaceStringArray(document.getArray('canvas-node-order'), idsForStructuredItems(nodes))
            replaceStringArray(document.getArray('canvas-edge-order'), idsForStructuredItems(edges))
          }
          for (const key of fields.keys()) fields.delete(key)
          fields.set('$schemaVersion', schemaVersion)
          fields.set('$type', type)
          for (const [key, value] of Object.entries(source)) fields.set(key, structuredClone(value))
          if (messages) {
            const target = document.getArray<unknown>('messages')
            target.delete(0, target.length)
            target.insert(0, messages.map(item => structuredClone(item)))
          }
          update = Y.encodeStateAsUpdate(document)
          document.destroy()
        }
        const checkpointId = crypto.randomUUID()
        const encrypted = await encryptSyncV2Payload(context.workspaceKey, update, {
          workspaceId: context.workspaceId, objectId: entity.objectId, kind: entity.kind,
          keyVersion: context.keyVersion, purpose: 'checkpoint', identity: checkpointId,
        })
        resolution = {
          checkpointId, documentId: entity.documentId, objectId: entity.objectId, kind: entity.kind,
          expectedDocumentSequence,
          keyVersion: context.keyVersion, ...encrypted,
        }
      }
      let objectResolution: Record<string, unknown> | undefined
      if (content !== null) {
        const objectPayload = chosenPayload ?? {
          schemaVersion: 1, type: 'markdown-note', relativePath: payload.path,
          content, modifiedAt: new Date().toISOString(),
        }
        const encryptedObject = await encryptSyncV2Payload(context.workspaceKey, objectPayload, {
          workspaceId: context.workspaceId, objectId: entity.objectId, kind: entity.kind,
          keyVersion: context.keyVersion, purpose: 'object', identity: entity.objectId,
        })
        objectResolution = {
          objectId: entity.objectId, kind: entity.kind, parentObjectId: entity.parentObjectId,
          nameCiphertext: encryptedObject.ciphertext, keyVersion: context.keyVersion,
          resourceObjectIds: getNoteGenServerPayloadResourceReferences(objectPayload)
            .map(reference => reference.resourceId),
          ...encryptedObject,
        }
      }
      const commandId = crypto.randomUUID()
      await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
        type: 'resolve-conflict', commandId, conflictId: conflict.conflictId,
        expectedCreatedSequence: conflict.createdSequence,
        ...(content === null
          ? !keepExisting && (payload.deletionRequestedLocally === true || forceDelete)
            ? { deleteObject: true } : {}
          : { resolution, objectResolution }),
      } })
      for (const related of conflicts) {
        if (related.conflictId === conflict.conflictId || related.objectId !== conflict.objectId
          || related.createdSequence === '0') continue
        await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
          type: 'resolve-conflict', commandId: crypto.randomUUID(), conflictId: related.conflictId,
          expectedCreatedSequence: related.createdSequence, requiresCommandId: commandId,
        } })
      }
      await syncNoteGenServerNow()
      const next = await listSyncV2Conflicts(context.syncScopeId)
      setConflicts(next)
      setIndex(Math.min(index, Math.max(0, next.length - 1)))
      setResolutions({})
      if (next.some(item => item.conflictId === conflict.conflictId)) {
        setResolutionError('冲突状态已发生变化，本次选择没有被应用。请返回同步页完成刷新后再处理。')
      }
      if (next.length === 0) onOpenChange(false)
    } catch (cause) {
      setResolutionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const resolveKeepObject = async () => {
    if (!context || !conflict || conflict.createdSequence === '0') return
    const entity = await getSyncV2Entity(context.syncScopeId, conflict.objectId)
    const objectPayload = entity ? parseRawPayload(entity.basePayloadJson ?? '') : null
    if (!entity || !objectPayload) throw new Error('缺少可恢复的对象快照')
    setSaving(true)
    try {
      const encrypted = await encryptSyncV2Payload(context.workspaceKey, objectPayload, {
        workspaceId: context.workspaceId, objectId: entity.objectId, kind: entity.kind,
        keyVersion: context.keyVersion, purpose: 'object', identity: entity.objectId,
      })
      await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
        type: 'resolve-conflict', commandId: crypto.randomUUID(), conflictId: conflict.conflictId,
        expectedCreatedSequence: conflict.createdSequence,
        objectResolution: {
          objectId: entity.objectId, kind: entity.kind, parentObjectId: entity.parentObjectId,
          nameCiphertext: encrypted.ciphertext, keyVersion: context.keyVersion, ...encrypted,
        },
      } })
      await syncNoteGenServerNow()
      const next = await listSyncV2Conflicts(context.syncScopeId)
      setConflicts(next)
      setIndex(Math.min(index, Math.max(0, next.length - 1)))
      if (next.length === 0) onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const resolveRemovedReferences = async () => {
    if (!rawPayload?.remote || typeof rawPayload.remote !== 'object') return
    const remote = structuredClone(rawPayload.remote) as Record<string, unknown>
    if (remote.type !== 'canvas' || !remote.value || typeof remote.value !== 'object') {
      await resolve(null, undefined, true)
      return
    }
    const references = Array.isArray(rawPayload.references) ? rawPayload.references : []
    const missingIds = new Set(references.flatMap(reference => reference && typeof reference === 'object'
      && typeof (reference as Record<string, unknown>).id === 'string'
      ? [(reference as Record<string, unknown>).id as string] : []))
    const value = remote.value as Record<string, unknown>
    const document = value.document && typeof value.document === 'object'
      ? value.document as Record<string, unknown> : null
    if (!document || !Array.isArray(document.nodes)) throw new Error('画布冲突缺少节点数据')
    document.nodes = document.nodes.map(node => {
      if (!node || typeof node !== 'object') return node
      const copy = structuredClone(node) as Record<string, unknown>
      if (copy.data && typeof copy.data === 'object') {
        const data = copy.data as Record<string, unknown>
        if (typeof data.recordSyncId === 'string' && missingIds.has(data.recordSyncId)) {
          delete data.recordSyncId
        }
      }
      return copy
    })
    await resolve(JSON.stringify(remote), remote)
  }

  const resolveAsset = async (choice: 'local' | 'remote') => {
    if (!context || !conflict || conflict.type !== 'asset-content'
      || conflict.createdSequence === '0' || !rawPayload) return
    const connection = getNoteGenServerBackgroundConnection()
    const entity = await getSyncV2Entity(context.syncScopeId, conflict.objectId)
    const remote = rawPayload.remote && typeof rawPayload.remote === 'object'
      ? rawPayload.remote as Record<string, unknown> : null
    const path = typeof rawPayload.path === 'string' ? rawPayload.path : null
    const scope = remote?.scope === 'workspace' ? 'workspace' as const : 'appData' as const
    if (!connection || !entity || !remote || !path) throw new Error('附件冲突缺少解决上下文')
    setSaving(true)
    try {
      let objectPayload: Record<string, unknown>
      let blobRefs: string[]
      if (choice === 'remote') {
        const blobId = typeof remote.blobId === 'string' ? remote.blobId : null
        if (!blobId) throw new Error('远端附件缺少 Blob 引用')
        await restoreNoteGenServerPayloadAssets({
          payload: remote,
          blobRefs: [blobId],
          baseUrl: connection.profile.baseUrl,
          accessToken: connection.session.accessToken,
          workspaceId: context.workspaceId,
          workspaceKey: context.workspaceKey,
        })
        objectPayload = remote
        blobRefs = [blobId]
      } else {
        const reference = (await collectNoteGenServerAssetReferences([path], scope))[0]
        if (!reference) throw new Error('要保留的本地附件不存在')
        const prepared = await prepareNoteGenServerPayloadAssets({
          payload: {
            ...remote,
            resourceId: entity.objectId,
            localPath: path,
            contentHash: reference.contentHash,
            size: reference.size,
            ...(scope === 'workspace' ? { scope } : {}),
            assets: [{ ...reference, resourceId: entity.objectId }],
          },
          baseUrl: connection.profile.baseUrl,
          accessToken: connection.session.accessToken,
          workspaceId: context.workspaceId,
          workspaceKey: context.workspaceKey,
          keyVersion: context.keyVersion,
        })
        const blobId = prepared.blobRefs[0]
        if (!blobId) throw new Error('本地附件上传后缺少 Blob 引用')
        objectPayload = { ...(prepared.payload as Record<string, unknown>), blobId }
        blobRefs = [blobId]
      }
      const encrypted = await encryptSyncV2Payload(context.workspaceKey, objectPayload, {
        workspaceId: context.workspaceId, objectId: entity.objectId, kind: 'asset',
        keyVersion: context.keyVersion, purpose: 'object', identity: entity.objectId,
      })
      await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
        type: 'resolve-conflict', commandId: crypto.randomUUID(), conflictId: conflict.conflictId,
        expectedCreatedSequence: conflict.createdSequence,
        objectResolution: {
          objectId: entity.objectId, kind: 'asset', parentObjectId: null,
          nameCiphertext: encrypted.ciphertext, blobRefs,
          keyVersion: context.keyVersion, ...encrypted,
        },
      } })
      await syncNoteGenServerNow()
      const next = await listSyncV2Conflicts(context.syncScopeId)
      setConflicts(next)
      setIndex(Math.min(index, Math.max(0, next.length - 1)))
      if (next.length === 0) onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const openMarkdownConflictInEditor = useCallback(async () => {
    if (!effectiveMarkdownPath) return
    onOpenChange(false)
    await useArticleStore.getState().setActiveFilePath(effectiveMarkdownPath)
    if (pathname.startsWith('/mobile')) router.push('/mobile/writing')
    window.setTimeout(() => {
      emitter.emit('sync-markdown-conflict-open', { path: effectiveMarkdownPath })
    }, 150)
  }, [effectiveMarkdownPath, onOpenChange, pathname, router])

  const shouldOpenMarkdownEditor = open && conflict?.kind === 'note' && Boolean(effectiveMarkdownPath)

  useEffect(() => {
    if (!shouldOpenMarkdownEditor || !conflict || openingMarkdownConflictRef.current === conflict.conflictId) return
    openingMarkdownConflictRef.current = conflict.conflictId
    void openMarkdownConflictInEditor()
  }, [conflict, openMarkdownConflictInEditor, shouldOpenMarkdownEditor])

  useEffect(() => {
    if (!open) openingMarkdownConflictRef.current = null
  }, [open])

  // Markdown content conflicts are handled inline in the article. Avoid
  // flashing the old modal while navigation and editor loading complete.
  if (shouldOpenMarkdownEditor) return null
  if (open && conflict?.kind === 'note' && !effectiveMarkdownPath) return null

  const actions = conflict?.type === 'asset-content' ? (
    <>
      <Button variant="outline" disabled={saving || conflict.createdSequence === '0'}
        onClick={() => void resolveAsset('local')}>保留本地附件</Button>
      <Button disabled={saving || conflict.createdSequence === '0'}
        onClick={() => void resolveAsset('remote')}>采用远端附件</Button>
    </>
  ) : conflict?.type === 'same-name' ? (
    <Button disabled={saving || conflict.createdSequence === '0'
      || !(resolutions[conflict.conflictId] ?? String(rawPayload?.name ?? '')).trim()}
      onClick={() => void resolveSameName(resolutions[conflict.conflictId] ?? String(rawPayload?.name ?? ''))}>
      <Check data-icon="inline-start" />使用新名称并解决
    </Button>
  ) : conflict?.type === 'reference-target-deleted' ? (
    conflict.kind === 'canvas' ? (
      <Button disabled={saving || conflict.createdSequence === '0'}
        onClick={() => void resolveRemovedReferences()}>
        <Check data-icon="inline-start" />移除失效引用并保留画布
      </Button>
    ) : (
      <Button disabled={saving || conflict.createdSequence === '0'}
        onClick={() => void resolve(null, undefined, false, true)}>
        <Check data-icon="inline-start" />保留记录
      </Button>
    )
  ) : conflict?.type === 'delete-subtree-vs-edit' || conflict?.type === 'delete-subtree' ? (
    <>
      {conflict.type === 'delete-subtree' ? (
        <Button variant="outline" disabled={saving || conflict.createdSequence === '0'}
          onClick={() => void resolveKeepObject()}><Check data-icon="inline-start" />恢复并保留文件夹</Button>
      ) : null}
      <Button variant="destructive" disabled={saving || conflict.createdSequence === '0'} onClick={() => void resolve(null)}>
        <Trash2 data-icon="inline-start" />{conflict.type === 'delete-subtree-vs-edit'
          ? '重新核对并确认删除整棵子树' : '确认删除文件夹'}</Button>
    </>
  ) : conflict?.type === 'structured-concurrent' ? (
    <Button disabled={saving || conflict.createdSequence === '0'} onClick={() => void resolve(null)}>
      <Check data-icon="inline-start" />使用当前同步结果
    </Button>
  ) : conflict?.type === 'delete-vs-edit' && conflict.kind !== 'note' ? (
    <>
      <Button disabled={saving || conflict.createdSequence === '0'}
        onClick={() => void resolve(null, undefined, false, true)}>
        <Check data-icon="inline-start" />保留有修改的内容
      </Button>
      <Button variant="destructive" disabled={saving || conflict.createdSequence === '0'}
        onClick={() => void resolve(null, undefined, true)}>
        <Trash2 data-icon="inline-start" />仍然删除
      </Button>
    </>
  ) : conflict?.kind !== 'note' && payload !== null && payload.remote !== null ? (
    <>
      <Button variant="outline" disabled={saving || conflict?.createdSequence === '0'} onClick={() => void resolve(payload.local, rawPayload?.local)}>采用本地</Button>
      <Button disabled={saving || conflict?.createdSequence === '0'} onClick={() => void resolve(payload.remote, rawPayload?.remote)}>采用远端</Button>
    </>
  ) : conflict?.kind === 'note' && payload !== null && payload.remote !== null ? (
    <Button disabled={!effectiveMarkdownPath} onClick={() => void openMarkdownConflictInEditor()}>
      <GitMerge data-icon="inline-start" />在 Markdown 编辑器中处理
    </Button>
  ) : payload !== null && payload.remote === null ? (
    <>
      <Button variant="destructive" disabled={saving || conflict?.createdSequence === '0'} onClick={() => void resolve(null)}><Trash2 data-icon="inline-start" />确认删除</Button>
      {conflict?.kind === 'note' ? <Button disabled={saving || conflict?.createdSequence === '0'} onClick={() => void resolve(payload.local)}><Check data-icon="inline-start" />恢复修改版</Button> : null}
    </>
  ) : (
    <Button disabled={!payload || saving || conflict?.createdSequence === '0'} onClick={() => void resolve(materializeMerge(parts, resolutions))}>
      <Check data-icon="inline-start" />提交合并结果{unresolved.length > 0 ? `（${unresolved.length} 块）` : ''}
    </Button>
  )

  return (
    <ConflictResolverRoot presentation={presentation} open={open} onOpenChange={onOpenChange}>
      <ConflictResolverContent presentation={presentation}>
        {presentation === 'page' ? (
          <header>
            <h1 className="flex items-center gap-2 text-xl font-semibold"><GitMerge />解决同步冲突</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {conflicts.length > 0 ? `第 ${index + 1} 项，共 ${conflicts.length} 项 · ` : ''}
              {conflict ? conflictDisplayName(conflict, payload?.path) : '没有待处理的同步冲突'}
            </p>
          </header>
        ) : (
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><GitMerge />解决同步冲突</DialogTitle>
            <DialogDescription>{conflict
              ? conflictDisplayName(conflict, payload?.path)
              : '没有待处理的同步冲突'}</DialogDescription>
          </DialogHeader>
        )}
        {resolutionError ? (
          <Alert variant="destructive">
            <GitMerge />
            <AlertTitle>冲突未能解决</AlertTitle>
            <AlertDescription>{resolutionError}</AlertDescription>
          </Alert>
        ) : null}
        {payload ? (
          <ScrollArea className="max-h-[65vh] pr-4">
            <div className="flex flex-col gap-4">
              {conflict?.type === 'asset-content' ? (
                <Alert variant="destructive">
                  <GitMerge />
                  <AlertTitle>附件路径存在不同内容</AlertTitle>
                  <AlertDescription>
                    本地附件不会被静默覆盖。请选择保留本地版本，或保留本地恢复副本后采用远端版本。
                  </AlertDescription>
                </Alert>
              ) : conflict?.type === 'same-name' ? (
                <Alert variant="destructive">
                  <GitMerge />
                  <AlertTitle>同一目录中存在同名对象</AlertTitle>
                  <AlertDescription>请输入一个不重复的新路径。原对象和内容会一直保留，冲突解决成功后才会应用重命名。</AlertDescription>
                  <Textarea
                    aria-label="新的文件路径"
                    className="mt-3 min-h-16 font-mono"
                    value={resolutions[conflict.conflictId] ?? String(rawPayload?.name ?? '')}
                    onChange={event => setResolutions(value => ({
                      ...value, [conflict.conflictId]: event.target.value,
                    }))}
                  />
                </Alert>
              ) : conflict?.type === 'reference-target-deleted' ? (
                <Alert variant="destructive">
                  <Trash2 />
                  <AlertTitle>引用的记录或标签已被删除</AlertTitle>
                  <AlertDescription>
                    系统会优先保留内容：画布会移除失效引用，记录会保留并忽略已经失效的关联。
                  </AlertDescription>
                </Alert>
              ) : conflict?.type === 'structured-concurrent' ? (
                <Alert>
                  <Check />
                  <AlertTitle>{conflictDisplayName(conflict, payload.path)}已在后台合并</AlertTitle>
                  <AlertDescription>
                    这是旧同步流程留下的状态记录，不需要比较内部数据。使用当前同步结果即可继续。
                  </AlertDescription>
                </Alert>
              ) : conflict?.type === 'delete-vs-edit' && conflict.kind !== 'note' ? (
                <Alert>
                  <GitMerge />
                  <AlertTitle>{conflictDisplayName(conflict, payload.path)}删除后又发生了修改</AlertTitle>
                  <AlertDescription>
                    为避免丢失内容，推荐保留修改后的版本；如果确定不再需要，也可以仍然删除。
                  </AlertDescription>
                </Alert>
              ) : conflict?.kind !== 'note' ? (
                conflict.type === 'delete-subtree-vs-edit' || conflict.type === 'delete-subtree' ? (
                  <Alert variant="destructive">
                    <Trash2 />
                    <AlertTitle>{conflict.type === 'delete-subtree-vs-edit'
                      ? '文件夹删除与远端编辑冲突' : '文件夹删除需要确认'}</AlertTitle>
                    <AlertDescription>
                      {conflict.type === 'delete-subtree-vs-edit'
                        ? '文件夹内至少一个对象在本次删除所依据的版本之后又被编辑。确认删除时会先重新核对整棵子树；若期间再次变化，删除不会执行，冲突也不会被关闭。'
                        : '远端请求删除此文件夹。你可以确认删除，也可以恢复当前文件夹；在选择前不会静默覆盖本地内容。'}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="grid gap-3 md:grid-cols-3">
                    <ConflictSide title="共同基线" value={payload.base} />
                    <ConflictSide title="本地" value={payload.local} />
                    <ConflictSide title="远端" value={payload.remote ?? '已删除'} />
                  </div>
                )
              ) : conflict?.kind === 'note' && payload.remote !== null ? (
                <Alert variant="destructive">
                  <GitMerge />
                  <AlertTitle>请在 Markdown 编辑器中处理</AlertTitle>
                  <AlertDescription>
                    编辑器会直接显示差异，并允许逐块采用本地、远端、两者或手工修改。
                  </AlertDescription>
                </Alert>
              ) : payload.remote === null ? (
                <div className="rounded-lg border p-4">
                  <p className="mb-3 text-sm">{payload.deletionRequestedLocally
                    ? '此设备请求删除笔记，但另一台设备在你删除后仍有编辑。'
                    : '另一台设备删除了笔记，但此设备仍有修改。'} 两个版本都会保留到你作出选择。</p>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{payload.local}</pre>
                </div>
              ) : parts.map((part, partIndex) => part.type === 'merged' ? (
                <pre key={partIndex} className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs">{part.content}</pre>
              ) : (
                <section key={part.block.id} className="rounded-lg border border-destructive/40 p-3">
                  <div className="mb-2 text-xs font-medium">第 {part.block.startLine} 行附近</div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <ConflictSide title="本地" value={part.block.local} />
                    <ConflictSide title="远端" value={part.block.remote} />
                  </div>
                  <div className="my-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setResolutions(value => ({ ...value, [part.block.id]: part.block.local }))}>采用本地</Button>
                    <Button size="sm" variant="outline" onClick={() => setResolutions(value => ({ ...value, [part.block.id]: part.block.remote }))}>采用远端</Button>
                    <Button size="sm" variant="outline" onClick={() => setResolutions(value => ({ ...value, [part.block.id]: part.block.local + part.block.remote }))}>保留两者</Button>
                  </div>
                  <Textarea aria-label="手工编辑合并结果" value={resolutions[part.block.id] ?? part.block.local}
                    onChange={event => setResolutions(value => ({ ...value, [part.block.id]: event.target.value }))}
                    className="min-h-32 font-mono text-xs" />
                </section>
              ))}
              {conflict?.kind === 'note' && payload.remote !== null ? (
                <div className="rounded-lg border p-3">
                  <div className="mb-2 text-sm font-medium">最终 Markdown 预览</div>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{materializeMerge(parts, resolutions)}</pre>
                </div>
              ) : null}
            </div>
          </ScrollArea>
        ) : null}
        {presentation === 'page' ? (
          <footer className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t bg-background py-3">
            {actions}
          </footer>
        ) : <DialogFooter>{actions}</DialogFooter>}
      </ConflictResolverContent>
    </ConflictResolverRoot>
  )
}

function ConflictResolverRoot({ presentation, open, onOpenChange, children }: {
  presentation: 'dialog' | 'page'
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return presentation === 'page'
    ? <>{children}</>
    : <Dialog open={open} onOpenChange={onOpenChange}>{children}</Dialog>
}

function ConflictResolverContent({ presentation, children }: {
  presentation: 'dialog' | 'page'
  children: ReactNode
}) {
  return presentation === 'page'
    ? <main className="flex min-h-full flex-col gap-4 p-4">{children}</main>
    : <DialogContent className="max-h-[90vh] max-w-5xl gap-4">{children}</DialogContent>
}

export async function resolveMarkdownSyncConflict({ conflict, content, relatedConflicts = [] }: {
  conflict: SyncV2Conflict
  content: string
  relatedConflicts?: SyncV2Conflict[]
}): Promise<void> {
  const context = getNoteGenServerBackgroundV2Context()
  if (!context || conflict.kind !== 'note' || conflict.createdSequence === '0') {
    throw new Error('Markdown 冲突尚未准备好，请等待同步完成后重试')
  }
  const payload = parsePayload(conflict.payloadJson)
  const entity = await getSyncV2Entity(context.syncScopeId, conflict.objectId)
  if (!payload || !entity?.documentId) throw new Error('冲突对象缺少 CRDT 文档身份')
  const durableDocument = await getLocalSyncV2Document(context.syncScopeId, entity.documentId)
  if (!durableDocument) throw new Error('冲突文档尚未下载完成')
  const encoded = await encodeMarkdownCheckpoint({ content, context, entity, document: durableDocument })
  const checkpointId = crypto.randomUUID()
  const encrypted = await encryptSyncV2Payload(context.workspaceKey, encoded.update, {
    workspaceId: context.workspaceId, objectId: entity.objectId, kind: entity.kind,
    keyVersion: context.keyVersion, purpose: 'checkpoint', identity: checkpointId,
  })
  const existingObjectPayload = parseRawPayload(entity.basePayloadJson ?? '')
  const objectPayload = existingObjectPayload?.type === 'crdt-object'
    ? existingObjectPayload
    : {
        schemaVersion: 2, type: 'crdt-object', localKey: payload.path,
        documentId: entity.documentId,
      }
  const encryptedObject = await encryptSyncV2Payload(context.workspaceKey, objectPayload, {
    workspaceId: context.workspaceId, objectId: entity.objectId, kind: entity.kind,
    keyVersion: context.keyVersion, purpose: 'object', identity: entity.objectId,
  })
  const commandId = crypto.randomUUID()
  await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
    type: 'resolve-conflict', commandId, conflictId: conflict.conflictId,
    expectedCreatedSequence: conflict.createdSequence,
    resolution: {
      checkpointId, documentId: entity.documentId, objectId: entity.objectId, kind: entity.kind,
      expectedDocumentSequence: encoded.documentSequence,
      keyVersion: context.keyVersion, ...encrypted,
    },
    objectResolution: {
      objectId: entity.objectId, kind: entity.kind, parentObjectId: entity.parentObjectId,
      nameCiphertext: encryptedObject.ciphertext, keyVersion: context.keyVersion,
      resourceObjectIds: getNoteGenServerPayloadResourceReferences(objectPayload)
        .map(reference => reference.resourceId),
      ...encryptedObject,
    },
  } })
  for (const related of relatedConflicts) {
    if (related.kind !== 'note' || related.objectId !== conflict.objectId || related.createdSequence === '0') continue
    await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
      type: 'resolve-conflict', commandId: crypto.randomUUID(), conflictId: related.conflictId,
      expectedCreatedSequence: related.createdSequence, requiresCommandId: commandId,
    } })
  }
  await syncNoteGenServerNow()
}

export async function dismissMarkdownSyncConflicts(conflicts: SyncV2Conflict[]): Promise<void> {
  const context = getNoteGenServerBackgroundV2Context()
  if (!context) throw new Error('同步服务连接不可用')
  for (const conflict of conflicts) {
    if (conflict.kind !== 'note' || conflict.createdSequence === '0') continue
    await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
      type: 'resolve-conflict', commandId: crypto.randomUUID(), conflictId: conflict.conflictId,
      expectedCreatedSequence: conflict.createdSequence,
    } })
  }
  await syncNoteGenServerNow()
}

export async function confirmMarkdownSyncDeletion({ conflict, relatedConflicts = [] }: {
  conflict: SyncV2Conflict
  relatedConflicts?: SyncV2Conflict[]
}): Promise<void> {
  const context = getNoteGenServerBackgroundV2Context()
  const payload = parsePayload(conflict.payloadJson)
  if (!context || conflict.kind !== 'note' || !payload || conflict.createdSequence === '0') {
    throw new Error('Markdown 冲突尚未准备好，请等待同步完成后重试')
  }
  const commandId = crypto.randomUUID()
  await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
    type: 'resolve-conflict', commandId, conflictId: conflict.conflictId,
    expectedCreatedSequence: conflict.createdSequence,
    ...(payload.deletionRequestedLocally === true ? { deleteObject: true } : {}),
  } })
  for (const related of relatedConflicts) {
    if (related.kind !== 'note' || related.objectId !== conflict.objectId || related.createdSequence === '0') continue
    await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
      type: 'resolve-conflict', commandId: crypto.randomUUID(), conflictId: related.conflictId,
      expectedCreatedSequence: related.createdSequence, requiresCommandId: commandId,
    } })
  }
  await syncNoteGenServerNow()
}

async function encodeMarkdownCheckpoint(input: {
  content: string
  context: NonNullable<ReturnType<typeof getNoteGenServerBackgroundV2Context>>
  entity: NonNullable<Awaited<ReturnType<typeof getSyncV2Entity>>>
  document: NonNullable<Awaited<ReturnType<typeof getLocalSyncV2Document>>>
}): Promise<{ update: Uint8Array, documentSequence: string }> {
  const loaded = await loadDurableYDoc(input)
  const document = loaded.document
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
      Collaboration.configure({ document }),
    ],
  })
  editor.commands.setContent(input.content, { contentType: 'markdown' })
  const update = Y.encodeStateAsUpdate(document)
  editor.destroy()
  document.destroy()
  return { update, documentSequence: loaded.documentSequence }
}

async function loadDurableYDoc(input: {
  context: NonNullable<ReturnType<typeof getNoteGenServerBackgroundV2Context>>
  entity: NonNullable<Awaited<ReturnType<typeof getSyncV2Entity>>>
  document: NonNullable<Awaited<ReturnType<typeof getLocalSyncV2Document>>>
}): Promise<{ document: Y.Doc, documentSequence: string }> {
  const document = new Y.Doc()
  const connection = getNoteGenServerBackgroundConnection()
  if (!connection) throw new Error('同步服务连接不可用')
  let after = input.document.checkpointDocumentSequence
  if (input.document.checkpointCiphertext && input.document.checkpointId
    && input.document.checkpointKeyVersion) {
    const key = input.context.workspaceKeys.get(input.document.checkpointKeyVersion)
    if (!key) throw new Error(`缺少 Workspace Key v${input.document.checkpointKeyVersion}`)
    const checkpoint = await decryptSyncV2Payload<Uint8Array>(key, input.document.checkpointCiphertext, {
      workspaceId: input.context.workspaceId, objectId: input.entity.objectId, kind: input.entity.kind,
      keyVersion: input.document.checkpointKeyVersion, purpose: 'checkpoint',
      identity: input.document.checkpointId,
    }, true)
    Y.applyUpdate(document, checkpoint)
  }
  while (true) {
    const page = await pullSyncV2DocumentUpdates({
      baseUrl: connection.profile.baseUrl, accessToken: connection.session.accessToken,
      workspaceId: input.context.workspaceId, documentId: input.document.documentId, after,
    })
    for (const item of page.updates) {
      const key = input.context.workspaceKeys.get(item.keyVersion)
      if (!key) throw new Error(`缺少 Workspace Key v${item.keyVersion}`)
      const update = await decryptSyncV2Payload<Uint8Array>(key, item.ciphertext, {
        workspaceId: input.context.workspaceId, objectId: input.entity.objectId, kind: input.entity.kind,
        keyVersion: item.keyVersion, purpose: 'update', identity: item.updateId,
      }, true)
      Y.applyUpdate(document, update)
    }
    after = page.nextDocumentSequence
    if (!page.hasMore) break
  }
  return { document, documentSequence: after }
}

function idsForStructuredItems(items: unknown[]): string[] {
  return items.flatMap(item => item && typeof item === 'object'
    && typeof (item as Record<string, unknown>).id === 'string'
    ? [(item as Record<string, unknown>).id as string] : [])
}

function replaceStructuredMap(target: Y.Map<unknown>, items: unknown[]): void {
  const ids = new Set(idsForStructuredItems(items))
  for (const key of target.keys()) if (!ids.has(key)) target.delete(key)
  for (const item of items) {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') {
      target.set((item as Record<string, unknown>).id as string, structuredClone(item))
    }
  }
}

function replaceStringArray(target: Y.Array<string>, items: string[]): void {
  target.delete(0, target.length)
  target.insert(0, items)
}

function ConflictSide({ title, value }: { title: string, value: string }) {
  return <div className="flex flex-col gap-1"><div className="text-xs text-muted-foreground">{title}</div><pre className="min-h-24 whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{value}</pre></div>
}

function parsePayload(value: string): ConflictPayload | null {
  try {
    const payload = JSON.parse(value) as Record<string, unknown>
    const text = (item: unknown) => typeof item === 'string' ? item : JSON.stringify(item, null, 2) ?? ''
    const type = String(payload.type ?? 'markdown-three-way') as ConflictPayload['type']
    return {
      ...payload,
      type,
      path: String(payload.path ?? payload.logicalKey ?? ''),
      base: text(payload.base), local: text(payload.local),
      remote: payload.remote === null || type === 'delete-subtree-vs-edit' ? null : text(payload.remote),
    } as ConflictPayload
  } catch { return null }
}

function parseRawPayload(value: string): Record<string, unknown> | null {
  try { return JSON.parse(value) as Record<string, unknown> } catch { return null }
}

function normalizeConflictPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').normalize('NFC')
}

function entityPathFromRawPayload(payload: Record<string, unknown> | null): string {
  return String(payload?.path ?? payload?.localKey ?? payload?.relativePath ?? '')
}

function conflictDisplayName(conflict: SyncV2Conflict, path?: string): string {
  const normalized = String(path ?? '').trim()
  if (normalized === 'workspace-preferences' || conflict.kind === 'setting') return '应用设置'
  if (conflict.kind === 'mark') return '记录'
  if (conflict.kind === 'tag') return '标签'
  if (conflict.kind === 'canvas') return '画布'
  if (conflict.kind === 'conversation') return '对话'
  if (conflict.kind === 'memory') return '记忆'
  if (conflict.kind === 'folder') return normalized || '文件夹'
  return normalized || '同步内容'
}
