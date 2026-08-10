'use client'

import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'

import {
  enqueueSyncV2Command,
  getLocalSyncV2Document,
  getOrCreateSyncV2Entity,
  type SyncV2Entity,
} from '@/db/note-gen-server-sync-index'
import {
  deleteNoteGenServerOutboxEntry,
  getNoteGenServerOutboxForObject,
} from '@/db/note-gen-server-sync'
import emitter from '@/lib/emitter'
import { normalizeWorkspaceRelativePath } from '@/lib/workspace'
import {
  getNoteGenServerBackgroundConnection,
  getNoteGenServerBackgroundV2Context,
  publishNoteGenServerDocumentUpdate,
  publishNoteGenServerPresence,
  retainNoteGenServerRealtimeDocument,
  subscribeNoteGenServerDocumentSyncRequests,
  subscribeNoteGenServerDocumentUpdates,
  subscribeNoteGenServerPresence,
  triggerNoteGenServerBackgroundSync,
  type NoteGenServerPresence,
} from './note-gen-server-background'
import { createSyncV2NameBlindIndex, decryptSyncV2Payload, encryptSyncV2Payload, getSyncV2StableBlindIndexKey, getSyncV2StableBlindIndexKeyVersion, pullSyncV2DocumentUpdates, type SyncV2ObjectKind } from './note-gen-server-sync-protocol'

type TextListener = (value: string) => void
type FieldsListener = (value: Record<string, unknown>) => void
type MessagesListener = (value: unknown[]) => void
type CanvasListener = (value: { nodes: unknown[], edges: unknown[] }) => void
export interface NoteGenServerAwarenessState {
  label: string
  anchor: number
  head: number
}

type AwarenessListener = (clientId: string, state: NoteGenServerAwarenessState | null) => void

const sessions = new Map<string, NoteGenServerTextSession>()
const jsonSessions = new Map<string, NoteGenServerTextSession>()
const markdownDocs = new Map<string, Y.Doc>()

export function getNoteGenServerMarkdownDoc(workspaceId: string, relativePath: string): Y.Doc {
  const path = relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').normalize('NFC')
  const key = `${workspaceId}:note-path:${path}`
  const existing = markdownDocs.get(key)
  if (existing) return existing
  const doc = new Y.Doc()
  markdownDocs.set(key, doc)
  return doc
}

export function moveNoteGenServerMarkdownDocs(
  workspaceId: string,
  oldPath: string,
  newPath: string,
): void {
  const normalize = (value: string) => value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    .replace(/\/+/g, '/').replace(/\/$/, '').normalize('NFC')
  const oldPrefix = `${workspaceId}:note-path:${normalize(oldPath)}`
  const newPrefix = `${workspaceId}:note-path:${normalize(newPath)}`
  for (const [key, doc] of [...markdownDocs]) {
    if (key !== oldPrefix && !key.startsWith(`${oldPrefix}/`)) continue
    markdownDocs.delete(key)
    markdownDocs.set(`${newPrefix}${key.slice(oldPrefix.length)}`, doc)
  }
}

export async function refreshNoteGenServerMarkdownEntity(
  workspaceId: string,
  entity: SyncV2Entity,
): Promise<void> {
  const session = sessions.get(`${workspaceId}:note:${entity.objectId}`)
  if (session) await session.updateEntity(entity)
}

export async function closeNoteGenServerMarkdownSession(
  workspaceId: string,
  relativePath: string,
): Promise<void> {
  const normalized = relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    .replace(/\/+/g, '/').normalize('NFC')
  for (const session of sessions.values()) {
    if (!session.matchesMarkdownPath(workspaceId, normalized)) continue
    await session.flushPendingUpdates()
    session.destroy()
  }
}

export function destroyNoteGenServerCollaborationSessions(): void {
  for (const session of new Set([...sessions.values(), ...jsonSessions.values()])) session.destroy()
  sessions.clear()
  jsonSessions.clear()
  markdownDocs.clear()
}

export interface NoteGenServerStructuredSnapshot {
  markdown: string | null
  fields: Record<string, unknown>
  messages: unknown[]
  canvas: { nodes: unknown[], edges: unknown[] }
}

type NoteGenServerStructuredFieldsSnapshot = Omit<NoteGenServerStructuredSnapshot, 'markdown'>

/**
 * Rebuilds a structured document without creating a long-lived editor session.
 * The background synchronizer uses this after durable inbox receipt so a
 * closed page cannot leave the CRDT state unapplied in the business tables.
 */
