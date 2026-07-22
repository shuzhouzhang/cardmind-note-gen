import { DEFAULT_CANVAS_DOCUMENT, type CanvasDocument, type CanvasProjectType } from '@/types/canvas'

const FLOWCHART_TEMPLATE: CanvasDocument = {
  ...structuredClone(DEFAULT_CANVAS_DOCUMENT),
  nodes: [
    { id: 'start', type: 'terminator', position: { x: 180, y: 0 }, data: { label: '开始' } },
    { id: 'process', type: 'process', position: { x: 160, y: 140 }, data: { label: '处理步骤' } },
    { id: 'decision', type: 'decision', position: { x: 180, y: 280 }, data: { label: '判断条件' } },
    { id: 'end', type: 'terminator', position: { x: 180, y: 480 }, data: { label: '结束' } },
  ],
  edges: [
    { id: 'start-process', source: 'start', target: 'process', type: 'smoothstep' },
    { id: 'process-decision', source: 'process', target: 'decision', type: 'smoothstep' },
    { id: 'decision-end', source: 'decision', target: 'end', label: '是', type: 'smoothstep' },
  ],
  viewport: { x: 200, y: 40, zoom: 0.9 },
}

const MINDMAP_TEMPLATE: CanvasDocument = {
  ...structuredClone(DEFAULT_CANVAS_DOCUMENT),
  settings: { ...DEFAULT_CANVAS_DOCUMENT.settings, layoutDirection: 'LR' },
  nodes: [
    { id: 'topic', type: 'process', position: { x: 0, y: 160 }, data: { label: '中心主题' } },
    { id: 'branch-1', type: 'process', position: { x: 280, y: 40 }, data: { label: '分支一' } },
    { id: 'branch-2', type: 'process', position: { x: 280, y: 160 }, data: { label: '分支二' } },
    { id: 'branch-3', type: 'process', position: { x: 280, y: 280 }, data: { label: '分支三' } },
  ],
  edges: [
    { id: 'topic-branch-1', source: 'topic', target: 'branch-1', type: 'smoothstep' },
    { id: 'topic-branch-2', source: 'topic', target: 'branch-2', type: 'smoothstep' },
    { id: 'topic-branch-3', source: 'topic', target: 'branch-3', type: 'smoothstep' },
  ],
  viewport: { x: 120, y: 80, zoom: 0.9 },
}

export function createCanvasDocument(canvasType: CanvasProjectType): CanvasDocument {
  if (canvasType === 'flowchart') return structuredClone(FLOWCHART_TEMPLATE)
  if (canvasType === 'mindmap') return structuredClone(MINDMAP_TEMPLATE)
  return structuredClone(DEFAULT_CANVAS_DOCUMENT)
}
