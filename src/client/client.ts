import { EventStream, type EventStreamOptions } from "./events"
import { Store, createInitialStoreState, type StoreState } from "./store"
import type { BackdashEvent, Board, BoardSummary, Column, Task } from "../types"

export class BackdashError extends Error {
  status: number
  body: unknown

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = "BackdashError"
    this.status = status
    this.body = body
  }
}

export interface BackdashClientOptions {
  url?: string
  fetchImpl?: typeof fetch
  headers?: Record<string, string>
  autoConnect?: boolean
  reconnect?: boolean
  minBackoffMs?: number
  maxBackoffMs?: number
  store?: Store
}

export class BackdashClient {
  readonly url: string
  readonly store: Store
  private fetchImpl: typeof fetch
  private headers: Record<string, string>
  private stream: EventStream | null = null
  private loadedDetails = new Set<string>()
  private loadQueue = new Map<string, Promise<void>>()
  private options: BackdashClientOptions

  constructor(options: BackdashClientOptions = {}) {
    this.url = (options.url ?? "http://localhost:3000").replace(/\/$/, "")
    this.fetchImpl = options.fetchImpl ?? fetch
    this.headers = { "Content-Type": "application/json", ...options.headers }
    this.options = options
    this.store = options.store ?? new Store(createInitialStoreState())
    if (options.autoConnect) void this.connect()
  }

  get connected(): boolean {
    return this.store.state.connected
  }

