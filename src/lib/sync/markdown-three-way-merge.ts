export interface MergeConflictBlock {
  id: string
  base: string
  local: string
  remote: string
  startLine: number
}

export type MergePart =
  | { type: 'merged', content: string }
  | { type: 'conflict', block: MergeConflictBlock }

interface Change {
  start: number
  end: number
  replacement: string[]
}

export function mergeMarkdownThreeWay(base: string, local: string, remote: string): MergePart[] {
  if (local === remote) return [{ type: 'merged', content: local }]
  if (local === base) return [{ type: 'merged', content: remote }]
  if (remote === base) return [{ type: 'merged', content: local }]
  const baseLines = splitLines(base)
  const localChanges = changesFromDiff(baseLines, splitLines(local))
  const remoteChanges = changesFromDiff(baseLines, splitLines(remote))
  const parts: MergePart[] = []
  let cursor = 0
  let left = 0
  let right = 0
  while (left < localChanges.length || right < remoteChanges.length) {
    const localChange = localChanges[left]
    const remoteChange = remoteChanges[right]
    const nextStart = Math.min(localChange?.start ?? Infinity, remoteChange?.start ?? Infinity)
    appendMerged(parts, baseLines.slice(cursor, nextStart).join(''))
    if (localChange && (!remoteChange || localChange.end <= remoteChange.start
      && !(localChange.start === localChange.end && localChange.start === remoteChange.start))) {
      appendMerged(parts, localChange.replacement.join(''))
      cursor = localChange.end
      left += 1
      continue
    }
    if (remoteChange && (!localChange || remoteChange.end <= localChange.start
      && !(remoteChange.start === remoteChange.end && remoteChange.start === localChange.start))) {
      appendMerged(parts, remoteChange.replacement.join(''))
      cursor = remoteChange.end
      right += 1
      continue
    }
    let end = Math.max(localChange?.end ?? nextStart, remoteChange?.end ?? nextStart)
    const localGroup: Change[] = []
    const remoteGroup: Change[] = []
    while (localChanges[left] && localChanges[left].start <= end) {
      end = Math.max(end, localChanges[left].end)
      localGroup.push(localChanges[left++])
    }
    while (remoteChanges[right] && remoteChanges[right].start <= end) {
      end = Math.max(end, remoteChanges[right].end)
      remoteGroup.push(remoteChanges[right++])
    }
    const localText = applyRegion(baseLines, nextStart, end, localGroup)
    const remoteText = applyRegion(baseLines, nextStart, end, remoteGroup)
    if (localText === remoteText) appendMerged(parts, localText)
    else parts.push({ type: 'conflict', block: {
      id: crypto.randomUUID(), base: baseLines.slice(nextStart, end).join(''),
      local: localText, remote: remoteText, startLine: nextStart + 1,
    } })
    cursor = end
  }
  appendMerged(parts, baseLines.slice(cursor).join(''))
  return parts
}

export function materializeMerge(parts: MergePart[], resolutions: Record<string, string>): string {
  return parts.map(part => part.type === 'merged'
    ? part.content
    : resolutions[part.block.id] ?? part.block.local).join('')
}

function changesFromDiff(base: string[], target: string[]): Change[] {
  const table = Array.from({ length: base.length + 1 }, () => new Uint32Array(target.length + 1))
  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = target.length - 1; j >= 0; j -= 1) {
      table[i][j] = base[i] === target[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const changes: Change[] = []
  let i = 0
  let j = 0
  let current: Change | null = null
  const begin = () => current ??= { start: i, end: i, replacement: [] }
  const finish = () => {
    if (current) changes.push(current)
    current = null
  }
  while (i < base.length || j < target.length) {
    if (i < base.length && j < target.length && base[i] === target[j]) {
      finish(); i += 1; j += 1
    } else if (j < target.length && (i === base.length || table[i][j + 1] >= table[i + 1][j])) {
      begin().replacement.push(target[j++])
    } else {
      begin().end = ++i
    }
  }
  finish()
  return changes
}

function applyRegion(base: string[], start: number, end: number, changes: Change[]): string {
  const output: string[] = []
  let cursor = start
  for (const change of changes) {
    output.push(...base.slice(cursor, change.start), ...change.replacement)
    cursor = change.end
  }
  output.push(...base.slice(cursor, end))
  return output.join('')
}

function splitLines(value: string): string[] {
  return value.match(/.*(?:\n|$)/g)?.filter(line => line.length > 0) ?? []
}

function appendMerged(parts: MergePart[], content: string): void {
  if (!content) return
  const previous = parts.at(-1)
  if (previous?.type === 'merged') previous.content += content
  else parts.push({ type: 'merged', content })
}
