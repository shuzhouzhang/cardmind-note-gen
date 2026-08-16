export interface RuntimeLogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error'
  message: string
}

const MAX_RUNTIME_LOG_ENTRIES = 300
const runtimeLogs: RuntimeLogEntry[] = []

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/((?:access|refresh|api|auth)[_-]?token|password|passphrase|recovery[_-]?key|secret)(["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi, '$1$2<redacted>')
    .replace(/([?&](?:token|key|secret|password|code)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/[A-Z]:\\(?:[^\\\s]+\\)+[^\s]*/gi, '<path>')
    .replace(/\/(?:Users|home)\/[^\s"']+(?:\/[^\s"']*)?/g, '<path>')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .slice(0, 2_000)
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value)
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (/token|password|passphrase|secret|recoveryKey|authorization/i.test(key)) {
        return [key, '<redacted>']
      }
      if (/path|fileName|logicalKey|objectId|accountId|deviceId|workspaceId/i.test(key)) {
        return [key, entry == null ? entry : '<redacted>']
      }
      return [key, sanitizeDiagnosticValue(entry)]
    }))
  }
  return value
}

export function recordRuntimeLog(level: RuntimeLogEntry['level'], args: unknown[]): void {
  const message = redactDiagnosticText(args.map(argument => {
    if (argument instanceof Error) return `${argument.name}: ${argument.message}`
    if (typeof argument === 'string') return argument
    try {
      return JSON.stringify(sanitizeDiagnosticValue(argument))
    } catch {
      return String(argument)
    }
  }).join(' '))
  runtimeLogs.push({ timestamp: Date.now(), level, message })
  if (runtimeLogs.length > MAX_RUNTIME_LOG_ENTRIES) runtimeLogs.splice(0, runtimeLogs.length - MAX_RUNTIME_LOG_ENTRIES)
}

export function getRuntimeLogs(): RuntimeLogEntry[] {
  return runtimeLogs.map(entry => ({ ...entry }))
}
