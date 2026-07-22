'use client'

import { memo } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import { CheckSquare2, ExternalLink, FileText, ImageIcon, Square } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { BaseNode, BaseNodeContent } from '@/components/base-node'
import emitter from '@/lib/emitter'
import type { CanvasNodeData, CanvasNodeType } from '@/types/canvas'
import useArticleStore from '@/stores/article'
import { useSidebarStore } from '@/stores/sidebar'
import { cn } from '@/lib/utils'
import { ImageViewer } from '@/components/image-viewer'

export type FlowCanvasNode = Node<CanvasNodeData, CanvasNodeType>

const ConnectionHandles = memo(function ConnectionHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="source" position={Position.Right} id="right" />
    </>
  )
})

function previewClassName(state?: CanvasNodeData['previewState']) {
  return cn(
    state === 'add' && 'border-primary bg-primary/5 ring-2 ring-primary/40',
    state === 'update' && 'border-primary ring-2 ring-primary/30',
    state === 'delete' && 'border-destructive bg-destructive/5 opacity-60 ring-2 ring-destructive/40'
  )
}

const EditableLabel = memo(function EditableLabel({ id, value, className }: { id: string; value: string; className?: string }) {
  const { updateNodeData } = useReactFlow<FlowCanvasNode>()
  return (
    <input
      className={`nodrag w-full bg-transparent text-center outline-none ${className || ''}`}
      value={value}
      onFocus={() => emitter.emit('canvas-history-checkpoint')}
      onChange={event => updateNodeData(id, { label: event.target.value })}
      onPointerDown={event => event.stopPropagation()}
      aria-label="Node label"
    />
  )
})

export const ProcessNode = memo(function ProcessNode({ id, data }: NodeProps<FlowCanvasNode>) {
  return (
    <BaseNode className={cn('min-w-40 max-w-72 shadow-sm', previewClassName(data.previewState))}>
      <ConnectionHandles />
      <BaseNodeContent className="items-center text-center text-sm">
        <EditableLabel id={id} value={data.label || '处理步骤'} />
      </BaseNodeContent>
    </BaseNode>
  )
})

export const DecisionNode = memo(function DecisionNode({ id, data }: NodeProps<FlowCanvasNode>) {
  return (
    <div className={cn('relative flex size-36 rotate-45 items-center justify-center border bg-card text-card-foreground shadow-sm in-[.selected]:shadow-lg', previewClassName(data.previewState))}>
      <ConnectionHandles />
      <EditableLabel id={id} value={data.label || '判断条件'} className="max-w-24 -rotate-45 text-sm" />
    </div>
  )
})

export const TerminatorNode = memo(function TerminatorNode({ id, data }: NodeProps<FlowCanvasNode>) {
  return (
    <div className={cn('relative flex min-h-14 min-w-40 items-center justify-center rounded-full border bg-card px-6 text-card-foreground shadow-sm in-[.selected]:shadow-lg', previewClassName(data.previewState))}>
      <ConnectionHandles />
      <EditableLabel id={id} value={data.label || '开始 / 结束'} className="text-sm" />
    </div>
  )
})

export const TextCanvasNode = memo(function TextCanvasNode({ id, data }: NodeProps<FlowCanvasNode>) {
  return (
    <div className={cn('min-w-24 rounded-md px-2 py-1 text-sm text-foreground in-[.selected]:ring-1 in-[.selected]:ring-ring', previewClassName(data.previewState))}>
      <EditableLabel id={id} value={data.label || '文本'} />
    </div>
  )
})

export const NoteCanvasNode = memo(function NoteCanvasNode({ data }: NodeProps<FlowCanvasNode>) {
  const filePath = data.filePath || ''
  const openNote = async () => {
    if (!filePath) return
    await useSidebarStore.getState().setLeftSidebarTab('files')
    await useArticleStore.getState().setActiveFilePath(filePath)
  }

  return (
    <BaseNode
      className={cn('min-w-52 max-w-72 shadow-sm', previewClassName(data.previewState))}
      onDoubleClick={() => void openNote()}
    >
      <ConnectionHandles />
      <BaseNodeContent className="gap-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{data.label || filePath.split('/').pop() || '笔记'}</span>
        </span>
        <span className="truncate text-xs text-muted-foreground">{filePath}</span>
      </BaseNodeContent>
    </BaseNode>
  )
})

