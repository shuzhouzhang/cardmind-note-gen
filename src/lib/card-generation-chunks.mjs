export const DEFAULT_CARD_GENERATION_CHUNK_SIZE = 12000

const CHAT_MESSAGE_MARKER = /^(?:#{1,3}\s*)?(?:我|用户|User|GPT|ChatGPT|助手|Assistant)\s*[:：]?\s*$/gim

function splitOversizedSegment(segment, maxCharacters) {
  const chunks = []
  for (let start = 0; start < segment.length; start += maxCharacters) {
    chunks.push(segment.slice(start, start + maxCharacters))
  }
  return chunks
}

/**
 * 按对话消息边界打包文本；单条消息超过上限时才做硬切分。
 * 所有分块重新拼接后必须与原文完全一致，避免静默漏读。
 */
export function splitCardGenerationText(text, maxCharacters = DEFAULT_CARD_GENERATION_CHUNK_SIZE) {
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
    throw new Error('maxCharacters must be a positive integer')
  }
  if (!text) return []

  const markerStarts = Array.from(text.matchAll(CHAT_MESSAGE_MARKER), match => match.index ?? 0)
  const starts = markerStarts[0] === 0 ? markerStarts : [0, ...markerStarts]
  const uniqueStarts = [...new Set(starts)].sort((a, b) => a - b)
  const segments = uniqueStarts.map((start, index) => text.slice(start, uniqueStarts[index + 1] ?? text.length))

  const chunks = []
  let current = ''

  for (const segment of segments) {
    if (segment.length > maxCharacters) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      chunks.push(...splitOversizedSegment(segment, maxCharacters))
      continue
    }

    if (current && current.length + segment.length > maxCharacters) {
      chunks.push(current)
      current = ''
    }
    current += segment
  }

  if (current) chunks.push(current)
  return chunks
}

export function calculateGenerationCoverage(chunks, processedChunks) {
  const safeProcessedChunks = Math.max(0, Math.min(processedChunks, chunks.length))
  const totalCharacters = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const processedCharacters = chunks
    .slice(0, safeProcessedChunks)
    .reduce((sum, chunk) => sum + chunk.length, 0)

  return {
    totalCharacters,
    processedCharacters,
    totalChunks: chunks.length,
    processedChunks: safeProcessedChunks,
    percentage: totalCharacters === 0 ? 100 : Math.round((processedCharacters / totalCharacters) * 100),
    complete: safeProcessedChunks === chunks.length,
  }
}
