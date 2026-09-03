export function isAbsoluteFsPath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Fail closed before any workspace lookup or filesystem API is reached. */
export function assertSafeWorkspaceRelativePathInput(relativePath: string): void {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('路径不能为空')
  }

  const candidate = relativePath.trim()
  const slashNormalized = candidate.replace(/\\/g, '/')
  if (
    isAbsoluteFsPath(candidate)
    || isAbsoluteFsPath(slashNormalized)
    || /^[a-zA-Z]:/.test(candidate)
  ) {
    throw new Error('不允许使用绝对路径')
  }
  if (candidate.includes('\0')) {
    throw new Error('路径包含无效字符')
  }

  const segments = slashNormalized.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('路径不能包含 . 或 .. 段')
  }
}

/**
 * Normalize a folder argument whose empty string explicitly means the
 * workspace root. Non-empty values still pass through the fail-closed path
 * guard before any workspace or filesystem API is reached.
 */
export function normalizeOptionalWorkspaceFolderInput(relativePath: unknown): string {
  if (typeof relativePath !== 'string') {
    throw new Error('路径必须是字符串')
  }

  const candidate = relativePath.trim()
  if (!candidate) return ''

  assertSafeWorkspaceRelativePathInput(candidate)
  return candidate
}
