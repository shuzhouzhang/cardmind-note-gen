const activeMarkdownEditors = new Map<string, number>()
const recentlyActiveUntil = new Map<string, number>()
const RELEASE_GRACE_MS = 5_000

export function retainActiveNoteGenServerMarkdownEditor(relativePath: string): () => void {
  const path = normalizePath(relativePath)
  recentlyActiveUntil.delete(path)
  activeMarkdownEditors.set(path, (activeMarkdownEditors.get(path) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (activeMarkdownEditors.get(path) ?? 1) - 1
    if (remaining > 0) activeMarkdownEditors.set(path, remaining)
    else {
      activeMarkdownEditors.delete(path)
      // Debounced disk saves and native file-watcher events can arrive shortly
      // after the editor unmounts. Keep treating them as collaboration output
      // so a remote update is not echoed back as a legacy Markdown snapshot.
      recentlyActiveUntil.set(path, Date.now() + RELEASE_GRACE_MS)
    }
  }
}

export function hasActiveNoteGenServerMarkdownEditor(relativePath: string): boolean {
  const path = normalizePath(relativePath)
  if (activeMarkdownEditors.has(path)) return true
  const until = recentlyActiveUntil.get(path) ?? 0
  if (until > Date.now()) return true
  recentlyActiveUntil.delete(path)
  return false
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').normalize('NFC')
}
