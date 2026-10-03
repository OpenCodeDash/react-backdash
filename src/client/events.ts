import type { BackdashEvent } from "../types"

export interface SseFrame {
  event: string
  id: string | null
  data: string
}

// Parses complete SSE frames out of a partial buffer. Frames are separated by
// a blank line; each may carry `event:`, `id:`, and one or more `data:` lines.
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = []
  let rest = buffer
  let idx: number
  while ((idx = rest.indexOf("\n\n")) !== -1) {
    const raw = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    let event = "message"
    let id: string | null = null
    const dataLines: string[] = []
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "")
      else if (line.startsWith("id:")) id = line.slice(3).replace(/^ /, "")
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
    }
    if (event === "ping") continue
    frames.push({ event, id, data: dataLines.join("\n") })
  }
  return { frames, rest }
}

function parseEvent(raw: string): BackdashEvent | null {
  try {
    const parsed = JSON.parse(raw) as BackdashEvent
    if (parsed && typeof parsed.type === "string" && typeof parsed.seq === "number") {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      done()
    }
    function done() {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export interface EventStreamOptions {
  url: string
  fetchImpl?: typeof fetch
  // Extra request headers (e.g. Authorization). `Accept` is always set.
  headers?: Record<string, string>
  // Resume point, read on every (re)connect. Returns undefined to start fresh.
  lastEventId?: () => number | undefined
  onEvent: (event: BackdashEvent) => void
  // History was pruned on the server: refetch full state.
  onResync?: () => void
  onConnected?: () => void
  onDisconnected?: () => void
  reconnect?: boolean
  minBackoffMs?: number
  maxBackoffMs?: number
  signal?: AbortSignal
}

export class EventStream {
  private options: EventStreamOptions
  private abortController: AbortController | null = null
  private stopped = true
  private backoffMs: number

  constructor(options: EventStreamOptions) {
    this.options = options
    this.backoffMs = options.minBackoffMs ?? 500
  }

  get connected(): boolean {
    return !this.stopped
  }

  async start(): Promise<void> {
    this.stopped = false
    while (!this.stopped) {
      const controller = new AbortController()
      this.abortController = controller
      const signal = this.combinedSignal(controller)
      let connected = false
      try {
        await this.consume(signal, () => {
          if (!connected) {
            connected = true
            this.options.onConnected?.()
            this.backoffMs = this.options.minBackoffMs ?? 500
          }
        })
      } catch {
        // connection failed or dropped; fall through to reconnect
      } finally {
        if (connected) this.options.onDisconnected?.()
        this.abortController = null
      }
      if (this.stopped) break
      if (!this.options.reconnect) break
      await delay(this.backoffMs, this.options.signal)
      this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 30_000)
    }
  }

  stop(): void {
    this.stopped = true
    this.abortController?.abort()
  }

  private combinedSignal(controller: AbortController): AbortSignal {
    const external = this.options.signal
    if (!external) return controller.signal
    if (external.aborted) return external
    const combined = new AbortController()
    const onAbort = () => combined.abort()
    external.addEventListener("abort", onAbort, { once: true })
    controller.signal.addEventListener("abort", () => external.removeEventListener("abort", onAbort), {
      once: true,
    })
    return combined.signal
  }

  private async consume(signal: AbortSignal, onOpen: () => void): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const lastEventId = this.options.lastEventId?.()
    const url =
      lastEventId === undefined ? this.options.url : `${this.options.url}${this.options.url.includes("?") ? "&" : "?"}lastEventId=${lastEventId}`
    const response = await fetchImpl(url, {
      headers: { Accept: "text/event-stream", ...this.options.headers },
      signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`event stream failed: ${response.status}`)
    }
    onOpen()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { frames, rest } = parseSseFrames(buffer)
      buffer = rest
      for (const frame of frames) {
        if (frame.event === "resync") {
          this.options.onResync?.()
          continue
        }
        const event = parseEvent(frame.data)
        if (event) this.options.onEvent(event)
      }
    }
    throw new Error("event stream closed")
  }
}
