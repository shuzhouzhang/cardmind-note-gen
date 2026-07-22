import type { CanvasDocument, CanvasNode } from '@/types/canvas'

const PADDING = 64

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function getNodeSize(node: CanvasNode) {
  if (node.type === 'decision') return { width: node.width || 144, height: node.height || 144 }
  if (node.type === 'text') return { width: node.width || 120, height: node.height || 40 }
  if (node.type === 'freehand') return { width: node.width || node.data.width || 4, height: node.height || node.data.height || 4 }
  if (node.type === 'group') return { width: node.width || 360, height: node.height || 240 }
  if (node.type === 'note' || node.type === 'image' || node.type === 'link' || node.type === 'todo') {
    return { width: node.width || 220, height: node.height || 76 }
  }
  return { width: node.width || 180, height: node.height || 56 }
}

function renderNode(node: CanvasNode, offsetX: number, offsetY: number) {
  const { width, height } = getNodeSize(node)
  const x = node.position.x + offsetX
  const y = node.position.y + offsetY
  const label = escapeXml(node.data.label || '')
  if (node.type === 'freehand') {
    return `<g transform="translate(${x} ${y})"><path d="${escapeXml(node.data.path || '')}" fill="${escapeXml(node.data.color || '#18181b')}" fill-opacity="${node.data.opacity ?? 1}"/></g>`
  }
  if (node.type === 'group') {
    return `<g><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16" fill="#f4f4f5" fill-opacity="0.55" stroke="#a1a1aa" stroke-dasharray="8 6"/><text x="${x + 16}" y="${y + 26}" font-family="sans-serif" font-size="14" font-weight="600" fill="#3f3f46">${label}</text></g>`
  }
  if (node.type === 'decision') {
    const cx = x + width / 2
    const cy = y + height / 2
    return `<g><polygon points="${cx},${y} ${x + width},${cy} ${cx},${y + height} ${x},${cy}" fill="#ffffff" stroke="#a1a1aa"/><text x="${cx}" y="${cy + 5}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#18181b">${label}</text></g>`
  }
  const radius = node.type === 'terminator' ? height / 2 : 10
  const subtitle = node.type === 'note'
    ? node.data.filePath
    : node.type === 'link'
      ? node.data.url
      : node.type === 'todo'
        ? (node.data.checked ? '✓' : '○')
        : ''
  return `<g><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="#ffffff" stroke="#a1a1aa"/><text x="${x + width / 2}" y="${y + height / 2 - (subtitle ? 5 : -5)}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#18181b">${label}</text>${subtitle ? `<text x="${x + width / 2}" y="${y + height / 2 + 15}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#71717a">${escapeXml(String(subtitle))}</text>` : ''}</g>`
}

export function canvasDocumentToSvg(document: CanvasDocument) {
  const allNodes = document.nodes
  if (allNodes.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="100%" height="100%" fill="#fff"/></svg>'
  }
  const boxes = allNodes.map(node => ({ node, ...getNodeSize(node) }))
  const minX = Math.min(...boxes.map(item => item.node.position.x))
  const minY = Math.min(...boxes.map(item => item.node.position.y))
  const maxX = Math.max(...boxes.map(item => item.node.position.x + item.width))
  const maxY = Math.max(...boxes.map(item => item.node.position.y + item.height))
  const width = Math.max(800, Math.ceil(maxX - minX + PADDING * 2))
  const height = Math.max(500, Math.ceil(maxY - minY + PADDING * 2))
  const offsetX = PADDING - minX
  const offsetY = PADDING - minY
  const nodeMap = new Map(boxes.map(item => [item.node.id, item]))
  const edges = document.edges.map(edge => {
    const source = nodeMap.get(edge.source)
    const target = nodeMap.get(edge.target)
    if (!source || !target) return ''
    const x1 = source.node.position.x + source.width / 2 + offsetX
    const y1 = source.node.position.y + source.height / 2 + offsetY
    const x2 = target.node.position.x + target.width / 2 + offsetX
    const y2 = target.node.position.y + target.height / 2 + offsetY
    return `<g><path d="M ${x1} ${y1} L ${x2} ${y2}" fill="none" stroke="#71717a" stroke-width="1.5" marker-end="url(#arrow)"/>${edge.label ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#52525b">${escapeXml(edge.label)}</text>` : ''}</g>`
  }).join('')
  const groups = allNodes.filter(node => node.type === 'group').map(node => renderNode(node, offsetX, offsetY)).join('')
  const nodes = allNodes.filter(node => node.type !== 'group').map(node => renderNode(node, offsetX, offsetY)).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#71717a"/></marker></defs>${groups}${edges}${nodes}</svg>`
}

export async function canvasDocumentToPngFile(
  document: CanvasDocument,
  fileName: string,
  options: { maxDimension?: number; scale?: number } = {}
) {
  const svg = canvasDocumentToSvg(document)
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const maxDimension = options.maxDimension || 4096
    const scale = Math.min(options.scale || 2, maxDimension / Math.max(image.width, image.height))
    const canvas = globalThis.document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Unable to create canvas renderer')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('Unable to encode PNG')), 'image/png')
    })
    return new File([pngBlob], fileName, { type: 'image/png' })
  } finally {
    URL.revokeObjectURL(url)
  }
}
