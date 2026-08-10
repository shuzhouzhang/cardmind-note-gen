'use client'

import type { Editor } from '@tiptap/react'
import { Check, ChevronLeft, ChevronRight, GitMerge, Loader2, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getSyncV2Entity, listSyncV2Conflicts, type SyncV2Conflict } from '@/db/note-gen-server-sync-index'
import emitter from '@/lib/emitter'
import { materializeMerge, mergeMarkdownThreeWay } from '@/lib/sync/markdown-three-way-merge'
import { getNoteGenServerBackgroundV2Context } from '@/lib/sync/note-gen-server-background'
import {
  confirmMarkdownSyncDeletion,
  dismissMarkdownSyncConflicts,
  resolveMarkdownSyncConflict,
} from '@/components/sync-conflict-dialog'

interface MarkdownConflictPayload {
  path: string
  base: string
  local: string
  remote: string | null
  deletionRequestedLocally: boolean
}

export function MarkdownConflictEditor({ filePath, editor }: {
  filePath: string
  editor: Editor | null
}) {
  const [conflict, setConflict] = useState<SyncV2Conflict | null>(null)
  const [relatedConflicts, setRelatedConflicts] = useState<SyncV2Conflict[]>([])
  const [payload, setPayload] = useState<MarkdownConflictPayload | null>(null)
  const [open, setOpen] = useState(false)
  const [blockIndex, setBlockIndex] = useState(0)
  const [resolutions, setResolutions] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const conflictIdRef = useRef<string | null>(null)
  const dismissedConflictIdRef = useRef<string | null>(null)

  const parts = useMemo(() => {
    if (!payload) return []
    let conflictIndex = 0
    if (payload.remote === null) return []
    return mergeMarkdownThreeWay(payload.base, payload.local, payload.remote).map(part => {
      if (part.type === 'merged') return part
      return { ...part, block: { ...part.block, id: `${part.block.startLine}:${conflictIndex++}` } }
    })
  }, [payload])
  const blocks = useMemo(() => parts.flatMap(part => part.type === 'conflict' ? [part.block] : []), [parts])
  const block = blocks[blockIndex]
  const resolvedCount = blocks.filter(item => resolutions[item.id] !== undefined).length
  const finalContent = useMemo(() => materializeMerge(parts, resolutions), [parts, resolutions])

  const loadConflict = useCallback(async (forceOpen = false) => {
    const context = getNoteGenServerBackgroundV2Context()
    if (!context || !filePath) return
    const conflicts = await listSyncV2Conflicts(context.syncScopeId)
    const noteConflicts = conflicts.filter(item => item.kind === 'note')
    const paths = await Promise.all(noteConflicts.map(async item => {
      const payloadPath = conflictPath(item)
      if (payloadPath) return payloadPath
      const entity = await getSyncV2Entity(context.syncScopeId, item.objectId)
      return normalizePath(entity?.localKey ?? '')
    }))
    const matches = noteConflicts
      .filter((item, itemIndex) => paths[itemIndex] === normalizePath(filePath))
      .sort((left, right) => BigInt(left.createdSequence) < BigInt(right.createdSequence) ? -1 : 1)
    const match = matches.at(-1) ?? null
    const parsedPayload = match ? parseMarkdownPayload(match.payloadJson) : null
    const nextPayload = parsedPayload
      ? { ...parsedPayload, path: parsedPayload.path || normalizePath(filePath) }
      : null
    if (!match || !nextPayload) {
      setConflict(null)
      setPayload(null)
      setRelatedConflicts([])
      setOpen(false)
      conflictIdRef.current = null
      return
    }
    if (conflictIdRef.current !== match.conflictId) {
      conflictIdRef.current = match.conflictId
      setBlockIndex(0)
      setResolutions({})
      setError(null)
    }
    setConflict(match)
    setRelatedConflicts(matches)
    setPayload(nextPayload)
    setOpen(forceOpen || dismissedConflictIdRef.current !== match.conflictId)
  }, [filePath])

  useEffect(() => {
    void loadConflict()
    const handleOpen = (event: unknown) => {
      const path = event && typeof event === 'object' && 'path' in event
        ? String((event as { path: unknown }).path) : ''
      if (normalizePath(path) === normalizePath(filePath)) void loadConflict(true)
    }
    const handleChanged = () => void loadConflict()
    emitter.on('sync-markdown-conflict-open', handleOpen)
    emitter.on('note-gen-server-conflict-created', handleChanged)
    emitter.on('note-gen-server-conflict-resolved', handleChanged)
    return () => {
      emitter.off('sync-markdown-conflict-open', handleOpen)
      emitter.off('note-gen-server-conflict-created', handleChanged)
      emitter.off('note-gen-server-conflict-resolved', handleChanged)
    }
  }, [filePath, loadConflict])

  useEffect(() => {
    if (!open || !payload || payload.remote === null || !editor) return
    emitter.emit('editor-agent-diff-preview', {
      filePath,
      originalContent: payload.local,
      modifiedContent: finalContent,
    })
    return () => emitter.emit('editor-agent-diff-clear')
  }, [editor, filePath, finalContent, open, payload])

  const choose = (value: string) => {
    if (!block) return
    setResolutions(current => ({ ...current, [block.id]: value }))
    if (blockIndex < blocks.length - 1) setBlockIndex(index => index + 1)
  }

  const submit = async () => {
    if (!conflict || !payload || !editor || resolvedCount < blocks.length) return
    setSaving(true)
    setError(null)
    try {
      await resolveMarkdownSyncConflict({
        conflict,
        content: finalContent,
        relatedConflicts: relatedConflicts.filter(item => item.conflictId !== conflict.conflictId),
      })
      const context = getNoteGenServerBackgroundV2Context()
      const remaining = context
        ? (await listSyncV2Conflicts(context.syncScopeId)).filter(item => (
            item.objectId === conflict.objectId && relatedConflicts.some(related => related.conflictId === item.conflictId)
          ))
        : []
      if (remaining.length > 0) {
        // Another conflict for this article may already have advanced the object revision.
        // Close the stale records, then persist the reviewed merge as a normal current edit.
        await dismissMarkdownSyncConflicts(remaining)
        editor.commands.setContent(finalContent, { contentType: 'markdown' })
      }
      emitter.emit('editor-agent-diff-clear')
      setOpen(false)
      setConflict(null)
      setPayload(null)
      setRelatedConflicts([])
      setResolutions({})
      conflictIdRef.current = null
      dismissedConflictIdRef.current = null
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const resolveDeletion = async (keepLocal: boolean) => {
    if (!conflict || !payload || payload.remote !== null || !editor) return
    setSaving(true)
    setError(null)
    try {
      const related = relatedConflicts.filter(item => item.conflictId !== conflict.conflictId)
      if (keepLocal) {
        await resolveMarkdownSyncConflict({ conflict, content: payload.local, relatedConflicts: related })
      } else {
        await confirmMarkdownSyncDeletion({ conflict, relatedConflicts: related })
      }
      emitter.emit('editor-agent-diff-clear')
      setOpen(false)
      setConflict(null)
      setPayload(null)
      setRelatedConflicts([])
      setResolutions({})
      conflictIdRef.current = null
      dismissedConflictIdRef.current = null
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (!conflict || !payload) return null

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="mx-3 mt-2 flex w-fit items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs text-muted-foreground shadow-sm hover:bg-muted/40">
        <GitMerge className="size-3.5" />继续处理同步冲突
      </button>
    )
  }

  if (payload.remote === null) {
    return (
      <section className="mx-3 mt-2 flex max-w-[calc(100%_-_1.5rem)] flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 shadow-sm md:w-fit">
        <Trash2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-40 flex-1">
          <div className="text-sm font-medium">文章删除与编辑冲突</div>
          <div className="text-xs text-muted-foreground">
            {payload.deletionRequestedLocally
              ? '此设备删除后，另一台设备又修改了文章。'
              : '另一台设备删除了文章，此设备仍有修改。'}
          </div>
          {error ? <div className="mt-1 text-xs text-destructive">{error}</div> : null}
        </div>
        <Button size="sm" variant="destructive" disabled={saving || conflict.createdSequence === '0'} onClick={() => void resolveDeletion(false)}>
          <Trash2 />确认删除
        </Button>
        <Button size="sm" disabled={saving || conflict.createdSequence === '0'} onClick={() => void resolveDeletion(true)}>
          {saving ? <Loader2 className="animate-spin" /> : <Check />}保留当前文章
        </Button>
      </section>
    )
  }

  if (blocks.length === 0) {
    return (
      <section className="mx-3 mt-2 flex w-fit max-w-[calc(100%_-_1.5rem)] items-center gap-1.5 rounded-full border border-border/60 bg-background py-1 pl-2.5 pr-1 shadow-sm">
        <GitMerge className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs text-muted-foreground">
          正在自动合并来自其他设备的修改
        </span>
        {error ? <span className="max-w-48 truncate text-xs text-destructive" title={error}>{error}</span> : null}
        <Button size="sm" className="h-6 shrink-0 rounded-full px-2 text-xs" disabled={!editor || saving || conflict.createdSequence === '0'} onClick={() => void submit()}>
          {saving ? <Loader2 className="animate-spin" /> : <Check />}
          {conflict.createdSequence === '0' ? '准备中' : '立即完成'}
        </Button>
        <Button size="icon-sm" className="size-6 shrink-0 rounded-full text-muted-foreground" variant="ghost" aria-label="收起冲突处理栏" onClick={() => {
          dismissedConflictIdRef.current = conflict.conflictId
          setOpen(false)
        }}><X /></Button>
      </section>
    )
  }

  return (
    <section className="mx-3 mt-2 rounded-lg border border-border/60 bg-background px-3 py-2 shadow-sm md:max-w-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium"><GitMerge className="size-4 text-muted-foreground" />处理 Markdown 冲突</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            已处理 {resolvedCount}/{blocks.length} 块；正文中的红色与绿色标记会随选择更新。
          </div>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="收起冲突处理栏" onClick={() => {
          dismissedConflictIdRef.current = conflict.conflictId
          setOpen(false)
        }}><X /></Button>
      </div>

      {block ? (
        <div className="mt-2 space-y-2 border-t border-border/50 pt-2">
          <div className="flex items-center justify-between text-xs">
            <span>第 {block.startLine} 行附近 · 冲突 {blockIndex + 1}/{blocks.length}</span>
            <div className="flex gap-1">
              <Button size="icon-sm" variant="ghost" disabled={blockIndex === 0} onClick={() => setBlockIndex(value => value - 1)}><ChevronLeft /></Button>
              <Button size="icon-sm" variant="ghost" disabled={blockIndex === blocks.length - 1} onClick={() => setBlockIndex(value => value + 1)}><ChevronRight /></Button>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <ConflictChoice title="本地" value={block.local} selected={resolutions[block.id] === block.local} onClick={() => choose(block.local)} />
            <ConflictChoice title="远端" value={block.remote} selected={resolutions[block.id] === block.remote} onClick={() => choose(block.remote)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => choose(block.local + block.remote)}>保留两者</Button>
            <span className="self-center text-xs text-muted-foreground">也可以直接修改下面的合并结果</span>
          </div>
          <Textarea aria-label="当前冲突块的合并结果" className="min-h-20 font-mono text-xs"
            value={resolutions[block.id] ?? block.local}
            onChange={event => setResolutions(current => ({ ...current, [block.id]: event.target.value }))} />
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {conflict.createdSequence === '0' ? (
            <p className="text-xs text-muted-foreground">冲突记录正在上传，服务器确认后即可提交合并结果。</p>
          ) : null}
        </div>
        <Button size="sm" disabled={!editor || saving || resolvedCount < blocks.length || conflict.createdSequence === '0'} onClick={() => void submit()}>
          {saving ? <Loader2 className="animate-spin" /> : <Check />}
          提交全部已确认的冲突块
        </Button>
      </div>
    </section>
  )
}

function ConflictChoice({ title, value, selected, onClick }: {
  title: string
  value: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick}
      className={`min-w-0 rounded-md border p-2 text-left ${selected ? 'border-primary bg-primary/5' : 'hover:bg-muted/60'}`}>
      <span className="text-xs font-medium">{title}</span>
      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-xs">{value || '（空内容）'}</pre>
    </button>
  )
}

function parseMarkdownPayload(value: string): MarkdownConflictPayload | null {
  try {
    const payload = JSON.parse(value) as Record<string, unknown>
    return {
      path: String(payload.path ?? payload.relativePath ?? payload.logicalKey ?? ''),
      base: String(payload.base ?? ''),
      local: String(payload.local ?? ''),
      remote: payload.remote === null ? null : String(payload.remote ?? ''),
      deletionRequestedLocally: payload.deletionRequestedLocally === true,
    }
  } catch {
    return null
  }
}

function conflictPath(conflict: SyncV2Conflict): string {
  return normalizePath(parseMarkdownPayload(conflict.payloadJson)?.path ?? '')
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').normalize('NFC')
}
