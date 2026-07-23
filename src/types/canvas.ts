export type CanvasProjectType =
  | 'blank'
  | 'flowchart'
  | 'mindmap'
  | 'timeline'
  | 'quadrant'
  | 'kanban'
  | 'swot'

export type CanvasTool =
  | 'select'
  | 'hand'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'rectangle'
  | 'text'
  | 'connector'

export type CanvasNodeType =
  | 'process'
  | 'decision'
  | 'terminator'
  | 'text'
  | 'note'
  | 'image'
  | 'link'
  | 'todo'
  | 'group'
  | 'freehand'

export interface CanvasPoint {
  x: number
  y: number
  pressure: number
}

export interface CanvasNodeData extends Record<string, unknown> {
  label?: string
  description?: string
  color?: string
  borderStyle?: 'solid' | 'dashed' | 'dotted'
  borderWidth?: number
  fillColor?: string
  fillStyle?: 'default' | 'tint'
  strokeWidth?: number
  pathStrokeWidth?: number
  opacity?: number
  points?: CanvasPoint[]
  path?: string
  width?: number
  height?: number
  drawingTool?: 'pen' | 'highlighter'
  filePath?: string
  imagePath?: string
  url?: string
  checked?: boolean
  childIds?: string[]
  previewState?: 'add' | 'update' | 'delete'
}

export interface CanvasNode {
  id: string
  type: CanvasNodeType
  position: { x: number; y: number }
  data: CanvasNodeData
  width?: number
  height?: number
  selected?: boolean
  draggable?: boolean
  connectable?: boolean
  zIndex?: number
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  label?: string
  type?: string
}

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasDocument {
  schemaVersion: 1
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: CanvasViewport
  settings: {
    layoutDirection: 'TB' | 'LR'
    showGrid: boolean
    snapToGrid: boolean
  }
}

export interface CanvasHistorySnapshot {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export interface CanvasHistoryState {
  undo: CanvasHistorySnapshot[]
  redo: CanvasHistorySnapshot[]
}

export interface CanvasProject {
  id: string
  title: string
  canvasType: CanvasProjectType
  schemaVersion: number
  document: CanvasDocument
  history?: CanvasHistoryState
  thumbnailPath?: string | null
  thumbnailRevision?: number
  createdAt: number
  updatedAt: number
  pinnedAt?: number | null
  deletedAt?: number | null
}

export interface CanvasProjectRow {
  id: string
  title: string
  canvasType: CanvasProjectType
  schemaVersion: number
  content: string
  undoStack?: string | null
  redoStack?: string | null
  thumbnailPath?: string | null
  createdAt: number
  updatedAt: number
  pinnedAt?: number | null
  deletedAt?: number | null
}

export const DEFAULT_CANVAS_DOCUMENT: CanvasDocument = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  settings: {
    layoutDirection: 'TB',
    showGrid: true,
    snapToGrid: false,
  },
}

export function normalizeCanvasDocument(value: unknown): CanvasDocument {
  if (!value || typeof value !== 'object') {
    return structuredClone(DEFAULT_CANVAS_DOCUMENT)
  }

  const candidate = value as Partial<CanvasDocument>
  return {
    schemaVersion: 1,
    nodes: Array.isArray(candidate.nodes) ? candidate.nodes : [],
    edges: Array.isArray(candidate.edges) ? candidate.edges : [],
    viewport: candidate.viewport || { x: 0, y: 0, zoom: 1 },
    settings: {
      ...DEFAULT_CANVAS_DOCUMENT.settings,
      ...(candidate.settings || {}),
    },
  }
}
