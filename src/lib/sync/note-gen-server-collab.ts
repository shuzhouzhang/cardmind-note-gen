'use client'

import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import {
  decryptNoteGenServerCollaborationUpdate,
  encryptNoteGenServerCollaborationUpdate,
  createDeterministicNoteObjectId,
} from './note-gen-server'
import {
  getNoteGenServerBackgroundConnection,
  getNoteGenServerBackgroundWorkspaceKey,
  subscribeNoteGenServerSession,
} from './note-gen-server-background'
import { normalizeWorkspaceRelativePath } from '@/lib/workspace'

interface CollaborationReadyMessage {
  type: 'ready'
  updates: Array<{ id: string, update: string }>
}

interface CollaborationUpdateMessage {
  type: 'update'
  id: string
  update: string
}

interface CollaborationAwarenessMessage {
  type: 'awareness'
  clientId: string
  state: string
}

type CollaborationMessage = CollaborationReadyMessage | CollaborationUpdateMessage | CollaborationAwarenessMessage
type TextListener = (value: string) => void
type FieldsListener = (value: Record<string, unknown>) => void
type MessagesListener = (value: unknown[]) => void
type AwarenessListener = (clientId: string, state: string) => void

const sessions = new Map<string, NoteGenServerTextSession>()
const jsonSessions = new Map<string, NoteGenServerTextSession>()