export async function loadNoteGenServerStructuredSnapshot(input: {
  workspaceId: string
  entity: SyncV2Entity
}): Promise<NoteGenServerStructuredSnapshot | null> {
  const connection = getNoteGenServerBackgroundConnection()
  const context = getNoteGenServerBackgroundV2Context()
  if (!connection || !context || context.workspaceId !== input.workspaceId || !input.entity.documentId) {
    return null
  }
  const doc = new Y.Doc()
  try {
    const localDocument = await getLocalSyncV2Document(context.syncScopeId, input.entity.documentId)
    let after = localDocument?.checkpointDocumentSequence ?? '0'
    if (localDocument?.checkpointCiphertext && localDocument.checkpointId
      && localDocument.checkpointKeyVersion) {
      const key = context.workspaceKeys.get(localDocument.checkpointKeyVersion)
      if (!key) throw new Error(`缺少 Workspace Key v${localDocument.checkpointKeyVersion}`)
      const checkpoint = await decryptSyncV2Payload<Uint8Array>(key, localDocument.checkpointCiphertext, {
        workspaceId: context.workspaceId, objectId: input.entity.objectId, kind: input.entity.kind,
        keyVersion: localDocument.checkpointKeyVersion, purpose: 'checkpoint',
        identity: localDocument.checkpointId,
      }, true)
      Y.applyUpdate(doc, checkpoint)
    }
    while (true) {
      const page = await pullSyncV2DocumentUpdates({
        baseUrl: connection.profile.baseUrl, accessToken: connection.session.accessToken,
        workspaceId: context.workspaceId, documentId: input.entity.documentId, after,
      })
      for (const item of page.updates) {
        const key = context.workspaceKeys.get(item.keyVersion)
        if (!key) throw new Error(`缺少 Workspace Key v${item.keyVersion}`)
        const update = await decryptSyncV2Payload<Uint8Array>(key, item.ciphertext, {
          workspaceId: context.workspaceId, objectId: input.entity.objectId, kind: input.entity.kind,
          keyVersion: item.keyVersion, purpose: 'update', identity: item.updateId,
        }, true)
        Y.applyUpdate(doc, update)
      }
      after = page.nextDocumentSequence
      if (!page.hasMore) break
    }
    return {
      markdown: doc.getMap('sync-meta').get('markdownMirrorVersion') === 1
        ? doc.getText('markdown').toString()
        : null,
      ...readStructuredSnapshot(doc),
    }
  } finally {
    doc.destroy()
  }
}

export async function getNoteGenServerTextSession(input: {
  workspaceId: string
  relativePath: string
  initialContent: string
  doc?: Y.Doc
}): Promise<NoteGenServerTextSession | null> {
  const connection = getNoteGenServerBackgroundConnection()
  const context = getNoteGenServerBackgroundV2Context()
  if (!connection || !context || connection.profile.workspaceId !== input.workspaceId) return null
  const normalizedPath = await normalizeWorkspaceRelativePath(input.relativePath)
  const entity = await getOrCreateSyncV2Entity({
    scopeId: context.syncScopeId, kind: 'note', localKey: normalizedPath,
    stableWorkspaceId: input.workspaceId,
  })
  const key = `${input.workspaceId}:note:${entity.objectId}`
  const existing = sessions.get(key)
  if (existing) return existing
  const session = new NoteGenServerTextSession({
    key, entity, workspaceId: input.workspaceId, kind: 'note',
    initialContent: input.initialContent,
    doc: input.doc ?? getNoteGenServerMarkdownDoc(input.workspaceId, normalizedPath),
  })
  sessions.set(key, session)
  try {
    await session.start()
    return session
  } catch {
    sessions.delete(key)
    session.destroy()
    return null
  }
}

export async function importNoteGenServerMarkdownFile(input: {
  workspaceId: string
  relativePath: string
  content: string
}): Promise<boolean> {
  const session = await getNoteGenServerTextSession({
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    initialContent: input.content,
    doc: getNoteGenServerMarkdownDoc(input.workspaceId, input.relativePath),
  })
  if (!session) return false
  return session.importText(input.content)
}

export async function getNoteGenServerJsonSession(input: {
  workspaceId: string
  documentId: string
  initialValue: unknown
  initialFields?: Record<string, unknown>
}): Promise<NoteGenServerTextSession | null> {
  const connection = getNoteGenServerBackgroundConnection()
  const context = getNoteGenServerBackgroundV2Context()
  if (!connection || !context || connection.profile.workspaceId !== input.workspaceId) return null
  const kind = kindForDocument(input.documentId)
  const localKey = localKeyForDocument(input.documentId, kind)
  const entity = await getOrCreateSyncV2Entity({
    scopeId: context.syncScopeId, kind, localKey,
    stableWorkspaceId: input.workspaceId,
  })
  const key = `${input.workspaceId}:${entity.documentId}`
  const existing = jsonSessions.get(key)
  if (existing) return existing
  const session = new NoteGenServerTextSession({
    key, entity, workspaceId: input.workspaceId, kind, initialContent: '',
  })
  jsonSessions.set(key, session)
  try {
    await session.start()
    if (input.initialFields) {
      if (session.fields.size === 0) session.setFields(input.initialFields)
    } else if (session.text.length === 0) {
      session.setText(JSON.stringify(input.initialValue))
    }
    return session
  } catch {
    jsonSessions.delete(key)
    session.destroy()
    return null
  }
}

export async function getNoteGenServerStructuredSession(input: {
  workspaceId: string
  documentId: string
  initialFields: Record<string, unknown>
}): Promise<NoteGenServerTextSession | null> {
  return await getNoteGenServerJsonSession({
    workspaceId: input.workspaceId, documentId: `structured:${input.documentId}`,
    initialValue: input.initialFields, initialFields: input.initialFields,
  })
}

export async function getNoteGenServerConversationSession(input: {
  workspaceId: string
  conversationSyncId: string
  initialMessages: unknown[]
}): Promise<NoteGenServerTextSession | null> {
  const session = await getNoteGenServerJsonSession({
    workspaceId: input.workspaceId, documentId: `conversation:${input.conversationSyncId}`, initialValue: null,
  })
  if (session && session.getMessages().length === 0) session.setMessages(input.initialMessages)
  return session
}

