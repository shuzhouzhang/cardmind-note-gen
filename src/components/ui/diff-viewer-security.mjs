/**
 * Convert diff-library output into inert text segments. Consumers must render
 * `text` as a React child, never as HTML.
 */
export function toTextDiffSegments(changes) {
  if (!Array.isArray(changes)) return []

  return changes.map((part) => ({
    text: typeof part?.value === 'string' ? part.value : String(part?.value ?? ''),
    added: part?.added === true,
    removed: part?.removed === true,
  }))
}