export async function getNoteGenServerTextSession(input: {
  workspaceId: string
  relativePath: string
  initialContent: string
  doc?: Y.Doc
}): Promise<NoteGenServerTextSession | null> {
  const connection = getNoteGenServerBackgroundConnection()
  if (!connection || connection.profile.workspaceId !== input.workspaceId) return null
  const normalizedPath = await normalizeWorkspaceRelativePath(input.relativePath)
  const objectId = await createDeterministicNoteObjectId(input.workspaceId, normalizedPath)
  const key = `${input.workspaceId}:note:${objectId}`
  const existing = sessions.get(key)
  if (existing) return existing
  const session = new NoteGenServerTextSession({
    key,
    baseUrl: connection.profile.baseUrl,
    accessToken: connection.session.accessToken,
    workspaceId: input.workspaceId,
    documentId: `note:${objectId}`,
    initialContent: input.initialContent,
    ...(input.doc ? { doc: input.doc } : {}),
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

export async function getNoteGenServerJsonSession(input: {
  workspaceId: string
  documentId: string
  initialValue: unknown
  initialFields?: Record<string, unknown>
}): Promise<NoteGenServerTextSession | null> {
  const connection = getNoteGenServerBackgroundConnection()
  if (!connection || connection.profile.workspaceId !== input.workspaceId) return null
  const key = `${input.workspaceId}:${input.documentId}`
  const existing = jsonSessions.get(key)
  if (existing) return existing
  const session = new NoteGenServerTextSession({
    key,
    baseUrl: connection.profile.baseUrl,
    accessToken: connection.session.accessToken,
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    initialContent: '',
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

/**
 * A field-level CRDT session for records and conversation metadata. Each
 * top-level field is an independent Y.Map entry, so changing a tag does not
 * overwrite an edited body on another device.
 */
export async function getNoteGenServerStructuredSession(input: {
  workspaceId: string
  documentId: string
  initialFields: Record<string, unknown>
}): Promise<NoteGenServerTextSession | null> {
  const session = await getNoteGenServerJsonSession({
    workspaceId: input.workspaceId,
    documentId: `structured:${input.documentId}`,
    initialValue: input.initialFields,
    initialFields: input.initialFields,
  })
  return session
}

export async function getNoteGenServerConversationSession(input: {
  workspaceId: string
  conversationSyncId: string
  initialMessages: unknown[]
}): Promise<NoteGenServerTextSession | null> {
  const session = await getNoteGenServerJsonSession({
    workspaceId: input.workspaceId,
    documentId: `conversation:${input.conversationSyncId}`,
    initialValue: null,
  })
  if (!session) return null
  if (session.messages.length === 0) session.setMessages(input.initialMessages)
  return session
}

export class NoteGenServerTextSession {
  readonly doc: Y.Doc
  readonly text: Y.Text
  readonly fields: Y.Map<unknown>
  readonly messages: Y.Array<unknown>
  readonly #persistence: IndexeddbPersistence
  readonly #listeners = new Set<TextListener>()
  readonly #fieldListeners = new Set<FieldsListener>()
  readonly #messageListeners = new Set<MessagesListener>()
  readonly #awarenessListeners = new Set<AwarenessListener>()
  readonly #remoteOrigin = {}
  readonly #key: string
  readonly #baseUrl: string
  #accessToken: string
  readonly #workspaceId: string
  readonly #documentId: string
  #socket: WebSocket | null = null
  #started = false
  #ready = false
  #destroyed = false
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectDelay = 1_000
  #unsubscribeSession: (() => void) | null = null
  #sendQueue = Promise.resolve()

  constructor(input: {
    key: string
    baseUrl: string
    accessToken: string
    workspaceId: string
    documentId: string
    initialContent: string
    doc?: Y.Doc
  }) {
    this.doc = input.doc ?? new Y.Doc()
    this.text = this.doc.getText('markdown')
    this.fields = this.doc.getMap<unknown>('fields')
    this.messages = this.doc.getArray<unknown>('messages')
    this.#key = input.key
    this.#baseUrl = input.baseUrl
    this.#accessToken = input.accessToken
    this.#workspaceId = input.workspaceId
    this.#documentId = input.documentId
    this.#persistence = new IndexeddbPersistence(`note-gen-server:${this.#key}`, this.doc)
    this.text.observe(() => {
      const value = this.text.toString()
      for (const listener of this.#listeners) listener(value)
    })
    this.fields.observe(() => {
      const value = this.getFields()
      for (const listener of this.#fieldListeners) listener(value)
    })
    this.messages.observe(() => {
      const value = this.messages.toArray().map(item => structuredClone(item))
      for (const listener of this.#messageListeners) listener(value)
    })
    this.doc.on('update', (update, origin) => {
      if (origin === this.#remoteOrigin || !this.#ready || this.#destroyed) return
      this.#sendUpdate(update)
    })
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    await this.#persistence.whenSynced
    this.#unsubscribeSession = subscribeNoteGenServerSession(session => {
      if (session?.accessToken && session.accessToken !== this.#accessToken) {
        this.updateAccessToken(session.accessToken)
      }
    })
    this.#connect()
  }

  updateAccessToken(accessToken: string): void {
    if (this.#destroyed || accessToken === this.#accessToken) return
    this.#accessToken = accessToken
    this.#ready = false
    this.#socket?.close()
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
    listener(this.messages.toArray().map(item => structuredClone(item)))
    return () => this.#messageListeners.delete(listener)
  }

  subscribeAwareness(listener: AwarenessListener): () => void {
    this.#awarenessListeners.add(listener)
    return () => this.#awarenessListeners.delete(listener)
  }

  setAwareness(state: unknown): void {
    if (this.#destroyed || this.#socket?.readyState !== WebSocket.OPEN) return
    this.#socket.send(JSON.stringify({ type: 'awareness', state: JSON.stringify(state) }))
  }

  setMessages(messages: unknown[]): void {
    if (this.#destroyed) return
    this.doc.transact(() => {
      this.messages.delete(0, this.messages.length)
      this.messages.insert(0, messages.map(message => structuredClone(message)))
    })
  }

  setText(value: string): void {
    if (this.#destroyed || value === this.text.toString()) return
    this.doc.transact(() => {
      this.text.delete(0, this.text.length)
      this.text.insert(0, value)
    })
  }

  setFields(fields: Record<string, unknown>): void {
    if (this.#destroyed) return
    this.doc.transact(() => {
      for (const key of Array.from(this.fields.keys())) {
        if (!(key in fields)) this.fields.delete(key)
      }
      for (const [key, value] of Object.entries(fields)) {
        if (JSON.stringify(this.fields.get(key)) !== JSON.stringify(value)) {
          this.fields.set(key, structuredClone(value))
        }
      }
    })
  }

  getFields(): Record<string, unknown> {
    return Object.fromEntries([...this.fields.entries()].map(([key, value]) => [
      key,
      structuredClone(value),
    ]))
  }

  destroy(): void {
    this.#destroyed = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
    this.#socket?.close()
    this.#socket = null
    this.#unsubscribeSession?.()
    this.#unsubscribeSession = null
    this.#persistence.destroy()
    this.doc.destroy()
    this.#listeners.clear()
    this.#fieldListeners.clear()
    this.#messageListeners.clear()
    this.#awarenessListeners.clear()
    if (sessions.get(this.#key) === this) sessions.delete(this.#key)
    if (jsonSessions.get(this.#key) === this) jsonSessions.delete(this.#key)
  }

  #connect(): void {
    if (this.#destroyed) return
    const url = new URL('/v1/collab', this.#baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.#socket = socket
    socket.addEventListener('open', () => {
      if (this.#destroyed || this.#socket !== socket) return
      socket.send(JSON.stringify({
        type: 'authenticate',
        accessToken: this.#accessToken,
        workspaceId: this.#workspaceId,
        documentId: this.#documentId,
      }))
    })
    socket.addEventListener('message', event => void this.#handleMessage(String(event.data)))
    socket.addEventListener('close', () => {
      if (this.#socket !== socket || this.#destroyed) return
      this.#socket = null
      this.#ready = false
      this.#scheduleReconnect()
    })
    socket.addEventListener('error', () => socket.close())
  }

  async #handleMessage(raw: string): Promise<void> {
    let message: CollaborationMessage
    try {
      message = JSON.parse(raw) as CollaborationMessage
    } catch {
      return
    }
    if (message.type === 'ready') {
      for (const item of message.updates) await this.#applyUpdate(item.update)
      this.#ready = true
      // The editor may have populated the shared ProseMirror fragment before
      // the socket authenticated. Re-send the complete current state so that
      // the first local snapshot is durable even if it was created offline.
      this.#sendUpdate(Y.encodeStateAsUpdate(this.doc), 'checkpoint')
      this.#reconnectDelay = 1_000
      return
    }
    if (message.type === 'update') void this.#applyUpdate(message.update)
    if (message.type === 'awareness') {
      for (const listener of this.#awarenessListeners) listener(message.clientId, message.state)
    }
  }

  async #applyUpdate(encoded: string): Promise<void> {
    try {
      const workspaceKey = getNoteGenServerBackgroundWorkspaceKey()
      if (!workspaceKey) return
      const update = await decryptNoteGenServerCollaborationUpdate(workspaceKey, encoded)
      Y.applyUpdate(this.doc, update, this.#remoteOrigin)
    } catch {
      // A malformed update is ignored; the next reconnect will replay the durable log.
    }
  }

  #sendUpdate(update: Uint8Array, type: 'update' | 'checkpoint' = 'update'): void {
    this.#sendQueue = this.#sendQueue.then(async () => {
      if (this.#socket?.readyState !== WebSocket.OPEN || this.#destroyed) return
      const workspaceKey = getNoteGenServerBackgroundWorkspaceKey()
      if (!workspaceKey) return
      const encrypted = await encryptNoteGenServerCollaborationUpdate(workspaceKey, update)
      if (this.#socket?.readyState !== WebSocket.OPEN || this.#destroyed) return
      this.#socket.send(JSON.stringify({ type, update: encrypted }))
    }).catch(() => undefined)
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer || this.#destroyed) return
    const delay = this.#reconnectDelay
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#connect()
    }, delay)
  }
}