export class NoteGenServerTextSession {
  readonly doc: Y.Doc
  readonly text: Y.Text
  readonly fragment: Y.XmlFragment
  readonly syncMeta: Y.Map<unknown>
  readonly fields: Y.Map<unknown>
  readonly messages: Y.Array<unknown>
  readonly messageItems: Y.Map<unknown>
  readonly messageOrder: Y.Array<string>
  readonly canvasNodes: Y.Map<unknown>
  readonly canvasEdges: Y.Map<unknown>
  readonly canvasNodeOrder: Y.Array<string>
  readonly canvasEdgeOrder: Y.Array<string>
  readonly #persistence: IndexeddbPersistence
  readonly #listeners = new Set<TextListener>()
  readonly #fieldListeners = new Set<FieldsListener>()
  readonly #messageListeners = new Set<MessagesListener>()
  readonly #canvasListeners = new Set<CanvasListener>()
  readonly #awarenessListeners = new Set<AwarenessListener>()
  readonly #realtimePeers = new Set<string>()
  readonly #remoteOrigin = {}
  readonly #key: string
  readonly #workspaceId: string
  #entity: SyncV2Entity
  readonly #kind: SyncV2ObjectKind
  readonly #recoveryStorageKey: string
  #started = false
  #ready = false
  #destroyed = false
  #sendQueue = Promise.resolve()
  #updatesSinceCheckpoint = 0
  #localUpdateGeneration = 0
  #unsubscribeUpdates: (() => void) | null = null
  #unsubscribeRealtimeUpdates: (() => void) | null = null
  #unsubscribeRealtimeSyncRequests: (() => void) | null = null
  #releaseRealtimeDocument: (() => void) | null = null
  #unsubscribeAwareness: (() => void) | null = null
  #hasLocalAwareness = false

