const DEFAULT_MAX_RETRIES = 2
const RETRY_DELAYS_MS = [500, 1000]

export interface RetryContext {
  attempt: number
  retry: number
  delayMs: number
  error: unknown
}

export interface RetryOptions {
  maxRetries?: number
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  onRetry?: (context: RetryContext) => void | Promise<void>
  shouldRetry?: (error: unknown) => boolean
}

export function isAbortError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) {
    return true
  }

  if (!(error instanceof Error)) {
    return false
  }

  return error.name === 'AbortError' ||
    error.message === 'USER_STOPPED' ||
    /request was aborted|operation was aborted|aborterror/i.test(error.message)
}

export function isRetryableModelError(error: unknown) {
  if (!(error instanceof Error) || isAbortError(error)) {
    return false
  }

  const status = Number((error as Error & { status?: number }).status)
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
    return true
  }

  const message = error.message.toLowerCase()
  return /\b(408|409|425|429|5\d\d)\b|timeout|timed out|temporar|rate limit|network|socket|connection|fetch failed|stream|eof|reset by peer/.test(message)
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Operation was aborted', 'AbortError'))
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Operation was aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class AgentRecoveryManager {
  async withRetry<T>(
    fn: (attempt: number) => Promise<T>,
    options: RetryOptions = {}
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    const sleep = options.sleep ?? abortableSleep
    const retryable = options.shouldRetry ?? isRetryableModelError
    let lastError: unknown

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      if (options.signal?.aborted) {
        throw new DOMException('Operation was aborted', 'AbortError')
      }

      try {
        return await fn(attempt)
      } catch (error) {
        lastError = error
        if (isAbortError(error, options.signal) || attempt > maxRetries || !retryable(error)) {
          throw error
        }

        const retry = attempt
        const delayMs = RETRY_DELAYS_MS[Math.min(retry - 1, RETRY_DELAYS_MS.length - 1)]
        await options.onRetry?.({ attempt, retry, delayMs, error })
        await sleep(delayMs, options.signal)
      }
    }

    throw lastError
  }
}