export const LinkCanvasNode = memo(function LinkCanvasNode({ id, data }: NodeProps<FlowCanvasNode>) {
  return (
    <BaseNode
      className={cn('min-w-52 max-w-80 shadow-sm', previewClassName(data.previewState))}
      onDoubleClick={() => data.url && void openUrl(data.url)}
    >
      <ConnectionHandles />
      <BaseNodeContent className="gap-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          <ExternalLink className="shrink-0 text-muted-foreground" />
          <EditableLabel id={id} value={data.label || '网页链接'} className="text-left" />
        </span>
        <span className="truncate text-xs text-muted-foreground">{data.url}</span>
      </BaseNodeContent>
    </BaseNode>
  )
})

export const TodoCanvasNode = memo(function TodoCanvasNode({ id, data }: NodeProps<FlowCanvasNode>) {
  const { updateNodeData } = useReactFlow<FlowCanvasNode>()
  return (
    <BaseNode className={cn('min-w-52 max-w-80 shadow-sm', previewClassName(data.previewState))}>
      <ConnectionHandles />
      <BaseNodeContent className="flex-row items-center gap-2">
        <button
          type="button"
          className="nodrag text-muted-foreground"
          onClick={() => updateNodeData(id, { checked: !data.checked })}
          aria-label={data.checked ? 'Mark incomplete' : 'Mark complete'}
        >
          {data.checked ? <CheckSquare2 /> : <Square />}
        </button>
        <EditableLabel
          id={id}
          value={data.label || '待办事项'}
          className={cn('text-left', data.checked && 'text-muted-foreground line-through')}
        />
      </BaseNodeContent>
    </BaseNode>
  )
})

export const ImageCanvasNode = memo(function ImageCanvasNode({ id, data }: NodeProps<FlowCanvasNode>) {
  return (
    <BaseNode className={cn('w-64 overflow-hidden shadow-sm', previewClassName(data.previewState))}>
      <ConnectionHandles />
      {data.imagePath ? (
        <ImageViewer path={data.imagePath} imageClassName="h-36 w-full rounded-t-lg object-cover" />
      ) : (
        <div className="flex h-36 items-center justify-center bg-muted text-muted-foreground"><ImageIcon /></div>
      )}
      <BaseNodeContent className="py-2">
        <EditableLabel id={id} value={data.label || '图片'} />
      </BaseNodeContent>
    </BaseNode>
  )
})

export const GroupCanvasNode = memo(function GroupCanvasNode({ id, data, selected }: NodeProps<FlowCanvasNode>) {
  return (
    <div className={cn('relative size-full rounded-2xl border border-dashed bg-muted/30', previewClassName(data.previewState))}>
      <NodeResizer
        isVisible={selected}
        minWidth={240}
        minHeight={160}
        onResizeStart={() => emitter.emit('canvas-history-checkpoint')}
      />
      <div className="absolute left-3 top-2 max-w-[calc(100%-1.5rem)] text-sm font-medium text-muted-foreground">
        <EditableLabel id={id} value={data.label || '分组'} className="text-left" />
      </div>
    </div>
  )
})

export const FreehandNode = memo(function FreehandNode({ data, selected }: NodeProps<FlowCanvasNode>) {
  const width = data.width || 4
  const height = data.height || 4

  return (
    <div className="relative size-full">
      <NodeResizer
        isVisible={selected}
        minWidth={4}
        minHeight={4}
        onResizeStart={() => emitter.emit('canvas-history-checkpoint')}
      />
      <svg className="size-full overflow-visible" viewBox={`0 0 ${width} ${height}`}>
        <path
          d={data.path || ''}
          fill={data.color || 'currentColor'}
          fillOpacity={data.opacity ?? 1}
        />
      </svg>
    </div>
  )
})