  constructor(input: {
    key: string
    entity: SyncV2Entity
    workspaceId: string
    kind: SyncV2ObjectKind
    initialContent: string
    doc?: Y.Doc
  }) {
    this.doc = input.doc ?? new Y.Doc()
    this.text = this.doc.getText('markdown')
    this.fragment = this.doc.getXmlFragment('default')
    this.syncMeta = this.doc.getMap<unknown>('sync-meta')
    this.fields = this.doc.getMap<unknown>('fields')
    this.messages = this.doc.getArray<unknown>('messages')
    this.messageItems = this.doc.getMap<unknown>('message-items')
    this.messageOrder = this.doc.getArray<string>('message-order')
    this.canvasNodes = this.doc.getMap<unknown>('canvas-nodes')
    this.canvasEdges = this.doc.getMap<unknown>('canvas-edges')
    this.canvasNodeOrder = this.doc.getArray<string>('canvas-node-order')
    this.canvasEdgeOrder = this.doc.getArray<string>('canvas-edge-order')
    this.#key = input.key
    this.#workspaceId = input.workspaceId
    this.#entity = input.entity
    this.#kind = input.kind
    this.#recoveryStorageKey = `note-gen-server:v2:recovery:${this.#key}`
    this.#persistence = new IndexeddbPersistence(`note-gen-server:v2:${this.#key}`, this.doc)
    this.text.observe(() => {
      for (const listener of this.#listeners) listener(this.text.toString())
    })
    this.fields.observe(() => {
      for (const listener of this.#fieldListeners) listener(this.getFields())
    })
    const notifyMessages = () => {
      const value = this.getMessages()
      for (const listener of this.#messageListeners) listener(value)
    }
    this.messages.observe(() => {
      if (this.messageItems.size === 0 && this.messages.length > 0) this.#migrateLegacyMessages()
      notifyMessages()
    })
    this.messageItems.observeDeep(notifyMessages)
    this.messageOrder.observe(notifyMessages)
    const notifyCanvas = () => {
      const value = this.getCanvasGraph()
      for (const listener of this.#canvasListeners) listener(value)
    }
    this.canvasNodes.observeDeep(notifyCanvas)
    this.canvasEdges.observeDeep(notifyCanvas)
    this.canvasNodeOrder.observe(notifyCanvas)
    this.canvasEdgeOrder.observe(notifyCanvas)
    this.doc.on('update', (update, origin) => {
      if (origin === this.#remoteOrigin || !this.#ready || this.#destroyed) return
      const generation = ++this.#localUpdateGeneration
      writeRecoveryState(this.#recoveryStorageKey, 'dirty')
      this.#queueUpdate(update, { generation })
    })
    if (!input.doc && input.initialContent) this.text.insert(0, input.initialContent)
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    await this.#persistence.whenSynced
    if (this.#kind === 'note') {
      const context = getNoteGenServerBackgroundV2Context()
      if (context) {
        const legacySnapshot = await getNoteGenServerOutboxForObject(
          context.syncScopeId,
          this.#entity.objectId,
        )
        if (legacySnapshot?.action === 'upsert') {
          await deleteNoteGenServerOutboxEntry(legacySnapshot.id, legacySnapshot.operationId)
        }
      }
    }
    await this.#ensureObjectCommand()
    try {
      await this.#loadRemoteDocument()
    } catch (error) {
      // IndexedDB is sufficient for offline editing. The durable background
      // pull will deliver the missing updates after connectivity returns.
      console.warn('Markdown collaboration remote restore deferred:', error)
    }
    this.#migrateLegacyMessages()
    const handler = (event: unknown) => {
      const value = event as { documentId?: string, update?: Uint8Array }
      if (value.documentId === this.#entity.documentId && value.update) {
        Y.applyUpdate(this.doc, value.update, this.#remoteOrigin)
      }
    }
    emitter.on('note-gen-server-document-update', handler)
    this.#unsubscribeUpdates = () => emitter.off('note-gen-server-document-update', handler)
    this.#unsubscribeRealtimeSyncRequests = subscribeNoteGenServerDocumentSyncRequests(
      (workspaceId, documentId) => {
        if (workspaceId === this.#workspaceId && documentId === this.#entity.documentId) {
          this.#broadcastRealtimeState()
        }
      },
    )
    this.#unsubscribeRealtimeUpdates = subscribeNoteGenServerDocumentUpdates(update => {
      if (this.#destroyed
        || update.workspaceId !== this.#workspaceId
        || update.documentId !== this.#entity.documentId
        || update.objectId !== this.#entity.objectId
        || update.kind !== this.#kind) return
      const context = getNoteGenServerBackgroundV2Context()
      const key = context?.workspaceKeys.get(update.keyVersion)
      if (!context || !key) return
      void decryptSyncV2Payload<Uint8Array>(key, update.ciphertext, {
        workspaceId: update.workspaceId,
        objectId: update.objectId,
        kind: update.kind,
        keyVersion: update.keyVersion,
        purpose: 'update',
        identity: update.updateId,
      }, true).then(value => {
        if (!this.#destroyed) Y.applyUpdate(this.doc, value, this.#remoteOrigin)
      }).catch(() => {
        // The durable event stream will retry and validate this update.
      })
    })
    if (this.#entity.documentId) {
      this.#releaseRealtimeDocument = retainNoteGenServerRealtimeDocument(
        this.#workspaceId, this.#entity.documentId,
      )
      this.#broadcastRealtimeState()
    }
    this.#unsubscribeAwareness = subscribeNoteGenServerPresence((presence, deviceId) => {
      if (presence
        && (presence.workspaceId !== this.#workspaceId
          || presence.documentId !== this.#entity.documentId)) return
      if (presence) {
        if (!this.#realtimePeers.has(deviceId)) {
          this.#realtimePeers.add(deviceId)
          this.#broadcastRealtimeState()
        }
      } else {
        this.#realtimePeers.delete(deviceId)
      }
      const awareness = presence
        ? { label: presence.label, anchor: presence.anchor, head: presence.head }
        : null
      for (const listener of this.#awarenessListeners) listener(deviceId, awareness)
    })
    this.#ready = true
    if (this.#entity.lifecycleRevision === '0'
      || readRecoveryState(this.#recoveryStorageKey) !== 'clean-v1') {
      this.#queueUpdate(Y.encodeStateAsUpdate(this.doc), {
        generation: this.#localUpdateGeneration,
      })
    }
  }

  subscribe(listener: TextListener): () => void {
    this.#listeners.add(listener)
    listener(this.text.toString())
    return () => this.#listeners.delete(listener)
  }

  subscribeFields(listener: FieldsListener): () => void {
    this.#fieldListeners.add(listener)
    listener(this.getFields())
    return () => this.#fieldListeners.delete(listener)
  }

  subscribeMessages(listener: MessagesListener): () => void {
    this.#messageListeners.add(listener)
    listener(this.getMessages())
    return () => this.#messageListeners.delete(listener)
  }

  subscribeCanvas(listener: CanvasListener): () => void {
    this.#canvasListeners.add(listener)
    listener(this.getCanvasGraph())
    return () => this.#canvasListeners.delete(listener)
  }

  subscribeAwareness(listener: AwarenessListener): () => void {
    this.#awarenessListeners.add(listener)
    return () => this.#awarenessListeners.delete(listener)
  }

  setAwareness(state: NoteGenServerAwarenessState | null): void {
    if (!state) {
      if (this.#hasLocalAwareness) publishNoteGenServerPresence(null)
      this.#hasLocalAwareness = false
      return
    }
    if (!this.#entity.documentId) return
    this.#hasLocalAwareness = true
    const presence: Omit<NoteGenServerPresence, 'deviceId'> = {
      workspaceId: this.#workspaceId,
      documentId: this.#entity.documentId,
      label: state.label,
      anchor: state.anchor,
      head: state.head,
    }
    publishNoteGenServerPresence(presence)
  }

  setMessages(messages: unknown[]): void {
    if (this.#destroyed) return
    this.doc.transact(() => {
      const entries = new Map<string, unknown>()
      for (let index = 0; index < messages.length; index += 1) {
        entries.set(getStableMessageId(messages[index], index), messages[index])
      }
      const ids = Array.from(entries.keys())
      for (const [id, message] of entries) {
        syncStructuredMapValue(this.messageItems, id, message)
      }
      const currentOrder = this.messageOrder.toArray()
      const seen = new Set<string>()
      for (let index = currentOrder.length - 1; index >= 0; index -= 1) {
        const id = currentOrder[index]
        if (seen.has(id)) {
          this.messageOrder.delete(index, 1)
          currentOrder.splice(index, 1)
        } else {
          seen.add(id)
        }
      }
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]
        if (currentOrder.includes(id)) continue
        const previousId = ids.slice(0, index).reverse().find(candidate => currentOrder.includes(candidate))
        const insertionIndex = previousId ? currentOrder.indexOf(previousId) + 1 : currentOrder.length
        this.messageOrder.insert(insertionIndex, [id])
        currentOrder.splice(insertionIndex, 0, id)
      }
    })
  }

  deleteMessages(messageIds: string[]): void {
    if (this.#destroyed || messageIds.length === 0) return
    const deleted = new Set(messageIds)
    this.doc.transact(() => {
      for (const id of deleted) this.messageItems.delete(id)
      const order = this.messageOrder.toArray()
      for (let index = order.length - 1; index >= 0; index -= 1) {
        if (deleted.has(order[index])) this.messageOrder.delete(index, 1)
      }
    })
  }

  getMessages(): unknown[] {
    if (this.messageItems.size === 0 && this.messageOrder.length === 0) {
      return deduplicateMessages(this.messages.toArray())
    }
    return uniqueStrings(this.messageOrder.toArray()).flatMap(id => {
      const message = this.messageItems.get(id)
      return message === undefined ? [] : [readStructuredMapValue(message)]
    })
  }

  setText(value: string): void {
    if (this.#destroyed) return
    if (value === this.text.toString() && this.syncMeta.get('markdownMirrorVersion') === 1) return
    this.doc.transact(() => {
      this.text.delete(0, this.text.length)
      this.text.insert(0, value)
      this.syncMeta.set('markdownMirrorVersion', 1)
    })
  }

  /**
   * Records a whole-file edit made outside Tiptap. The Markdown mirror can be
   * updated headlessly, while the ProseMirror XmlFragment must be replaced by
   * Tiptap the next time this device opens the note. Keep this marker local to
   * the importing device so two peers never perform the same whole-document
   * replacement concurrently.
   */
  importText(value: string): boolean {
    if (this.#destroyed) return false
    if (value === this.text.toString() && this.hasMarkdownMirror()) return false
    this.setText(value)
    writeRecoveryState(`${this.#recoveryStorageKey}:markdown-import`, 'pending-v1')
    return true
  }

  getText(): string {
    return this.text.toString()
  }

  hasPendingMarkdownImport(): boolean {
    return readRecoveryState(`${this.#recoveryStorageKey}:markdown-import`) === 'pending-v1'
  }

  completeMarkdownImport(): void {
    removeRecoveryState(`${this.#recoveryStorageKey}:markdown-import`)
  }

  hasMarkdownMirror(): boolean {
    return this.syncMeta.get('markdownMirrorVersion') === 1
  }

  async updateEntity(entity: SyncV2Entity): Promise<void> {
    this.#entity = entity
    await this.#ensureObjectCommand()
  }

  matchesMarkdownPath(workspaceId: string, relativePath: string): boolean {
    return this.#kind === 'note' && this.#workspaceId === workspaceId
      && this.#entity.localKey === relativePath
  }

  async flushPendingUpdates(): Promise<void> {
    await this.#sendQueue
  }

  setFields(fields: Record<string, unknown>, options: { preserveUnknown?: boolean } = {}): void {
    if (this.#destroyed) return
    this.doc.transact(() => {
      if (!options.preserveUnknown) {
        for (const key of Array.from(this.fields.keys())) if (!(key in fields)) this.fields.delete(key)
      }
      for (const [key, value] of Object.entries(fields)) {
        if (JSON.stringify(this.fields.get(key)) !== JSON.stringify(value)) this.fields.set(key, structuredClone(value))
      }
    })
  }

  setCanvasGraph(nodes: Array<{ id: string }>, edges: Array<{ id: string }>): void {
    if (this.#destroyed) return
    this.doc.transact(() => {
      const nodeIds = new Set(nodes.map(node => node.id))
      const edgeIds = new Set(edges.map(edge => edge.id))
      for (const id of this.canvasNodes.keys()) if (!nodeIds.has(id)) this.canvasNodes.delete(id)
      for (const id of this.canvasEdges.keys()) if (!edgeIds.has(id)) this.canvasEdges.delete(id)
      for (const node of nodes) {
        syncStructuredMapValue(this.canvasNodes, node.id, node)
      }
      for (const edge of edges) {
        syncStructuredMapValue(this.canvasEdges, edge.id, edge)
      }
      replaceYArray(this.canvasNodeOrder, nodes.map(node => node.id))
      replaceYArray(this.canvasEdgeOrder, edges.map(edge => edge.id))
    })
  }

  getCanvasGraph(): { nodes: unknown[], edges: unknown[] } {
    return {
      nodes: this.canvasNodeOrder.toArray().flatMap(id => {
        const node = this.canvasNodes.get(id)
        return node === undefined ? [] : [readStructuredMapValue(node)]
      }),
      edges: this.canvasEdgeOrder.toArray().flatMap(id => {
        const edge = this.canvasEdges.get(id)
        return edge === undefined ? [] : [readStructuredMapValue(edge)]
      }),
    }
  }

  getFields(): Record<string, unknown> {
    return Object.fromEntries([...this.fields.entries()].map(([key, value]) => [key, structuredClone(value)]))
  }

  #migrateLegacyMessages(): void {
    if (this.messageItems.size > 0 || this.messages.length === 0) return
    const legacy = deduplicateMessages(this.messages.toArray())
    this.doc.transact(() => {
      for (let index = 0; index < legacy.length; index += 1) {
        const id = getStableMessageId(legacy[index], index)
        syncStructuredMapValue(this.messageItems, id, legacy[index])
        this.messageOrder.push([id])
      }
      this.messages.delete(0, this.messages.length)
    }, this.#remoteOrigin)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    if (this.#hasLocalAwareness) publishNoteGenServerPresence(null)
    this.#hasLocalAwareness = false
    this.#unsubscribeUpdates?.()
    this.#unsubscribeUpdates = null
    this.#unsubscribeRealtimeUpdates?.()
    this.#unsubscribeRealtimeUpdates = null
    this.#unsubscribeRealtimeSyncRequests?.()
    this.#unsubscribeRealtimeSyncRequests = null
    this.#releaseRealtimeDocument?.()
    this.#releaseRealtimeDocument = null
    this.#unsubscribeAwareness?.()
    this.#unsubscribeAwareness = null
    this.#listeners.clear()
    this.#fieldListeners.clear()
    this.#messageListeners.clear()
    this.#canvasListeners.clear()
    this.#awarenessListeners.clear()
    this.#realtimePeers.clear()
    if (sessions.get(this.#key) === this) sessions.delete(this.#key)
    if (jsonSessions.get(this.#key) === this) jsonSessions.delete(this.#key)
    for (const [key, doc] of markdownDocs) {
      if (doc === this.doc) markdownDocs.delete(key)
    }
    // Keep the document and IndexedDB provider alive until every update that
    // was captured before close has reached the durable local command queue.
    // This also gives y-indexeddb time to persist a final delete/edit before
    // the same file is reopened.
    void this.#sendQueue.finally(() => {
      this.#persistence.destroy()
      this.doc.destroy()
    })
  }

  async #ensureObjectCommand(): Promise<void> {
    let lifecycleType: string | undefined
    let lifecycleLocalKey: string | undefined
    try {
      const lifecycle = this.#entity.basePayloadJson
        ? JSON.parse(this.#entity.basePayloadJson) as { type?: string, localKey?: string }
        : null
      lifecycleType = lifecycle?.type
      lifecycleLocalKey = lifecycle?.localKey
    } catch {
      lifecycleType = undefined
      lifecycleLocalKey = undefined
    }
    if (this.#entity.lifecycleRevision !== '0' && lifecycleType === 'crdt-object'
      && lifecycleLocalKey === this.#entity.localKey) return
    const context = getNoteGenServerBackgroundV2Context()
    if (!context || !this.#entity.documentId) throw new Error('同步工作区尚未解锁')
    const payload = {
      schemaVersion: 2, type: 'crdt-object', localKey: this.#entity.localKey,
      documentId: this.#entity.documentId,
    }
    const encrypted = await encryptSyncV2Payload(context.workspaceKey, payload, {
      workspaceId: this.#workspaceId, objectId: this.#entity.objectId, kind: this.#kind,
      keyVersion: context.keyVersion, purpose: 'object', identity: this.#entity.objectId,
    })
    const name = this.#entity.localKey.split('/').filter(Boolean).at(-1) ?? this.#entity.localKey
    const nameConflictId = crypto.randomUUID()
    const nameConflict = await encryptSyncV2Payload(context.workspaceKey, {
      schemaVersion: 2, type: 'same-name', objectId: this.#entity.objectId,
      parentObjectId: this.#entity.parentObjectId, path: this.#entity.localKey, name,
    }, {
      workspaceId: this.#workspaceId, objectId: this.#entity.objectId, kind: this.#kind,
      keyVersion: context.keyVersion, purpose: 'conflict', identity: nameConflictId,
    })
    await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
      type: 'upsert-object', commandId: crypto.randomUUID(), objectId: this.#entity.objectId,
      kind: this.#kind, parentObjectId: this.#entity.parentObjectId,
      nameCiphertext: encrypted.ciphertext,
      baseRevision: this.#entity.lifecycleRevision === '0' ? null : this.#entity.lifecycleRevision,
      blobRefs: [],
      ...(['note', 'folder'].includes(this.#kind) ? {
        nameBlindIndex: await createSyncV2NameBlindIndex({
          key: getSyncV2StableBlindIndexKey(context.workspaceKeys, context.workspaceKey),
          workspaceId: this.#workspaceId,
          parentObjectId: this.#entity.parentObjectId, name,
        }),
        nameBlindIndexKeyVersion: getSyncV2StableBlindIndexKeyVersion(context.workspaceKeys),
        nameConflictId,
        nameConflictCiphertext: nameConflict.ciphertext,
        nameConflictCiphertextHash: nameConflict.ciphertextHash,
      } : {}),
      keyVersion: context.keyVersion, ...encrypted,
    } })
  }

  async #loadRemoteDocument(): Promise<void> {
    const context = getNoteGenServerBackgroundV2Context()
    const connection = getNoteGenServerBackgroundConnection()
    if (!context || !connection || !this.#entity.documentId) return
    const document = await getLocalSyncV2Document(context.syncScopeId, this.#entity.documentId)
    let after = document?.checkpointDocumentSequence ?? '0'
    if (document?.checkpointCiphertext && document.checkpointId && document.checkpointKeyVersion) {
      const key = context.workspaceKeys.get(document.checkpointKeyVersion)
      if (!key) throw new Error(`缺少 Workspace Key v${document.checkpointKeyVersion}`)
      const checkpoint = await decryptSyncV2Payload<Uint8Array>(key, document.checkpointCiphertext, {
        workspaceId: context.workspaceId, objectId: this.#entity.objectId, kind: this.#kind,
        keyVersion: document.checkpointKeyVersion, purpose: 'checkpoint', identity: document.checkpointId,
      }, true)
      Y.applyUpdate(this.doc, checkpoint, this.#remoteOrigin)
    }
    while (true) {
      const page = await pullSyncV2DocumentUpdates({
        baseUrl: connection.profile.baseUrl, accessToken: connection.session.accessToken,
        workspaceId: context.workspaceId, documentId: this.#entity.documentId, after,
      })
      for (const item of page.updates) {
        const key = context.workspaceKeys.get(item.keyVersion)
        if (!key) throw new Error(`缺少 Workspace Key v${item.keyVersion}`)
        const update = await decryptSyncV2Payload<Uint8Array>(key, item.ciphertext, {
          workspaceId: context.workspaceId, objectId: this.#entity.objectId, kind: this.#kind,
          keyVersion: item.keyVersion, purpose: 'update', identity: item.updateId,
        }, true)
        Y.applyUpdate(this.doc, update, this.#remoteOrigin)
      }
      after = page.nextDocumentSequence
      if (!page.hasMore) break
    }
  }

  #queueUpdate(update: Uint8Array, options: {
    generation?: number
  } = {}): void {
    this.#sendQueue = this.#sendQueue.then(async () => {
      // An editor may close immediately after producing this update. The
      // update bytes are already captured, so destroying the in-memory Y.Doc
      // must not discard durable work that is waiting for encryption/queueing.
      if (!this.#entity.documentId) return
      const context = getNoteGenServerBackgroundV2Context()
      if (!context || context.workspaceId !== this.#workspaceId) return
      const updateId = crypto.randomUUID()
      const encrypted = await encryptSyncV2Payload(context.workspaceKey, update, {
        workspaceId: this.#workspaceId, objectId: this.#entity.objectId, kind: this.#kind,
        keyVersion: context.keyVersion, purpose: 'update', identity: updateId,
      })
      await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
        type: 'append-update', commandId: crypto.randomUUID(), updateId,
        documentId: this.#entity.documentId, objectId: this.#entity.objectId,
        kind: this.#kind, keyVersion: context.keyVersion, ...encrypted,
      } })
      publishNoteGenServerDocumentUpdate({
        workspaceId: this.#workspaceId,
        documentId: this.#entity.documentId,
        objectId: this.#entity.objectId,
        kind: this.#kind,
        updateId,
        keyVersion: context.keyVersion,
        ...encrypted,
      })
      if ((options.generation ?? this.#localUpdateGeneration) === this.#localUpdateGeneration) {
        writeRecoveryState(this.#recoveryStorageKey, 'clean-v1')
      }
      this.#updatesSinceCheckpoint += 1
      if (this.#updatesSinceCheckpoint >= 100) {
        await this.#queueCheckpoint(context)
        this.#updatesSinceCheckpoint = 0
      }
      void triggerNoteGenServerBackgroundSync()
    }).catch(() => undefined)
  }

  #broadcastRealtimeState(): void {
    if (this.#destroyed || !this.#entity.documentId) return
    const stateUpdate = Y.encodeStateAsUpdate(this.doc)
    void (async () => {
      const context = getNoteGenServerBackgroundV2Context()
      if (!context || context.workspaceId !== this.#workspaceId || !this.#entity.documentId) return
      const updateId = crypto.randomUUID()
      const encrypted = await encryptSyncV2Payload(context.workspaceKey, stateUpdate, {
        workspaceId: this.#workspaceId,
        objectId: this.#entity.objectId,
        kind: this.#kind,
        keyVersion: context.keyVersion,
        purpose: 'update',
        identity: updateId,
      })
      publishNoteGenServerDocumentUpdate({
        workspaceId: this.#workspaceId,
        documentId: this.#entity.documentId,
        objectId: this.#entity.objectId,
        kind: this.#kind,
        updateId,
        keyVersion: context.keyVersion,
        ...encrypted,
      })
    })().catch(() => {
      // Durable synchronization remains authoritative when the room is gone.
    })
  }

  async #queueCheckpoint(context: NonNullable<ReturnType<typeof getNoteGenServerBackgroundV2Context>>): Promise<void> {
    if (!this.#entity.documentId) return
    const current = await getLocalSyncV2Document(context.syncScopeId, this.#entity.documentId)
    const covers = current?.latestDocumentSequence ?? '0'
    if (covers === '0' || covers === current?.checkpointDocumentSequence) return
    const checkpointId = crypto.randomUUID()
    const encrypted = await encryptSyncV2Payload(context.workspaceKey, Y.encodeStateAsUpdate(this.doc), {
      workspaceId: this.#workspaceId, objectId: this.#entity.objectId, kind: this.#kind,
      keyVersion: context.keyVersion, purpose: 'checkpoint', identity: checkpointId,
    })
    await enqueueSyncV2Command({ scopeId: context.syncScopeId, command: {
      type: 'commit-checkpoint', commandId: crypto.randomUUID(), checkpointId,
      documentId: this.#entity.documentId, objectId: this.#entity.objectId, kind: this.#kind,
      coversDocumentSequence: covers,
      materializedRevision: this.#entity.lifecycleRevision === '0' ? null : this.#entity.lifecycleRevision,
      keyVersion: context.keyVersion, ...encrypted,
    } })
  }
}

function replaceYArray(target: Y.Array<string>, next: string[]): void {
  const current = target.toArray()
  if (current.length === next.length && current.every((value, index) => value === next[index])) return
  target.delete(0, target.length)
  target.insert(0, next)
}

function syncStructuredMapValue(container: Y.Map<unknown>, id: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (JSON.stringify(readStructuredMapValue(container.get(id))) !== JSON.stringify(value)) {
      container.set(id, structuredClone(value))
    }
    return
  }
  let target = container.get(id)
  if (!(target instanceof Y.Map)) {
    target = new Y.Map<unknown>()
    container.set(id, target)
  }
  const fields = target as Y.Map<unknown>
  const source = value as Record<string, unknown>
  for (const key of Array.from(fields.keys())) {
    if (!(key in source) || source[key] === undefined) fields.delete(key)
  }
  for (const [key, item] of Object.entries(source)) {
    if (item === undefined) continue
    if (JSON.stringify(fields.get(key)) !== JSON.stringify(item)) {
      fields.set(key, structuredClone(item))
    }
  }
}

function readStructuredMapValue(value: unknown): unknown {
  if (!(value instanceof Y.Map)) return structuredClone(value)
  return Object.fromEntries(
    Array.from(value.entries(), ([key, item]) => [key, structuredClone(item)]),
  )
}

function readStructuredSnapshot(doc: Y.Doc): NoteGenServerStructuredFieldsSnapshot {
  const fields = doc.getMap<unknown>('fields')
  const legacyMessages = doc.getArray<unknown>('messages')
  const messageItems = doc.getMap<unknown>('message-items')
  const messageOrder = doc.getArray<string>('message-order')
  const canvasNodes = doc.getMap<unknown>('canvas-nodes')
  const canvasEdges = doc.getMap<unknown>('canvas-edges')
  const canvasNodeOrder = doc.getArray<string>('canvas-node-order')
  const canvasEdgeOrder = doc.getArray<string>('canvas-edge-order')
  const messages = messageItems.size === 0 && messageOrder.length === 0
    ? deduplicateMessages(legacyMessages.toArray())
    : uniqueStrings(messageOrder.toArray()).flatMap(id => {
      const message = messageItems.get(id)
      return message === undefined ? [] : [readStructuredMapValue(message)]
    })
  return {
    fields: Object.fromEntries(
      Array.from(fields.entries(), ([key, value]) => [key, structuredClone(value)]),
    ),
    messages,
    canvas: {
      nodes: canvasNodeOrder.toArray().flatMap(id => {
        const node = canvasNodes.get(id)
        return node === undefined ? [] : [readStructuredMapValue(node)]
      }),
      edges: canvasEdgeOrder.toArray().flatMap(id => {
        const edge = canvasEdges.get(id)
        return edge === undefined ? [] : [readStructuredMapValue(edge)]
      }),
    },
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function deduplicateMessages(messages: unknown[]): unknown[] {
  const unique = new Map<string, unknown>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    unique.set(getStableMessageId(message, index), message)
  }
  return Array.from(unique.values(), item => structuredClone(item))
}

function getStableMessageId(message: unknown, index: number): string {
  if (message && typeof message === 'object') {
    const value = message as Record<string, unknown>
    if (typeof value.syncId === 'string' && value.syncId.length > 0) return value.syncId
    if (typeof value.id === 'string' || typeof value.id === 'number') return `legacy-id:${value.id}`
  }
  const serialized = JSON.stringify(message) ?? String(message)
  let hash = 2_166_136_261
  for (let offset = 0; offset < serialized.length; offset += 1) {
    hash ^= serialized.charCodeAt(offset)
    hash = Math.imul(hash, 16_777_619)
  }
  return `legacy-value:${(hash >>> 0).toString(16)}:${index}`
}

function readRecoveryState(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeRecoveryState(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // IndexedDB still keeps the Yjs state. If localStorage is unavailable,
    // startup falls back to sending the complete state for recovery.
  }
}

function removeRecoveryState(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // The imported Markdown still remains in the local file and Y.Text mirror.
  }
}

function kindForDocument(documentId: string): SyncV2ObjectKind {
  const value = documentId.startsWith('structured:') ? documentId.slice('structured:'.length) : documentId
  if (value.startsWith('conversation:')) return 'conversation'
  if (value.startsWith('canvas:')) return 'canvas'
  if (value.startsWith('memory:')) return 'memory'
  if (value.startsWith('setting:') || value === 'workspace-preferences' || value === 'settings') return 'setting'
  if (value.startsWith('tag:')) return 'tag'
  return 'mark'
}

function localKeyForDocument(documentId: string, kind: SyncV2ObjectKind): string {
  const value = documentId.startsWith('structured:') ? documentId.slice('structured:'.length) : documentId
  if (value === 'workspace-preferences' || value === 'settings') return 'workspace-preferences'
  if (value.startsWith('record:')) return `mark:${value.slice('record:'.length)}`
  if (value.startsWith(`${kind}:`)) return value
  return `${kind}:${value}`
}
