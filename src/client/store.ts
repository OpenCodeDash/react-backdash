import type {
  BackdashEvent,
  Board,
  BoardEventPayload,
  BoardSummary,
  Column,
  Tag,
  Task,
} from "../types"

export interface StoreState {
  connected: boolean
  boards: BoardSummary[]
  // Detail of boards the client has explicitly loaded
  boardDetails: Record<string, Board>
  // Highest event seq observed; used as the resume point on reconnect
  lastSeq: number
  version: number
}

export type StoreListener = () => void

export function createInitialStoreState(): StoreState {
  return {
    connected: false,
    boards: [],
    boardDetails: {},
    lastSeq: 0,
    version: 0,
  }
}

function byName(a: BoardSummary, b: BoardSummary): number {
  return a.name.localeCompare(b.name)
}

function byPosition(a: Column, b: Column): number {
  return a.position - b.position
}

function byTaskPosition(a: Task, b: Task): number {
  return a.position - b.position
}

function byTagName(a: Tag, b: Tag): number {
  return a.name.localeCompare(b.name)
}

export class Store {
  state: StoreState

  private listeners = new Set<StoreListener>()

  constructor(initial?: StoreState) {
    this.state = initial ?? createInitialStoreState()
  }

  subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): StoreState => this.state

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private commit(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 }
    this.emit()
  }

  setConnected(connected: boolean): void {
    if (this.state.connected === connected) return
    this.commit({ connected })
  }

  // Advance the resume point, monotonically.
  markSeq(seq: number): void {
    if (seq <= this.state.lastSeq) return
    this.commit({ lastSeq: seq })
  }

  setBoards(boards: BoardSummary[]): void {
    this.commit({ boards: [...boards].sort(byName) })
  }

  upsertBoard(summary: BoardSummary): void {
    const boards = this.state.boards.filter((b) => b.id !== summary.id)
    boards.push(summary)
    this.commit({ boards: boards.sort(byName) })
  }

  removeBoard(id: string): void {
    if (!this.state.boards.some((b) => b.id === id)) return
    const boardDetails = { ...this.state.boardDetails }
    delete boardDetails[id]
    this.commit({
      boards: this.state.boards.filter((b) => b.id !== id),
      boardDetails,
    })
  }

  setBoardDetail(board: Board): void {
    this.commit({
      boardDetails: { ...this.state.boardDetails, [board.id]: board },
    })
  }

  clearBoardDetail(id: string): void {
    if (!(id in this.state.boardDetails)) return
    const boardDetails = { ...this.state.boardDetails }
    delete boardDetails[id]
    this.commit({ boardDetails })
  }

  // ---------- Column patches (no-op unless the board's detail is loaded) ----------

  applyColumnAdded(boardId: string, column: Column): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    // The column may already be present: the SSE event and the HTTP response
    // both carry it, in either order
    if (detail.columns.some((c) => c.id === column.id)) return
    const columns = [...detail.columns, column].sort(byPosition)
    this.setBoardDetail({ ...detail, columns })
  }

  applyColumnUpdated(boardId: string, column: Column): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    const columns = detail.columns.map((c) => (c.id === column.id ? column : c))
    this.setBoardDetail({ ...detail, columns })
  }

  applyColumnDeleted(boardId: string, columnId: number): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    const columns = detail.columns.filter((c) => c.id !== columnId)
    this.setBoardDetail({ ...detail, columns })
  }

  applyColumnsReordered(boardId: string, columns: Column[]): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    this.setBoardDetail({ ...detail, columns: [...columns].sort(byPosition) })
  }

  // ---------- Task patches (no-op unless the board's detail is loaded) ----------

  // Upserts a task into the column its columnId points at. The HTTP response
  // and the SSE event both carry the full task, in either order.
  applyTaskUpsert(boardId: string, task: Task): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    const columns = detail.columns.map((c) => {
      if (c.id !== task.columnId) return c
      const exists = c.tasks.some((t) => t.id === task.id)
      const tasks = exists
        ? c.tasks.map((t) => (t.id === task.id ? task : t)).sort(byTaskPosition)
        : [...c.tasks, task].sort(byTaskPosition)
      return { ...c, tasks }
    })
    this.setBoardDetail({ ...detail, columns })
  }

  // Removes the task from wherever it is, then inserts it into its (new)
  // column at its position, reindexing the surviving tasks. Covers both
  // within-column reorders and cross-column moves; only the moved task's new
  // position arrives over the wire, so the column must be renumbered here,
  // exactly as the server does.
  applyTaskMoved(boardId: string, task: Task): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    const columns = detail.columns.map((c) => {
      const without = c.tasks.filter((t) => t.id !== task.id)
      if (c.id !== task.columnId) return { ...c, tasks: without }
      const at = Math.max(0, Math.min(task.position, without.length))
      const tasks = [...without]
      tasks.splice(at, 0, { ...task, position: at })
      return { ...c, tasks: tasks.map((t, i) => ({ ...t, position: i })) }
    })
    this.setBoardDetail({ ...detail, columns })
  }

  applyTaskDeleted(boardId: string, taskId: number): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    const columns = detail.columns.map((c) => ({
      ...c,
      tasks: c.tasks.filter((t) => t.id !== taskId),
    }))
    this.setBoardDetail({ ...detail, columns })
  }

  // ---------- Tag patches (no-op unless the board's detail is loaded) ----------

  // Upserts a tag into the board's tag list. The HTTP response and the SSE
  // event both carry the full tag, in either order.
  applyTagAdded(boardId: string, tag: Tag): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    const tags = detail.tags.filter((t) => t.id !== tag.id)
    tags.push(tag)
    this.setBoardDetail({ ...detail, tags: tags.sort(byTagName) })
  }

  // A tag rename/field change must reach every task carrying the tag, not just
  // the board's tag list. Tasks without the tag keep their identity.
  applyTagUpdated(boardId: string, tag: Tag): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    const tags = detail.tags.map((t) => (t.id === tag.id ? tag : t)).sort(byTagName)
    const columns = detail.columns.map((c) => ({
      ...c,
      tasks: c.tasks.map((t) =>
        t.tags.some((onTask) => onTask.id === tag.id)
          ? {
              ...t,
              tags: t.tags
                .map((onTask) => (onTask.id === tag.id ? tag : onTask))
                .sort(byTagName),
            }
          : t,
      ),
    }))
    this.setBoardDetail({ ...detail, tags, columns })
  }

  applyTagDeleted(boardId: string, tagId: number): void {
    const detail = this.state.boardDetails[boardId]
    if (!detail) return
    const tags = detail.tags.filter((t) => t.id !== tagId)
    const columns = detail.columns.map((c) => ({
      ...c,
      tasks: c.tasks.map((t) =>
        t.tags.some((onTask) => onTask.id === tagId)
          ? { ...t, tags: t.tags.filter((onTask) => onTask.id !== tagId) }
          : t,
      ),
    }))
    this.setBoardDetail({ ...detail, tags, columns })
  }

  // ---------- Event application ----------

  // Idempotent: events with seq <= lastSeq are ignored, so optimistic
  // mutation sync and the SSE event never double-apply.
  apply(event: BackdashEvent): void {
    if (event.seq <= this.state.lastSeq) return
    this.commit({ lastSeq: event.seq })

    switch (event.type) {
      case "board.created":
      case "board.updated": {
        const payload = event.payload as BoardEventPayload
        this.upsertBoard({ id: payload.id, name: payload.name })
        // The payload is a full BoardDetail and authoritative for a loaded
        // detail; never create one for a board that was not opened
        const existing = this.state.boardDetails[payload.id]
        if (existing) {
          this.setBoardDetail({
            id: payload.id,
            name: payload.name,
            columns: payload.columns ?? existing.columns,
            tags: payload.tags ?? existing.tags,
          })
        }
        return
      }
      case "board.deleted":
        this.removeBoard(event.boardId)
        return
      case "column.added":
        this.applyColumnAdded(event.boardId, event.payload as Column)
        return
      case "column.updated":
        this.applyColumnUpdated(event.boardId, event.payload as Column)
        return
      case "column.deleted": {
        const { id } = event.payload as { id: number }
        this.applyColumnDeleted(event.boardId, id)
        return
      }
      case "column.reordered": {
        const { columns } = event.payload as { columns?: Column[] }
        if (columns) this.applyColumnsReordered(event.boardId, columns)
        return
      }
      case "task.created":
      case "task.updated":
      case "task.claimed":
      case "task.released":
        this.applyTaskUpsert(event.boardId, event.payload as Task)
        return
      case "task.moved":
        this.applyTaskMoved(event.boardId, event.payload as Task)
        return
      case "task.deleted": {
        const { id } = event.payload as { id: number }
        this.applyTaskDeleted(event.boardId, id)
        return
      }
      case "tag.added":
        this.applyTagAdded(event.boardId, event.payload as Tag)
        return
      case "tag.updated":
        this.applyTagUpdated(event.boardId, event.payload as Tag)
        return
      case "tag.deleted": {
        const { id } = event.payload as { id: number }
        this.applyTagDeleted(event.boardId, id)
        return
      }
      default:
        // future event types are ignored
        return
    }
  }
}
