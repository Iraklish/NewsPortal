// Capture browser-side errors and ship them to the backend log sink.
// Idempotent: safe to call multiple times.

interface ClientLogEntry {
  level: 'ERROR' | 'WARN' | 'INFO'
  message: string
  url?: string
  stack?: string
  user_agent?: string
  context?: Record<string, unknown>
}

let installed = false
let baseUrl: string | null = null

function resolveBase(): string {
  if (baseUrl) return baseUrl
  const env = process.env.NEXT_PUBLIC_API_BASE
  if (env && env.trim()) {
    baseUrl = env.trim().replace(/\/$/, '')
  } else if (typeof window !== 'undefined') {
    baseUrl = `${window.location.protocol}//${window.location.hostname}:8000`
  } else {
    baseUrl = 'http://localhost:8000'
  }
  return baseUrl
}

// Throttle bursts — at most 1 same-message in-flight every 2s
const recent = new Map<string, number>()

export function logToServer(entry: ClientLogEntry): void {
  if (typeof window === 'undefined') return
  const key = `${entry.level}:${entry.message.slice(0, 200)}`
  const now = Date.now()
  const last = recent.get(key)
  if (last && now - last < 2000) return
  recent.set(key, now)
  if (recent.size > 200) {
    // Drop oldest entries to bound memory
    const k = recent.keys().next().value
    if (k) recent.delete(k)
  }

  const payload: ClientLogEntry = {
    level: entry.level,
    message: entry.message,
    url: entry.url || window.location.href,
    stack: entry.stack,
    user_agent: navigator.userAgent,
    context: entry.context,
  }
  // fire-and-forget — never let the logger itself throw
  fetch(`${resolveBase()}/logs/client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {})
}

export function installClientErrorLogger(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (ev: ErrorEvent) => {
    logToServer({
      level: 'ERROR',
      message: ev.message || 'Uncaught error',
      stack: ev.error?.stack || `${ev.filename}:${ev.lineno}:${ev.colno}`,
    })
  })

  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const reason = ev.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? reason.stack : undefined
    logToServer({
      level: 'ERROR',
      message: `Unhandled promise rejection: ${message}`,
      stack,
    })
  })

  // Also forward console.error so manual errors flow through
  const origError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    try {
      logToServer({
        level: 'ERROR',
        message: args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        stack: args.find(a => a instanceof Error) instanceof Error ? (args.find(a => a instanceof Error) as Error).stack : undefined,
      })
    } catch {}
    origError(...args)
  }
}
