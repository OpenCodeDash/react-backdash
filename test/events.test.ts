import { describe, expect, it, vi } from "vitest"
import { EventStream, parseSseFrames } from "../src/client/events"
import type { BackdashEvent } from "../src/types"

function ev(seq: number, type: string, payload: unknown): string {
  const data = JSON.stringify({
    seq,
    boardId: "b1",
    type,
    actor: "dashboard",
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  })
  return `id: ${seq}\ndata: ${data}\n\n`
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )
}

describe("parseSseFrames", () => {
  it("parses complete frames and leaves the rest empty", () => {
    const { frames, rest } = parseSseFrames(
      ev(1, "board.created", { id: "b1", name: "X" }) + ev(2, "board.updated", { name: "Y" }),
    )
    expect(rest).toBe("")
    expect(frames).toHaveLength(2)
    expect(frames[0].event).toBe("message")
    expect(frames[0].id).toBe("1")
    const first = JSON.parse(frames[0].data) as BackdashEvent
    expect(first.seq).toBe(1)
    expect(first.type).toBe("board.created")
    expect(first.payload).toEqual({ id: "b1", name: "X" })
    expect(frames[1].id).toBe("2")
  })

  it("returns an incomplete trailing frame as rest", () => {
    const frame = ev(1, "board.created", { id: "b1", name: "X" })
    const cut = frame.slice(0, frame.lastIndexOf("\n"))
    const { frames, rest } = parseSseFrames(cut)
    expect(frames).toHaveLength(0)
    expect(rest).toBe(cut)
  })

  it("drops ping frames", () => {
    const { frames } = parseSseFrames(`event: ping\ndata: {}\n\n` + ev(3, "column.added", { id: 1 }))
    expect(frames).toHaveLength(1)
    expect(frames[0].id).toBe("3")
  })

  it("keeps named non-ping frames such as resync", () => {
    const { frames } = parseSseFrames(`event: resync\ndata: {"reason":"pruned"}\n\n`)
    expect(frames).toHaveLength(1)
    expect(frames[0].event).toBe("resync")
  })

  it("rejoins multi-line data", () => {
    const data = JSON.stringify({ a: "x\ny" })
    const lines = data.split("\n").map((line, i) => (i === 0 ? `data: ${line}` : line)).join("\n")
    const { frames } = parseSseFrames(`id: 7\n${lines}\n\n`)
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0].data).a).toBe("x\ny")
  })
})

describe("EventStream", () => {
  it("appends lastEventId and emits parsed events", async () => {
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return sseResponse([ev(43, "board.updated", { name: "N" }), ev(44, "column.reordered", {})])
    })
    const onEvent = vi.fn()

    const stream = new EventStream({
      url: "http://x/boards/b1/events",
      fetchImpl: fetchMock as unknown as typeof fetch,
      lastEventId: () => 42,
      onEvent,
      reconnect: false,
    })
    void stream.start()
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2))

    expect(urls[0]).toBe("http://x/boards/b1/events?lastEventId=42")
    expect(onEvent.mock.calls[0][0].seq).toBe(43)
    expect(onEvent.mock.calls[1][0].seq).toBe(44)
    stream.stop()
  })

  it("omits lastEventId when the resume point is undefined", async () => {
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return sseResponse([])
    })

    const stream = new EventStream({
      url: "http://x/events",
      fetchImpl: fetchMock as unknown as typeof fetch,
      lastEventId: () => undefined,
      onEvent: vi.fn(),
      reconnect: false,
    })
    void stream.start()
    await vi.waitFor(() => expect(urls).toHaveLength(1))
    expect(urls[0]).toBe("http://x/events")
    stream.stop()
  })

  it("invokes onResync for resync frames and skips them as events", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([`event: resync\ndata: {"reason":"pruned"}\n\n`, ev(1, "board.deleted", {})]),
    )
    const onEvent = vi.fn()
    const onResync = vi.fn()

    const stream = new EventStream({
      url: "http://x/events",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent,
      onResync,
      reconnect: false,
    })
    void stream.start()
    await vi.waitFor(() => expect(onResync).toHaveBeenCalledTimes(1))
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0][0].seq).toBe(1)
    stream.stop()
  })

  it("calls onConnected and onDisconnected around a live connection", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const encoder = new TextEncoder()
      const signal = init?.signal as AbortSignal | undefined
      // stays open until the fetch signal aborts
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(ev(1, "board.deleted", {})))
        },
        pull() {
          return new Promise<ReadResult<Uint8Array>>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          })
        },
      })
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    })
    const onConnected = vi.fn()
    const onDisconnected = vi.fn()

    const stream = new EventStream({
      url: "http://x/events",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
      onConnected,
      onDisconnected,
      reconnect: false,
    })
    void stream.start()
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
    expect(onDisconnected).not.toHaveBeenCalled()
    stream.stop()
    await vi.waitFor(() => expect(onDisconnected).toHaveBeenCalledTimes(1))
  })

  it("reconnects with backoff, resuming from the highest emitted seq", async () => {
    vi.useFakeTimers()
    let seenSeq = 0
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      const first = urls.length === 1
      return sseResponse(first ? [ev(5, "board.updated", {})] : [ev(6, "board.updated", {})])
    })

    const stream = new EventStream({
      url: "http://x/events",
      fetchImpl: fetchMock as unknown as typeof fetch,
      lastEventId: () => (seenSeq > 0 ? seenSeq : undefined),
      onEvent: (event) => {
        seenSeq = event.seq
      },
      reconnect: true,
      minBackoffMs: 50,
    })
    void stream.start()
    await vi.advanceTimersByTimeAsync(500)

    expect(urls.length).toBeGreaterThanOrEqual(2)
    expect(urls[0]).toBe("http://x/events")
    expect(urls[1]).toBe("http://x/events?lastEventId=5")
    stream.stop()
    vi.useRealTimers()
  })

  it("does not reconnect after stop()", async () => {
    vi.useFakeTimers()
    let connections = 0
    const fetchMock = vi.fn(async () => {
      connections += 1
      return sseResponse([])
    })

    const stream = new EventStream({
      url: "http://x/events",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
      reconnect: true,
      minBackoffMs: 10,
    })
    void stream.start()
    await vi.advanceTimersByTimeAsync(100)
    stream.stop()
    const afterStop = connections
    await vi.advanceTimersByTimeAsync(1_000)
    expect(connections).toBe(afterStop)
    vi.useRealTimers()
  })

  it("retries after a failed (non-200) response", async () => {
    vi.useFakeTimers()
    let attempts = 0
    let succeeded = false
    const fetchMock = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) {
        return new Response("nope", { status: 500 })
      }
      if (!succeeded) {
        // emit the event exactly once; later reconnects stay open without data
        succeeded = true
        return sseResponse([ev(1, "board.deleted", {})])
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<ReadResult<Uint8Array>>(() => {})
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )
    })
    const onEvent = vi.fn()

    const stream = new EventStream({
      url: "http://x/events",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent,
      reconnect: true,
      minBackoffMs: 10,
    })
    void stream.start()
    await vi.advanceTimersByTimeAsync(500)

    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(onEvent).toHaveBeenCalledTimes(1)
    stream.stop()
    vi.useRealTimers()
  })
})
