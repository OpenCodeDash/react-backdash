import { vi } from "vitest"
import type { Account, Board, Column, Tag, Task, TaskPriority } from "../src/types"

export interface RecordedCall {
  method: string
  path: string
  body?: unknown
  headers?: Record<string, string>
}

const FIXED_DATE = "2026-01-01T00:00:00.000Z"

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const out: Record<string, string> = {}
    headers.forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

function bearer(headers: Record<string, string>): string {
  const header = headers.Authorization ?? headers.authorization ?? ""
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
}

export function nestError(status: number, message: string): Response {
  return new Response(JSON.stringify({ statusCode: status, message, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function noContent(): Response {
  return new Response(null, { status: 204 })
}

// A tiny in-memory stand-in for the backdash API: board + column CRUD on the
// real routes, plus a /events SSE endpoint that either stays open (default) or
// emits a single preloaded frame and closes.
export function createFakeServer(sseFrame?: string) {
  const boards = new Map<string, Board>()
  let boardCounter = 0
  let columnCounter = 0
  let taskCounter = 0
  let tagCounter = 0
  const calls: RecordedCall[] = []

  // Minimal identity store for the /auth routes. `tokens` maps an issued token
  // to the account name; registration/login rotate it.
  const accounts = new Map<string, { account: Account; password: string }>()
  const tokens = new Map<string, string>()
  let accountCounter = 0
  let tokenCounter = 0

  function issueToken(name: string): string {
    const token = `bdsk_${name}_${++tokenCounter}`
    tokens.set(token, name)
    return token
  }

  const reindexTasks = (tasks: Task[]): Task[] =>
    tasks.map((t, i) => ({ ...t, position: i }))

  const resolveTags = (board: Board, tagIds?: number[]): Tag[] =>
    tagIds ? tagIds.map((id) => board.tags.find((t) => t.id === id)).filter((t): t is Tag => !!t) : []

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace(/^http:\/\/fake/, "")
    const method = init?.method ?? "GET"
    const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as never) : undefined
    const headers = normalizeHeaders(init?.headers)
    calls.push({ method, path, body, headers })

    if (path === "/events") {
      const signal = init?.signal as AbortSignal | undefined
      const encoder = new TextEncoder()
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (sseFrame) {
            controller.enqueue(encoder.encode(sseFrame))
            controller.close()
          }
        },
        pull() {
          if (sseFrame) return { value: undefined, done: true }
          return new Promise<ReadResult<Uint8Array>>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          })
        },
      })
      return new Response(bodyStream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    }

    // /auth/* — a minimal identity service. Tokens map to account names.
    if (path === "/auth/register" && method === "POST") {
      const { name, password } = body as { name: string; password: string }
      // Mirrors the real server: open only for the first (admin) account.
      if (accounts.size > 0) return nestError(403, "Registration is closed")
      if (accounts.has(name)) return nestError(409, `Account ${name} already exists`)
      const account: Account = {
        id: `a${String(++accountCounter).padStart(5, "0")}`,
        name,
        kind: "user",
        isAdmin: true,
        createdAt: FIXED_DATE,
      }
      accounts.set(name, { account, password })
      return json({ account, token: issueToken(name) }, 201)
    }

    if (path === "/auth/users" && method === "POST") {
      const caller = tokens.get(bearer(headers))
      const current = caller ? accounts.get(caller) : undefined
      if (!current) return nestError(401, "Invalid bearer token")
      if (!current.account.isAdmin) return nestError(403, "Admin account required")
      const { name, password, isAdmin } = body as {
        name: string
        password: string
        isAdmin?: boolean
      }
      if (accounts.has(name)) return nestError(409, `Account ${name} already exists`)
      const account: Account = {
        id: `a${String(++accountCounter).padStart(5, "0")}`,
        name,
        kind: "user",
        isAdmin: !!isAdmin,
        createdAt: FIXED_DATE,
      }
      accounts.set(name, { account, password })
      return json({ account, token: issueToken(name) }, 201)
    }

    if (path === "/auth/login" && method === "POST") {
      const { name, password } = body as { name: string; password: string }
      const existing = accounts.get(name)
      if (!existing || existing.password !== password) {
        return nestError(401, "Invalid name or password")
      }
      return json({ account: existing.account, token: issueToken(name) })
    }

    if (path === "/auth/me" && method === "GET") {
      const name = tokens.get(bearer(headers))
      if (!name) return nestError(401, "Invalid bearer token")
      return json(accounts.get(name)!.account)
    }

    if (path === "/auth/service" && (method === "GET" || method === "POST")) {
      const caller = tokens.get(bearer(headers))
      const current = caller ? accounts.get(caller) : undefined
      if (!current) return nestError(401, "Invalid bearer token")
      if (!current.account.isAdmin) return nestError(403, "Admin account required")

      if (method === "GET") {
        return json(
          [...accounts.values()]
            .map((entry) => entry.account)
            .filter((account) => account.kind === "service"),
        )
      }

      const { name: serviceName } = body as { name: string }
      if (accounts.has(serviceName)) {
        return nestError(409, `Account ${serviceName} already exists`)
      }
      const account: Account = {
        id: `a${String(++accountCounter).padStart(5, "0")}`,
        name: serviceName,
        kind: "service",
        isAdmin: false,
        createdAt: FIXED_DATE,
      }
      accounts.set(serviceName, { account, password: "" })
      return json({ account, token: issueToken(serviceName) }, 201)
    }

    if (path.startsWith("/auth/service/") && method === "DELETE") {
      const caller = tokens.get(bearer(headers))
      const current = caller ? accounts.get(caller) : undefined
      if (!current) return nestError(401, "Invalid bearer token")
      if (!current.account.isAdmin) return nestError(403, "Admin account required")
      const id = path.slice("/auth/service/".length)
      const entry = [...accounts.entries()].find(
        ([, value]) => value.account.id === id && value.account.kind === "service",
      )
      if (!entry) return nestError(404, `Service account ${id} not found`)
      accounts.delete(entry[0])
      return noContent()
    }

    const segments = path.split("/").filter(Boolean)

    // GET /kanban
    if (method === "GET" && segments.length === 1 && segments[0] === "kanban") {
      return json([...boards.values()].map(({ id, name }) => ({ id, name })))
    }

    // POST /kanban
    if (method === "POST" && segments.length === 1 && segments[0] === "kanban") {
      const { name } = body as { name: string }
      const id = `b${String(++boardCounter).padStart(5, "0")}`
      const board: Board = { id, name, columns: [], tags: [] }
      boards.set(id, board)
      return json(board, 201)
    }

    // /kanban/:id
    if (segments.length === 2 && segments[0] === "kanban") {
      const board = boards.get(segments[1])
      if (method === "GET") {
        return board ? json(board) : nestError(404, `Board ${segments[1]} not found`)
      }
      if (method === "PUT") {
        if (!board) return nestError(404, `Board ${segments[1]} not found`)
        const renamed = { ...board, name: (body as { name: string }).name }
        boards.set(segments[1], renamed)
        return json(renamed)
      }
      if (method === "DELETE") {
        if (!board) return nestError(404, `Board ${segments[1]} not found`)
        boards.delete(segments[1])
        return noContent()
      }
    }

    // /kanban/:boardId/tags[/:tagId]
    if (segments.length >= 3 && segments[0] === "kanban" && segments[2] === "tags") {
      const board = boards.get(segments[1])
      if (!board) return nestError(404, `Board ${segments[1]} not found`)

      if (segments.length === 3) {
        if (method === "GET") return json(board.tags)
        if (method === "POST") {
          const { name, description, prompt, color } = body as {
            name: string
            description?: string | null
            prompt?: string | null
            color?: string | null
          }
          if (board.tags.some((t) => t.name === name)) {
            return nestError(409, `A tag named '${name}' already exists on this board`)
          }
          const tag: Tag = {
            id: ++tagCounter,
            name,
            description: description ?? null,
            prompt: prompt ?? null,
            color: color ?? null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }
          boards.set(board.id, {
            ...board,
            tags: [...board.tags, tag].sort((a, b) => a.name.localeCompare(b.name)),
          })
          return json(tag, 201)
        }
      }

      if (segments.length === 4) {
        const tagId = Number(segments[3])
        const tag = board.tags.find((t) => t.id === tagId)
        if (!tag) return nestError(404, `Tag ${tagId} not found`)
        if (method === "PUT") {
          const next: Tag = {
            ...tag,
            ...(body as Partial<Tag>),
            id: tag.id,
            updatedAt: "2026-01-02T00:00:00.000Z",
          }
          boards.set(board.id, {
            ...board,
            tags: board.tags.map((t) => (t.id === tagId ? next : t)),
          })
          return json(next)
        }
        if (method === "DELETE") {
          const columns = board.columns.map((c) => ({
            ...c,
            tasks: c.tasks.map((t) => ({ ...t, tags: t.tags.filter((tt) => tt.id !== tagId) })),
          }))
          boards.set(board.id, {
            ...board,
            tags: board.tags.filter((t) => t.id !== tagId),
            columns,
          })
          return noContent()
        }
      }
    }

    // /kanban/:boardId/columns[/:columnId] and /order
    if (segments.length >= 3 && segments[0] === "kanban" && segments[2] === "columns") {
      const board = boards.get(segments[1])
      if (!board) return nestError(404, `Board ${segments[1]} not found`)

      if (method === "POST" && segments.length === 3) {
        const { name, isQueue } = body as { name: string; isQueue?: boolean }
        const column: Column = {
          id: ++columnCounter,
          name,
          position: board.columns.length,
          isQueue: isQueue ?? false,
          pushDescription: null,
          pullDescription: null,
          tasks: [],
        }
        boards.set(board.id, { ...board, columns: [...board.columns, column] })
        return json(column, 201)
      }

      if (segments.length === 4 && segments[3] === "order" && method === "PUT") {
        const { columnIds } = body as { columnIds: number[] }
        const columns = columnIds.map((id, i) => {
          const found = board.columns.find((c) => c.id === id)
          if (!found) throw new Error(`unknown column ${id}`)
          return { ...found, position: i }
        })
        boards.set(board.id, { ...board, columns: columns.sort((a, b) => a.position - b.position) })
        return json(columns)
      }

      if (segments.length === 4 && segments[3] !== "order") {
        const columnId = Number(segments[3])
        if (method === "PUT") {
          const columns = board.columns.map((c) =>
            c.id === columnId ? { ...c, ...(body as Partial<Column>) } : c,
          )
          boards.set(board.id, { ...board, columns })
          return json(columns.find((c) => c.id === columnId))
        }
        if (method === "DELETE") {
          boards.set(board.id, { ...board, columns: board.columns.filter((c) => c.id !== columnId) })
          return noContent()
        }
      }

      // /kanban/:boardId/columns/:columnId/tasks[...]
      if (segments.length >= 5 && segments[4] === "tasks") {
        const columnId = Number(segments[3])
        const column = board.columns.find((c) => c.id === columnId)
        if (!column) return nestError(404, `Column ${columnId} not found`)

        // POST .../tasks
        if (method === "POST" && segments.length === 5) {
          const input = body as {
            name: string
            description?: string
            priority?: TaskPriority | null
            estimate?: number | null
            assignee?: string | null
            dueAt?: string | null
            tagIds?: number[]
          }
          const task: Task = {
            id: ++taskCounter,
            columnId,
            name: input.name,
            description: input.description ?? null,
            position: column.tasks.length,
            claimedBy: null,
            priority: input.priority ?? null,
            estimate: input.estimate ?? null,
            assignee: input.assignee ?? null,
            dueAt: input.dueAt ?? null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            tags: resolveTags(board, input.tagIds),
          }
          const columns = board.columns.map((c) =>
            c.id === columnId ? { ...c, tasks: reindexTasks([...c.tasks, task]) } : c,
          )
          boards.set(board.id, { ...board, columns })
          return json(task, 201)
        }

        // PUT / DELETE .../tasks/:taskId
        if (segments.length === 6) {
          const taskId = Number(segments[5])
          const task = column.tasks.find((t) => t.id === taskId)
          if (!task) return nestError(404, `Task ${taskId} not found`)
          if (method === "PUT") {
            const { tagIds, ...patch } = body as { tagIds?: number[] } & Partial<Task>
            const next: Task = {
              ...task,
              ...patch,
              id: task.id,
              columnId,
              tags: tagIds ? resolveTags(board, tagIds) : task.tags,
              updatedAt: "2026-01-02T00:00:00.000Z",
            }
            const columns = board.columns.map((c) =>
              c.id === columnId
                ? { ...c, tasks: reindexTasks(c.tasks.map((t) => (t.id === taskId ? next : t))) }
                : c,
            )
            boards.set(board.id, { ...board, columns })
            return json(next)
          }
          if (method === "DELETE") {
            const columns = board.columns.map((c) =>
              c.id === columnId ? { ...c, tasks: c.tasks.filter((t) => t.id !== taskId) } : c,
            )
            boards.set(board.id, { ...board, columns })
            return noContent()
          }
        }

        // POST .../tasks/:taskId/(claim|release)
        if (method === "POST" && segments.length === 7) {
          const taskId = Number(segments[5])
          const action = segments[6]
          const task = column.tasks.find((t) => t.id === taskId)
          if (!task) return nestError(404, `Task ${taskId} not found`)
          if (action === "claim" && task.claimedBy) {
            return nestError(409, `Task ${taskId} is already claimed`)
          }
          if (action === "release" && !task.claimedBy) {
            return nestError(409, `Task ${taskId} is not claimed`)
          }
          const actor = (body as { actor?: string })?.actor
          const next: Task = {
            ...task,
            claimedBy: action === "claim" ? actor ?? "dashboard" : null,
          }
          const columns = board.columns.map((c) =>
            c.id === columnId
              ? { ...c, tasks: c.tasks.map((t) => (t.id === taskId ? next : t)) }
              : c,
          )
          boards.set(board.id, { ...board, columns })
          return json(next)
        }
      }
    }

    // /kanban/:boardId/tasks/:taskId/move
    if (
      method === "POST" &&
      segments.length === 5 &&
      segments[0] === "kanban" &&
      segments[2] === "tasks" &&
      segments[4] === "move"
    ) {
      const board = boards.get(segments[1])
      if (!board) return nestError(404, `Board ${segments[1]} not found`)
      const taskId = Number(segments[3])
      const { columnId, position } = body as { columnId: number; position?: number }
      const target = board.columns.find((c) => c.id === columnId)
      if (!target) return nestError(404, `Column ${columnId} not found`)
      let moved: Task | null = null
      let found = false
      const columns = board.columns.map((c) => {
        const task = c.tasks.find((t) => t.id === taskId)
        if (task) {
          moved = task
          found = true
        }
        return { ...c, tasks: c.tasks.filter((t) => t.id !== taskId) }
      })
      if (!found || !moved) return nestError(404, `Task ${taskId} not found`)
      const at = position === undefined ? target.tasks.length : Math.max(0, Math.min(position, target.tasks.length))
      const next: Task = { ...moved, columnId }
      const tasks = [...target.tasks]
      tasks.splice(at, 0, next)
      const withReindex = reindexTasks(tasks)
      const finalColumns = columns.map((c) =>
        c.id === columnId ? { ...c, tasks: withReindex } : c,
      )
      boards.set(board.id, { ...board, columns: finalColumns })
      return json(withReindex.find((t) => t.id === taskId)!)
    }

    return nestError(404, `no route for ${method} ${path}`)
  })

  function seed(overrides: { id: string; name?: string; columns?: Column[]; tags?: Tag[] }): Board {
    const columns = overrides.columns ?? []
    // keep generated ids clear of seeded ones
    columnCounter = Math.max(columnCounter, ...columns.map((c) => c.id))
    taskCounter = Math.max(taskCounter, ...columns.flatMap((c) => c.tasks.map((t) => t.id)))
    const tags = overrides.tags ?? []
    tagCounter = Math.max(tagCounter, ...tags.map((t) => t.id))
    const board: Board = {
      id: overrides.id,
      name: overrides.name ?? overrides.id,
      columns,
      tags,
    }
    boards.set(board.id, board)
    return board
  }

  return { fetchMock, calls, boards, seed }
}

export type FakeServer = ReturnType<typeof createFakeServer>
