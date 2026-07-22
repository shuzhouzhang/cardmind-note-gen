import emitter from '@/lib/emitter'
import { applyCanvasOperations } from '@/lib/canvas/operations'
import type { CanvasDocument } from '@/types/canvas'
import type { AgentTool, AgentToolResult } from '../types'

async function getActiveCanvas(contextCanvasId?: string) {
  const { default: useCanvasStore } = await import('@/stores/canvas')
  const store = useCanvasStore.getState()
  const canvasId = contextCanvasId || store.activeCanvasId || ''
  const document = canvasId ? store.documents[canvasId] : undefined
  const project = store.projects.find(item => item.id === canvasId)
  return { store, canvasId, document, project }
}

function summarizeDocument(document: CanvasDocument) {
  return {
    settings: document.settings,
    viewport: document.viewport,
    nodes: document.nodes.map(node => ({
      id: node.id,
      type: node.type,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      label: node.data.label || '',
      description: node.data.description || '',
    })),
    edges: document.edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label || '',
    })),
  }
}

const getCanvasStateTool: AgentTool = {
  name: 'canvas_get_state',
  title: '读取当前画布',
  description: '读取 NoteGen 当前打开的原生可视化画布，包括节点、连线、位置和设置。用户提到当前画布、流程图、节点或连线时必须优先使用，不能用 note_read_file 或 Mermaid 文件代替。',
  category: 'canvas',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute: async (_input, context): Promise<AgentToolResult> => {
    const { canvasId, document, project } = await getActiveCanvas(context.context.activeCanvasId)
    if (!canvasId || !document) {
      return { ok: false, message: '当前没有打开的画布。', error: 'NO_ACTIVE_CANVAS' }
    }
    return {
      ok: true,
      message: `已读取画布“${project?.title || canvasId}”，共 ${document.nodes.length} 个节点、${document.edges.length} 条连线。`,
      data: { canvasId, title: project?.title || '', ...summarizeDocument(document) },
    }
  },
}

const applyCanvasOperationsTool: AgentTool = {
  name: 'canvas_apply_operations',
  title: '编辑当前画布',
  description: '直接编辑 NoteGen 当前打开的原生可视化画布。批量添加、更新或删除节点与连线；不要改写 Markdown/Mermaid 文件来代替画布操作。使用稳定 ID，以便在同一次调用中创建节点后连接或更新它们。',
  category: 'canvas',
  risk: 'editor-write',
  inputSchema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        description: 'Ordered canvas edits. Supported types: add_node, update_node, delete_node, add_edge, delete_edge, clear.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['add_node', 'update_node', 'delete_node', 'add_edge', 'delete_edge', 'clear'] },
            id: { type: 'string', description: 'Node or edge ID.' },
            nodeType: { type: 'string', enum: ['process', 'decision', 'terminator', 'text'] },
            label: { type: 'string' },
            description: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            source: { type: 'string' },
            target: { type: 'string' },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    const { store, canvasId, document, project } = await getActiveCanvas(context.context.activeCanvasId)
    if (!canvasId || !document) {
      return { ok: false, message: '当前没有打开的画布。', error: 'NO_ACTIVE_CANVAS' }
    }
    const operations = Array.isArray(input.operations) ? input.operations : []
    if (operations.length === 0) {
      return { ok: false, message: '没有提供可执行的画布操作。', error: 'EMPTY_OPERATIONS' }
    }

    const before = JSON.stringify(summarizeDocument(document))
    const result = applyCanvasOperations(document, operations)
    if (result.applied === 0) {
      return { ok: false, message: '没有操作被应用，请检查节点或连线 ID。', error: 'NO_OPERATION_APPLIED' }
    }
    store.updateDocument(canvasId, result.document)
    emitter.emit('canvas-document-replace', { canvasId, document: result.document })
    requestAnimationFrame(() => {
      emitter.emit('canvas-auto-layout', { recordHistory: false })
    })

    return {
      ok: true,
      message: `已在画布“${project?.title || canvasId}”应用 ${result.applied} 项修改。`,
      data: summarizeDocument(result.document),
      changes: [{
        id: crypto.randomUUID(),
        type: 'canvas',
        target: canvasId,
        before,
        after: JSON.stringify(summarizeDocument(result.document)),
        reversible: true,
        summary: `修改画布“${project?.title || canvasId}”`,
      }],
    }
  },
}

export const canvasTools: AgentTool[] = [getCanvasStateTool, applyCanvasOperationsTool]
