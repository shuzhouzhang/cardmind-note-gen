const safeTokenMetricKey = /^(?:promptTokens|completionTokens|totalTokens|tokenUsageAvailability|tokenUsageAvailableCount)$/i
const replacements: Array<[RegExp, string]> = [
  [/(?<![A-Za-z0-9-])sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED_TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/basic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [REDACTED]'],
  [/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]'],
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|password|secret|credentials?)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;"']+)/gi, '$1=[REDACTED]'],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]'],
]

export function redactString(value: string) {
  return replacements.reduce((current, [pattern, replacement]) => (
    current.replace(pattern, replacement)
  ), value)
}

function isSensitiveKey(key: string) {
  if (safeTokenMetricKey.test(key)) return false
  const segmented = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
  return /(?:^|_)(?:authorization|credentials?|cookies?|api_key|token|client_secret|password|secret)(?:_|$)/.test(segmented)
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value)
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen))
  }

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redactValue(item, seen)
  }
  return output
}

export function safeError(error: unknown, maxLength = 200) {
  const text = error instanceof Error ? error.message : String(error)
  return redactString(text).replaceAll(/\s+/g, ' ').slice(0, maxLength)
}
