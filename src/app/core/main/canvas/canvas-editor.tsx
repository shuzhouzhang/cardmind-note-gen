'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import { toPng, toSvg } from 'html-to-image'
import { open, save } from '@tauri-apps/plugin-dialog'
import { mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Bot,
  CheckSquare2,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eraser,
  FileText,
  FolderKanban,
  Hand,
  Highlighter,
  ImagePlus,
  Link2,
  MousePointer2,
  Palette,
  Pencil,
  RectangleHorizontal,
  Redo2,
  Route,
  SquareRoundCorner,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import emitter from '@/lib/emitter'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import useCanvasStore from '@/stores/canvas'
import useArticleStore from '@/stores/article'
import type { CanvasDocument, CanvasNode, CanvasPoint, CanvasTool } from '@/types/canvas'
import { flattenFileTree } from '@/app/core/main/file/file-selection'
import { applyCanvasOperations } from '@/lib/canvas/operations'
import { getFilePathOptions } from '@/lib/workspace'
import {
  createFreehandGeometry,
  getFreehandOutline,
  getSvgPathFromStroke,
  HIGHLIGHTER_STYLE,
  PEN_STYLE,
} from '@/lib/canvas/freehand'
import {
  DecisionNode,
  FreehandNode,
  GroupCanvasNode,
  ImageCanvasNode,
  LinkCanvasNode,
  NoteCanvasNode,
  ProcessNode,
  TerminatorNode,
  TextCanvasNode,
  TodoCanvasNode,
  type FlowCanvasNode,
} from './nodes/canvas-nodes'
import { CanvasFooter } from './canvas-footer'
import { getCanvasVersions, type CanvasVersion } from '@/db/canvases'
import { ScrollArea } from '@/components/ui/scroll-area'

const elk = new ELK()

const nodeTypes: NodeTypes = {
  process: ProcessNode,
  decision: DecisionNode,
  terminator: TerminatorNode,
  text: TextCanvasNode,
  note: NoteCanvasNode,
  image: ImageCanvasNode,
  link: LinkCanvasNode,
  todo: TodoCanvasNode,
  group: GroupCanvasNode,
  freehand: FreehandNode,
}

interface CanvasEditorProps {
  canvasId: string
}

interface CanvasSnapshot {
  nodes: FlowCanvasNode[]
  edges: Edge[]
}

function cloneSnapshot(nodes: FlowCanvasNode[], edges: Edge[]): CanvasSnapshot {
  return structuredClone({ nodes, edges })
}

function serializeNodes(nodes: FlowCanvasNode[]): CanvasNode[] {
  return nodes.map(node => ({
    id: node.id,
    type: node.type || 'process',
    position: node.position,
    data: node.data,
    ...(typeof node.width === 'number' ? { width: node.width } : {}),
    ...(typeof node.height === 'number' ? { height: node.height } : {}),
    ...(node.draggable === false ? { draggable: false } : {}),
    ...(node.connectable === false ? { connectable: false } : {}),
    ...(typeof node.zIndex === 'number' ? { zIndex: node.zIndex } : {}),
  }))
}

function havePersistentNodesChanged(previous: FlowCanvasNode[], current: FlowCanvasNode[]) {
  if (previous.length !== current.length) return true
  return current.some((node, index) => {
    const prior = previous[index]
    return !prior
      || prior.id !== node.id
      || prior.type !== node.type
      || prior.position.x !== node.position.x
      || prior.position.y !== node.position.y
      || (prior.data !== node.data && JSON.stringify(prior.data) !== JSON.stringify(node.data))
      || prior.width !== node.width
      || prior.height !== node.height
      || prior.draggable !== node.draggable
      || prior.connectable !== node.connectable
      || prior.zIndex !== node.zIndex
  })
}

function havePersistentEdgesChanged(previous: Edge[], current: Edge[]) {
  if (previous.length !== current.length) return true
  return current.some((edge, index) => {
    const prior = previous[index]
    return !prior
      || prior.id !== edge.id
      || prior.source !== edge.source
      || prior.target !== edge.target
      || prior.label !== edge.label
      || prior.type !== edge.type
  })
}

function CanvasEditorInner({ canvasId }: CanvasEditorProps) {
  const t = useTranslations('canvas')
  const document = useCanvasStore(state => state.documents[canvasId])
  const updateDocument = useCanvasStore(state => state.updateDocument)
  const saveProject = useCanvasStore(state => state.saveProject)
  const openProject = useCanvasStore(state => state.openProject)
  const projects = useCanvasStore(state => state.projects)
  const fileTree = useArticleStore(state => state.fileTree)
  const loadFileTree = useArticleStore(state => state.loadFileTree)
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<FlowCanvasNode>(
    (document?.nodes || []) as FlowCanvasNode[]
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(document?.edges || [])
  const [tool, setTool] = useState<CanvasTool>('select')
  const [penColor, setPenColor] = useState('#18181b')
  const [penSize, setPenSize] = useState(PEN_STYLE.size)
  const [highlighterColor, setHighlighterColor] = useState('#facc15')
  const [highlighterSize, setHighlighterSize] = useState(HIGHLIGHTER_STYLE.size)
  const [drawingPoints, setDrawingPoints] = useState<CanvasPoint[]>([])
  const [previewPath, setPreviewPath] = useState('')
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [hasClipboard, setHasClipboard] = useState(false)
  const [notePickerOpen, setNotePickerOpen] = useState(false)
  const [agentPreviewOperations, setAgentPreviewOperations] = useState<unknown[] | null>(null)
  const [versionPickerOpen, setVersionPickerOpen] = useState(false)
  const [versions, setVersions] = useState<CanvasVersion[]>([])
  const [isExporting, setIsExporting] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<CanvasSnapshot[]>([])
  const redoRef = useRef<CanvasSnapshot[]>([])
  const drawingFlowPointsRef = useRef<CanvasPoint[]>([])
  const erasingIdsRef = useRef(new Set<string>())
  const clipboardRef = useRef<CanvasSnapshot | null>(null)
  const pasteOffsetRef = useRef(0)
  const resizingRef = useRef(false)
  const groupDragRef = useRef<{
    groupId: string
    start: { x: number; y: number }
    children: Map<string, { x: number; y: number }>
  } | null>(null)
  const persistedNodesRef = useRef(nodes)
  const persistedEdgesRef = useRef(edges)
  const pendingDocumentRef = useRef<CanvasDocument | null>(null)
  const pendingDocumentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastStoreDocumentRef = useRef(document)
  const { screenToFlowPosition, getViewport, getNodesBounds, fitView } = useReactFlow()
  const activeBrushColor = tool === 'highlighter' ? highlighterColor : penColor
  const activeBrushSize = tool === 'highlighter' ? highlighterSize : penSize
  const activeBrushStyle = useMemo(() => ({
    ...(tool === 'highlighter' ? HIGHLIGHTER_STYLE : PEN_STYLE),
    size: activeBrushSize,
  }), [activeBrushSize, tool])
  const selectedNodeCount = nodes.filter(node => node.selected).length
  const selectedEdgeCount = edges.filter(edge => edge.selected).length
  const selectedCount = selectedNodeCount + selectedEdgeCount
  const shortcutModifier = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'
  const availableNotes = useMemo(() => flattenFileTree(fileTree).filter(entry => (
    entry.isFile && /\.(md|markdown|txt)$/i.test(entry.name)
  )), [fileTree])
  const previewSnapshot = useMemo(() => {
    if (!document || !agentPreviewOperations) return null
    const currentDocument: CanvasDocument = {
      ...document,
      nodes: serializeNodes(nodes),
      edges: edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: typeof edge.label === 'string' ? edge.label : undefined,
        type: edge.type,
      })),
    }
    const result = applyCanvasOperations(currentDocument, agentPreviewOperations).document
    const currentNodeMap = new Map(currentDocument.nodes.map(node => [node.id, node]))
    const currentFlowNodeMap = new Map(nodes.map(node => [node.id, node]))
    const resultNodeIds = new Set(result.nodes.map(node => node.id))
    const previewNodes = result.nodes.map(node => {
      const current = currentNodeMap.get(node.id)
      const currentFlowNode = currentFlowNodeMap.get(node.id)
      const changed = current && (
        JSON.stringify(current.position) !== JSON.stringify(node.position)
        || JSON.stringify(current.data) !== JSON.stringify(node.data)
      )
      return {
        ...currentFlowNode,
        ...node,
        ...(!currentFlowNode ? {
          width: node.width || (node.type === 'decision' ? 144 : node.type === 'text' ? 120 : 180),
          height: node.height || (node.type === 'decision' ? 144 : node.type === 'text' ? 40 : 56),
        } : {}),
        data: {
          ...node.data,
          previewState: current ? (changed ? 'update' : undefined) : 'add',
        },
      } as FlowCanvasNode
    })
    for (const node of currentDocument.nodes) {
      if (!resultNodeIds.has(node.id)) {
        const currentFlowNode = currentFlowNodeMap.get(node.id)
        previewNodes.push({
          ...currentFlowNode,
          ...node,
          data: { ...node.data, previewState: 'delete' },
        } as FlowCanvasNode)
      }
    }

    const currentEdgeMap = new Map(currentDocument.edges.map(edge => [edge.id, edge]))
    const currentFlowEdgeMap = new Map(edges.map(edge => [edge.id, edge]))
    const resultEdgeIds = new Set(result.edges.map(edge => edge.id))
    const previewEdges: Edge[] = result.edges.map(edge => ({
      ...currentFlowEdgeMap.get(edge.id),
      ...edge,
      animated: !currentEdgeMap.has(edge.id),
      style: !currentEdgeMap.has(edge.id)
        ? { stroke: 'var(--primary)', strokeWidth: 2, strokeDasharray: '6 4' }
        : undefined,
    }))
    for (const edge of currentDocument.edges) {
      if (!resultEdgeIds.has(edge.id)) {
        previewEdges.push({
          ...currentFlowEdgeMap.get(edge.id),
          ...edge,
          animated: true,
          style: { stroke: 'var(--destructive)', strokeWidth: 2, strokeDasharray: '6 4' },
        })
      }
    }
    return { nodes: previewNodes, edges: previewEdges }
  }, [agentPreviewOperations, document, edges, nodes])
  const displayNodes = previewSnapshot?.nodes || nodes
  const displayEdges = previewSnapshot?.edges || edges

  useEffect(() => {
    if (!document) {
      void openProject(canvasId)
    }
  }, [canvasId, document, openProject])

  useEffect(() => () => {
    if (pendingDocumentTimerRef.current) clearTimeout(pendingDocumentTimerRef.current)
    const pendingDocument = pendingDocumentRef.current
    if (pendingDocument) {
      useCanvasStore.getState().updateDocument(canvasId, pendingDocument)
      pendingDocumentRef.current = null
    }
    void useCanvasStore.getState().saveProject(canvasId)
  }, [canvasId])

  useEffect(() => {
    if (!document || document === lastStoreDocumentRef.current) return
    if (pendingDocumentTimerRef.current) clearTimeout(pendingDocumentTimerRef.current)
    pendingDocumentTimerRef.current = null
    pendingDocumentRef.current = null
    lastStoreDocumentRef.current = document
    const nextNodes = document.nodes as FlowCanvasNode[]
    const nextEdges = document.edges as Edge[]
    persistedNodesRef.current = nextNodes
    persistedEdgesRef.current = nextEdges
    historyRef.current = []
    redoRef.current = []
    setCanUndo(false)
    setCanRedo(false)
    setNodes(nextNodes)
    setEdges(nextEdges)
  }, [document, setEdges, setNodes])

  useEffect(() => {
    const showPreview = ({ operations }: { operations: unknown[] }) => setAgentPreviewOperations(operations)
    const clearPreview = () => setAgentPreviewOperations(null)
    emitter.on('canvas-agent-preview', showPreview)
    emitter.on('canvas-agent-preview-clear', clearPreview)
    return () => {
      emitter.off('canvas-agent-preview', showPreview)
      emitter.off('canvas-agent-preview-clear', clearPreview)
    }
  }, [])

  useEffect(() => {
    if (!agentPreviewOperations) return
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.2, duration: 300 })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [agentPreviewOperations, fitView])

  useEffect(() => {
    if (notePickerOpen && fileTree.length === 0) {
      void loadFileTree({ skipRemoteSync: true })
    }
  }, [fileTree.length, loadFileTree, notePickerOpen])

  useEffect(() => {
    if (!document) return
    if (!havePersistentNodesChanged(persistedNodesRef.current, nodes)
      && !havePersistentEdgesChanged(persistedEdgesRef.current, edges)) return
    persistedNodesRef.current = nodes
    persistedEdgesRef.current = edges
    const nextDocument: CanvasDocument = {
      ...document,
      nodes: serializeNodes(nodes),
      edges: edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: typeof edge.label === 'string' ? edge.label : undefined,
        type: edge.type,
      })),
      viewport: getViewport(),
    }
    pendingDocumentRef.current = nextDocument
    if (pendingDocumentTimerRef.current) clearTimeout(pendingDocumentTimerRef.current)
    pendingDocumentTimerRef.current = setTimeout(() => {
      const pendingDocument = pendingDocumentRef.current
      if (!pendingDocument) return
      pendingDocumentRef.current = null
      pendingDocumentTimerRef.current = null
      lastStoreDocumentRef.current = pendingDocument
      updateDocument(canvasId, pendingDocument)
    }, 180)
  }, [canvasId, document, edges, getViewport, nodes, updateDocument])

  const pushHistory = useCallback(() => {
    const historyLimit = nodes.length > 500 ? 10 : nodes.length > 250 ? 20 : 50
    historyRef.current = [...historyRef.current.slice(-(historyLimit - 1)), cloneSnapshot(nodes, edges)]
    redoRef.current = []
    setCanUndo(true)
    setCanRedo(false)
  }, [edges, nodes])

  useEffect(() => {
    const checkpoint = () => {
      if (useCanvasStore.getState().activeCanvasId === canvasId) pushHistory()
    }
    emitter.on('canvas-history-checkpoint', checkpoint)
    return () => emitter.off('canvas-history-checkpoint', checkpoint)
  }, [canvasId, pushHistory])

  useEffect(() => {
    const replaceDocument = ({ canvasId: targetCanvasId, document: nextDocument }: { canvasId: string; document: CanvasDocument }) => {
      if (targetCanvasId !== canvasId) return
      pushHistory()
      setNodes(nextDocument.nodes as FlowCanvasNode[])
      setEdges(nextDocument.edges as Edge[])
      requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 300 }))
    }

    emitter.on('canvas-document-replace', replaceDocument)
    return () => emitter.off('canvas-document-replace', replaceDocument)
  }, [canvasId, fitView, pushHistory, setEdges, setNodes])

  const undo = useCallback(() => {
    const snapshot = historyRef.current.pop()
    if (!snapshot) return
    redoRef.current.push(cloneSnapshot(nodes, edges))
    setNodes(snapshot.nodes)
    setEdges(snapshot.edges)
    setCanUndo(historyRef.current.length > 0)
    setCanRedo(true)
  }, [edges, nodes, setEdges, setNodes])

  const redo = useCallback(() => {
    const snapshot = redoRef.current.pop()
    if (!snapshot) return
    historyRef.current.push(cloneSnapshot(nodes, edges))
    setNodes(snapshot.nodes)
    setEdges(snapshot.edges)
    setCanUndo(true)
    setCanRedo(redoRef.current.length > 0)
  }, [edges, nodes, setEdges, setNodes])

  const onNodesChange = useCallback((changes: NodeChange<FlowCanvasNode>[]) => {
    const startsResize = changes.some(change => change.type === 'dimensions' && change.resizing === true)
    if (changes.some(change => change.type === 'remove') || (startsResize && !resizingRef.current)) {
      pushHistory()
    }
    if (startsResize) resizingRef.current = true
    if (changes.some(change => change.type === 'dimensions' && change.resizing === false)) {
      resizingRef.current = false
    }
    onNodesChangeBase(changes)
  }, [onNodesChangeBase, pushHistory])

  const onEdgesChangeTracked = useCallback((changes: EdgeChange<Edge>[]) => {
    if (changes.some(change => change.type === 'remove')) pushHistory()
    onEdgesChange(changes)
  }, [onEdgesChange, pushHistory])

  const onConnect = useCallback((connection: Connection) => {
    pushHistory()
    setEdges(current => addEdge({ ...connection, type: 'smoothstep' }, current))
  }, [pushHistory, setEdges])

  const getSelectedSnapshot = useCallback((): CanvasSnapshot | null => {
    const selectedNodes = nodes.filter(node => node.selected)
    if (selectedNodes.length === 0) return null
    const selectedIds = new Set(selectedNodes.map(node => node.id))
    return cloneSnapshot(
      selectedNodes,
      edges.filter(edge => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    )
  }, [edges, nodes])

  const copySelection = useCallback(() => {
    const snapshot = getSelectedSnapshot()
    if (!snapshot) return
    clipboardRef.current = snapshot
    pasteOffsetRef.current = 0
    setHasClipboard(true)
    toast.success(t('clipboard.copied', { count: snapshot.nodes.length }))
  }, [getSelectedSnapshot, t])

  const insertSnapshot = useCallback((snapshot: CanvasSnapshot) => {
    pushHistory()
    pasteOffsetRef.current += 32
    const idMap = new Map(snapshot.nodes.map(node => [node.id, crypto.randomUUID()]))
    const offset = pasteOffsetRef.current
    const pastedNodes = snapshot.nodes.map(node => ({
      ...structuredClone(node),
      id: idMap.get(node.id) || crypto.randomUUID(),
      position: { x: node.position.x + offset, y: node.position.y + offset },
      selected: true,
    }))
    const pastedEdges = snapshot.edges.map(edge => ({
      ...structuredClone(edge),
      id: crypto.randomUUID(),
      source: idMap.get(edge.source) || edge.source,
      target: idMap.get(edge.target) || edge.target,
      selected: true,
    }))
    setNodes(current => [...current.map(node => ({ ...node, selected: false })), ...pastedNodes])
    setEdges(current => [...current.map(edge => ({ ...edge, selected: false })), ...pastedEdges])
  }, [pushHistory, setEdges, setNodes])

  const pasteSelection = useCallback(() => {
    if (!clipboardRef.current) return
    insertSnapshot(clipboardRef.current)
  }, [insertSnapshot])

  const duplicateSelection = useCallback(() => {
    const snapshot = getSelectedSnapshot()
    if (!snapshot) return
    pasteOffsetRef.current = 0
    insertSnapshot(snapshot)
  }, [getSelectedSnapshot, insertSnapshot])

  const deleteSelection = useCallback(() => {
    const selectedNodeIds = new Set(nodes.filter(node => node.selected).map(node => node.id))
    const selectedEdgeIds = new Set(edges.filter(edge => edge.selected).map(edge => edge.id))
    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return
    pushHistory()
    setNodes(current => current.filter(node => !selectedNodeIds.has(node.id)))
    setEdges(current => current.filter(edge => (
      !selectedEdgeIds.has(edge.id)
      && !selectedNodeIds.has(edge.source)
      && !selectedNodeIds.has(edge.target)
    )))
  }, [edges, nodes, pushHistory, setEdges, setNodes])

  const selectAll = useCallback(() => {
    setNodes(current => current.map(node => ({ ...node, selected: true })))
    setEdges(current => current.map(edge => ({ ...edge, selected: true })))
  }, [setEdges, setNodes])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (useCanvasStore.getState().activeCanvasId !== canvasId) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, [role="textbox"]'))) return

      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        copySelection()
      } else if (modifier && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        pasteSelection()
      } else if (modifier && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelection()
      } else if (modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectAll()
      } else if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (!modifier && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        void fitView({ padding: 0.2, duration: 300 })
      } else if (!modifier && event.code === 'Space') {
        event.preventDefault()
        setTool(current => current === 'select' ? 'hand' : current)
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        deleteSelection()
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setTool(current => current === 'hand' ? 'select' : current)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [canvasId, copySelection, deleteSelection, duplicateSelection, fitView, pasteSelection, redo, selectAll, undo])

  const addNode = useCallback((nodeType: 'process' | 'decision' | 'terminator' | 'text') => {
    pushHistory()
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    setNodes(current => [...current, {
      id: crypto.randomUUID(),
      type: nodeType,
      position,
      data: {
        label: nodeType === 'decision'
          ? t('nodes.decision')
          : nodeType === 'terminator'
            ? t('nodes.terminator')
            : nodeType === 'text'
              ? t('nodes.text')
              : t('nodes.process'),
      },
    }])
  }, [pushHistory, screenToFlowPosition, setNodes, t])

  const addNoteNode = useCallback((filePath: string, name: string) => {
    pushHistory()
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    setNodes(current => [...current, {
      id: crypto.randomUUID(),
      type: 'note',
      position,
      data: { label: name, filePath },
    }])
    setNotePickerOpen(false)
    toast.success(t('noteNode.added', { name }))
  }, [pushHistory, screenToFlowPosition, setNodes, t])

  const addUtilityNode = useCallback((nodeType: 'link' | 'todo') => {
    const url = nodeType === 'link' ? window.prompt(t('linkNode.urlPrompt'), 'https://')?.trim() : undefined
    if (nodeType === 'link' && !url) return
    const label = nodeType === 'link'
      ? window.prompt(t('linkNode.labelPrompt'), url) || url
      : t('nodes.todo')
    pushHistory()
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    setNodes(current => [...current, {
      id: crypto.randomUUID(),
      type: nodeType,
      position,
      data: { label, ...(url ? { url } : {}), ...(nodeType === 'todo' ? { checked: false } : {}) },
    }])
  }, [pushHistory, screenToFlowPosition, setNodes, t])

  const addImageNode = useCallback(async () => {
    const sourcePath = await open({
      multiple: false,
      filters: [{ name: t('nodes.image'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    })
    if (!sourcePath || Array.isArray(sourcePath)) return
    const extension = sourcePath.split('.').pop()?.toLowerCase() || 'png'
    const relativePath = `画布资源/${crypto.randomUUID()}.${extension}`
    const directoryOptions = await getFilePathOptions('画布资源')
    await mkdir(
      directoryOptions.path,
      directoryOptions.baseDir ? { baseDir: directoryOptions.baseDir, recursive: true } : { recursive: true }
    )
    const targetOptions = await getFilePathOptions(relativePath)
    await writeFile(
      targetOptions.path,
      await readFile(sourcePath),
      targetOptions.baseDir ? { baseDir: targetOptions.baseDir } : undefined
    )
    await loadFileTree({ skipRemoteSync: true })
    pushHistory()
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    setNodes(current => [...current, {
      id: crypto.randomUUID(),
      type: 'image',
      position,
      data: { label: sourcePath.split(/[\\/]/).pop() || t('nodes.image'), imagePath: relativePath },
    }])
  }, [loadFileTree, pushHistory, screenToFlowPosition, setNodes, t])

  const alignSelection = useCallback((axis: 'horizontal' | 'vertical') => {
    const selected = nodes.filter(node => node.selected)
    if (selected.length < 2) return
    pushHistory()
    if (axis === 'horizontal') {
      const centerY = selected.reduce((sum, node) => sum + node.position.y + (node.measured?.height || node.height || 56) / 2, 0) / selected.length
      setNodes(current => current.map(node => node.selected ? {
        ...node,
        position: { ...node.position, y: centerY - (node.measured?.height || node.height || 56) / 2 },
      } : node))
    } else {
      const centerX = selected.reduce((sum, node) => sum + node.position.x + (node.measured?.width || node.width || 180) / 2, 0) / selected.length
      setNodes(current => current.map(node => node.selected ? {
        ...node,
        position: { ...node.position, x: centerX - (node.measured?.width || node.width || 180) / 2 },
      } : node))
    }
  }, [nodes, pushHistory, setNodes])

  const distributeSelection = useCallback((axis: 'horizontal' | 'vertical') => {
    const selected = nodes.filter(node => node.selected)
    if (selected.length < 3) return
    pushHistory()
    const sorted = [...selected].sort((left, right) => axis === 'horizontal'
      ? left.position.x - right.position.x
      : left.position.y - right.position.y)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const distance = axis === 'horizontal'
      ? (last.position.x - first.position.x) / (sorted.length - 1)
      : (last.position.y - first.position.y) / (sorted.length - 1)
    const positions = new Map(sorted.map((node, index) => [node.id, axis === 'horizontal'
      ? { ...node.position, x: first.position.x + distance * index }
      : { ...node.position, y: first.position.y + distance * index }]))
    setNodes(current => current.map(node => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node))
  }, [nodes, pushHistory, setNodes])

  const groupSelection = useCallback(() => {
    const selected = nodes.filter(node => node.selected && node.type !== 'group')
    if (selected.length < 2) return
    const bounds = getNodesBounds(selected)
    pushHistory()
    setNodes(current => [{
      id: crypto.randomUUID(),
      type: 'group',
      position: { x: bounds.x - 28, y: bounds.y - 48 },
      width: bounds.width + 56,
      height: bounds.height + 76,
      zIndex: -1,
      data: { label: t('group.defaultLabel'), childIds: selected.map(node => node.id) },
    }, ...current.map(node => ({ ...node, selected: false }))])
  }, [getNodesBounds, nodes, pushHistory, setNodes, t])

  const updateSelectedEdges = useCallback((type: 'smoothstep' | 'straight' | 'default') => {
    if (selectedEdgeCount === 0) return
    pushHistory()
    setEdges(current => current.map(edge => edge.selected ? { ...edge, type } : edge))
  }, [pushHistory, selectedEdgeCount, setEdges])

  const editSelectedEdgeLabel = useCallback(() => {
    const selected = edges.find(edge => edge.selected)
    if (!selected) return
    const label = window.prompt(t('edge.labelPrompt'), typeof selected.label === 'string' ? selected.label : '')
    if (label === null) return
    pushHistory()
    setEdges(current => current.map(edge => edge.selected ? { ...edge, label } : edge))
  }, [edges, pushHistory, setEdges, t])

  const runSelectionAi = useCallback((instruction: string) => {
    const selectedIds = nodes.filter(node => node.selected).map(node => node.id)
    if (selectedIds.length === 0) return
    emitter.emit('quick-prompt-send', `${instruction}\n只修改当前画布中这些选中的节点：${selectedIds.join(', ')}。先读取当前画布，保持其他节点不变。`)
  }, [nodes])

  const openVersionHistory = useCallback(async () => {
    if (pendingDocumentTimerRef.current) clearTimeout(pendingDocumentTimerRef.current)
    pendingDocumentTimerRef.current = null
    const pendingDocument = pendingDocumentRef.current
    if (pendingDocument) {
      pendingDocumentRef.current = null
      lastStoreDocumentRef.current = pendingDocument
      updateDocument(canvasId, pendingDocument)
    }
    await saveProject(canvasId)
    setVersions(await getCanvasVersions(canvasId))
    setVersionPickerOpen(true)
  }, [canvasId, saveProject, updateDocument])

  const restoreVersion = useCallback((version: CanvasVersion) => {
    pushHistory()
    const restoredDocument = structuredClone(version.document)
    const restoredNodes = restoredDocument.nodes as FlowCanvasNode[]
    const restoredEdges = restoredDocument.edges as Edge[]
    setNodes(restoredNodes)
    setEdges(restoredEdges)
    lastStoreDocumentRef.current = restoredDocument
    persistedNodesRef.current = restoredNodes
    persistedEdgesRef.current = restoredEdges
    updateDocument(canvasId, restoredDocument)
    setVersionPickerOpen(false)
    requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 300 }))
    toast.success(t('history.restored'))
  }, [canvasId, fitView, pushHistory, setEdges, setNodes, t, updateDocument])

  const layoutNodes = useCallback(async (recordHistory = true) => {
    if (nodes.length === 0) return
    if (recordHistory) pushHistory()
    const graph = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': document?.settings.layoutDirection === 'LR' ? 'RIGHT' : 'DOWN',
        'elk.spacing.nodeNode': '48',
        'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      },
      children: nodes.map(node => ({
        id: node.id,
        width: node.measured?.width || node.width || 180,
        height: node.measured?.height || node.height || 72,
      })),
      edges: edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    })
    const positions = new Map((graph.children || []).map(child => [child.id, child]))
    setNodes(current => current.map(node => {
      const position = positions.get(node.id)
      return position ? { ...node, position: { x: position.x || 0, y: position.y || 0 } } : node
    }))
    requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 300 }))
  }, [document?.settings.layoutDirection, edges, fitView, nodes, pushHistory, setNodes])

  useEffect(() => {
    const autoLayout = ({ recordHistory = true }: { recordHistory?: boolean }) => {
      if (useCanvasStore.getState().activeCanvasId === canvasId) {
        void layoutNodes(recordHistory)
      }
    }
    emitter.on('canvas-auto-layout', autoLayout)
    return () => emitter.off('canvas-auto-layout', autoLayout)
  }, [canvasId, layoutNodes])

  const updateCanvasSettings = useCallback((settings: Partial<CanvasDocument['settings']>) => {
    if (!document) return
    const nextDocument: CanvasDocument = {
      ...document,
      nodes: serializeNodes(nodes),
      edges: edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: typeof edge.label === 'string' ? edge.label : undefined,
        type: edge.type,
      })),
      viewport: getViewport(),
      settings: { ...document.settings, ...settings },
    }
    lastStoreDocumentRef.current = nextDocument
    updateDocument(canvasId, nextDocument)
  }, [canvasId, document, edges, getViewport, nodes, updateDocument])

  const exportCanvas = useCallback(async (
    format: 'png' | 'svg',
    pixelRatio: number,
    destination: 'computer' | 'workspace'
  ) => {
    setIsExporting(true)
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const viewport = containerRef.current?.querySelector<HTMLElement>('.react-flow__viewport')
      if (!viewport) return
      const bounds = getNodesBounds(nodes)
      const maxCssDimension = Math.floor(8192 / Math.max(1, pixelRatio))
      const imageWidth = Math.min(maxCssDimension, Math.max(1200, Math.ceil(bounds.width + 240)))
      const imageHeight = Math.min(maxCssDimension, Math.max(800, Math.ceil(bounds.height + 240)))
      const exportViewport = getViewportForBounds(bounds, imageWidth, imageHeight, 0.1, 2, 0.12)
      const backgroundColor = globalThis.document.documentElement.classList.contains('dark') ? '#09090b' : '#ffffff'
      const exportOptions = {
        cacheBust: true,
        width: imageWidth,
        height: imageHeight,
        backgroundColor,
        filter: (node: HTMLElement) => {
          if (!(node instanceof HTMLElement)) return true
          return !node.classList.contains('react-flow__handle')
            && !node.classList.contains('react-flow__resize-control')
        },
        style: {
          width: `${imageWidth}px`,
          height: `${imageHeight}px`,
          transform: `translate(${exportViewport.x}px, ${exportViewport.y}px) scale(${exportViewport.zoom})`,
        },
      }
      const dataUrl = format === 'svg'
        ? await toSvg(viewport, exportOptions)
        : await toPng(viewport, { ...exportOptions, pixelRatio })
      const response = await fetch(dataUrl)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const projectTitle = projects.find(project => project.id === canvasId)?.title || t('untitled')
      const safeTitle = projectTitle.replace(/[\\/:*?"<>|]/g, '-').trim() || 'NoteGen-Canvas'
      const extension = format

      if (destination === 'computer') {
        const path = await save({
          filters: [{ name: format.toUpperCase(), extensions: [extension] }],
          defaultPath: `${safeTitle}.${extension}`,
        })
        if (!path) return
        await writeFile(path, bytes)
        toast.success(t('exportSuccess'))
        return
      }

      const directoryOptions = await getFilePathOptions('画布导出')
      await mkdir(
        directoryOptions.path,
        directoryOptions.baseDir ? { baseDir: directoryOptions.baseDir, recursive: true } : { recursive: true }
      )
      const relativePath = `画布导出/${safeTitle}.${extension}`
      const fileOptions = await getFilePathOptions(relativePath)
      await writeFile(
        fileOptions.path,
        bytes,
        fileOptions.baseDir ? { baseDir: fileOptions.baseDir } : undefined
      )
      await useArticleStore.getState().loadFileTree({ skipRemoteSync: true })
      toast.success(t('exportWorkspaceSuccess', { path: relativePath }))
    } catch (error) {
      console.error('Failed to export canvas:', error)
      toast.error(t('exportError'))
    } finally {
      setIsExporting(false)
    }
  }, [canvasId, getNodesBounds, nodes, projects, t])

  const drawOverlayEnabled = tool === 'pen' || tool === 'highlighter' || tool === 'eraser'

  const eraseAtPoint = useCallback((point: { x: number; y: number }) => {
    setNodes(current => current.filter(node => {
      if (node.type !== 'freehand' || erasingIdsRef.current.has(node.id)) return true
      const width = node.measured?.width || node.width || node.data.width || 0
      const height = node.measured?.height || node.height || node.data.height || 0
      const hit = point.x >= node.position.x - 8 && point.x <= node.position.x + width + 8
        && point.y >= node.position.y - 8 && point.y <= node.position.y + height + 8
      if (hit) erasingIdsRef.current.add(node.id)
      return !hit
    }))
  }, [setNodes])

  const handleDrawingPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawOverlayEnabled) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'eraser') {
      pushHistory()
      erasingIdsRef.current.clear()
    }
    const bounds = event.currentTarget.getBoundingClientRect()
    const localPoint = { x: event.clientX - bounds.left, y: event.clientY - bounds.top, pressure: event.pressure || 0.5 }
    const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const point = { ...flowPoint, pressure: event.pressure || 0.5 }
    if (tool === 'eraser') eraseAtPoint(flowPoint)
    setDrawingPoints([localPoint])
    drawingFlowPointsRef.current = [point]
  }, [drawOverlayEnabled, eraseAtPoint, pushHistory, screenToFlowPosition, tool])

  const handleDrawingPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const pressure = event.pressure || 0.5
    const localPoint = { x: event.clientX - bounds.left, y: event.clientY - bounds.top, pressure }
    const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const flowPoint = { ...flowPosition, pressure }

    if (tool === 'eraser') {
      eraseAtPoint(flowPoint)
      return
    }

    const nextLocalPoints = [...drawingPoints, localPoint]
    drawingFlowPointsRef.current = [...drawingFlowPointsRef.current, flowPoint]
    setDrawingPoints(nextLocalPoints)
    const outline = getFreehandOutline(nextLocalPoints, activeBrushStyle)
    setPreviewPath(getSvgPathFromStroke(outline))
  }, [activeBrushStyle, drawingPoints, eraseAtPoint, screenToFlowPosition, tool])

  const handleDrawingPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (tool !== 'eraser' && drawingFlowPointsRef.current.length > 0) {
      const geometry = createFreehandGeometry(drawingFlowPointsRef.current, activeBrushStyle)
      if (geometry) {
        const drawingTool: 'pen' | 'highlighter' = tool === 'highlighter' ? 'highlighter' : 'pen'
        pushHistory()
        setNodes(current => [...current, {
          id: crypto.randomUUID(),
          type: 'freehand',
          position: { x: geometry.x, y: geometry.y },
          width: geometry.width,
          height: geometry.height,
          connectable: false,
          data: {
            points: drawingFlowPointsRef.current,
            path: geometry.path,
            width: geometry.width,
            height: geometry.height,
            color: activeBrushColor,
            opacity: tool === 'highlighter' ? 0.28 : 1,
            strokeWidth: activeBrushStyle.size,
            drawingTool,
          },
        }])
      }
    }
    setDrawingPoints([])
    drawingFlowPointsRef.current = []
    setPreviewPath('')
  }, [activeBrushColor, activeBrushStyle, pushHistory, setNodes, tool])

  const persistViewport = useCallback((viewport: CanvasDocument['viewport']) => {
    if (!document) return
    if (pendingDocumentTimerRef.current) clearTimeout(pendingDocumentTimerRef.current)
    pendingDocumentTimerRef.current = null
    const nextDocument: CanvasDocument = {
      ...(pendingDocumentRef.current || document),
      nodes: serializeNodes(nodes),
      edges: edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: typeof edge.label === 'string' ? edge.label : undefined,
        type: edge.type,
      })),
      viewport,
    }
    pendingDocumentRef.current = null
    lastStoreDocumentRef.current = nextDocument
    updateDocument(canvasId, nextDocument)
  }, [canvasId, document, edges, nodes, updateDocument])

  const tools = useMemo(() => [
    { value: 'select', label: t('tools.select'), icon: MousePointer2 },
    { value: 'hand', label: t('tools.hand'), icon: Hand },
    { value: 'pen', label: t('tools.pen'), icon: Pencil },
    { value: 'highlighter', label: t('tools.highlighter'), icon: Highlighter },
    { value: 'eraser', label: t('tools.eraser'), icon: Eraser },
  ] as const, [t])

  if (!document) {
    return <div className="flex size-full items-center justify-center text-sm text-muted-foreground">{t('loading')}</div>
  }

  return (
    <div ref={containerRef} className="flex size-full min-h-0 flex-col bg-background">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="size-full">
              <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChangeTracked}
        onConnect={onConnect}
        onConnectEnd={(event, connectionState) => {
          if (connectionState.isValid || !connectionState.fromNode) return
          const clientX = 'clientX' in event ? event.clientX : event.changedTouches[0]?.clientX
          const clientY = 'clientY' in event ? event.clientY : event.changedTouches[0]?.clientY
          if (clientX === undefined || clientY === undefined) return
          const id = crypto.randomUUID()
          pushHistory()
          setNodes(current => [...current, {
            id,
            type: 'process',
            position: screenToFlowPosition({ x: clientX, y: clientY }),
            data: { label: t('nodes.process') },
          }])
          setEdges(current => addEdge({
            id: crypto.randomUUID(),
            source: connectionState.fromNode.id,
            target: id,
            type: 'smoothstep',
          }, current))
        }}
        onNodeContextMenu={(_event, targetNode) => {
          if (!targetNode.selected) {
            setNodes(current => current.map(node => ({ ...node, selected: node.id === targetNode.id })))
            setEdges(current => current.map(edge => ({ ...edge, selected: false })))
          }
        }}
        onEdgeContextMenu={(_event, targetEdge) => {
          if (!targetEdge.selected) {
            setNodes(current => current.map(node => ({ ...node, selected: false })))
            setEdges(current => current.map(edge => ({ ...edge, selected: edge.id === targetEdge.id })))
          }
        }}
        onMoveEnd={(_event, viewport) => persistViewport(viewport)}
        onNodeDragStart={(_event, node) => {
          pushHistory()
          if (node.type !== 'group' || !Array.isArray(node.data.childIds)) return
          const childIds = new Set(node.data.childIds.filter((id): id is string => typeof id === 'string'))
          groupDragRef.current = {
            groupId: node.id,
            start: { ...node.position },
            children: new Map(nodes.filter(item => childIds.has(item.id)).map(item => [item.id, { ...item.position }])),
          }
        }}
        onNodeDrag={(_event, node) => {
          const drag = groupDragRef.current
          if (!drag || drag.groupId !== node.id) return
          const delta = { x: node.position.x - drag.start.x, y: node.position.y - drag.start.y }
          setNodes(current => current.map(item => {
            const start = drag.children.get(item.id)
            return start ? { ...item, position: { x: start.x + delta.x, y: start.y + delta.y } } : item
          }))
        }}
        onNodeDragStop={() => { groupDragRef.current = null }}
        deleteKeyCode={null}
        nodesDraggable={!previewSnapshot && tool === 'select'}
        nodesConnectable={!previewSnapshot && (tool === 'select' || tool === 'connector')}
        elementsSelectable={!previewSnapshot && tool === 'select'}
        panOnDrag={tool === 'hand' || tool === 'select'}
        selectionOnDrag={tool === 'select'}
        snapToGrid={document.settings.snapToGrid}
        snapGrid={[20, 20]}
        defaultViewport={document.viewport}
        onlyRenderVisibleElements={!isExporting && nodes.length >= 150}
        colorMode="system"
        >
          {document.settings.showGrid && <Background variant={BackgroundVariant.Dots} gap={20} size={1} />}
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
              </ReactFlow>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuGroup>
              <ContextMenuItem onSelect={selectAll}>
                {t('contextMenu.selectAll')}
                <ContextMenuShortcut>{shortcutModifier}A</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem disabled={selectedNodeCount === 0} onSelect={copySelection}>
                <Copy />
                {t('contextMenu.copy')}
                <ContextMenuShortcut>{shortcutModifier}C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem disabled={!hasClipboard} onSelect={pasteSelection}>
                <ClipboardPaste />
                {t('contextMenu.paste')}
                <ContextMenuShortcut>{shortcutModifier}V</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem disabled={selectedNodeCount === 0} onSelect={duplicateSelection}>
                <CopyPlus />
                {t('contextMenu.duplicate')}
                <ContextMenuShortcut>{shortcutModifier}D</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem variant="destructive" disabled={selectedCount === 0} onSelect={deleteSelection}>
                <Trash2 />
                {t('contextMenu.delete')}
                <ContextMenuShortcut>⌫</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>

        {previewSnapshot && (
          <Badge variant="secondary" className="absolute left-1/2 top-16 -translate-x-1/2 shadow-sm">
            {t('aiPreview')}
          </Badge>
        )}

        <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-background p-1 shadow-sm">
          <ToggleGroup
          type="single"
          value={tool}
          onValueChange={value => value && setTool(value as CanvasTool)}
          variant="outline"
          size="sm"
        >
          {tools.map(item => (
            <Tooltip key={item.value}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={item.value} aria-label={item.label}>
                  <item.icon />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{item.label}</TooltipContent>
            </Tooltip>
          ))}
          </ToggleGroup>

          {(tool === 'pen' || tool === 'highlighter') && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" title={t('brush.title')}>
                <Palette />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center">
              <PopoverHeader>
                <PopoverTitle>{t('brush.title')}</PopoverTitle>
                <PopoverDescription>{t('brush.description')}</PopoverDescription>
              </PopoverHeader>
              <label className="grid gap-1.5 text-sm">
                <span className="text-muted-foreground">{t('brush.color')}</span>
                <Input
                  type="color"
                  value={activeBrushColor}
                  onChange={event => tool === 'highlighter'
                    ? setHighlighterColor(event.target.value)
                    : setPenColor(event.target.value)}
                  className="h-9 cursor-pointer p-1"
                />
              </label>
              <div className="grid gap-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('brush.size')}</span>
                  <span>{activeBrushSize}px</span>
                </div>
                <Slider
                  min={tool === 'highlighter' ? 8 : 1}
                  max={tool === 'highlighter' ? 40 : 16}
                  step={1}
                  value={[activeBrushSize]}
                  onValueChange={value => tool === 'highlighter'
                    ? setHighlighterSize(value[0] ?? highlighterSize)
                    : setPenSize(value[0] ?? penSize)}
                  aria-label={t('brush.size')}
                />
              </div>
            </PopoverContent>
          </Popover>
          )}

          <Button variant="ghost" size="icon-sm" onClick={() => addNode('process')} title={t('nodes.process')}>
            <RectangleHorizontal />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => addNode('decision')} title={t('nodes.decision')}>
            <Route />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => addNode('terminator')} title={t('nodes.terminator')}>
            <SquareRoundCorner />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => addNode('text')} title={t('nodes.text')}>
            <Type />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setNotePickerOpen(true)} title={t('nodes.note')}>
            <FileText />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" title={t('utilityNodes.title')}>
                <ImagePlus />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-48">
              <PopoverHeader>
                <PopoverTitle>{t('utilityNodes.title')}</PopoverTitle>
                <PopoverDescription>{t('utilityNodes.description')}</PopoverDescription>
              </PopoverHeader>
              <div className="flex flex-col gap-1">
                <Button variant="ghost" className="justify-start" onClick={() => void addImageNode()}><ImagePlus data-icon="inline-start" />{t('nodes.image')}</Button>
                <Button variant="ghost" className="justify-start" onClick={() => addUtilityNode('link')}><Link2 data-icon="inline-start" />{t('nodes.link')}</Button>
                <Button variant="ghost" className="justify-start" onClick={() => addUtilityNode('todo')}><CheckSquare2 data-icon="inline-start" />{t('nodes.todo')}</Button>
              </div>
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={selectedNodeCount < 2} title={t('arrange.title')}>
                <FolderKanban />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-56">
              <PopoverHeader>
                <PopoverTitle>{t('arrange.title')}</PopoverTitle>
                <PopoverDescription>{t('arrange.description')}</PopoverDescription>
              </PopoverHeader>
              <div className="flex flex-col gap-1">
                <Button variant="ghost" className="justify-start" onClick={() => alignSelection('horizontal')}><AlignCenterHorizontal data-icon="inline-start" />{t('arrange.alignHorizontal')}</Button>
                <Button variant="ghost" className="justify-start" onClick={() => alignSelection('vertical')}><AlignCenterVertical data-icon="inline-start" />{t('arrange.alignVertical')}</Button>
                <Button variant="ghost" className="justify-start" disabled={selectedNodeCount < 3} onClick={() => distributeSelection('horizontal')}><AlignHorizontalDistributeCenter data-icon="inline-start" />{t('arrange.distributeHorizontal')}</Button>
                <Button variant="ghost" className="justify-start" disabled={selectedNodeCount < 3} onClick={() => distributeSelection('vertical')}><AlignVerticalDistributeCenter data-icon="inline-start" />{t('arrange.distributeVertical')}</Button>
                <Button variant="ghost" className="justify-start" onClick={groupSelection}><FolderKanban data-icon="inline-start" />{t('arrange.group')}</Button>
              </div>
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={selectedNodeCount === 0} title={t('selectionAi.title')}>
                <Bot />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-64">
              <PopoverHeader>
                <PopoverTitle>{t('selectionAi.title')}</PopoverTitle>
                <PopoverDescription>{t('selectionAi.description')}</PopoverDescription>
              </PopoverHeader>
              <div className="flex flex-col gap-1">
                <Button variant="ghost" className="justify-start" onClick={() => runSelectionAi(t('selectionAi.expandPrompt'))}>{t('selectionAi.expand')}</Button>
                <Button variant="ghost" className="justify-start" onClick={() => runSelectionAi(t('selectionAi.branchesPrompt'))}>{t('selectionAi.branches')}</Button>
                <Button variant="ghost" className="justify-start" onClick={() => runSelectionAi(t('selectionAi.reviewPrompt'))}>{t('selectionAi.review')}</Button>
              </div>
            </PopoverContent>
          </Popover>
          {selectedEdgeCount > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" title={t('edge.title')}><Route /></Button>
              </PopoverTrigger>
              <PopoverContent align="center" className="w-52">
                <PopoverHeader>
                  <PopoverTitle>{t('edge.title')}</PopoverTitle>
                  <PopoverDescription>{t('edge.description')}</PopoverDescription>
                </PopoverHeader>
                <div className="flex flex-col gap-1">
                  <Button variant="ghost" className="justify-start" onClick={() => updateSelectedEdges('smoothstep')}>{t('edge.orthogonal')}</Button>
                  <Button variant="ghost" className="justify-start" onClick={() => updateSelectedEdges('straight')}>{t('edge.straight')}</Button>
                  <Button variant="ghost" className="justify-start" onClick={() => updateSelectedEdges('default')}>{t('edge.curve')}</Button>
                  <Button variant="ghost" className="justify-start" onClick={editSelectedEdgeLabel}>{t('edge.editLabel')}</Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Button variant="ghost" size="icon-sm" onClick={undo} disabled={!canUndo} title={t('undo')}>
            <Undo2 />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={redo} disabled={!canRedo} title={t('redo')}>
            <Redo2 />
          </Button>
        </div>

        {drawOverlayEnabled && (
          <div
          className="absolute inset-0 cursor-crosshair touch-none"
          onPointerDown={handleDrawingPointerDown}
          onPointerMove={handleDrawingPointerMove}
          onPointerUp={handleDrawingPointerUp}
          onPointerCancel={handleDrawingPointerUp}
          >
            {previewPath && (
              <svg className="pointer-events-none size-full overflow-visible">
                <path d={previewPath} fill={activeBrushColor} fillOpacity={tool === 'highlighter' ? 0.28 : 1} />
              </svg>
            )}
          </div>
        )}
      </div>

      <CanvasFooter
        nodeCount={nodes.length}
        edgeCount={edges.length}
        selectedCount={selectedCount}
        showGrid={document.settings.showGrid}
        snapToGrid={document.settings.snapToGrid}
        layoutDirection={document.settings.layoutDirection}
        onToggleGrid={() => updateCanvasSettings({ showGrid: !document.settings.showGrid })}
        onToggleSnap={() => updateCanvasSettings({ snapToGrid: !document.settings.snapToGrid })}
        onDirectionChange={layoutDirection => updateCanvasSettings({ layoutDirection })}
        onFitView={() => void fitView({ padding: 0.2, duration: 300 })}
        onLayout={() => void layoutNodes()}
        onHistory={() => void openVersionHistory()}
        onExport={(format, pixelRatio, destination) => void exportCanvas(format, pixelRatio, destination)}
      />

      <Dialog open={notePickerOpen} onOpenChange={setNotePickerOpen}>
        <DialogContent className="p-0 sm:max-w-lg">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>{t('noteNode.title')}</DialogTitle>
            <DialogDescription>{t('noteNode.description')}</DialogDescription>
          </DialogHeader>
          <Command className="border-t">
            <CommandInput placeholder={t('noteNode.search')} />
            <CommandList>
              <CommandEmpty>{t('noteNode.empty')}</CommandEmpty>
              <CommandGroup heading={t('noteNode.group')}>
                {availableNotes.map(note => (
                  <CommandItem
                    key={note.path}
                    value={`${note.name} ${note.path}`}
                    onSelect={() => addNoteNode(note.path, note.name)}
                  >
                    <FileText />
                    <span className="min-w-0 flex-1 truncate">{note.name}</span>
                    <span className="max-w-48 truncate text-xs text-muted-foreground">{note.path}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      <Dialog open={versionPickerOpen} onOpenChange={setVersionPickerOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('history.title')}</DialogTitle>
            <DialogDescription>{t('history.description')}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-80">
            <div className="flex flex-col gap-1 pr-3">
              {versions.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('history.empty')}</p>
              ) : versions.map(version => (
                <Button
                  key={version.id}
                  variant="ghost"
                  className="h-auto justify-between py-3"
                  onClick={() => restoreVersion(version)}
                >
                  <span>{new Date(version.createdAt).toLocaleString()}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('history.summary', { nodes: version.document.nodes.length, edges: version.document.edges.length })}
                  </span>
                </Button>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function CanvasEditor(props: CanvasEditorProps) {
  return (
    <ReactFlowProvider>
      <CanvasEditorInner {...props} />
    </ReactFlowProvider>
  )
}
