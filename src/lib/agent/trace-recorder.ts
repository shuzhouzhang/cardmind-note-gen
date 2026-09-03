import type { AgentRunStatus, AgentTraceEvent } from './types'

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const SECRET_KEY_PATTERN = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|cookie|password|secret|credential)/i
const SAFE_TOKEN_METRIC_KEY_PATTERN = /^(promptTokens|completionTokens|totalTokens)$/i
const BODY_KEY_PATTERN = /^(before|after|diff|patch|content|fullContent|originalContent|modifiedContent|newContent|oldContent|replaceContent|selectedText|body|markdown|message|observation|text|excerpt|quote|output|data)$/i
const TRACE_CONTENT_CONTAINER_PATTERN = /^(input|output|data|params|previewParams|change|changes)$/i
const MAX_TRACE_STRING = 1000

function redactSecrets(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_SK_TOKEN]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|cookie|password|secret)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
}

function summarizeTraceText(value: string, key: string) {
  const trimmed = value.trim()
  const safeCode = key === 'error' && /^(?:[45]\d{2}|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/.test(trimmed)
    ? ` code=${trimmed}`
    : ''
  return `[REDACTED_CONTENT length=${value.length}${safeCode}]`
}

export function sanitizeAgentTraceValue(
  value: unknown,
  key = '',
  depth = 0,
  contentContainer = false
): unknown {
  if (depth > 8) return '[MAX_DEPTH]'
  if (SECRET_KEY_PATTERN.test(key) && !SAFE_TOKEN_METRIC_KEY_PATTERN.test(key)) return '[REDACTED]'

  if (typeof value === 'string') {
    if (BODY_KEY_PATTERN.test(key) || contentContainer) {
      return summarizeTraceText(value, key)
    }
    const redacted = redactSecrets(value)
    return redacted.length > MAX_TRACE_STRING
      ? `${redacted.slice(0, MAX_TRACE_STRING)}… [truncated ${redacted.length - MAX_TRACE_STRING} chars]`
      : redacted
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAgentTraceValue(entry, key, depth + 1, contentContainer))
  }

  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeAgentTraceValue(
          entryValue,
          entryKey,
          depth + 1,
          contentContainer || TRACE_CONTENT_CONTAINER_PATTERN.test(entryKey)
        ),
      ])
  )
}

export function sanitizeAgentTraceEvents(events: AgentTraceEvent[]) {
  return events.map((event) => sanitizeAgentTraceEvent(event))
}

function sanitizeAgentTraceEvent(event: AgentTraceEvent) {
  const normalized = event.type === 'change'
    ? { ...event, title: '记录改动' }
    : event
  return sanitizeAgentTraceValue(normalized) as AgentTraceEvent
}

export class AgentTraceRecorder {
  private readonly runId: string
  private events: AgentTraceEvent[] = []
  private status: AgentRunStatus = 'idle'

  private readonly now: () => number
  private readonly createId: (prefix: string) => string

  constructor(
    runId = createId('run'),
    options: { now?: () => number; createId?: (prefix: string) => string } = {}
  ) {
    this.runId = runId
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? createId
  }

  getRunId() {
    return this.runId
  }

  getStatus() {
    return this.status
  }

  setStatus(status: AgentRunStatus) {
    this.status = status
  }

  add(event: Omit<AgentTraceEvent, 'schemaVersion' | 'id' | 'runId' | 'timestamp'> & { id?: string }) {
    const traceEvent = sanitizeAgentTraceEvent({
      schemaVersion: 1 as const,
      id: event.id ?? this.createId(event.type),
      runId: this.runId,
      timestamp: this.now(),
      ...event,
    } as AgentTraceEvent)

    this.events.push(traceEvent)
    return traceEvent
  }

  update(id: string, updates: Partial<Omit<AgentTraceEvent, 'id' | 'runId'>>) {
    const event = this.events.find((item) => item.id === id)
    if (!event) {
      return undefined
    }

    Object.assign(event, sanitizeAgentTraceValue(updates))
    if (event.type === 'change') event.title = '记录改动'
    return event
  }

  all() {
    return sanitizeAgentTraceEvents(this.events)
  }
}

export { createId as createAgentId }