  // ---------- HTTP ----------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // call through a local binding: a bare `this.fetchImpl(...)` would pass the
    // client as `this`, which the native browser `fetch` rejects
    const doFetch = this.fetchImpl
    const response = await doFetch(`${this.url}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const data: unknown = text.length > 0 ? JSON.parse(text) : null
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "message" in data && data.message
          ? String(data.message)
          : `request failed: ${response.status} ${response.statusText}`
      throw new BackdashError(response.status, message, data)
    }
    return data as T
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path)
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body ?? {})
  }

  private put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body ?? {})
  }

  private del(path: string): Promise<void> {
    return this.request<void>("DELETE", path)
  }

  // ---------- Connection ----------

  async connect(): Promise<void> {
    if (this.stream) return
    const opts: EventStreamOptions = {
      url: `${this.url}/events`,
      fetchImpl: this.fetchImpl,
      lastEventId: () => (this.store.state.lastSeq > 0 ? this.store.state.lastSeq : undefined),
      onEvent: (event) => this.applyEvent(event),
      onResync: () => {
        void this.hydrate()
      },
      onConnected: () => {
        this.store.setConnected(true)
        void this.hydrate()
      },
      onDisconnected: () => this.store.setConnected(false),
      reconnect: this.options.reconnect ?? true,
      minBackoffMs: this.options.minBackoffMs,
      maxBackoffMs: this.options.maxBackoffMs,
    }
    this.stream = new EventStream(opts)
    void this.stream.start()
  }

  disconnect(): void {
    this.stream?.stop()
    this.stream = null
    this.store.setConnected(false)
  }

  private applyEvent(event: BackdashEvent): void {
    // board.created / board.updated carry the board in their payload, so they
    // never indicate a missed board. Any other event for a board we have never
    // seen means we were offline through its creation: refetch to self-heal.
    const known =
      event.type === "board.created" ||
      event.type === "board.updated" ||
      this.store.state.boards.some((b) => b.id === event.boardId)
    this.store.apply(event)
    if (!known) void this.hydrateBoards()
  }

  private async hydrateBoards(): Promise<void> {
    try {
      const boards = await this.listBoards()
      this.store.setBoards(boards)
    } catch {
      // best-effort; the next event or reconnect retries
    }
  }

  private async hydrate(): Promise<void> {
    await this.hydrateBoards()
    await Promise.all(
      [...this.loadedDetails].map(async (id) => {
        try {
          await this.refreshBoardDetail(id)
        } catch {
          // the board went away while we were offline
          this.loadedDetails.delete(id)
          this.store.clearBoardDetail(id)
        }
      }),
    )
  }

  // ---------- Boards ----------

  listBoards(): Promise<BoardSummary[]> {
    return this.get<BoardSummary[]>("/kanban")
  }

  getBoard(id: string): Promise<Board> {
    return this.get<Board>(`/kanban/${id}`)
  }

  // Fetch a board's detail into the store, unless events arrived while the
  // request was in flight: an in-flight GET can resolve with state older than
  // events we already applied, and writing it would roll them back. On a first
  // load there is no local state to roll back, so always write.
  private async refreshBoardDetail(id: string): Promise<void> {
    const hadDetail = this.loadedDetails.has(id)
    const seqBefore = this.store.state.lastSeq
    const board = await this.getBoard(id)
    if (!hadDetail || this.store.state.lastSeq === seqBefore) {
      this.store.setBoardDetail(board)
    }
  }

  // Load (or reload) a board's detail into the store. Deduped per board; a
  // 404 clears any stale detail and resolves rather than rejecting.
  async loadBoard(id: string): Promise<void> {
    const pending = this.loadQueue.get(id)
    if (pending) return pending
    const task = (async () => {
      try {
        await this.refreshBoardDetail(id)
        this.loadedDetails.add(id)
      } catch (error) {
        if (error instanceof BackdashError && error.status === 404) {
          this.loadedDetails.delete(id)
          this.store.clearBoardDetail(id)
          return
        }
        throw error
      }
    })()
    this.loadQueue.set(id, task)
    try {
      await task
    } finally {
      this.loadQueue.delete(id)
    }
  }

  createBoard(name: string): Promise<Board> {
    // The server emits board.created, so this local sync is idempotent; it
    // just makes the UI snappy without waiting on the SSE round trip.
    return this.post<Board>("/kanban", { name }).then((board) => {
      this.store.upsertBoard({ id: board.id, name: board.name })
      return board
    })
  }

  renameBoard(id: string, name: string): Promise<Board> {
    return this.put<Board>(`/kanban/${id}`, { name }).then((board) => {
      this.store.upsertBoard({ id: board.id, name: board.name })
      if (this.loadedDetails.has(id)) this.store.setBoardDetail(board)
      return board
    })
  }

  deleteBoard(id: string): Promise<void> {
    return this.del(`/kanban/${id}`).then(() => {
      this.loadedDetails.delete(id)
      this.store.removeBoard(id)
      // removeBoard is a no-op when the summary list was never hydrated, so
      // the loaded detail must be cleared explicitly
      this.store.clearBoardDetail(id)
    })
  }

  // ---------- Columns ----------

  createColumn(boardId: string, input: { name: string; isQueue?: boolean }): Promise<Column> {
    return this.post<Column>(`/kanban/${boardId}/columns`, input).then((column) => {
      this.store.applyColumnAdded(boardId, column)
      return column
    })
  }

  updateColumn(
    boardId: string,
    columnId: number,
    input: {
      name?: string
      isQueue?: boolean
      pushDescription?: string | null
      pullDescription?: string | null
    },
  ): Promise<Column> {
    return this.put<Column>(`/kanban/${boardId}/columns/${columnId}`, input).then((column) => {
      this.store.applyColumnUpdated(boardId, column)
      return column
    })
  }

  deleteColumn(boardId: string, columnId: number): Promise<void> {
    return this.del(`/kanban/${boardId}/columns/${columnId}`).then(() => {
      this.store.applyColumnDeleted(boardId, columnId)
    })
  }

  reorderColumns(boardId: string, columnIds: number[]): Promise<Column[]> {
    return this.put<Column[]>(`/kanban/${boardId}/columns/order`, { columnIds }).then(
      (columns) => {
        this.store.applyColumnsReordered(boardId, columns)
        return columns
      },
    )
  }

  // ---------- Tasks ----------

  createTask(
    boardId: string,
    columnId: number,
    input: { name: string; description?: string },
  ): Promise<Task> {
    return this.post<Task>(`/kanban/${boardId}/columns/${columnId}/tasks`, input).then((task) => {
      this.store.applyTaskUpsert(boardId, task)
      return task
    })
  }

  updateTask(
    boardId: string,
    columnId: number,
    taskId: number,
    input: { name?: string; description?: string },
  ): Promise<Task> {
    return this.put<Task>(`/kanban/${boardId}/columns/${columnId}/tasks/${taskId}`, input).then(
      (task) => {
        this.store.applyTaskUpsert(boardId, task)
        return task
      },
    )
  }

  deleteTask(boardId: string, columnId: number, taskId: number): Promise<void> {
    return this.del(`/kanban/${boardId}/columns/${columnId}/tasks/${taskId}`).then(() => {
      this.store.applyTaskDeleted(boardId, taskId)
    })
  }

  // Moves a task to a (possibly other) column. The response carries the task's
  // new columnId, so the patch is routed by that.
  moveTask(boardId: string, taskId: number, input: { columnId: number; position?: number }): Promise<Task> {
    return this.post<Task>(`/kanban/${boardId}/tasks/${taskId}/move`, input).then((task) => {
      this.store.applyTaskMoved(boardId, task)
      return task
    })
  }

  claimTask(boardId: string, columnId: number, taskId: number, actor?: string): Promise<Task> {
    return this.post<Task>(`/kanban/${boardId}/columns/${columnId}/tasks/${taskId}/claim`, {
      actor,
    }).then((task) => {
      this.store.applyTaskUpsert(boardId, task)
      return task
    })
  }

  releaseTask(boardId: string, columnId: number, taskId: number): Promise<Task> {
    return this.post<Task>(`/kanban/${boardId}/columns/${columnId}/tasks/${taskId}/release`).then(
      (task) => {
        this.store.applyTaskUpsert(boardId, task)
        return task
      },
    )
  }
}

export function createClient(options: BackdashClientOptions = {}): BackdashClient {
  return new BackdashClient(options)
}

export type { StoreState }
