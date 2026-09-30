import { describe, expect, it, vi } from "vitest"
import { createInitialStoreState, Store } from "../src/client/store"
import { makeBoard, makeBoardSummary, makeColumn, makeEvent, makeTask } from "./fixtures"

describe("Store", () => {
  it("starts with the initial state", () => {
    const store = new Store()
    expect(store.state).toEqual(createInitialStoreState())
  })

  it("notifies subscribers on every commit and supports unsubscribing", () => {
    const store = new Store()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.setBoards([makeBoardSummary({ id: "b1", name: "A" })])
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.setBoards([])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("setBoards sorts by name and commits a new array identity", () => {
    const store = new Store()
    store.setBoards([makeBoardSummary({ id: "b2", name: "Beta" }), makeBoardSummary({ id: "b1", name: "Alpha" })])
    expect(store.state.boards.map((b) => b.name)).toEqual(["Alpha", "Beta"])
    const snapshot = store.getSnapshot()
    store.setBoards([])
    expect(store.state.boards).toHaveLength(0)
    expect(snapshot.boards).toHaveLength(2)
  })

  it("upsertBoard inserts and replaces in place, keeping name order", () => {
    const store = new Store()
    store.setBoards([makeBoardSummary({ id: "b1", name: "A" }), makeBoardSummary({ id: "b2", name: "C" })])
    store.upsertBoard({ id: "b3", name: "B" })
    expect(store.state.boards.map((b) => b.id)).toEqual(["b1", "b3", "b2"])

    store.upsertBoard({ id: "b2", name: "Z" })
    expect(store.state.boards).toHaveLength(3)
    expect(store.state.boards.find((b) => b.id === "b2")?.name).toBe("Z")
    expect(store.state.boards.map((b) => b.id)).toEqual(["b1", "b3", "b2"])
  })

  it("removeBoard drops the summary and any loaded detail", () => {
    const store = new Store()
    const board = makeBoard([makeColumn()])
    store.setBoards([makeBoardSummary(board)])
    store.setBoardDetail(board)

    store.removeBoard(board.id)
    expect(store.state.boards).toHaveLength(0)
    expect(store.state.boardDetails[board.id]).toBeUndefined()
  })

  it("markSeq is monotonic", () => {
    const store = new Store()
    store.markSeq(10)
    expect(store.state.lastSeq).toBe(10)
    store.markSeq(5)
    expect(store.state.lastSeq).toBe(10)
    store.markSeq(11)
    expect(store.state.lastSeq).toBe(11)
  })

  it("setConnected is a no-op when unchanged", () => {
    const store = new Store()
    const listener = vi.fn()
    store.subscribe(listener)
    store.setConnected(false)
    expect(listener).not.toHaveBeenCalled()
    store.setConnected(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  describe("column patches", () => {
    it("are no-ops when the board detail is not loaded", () => {
      const store = new Store()
      const column = makeColumn({ id: 1, position: 0 })
      store.applyColumnAdded("b1", column)
      store.applyColumnUpdated("b1", column)
      store.applyColumnDeleted("b1", 1)
      store.applyColumnsReordered("b1", [column])
      expect(store.state.boardDetails).toEqual({})
    })

    it("applyColumnAdded appends and sorts by position", () => {
      const store = new Store()
      const board = makeBoard([makeColumn({ id: 2, name: "B", position: 1 })])
      store.setBoardDetail(board)

      store.applyColumnAdded(board.id, makeColumn({ id: 1, name: "A", position: 0 }))
      expect(store.state.boardDetails[board.id].columns.map((c) => c.id)).toEqual([1, 2])
    })

    it("applyColumnAdded is idempotent when the SSE event and HTTP response both carry the column", () => {
      const store = new Store()
      const board = makeBoard([makeColumn({ id: 1, name: "A", position: 0 })])
      store.setBoardDetail(board)
      const column = makeColumn({ id: 2, name: "B", position: 1 })

      // SSE event first, then the HTTP response (or vice versa): no duplicate
      store.applyColumnAdded(board.id, column)
      store.applyColumnAdded(board.id, { ...column })
      expect(store.state.boardDetails[board.id].columns).toHaveLength(2)
    })

    it("applyColumnUpdated replaces the matching column", () => {
      const store = new Store()
      const existing = makeColumn({ id: 1, name: "A", position: 0 })
      const board = makeBoard([existing, makeColumn({ id: 2, name: "B", position: 1 })])
      store.setBoardDetail(board)

      store.applyColumnUpdated(board.id, { ...existing, name: "Renamed" })
      const columns = store.state.boardDetails[board.id].columns
      expect(columns[0].name).toBe("Renamed")
      expect(columns).toHaveLength(2)
    })

    it("applyColumnDeleted removes the column", () => {
      const store = new Store()
      const board = makeBoard([makeColumn({ id: 1 }), makeColumn({ id: 2, position: 1 })])
      store.setBoardDetail(board)

      store.applyColumnDeleted(board.id, 1)
      expect(store.state.boardDetails[board.id].columns).toHaveLength(1)
      expect(store.state.boardDetails[board.id].columns[0].id).toBe(2)
    })

    it("applyColumnsReordered replaces the full column list", () => {
      const store = new Store()
      const board = makeBoard([makeColumn({ id: 1, name: "A", position: 0 }), makeColumn({ id: 2, name: "B", position: 1 })])
      store.setBoardDetail(board)

      store.applyColumnsReordered(board.id, [
        makeColumn({ id: 2, name: "B", position: 0 }),
        makeColumn({ id: 1, name: "A", position: 1 }),
      ])
      expect(store.state.boardDetails[board.id].columns.map((c) => c.id)).toEqual([2, 1])
    })
  })

  describe("task patches", () => {
    it("are no-ops when the board detail is not loaded", () => {
      const store = new Store()
      const task = makeTask({ id: 1, columnId: 1 })
      store.applyTaskUpsert("b1", task)
      store.applyTaskMoved("b1", task)
      store.applyTaskDeleted("b1", 1)
      expect(store.state.boardDetails).toEqual({})
    })

    it("applyTaskUpsert appends a new task and sorts by position", () => {
      const store = new Store()
      const board = makeBoard([
        makeColumn({ id: 1, tasks: [makeTask({ id: 2, columnId: 1, position: 1 })] }),
      ])
      store.setBoardDetail(board)

      store.applyTaskUpsert(board.id, makeTask({ id: 1, columnId: 1, position: 0 }))
      expect(store.state.boardDetails[board.id].columns[0].tasks.map((t) => t.id)).toEqual([1, 2])
    })

    it("applyTaskUpsert is idempotent when the SSE event and HTTP response both carry the task", () => {
      const store = new Store()
      const board = makeBoard([makeColumn({ id: 1, tasks: [] })])
      store.setBoardDetail(board)
      const task = makeTask({ id: 1, columnId: 1, position: 0 })

      store.applyTaskUpsert(board.id, task)
      store.applyTaskUpsert(board.id, { ...task })
      expect(store.state.boardDetails[board.id].columns[0].tasks).toHaveLength(1)
    })

    it("applyTaskUpsert replaces an existing task in place", () => {
      const store = new Store()
      const board = makeBoard([
        makeColumn({ id: 1, tasks: [makeTask({ id: 1, columnId: 1, name: "Old", position: 0 })] }),
      ])
      store.setBoardDetail(board)

      store.applyTaskUpsert(board.id, makeTask({ id: 1, columnId: 1, name: "New", position: 0 }))
      const tasks = store.state.boardDetails[board.id].columns[0].tasks
      expect(tasks).toHaveLength(1)
      expect(tasks[0].name).toBe("New")
    })

    it("applyTaskMoved reorders within a single column", () => {
      const store = new Store()
      const board = makeBoard([
        makeColumn({
          id: 1,
          tasks: [makeTask({ id: 1, columnId: 1, position: 0 }), makeTask({ id: 2, columnId: 1, position: 1 })],
        }),
      ])
      store.setBoardDetail(board)

      store.applyTaskMoved(board.id, makeTask({ id: 2, columnId: 1, position: 0 }))
      expect(store.state.boardDetails[board.id].columns[0].tasks.map((t) => t.id)).toEqual([2, 1])
    })

    it("applyTaskMoved transfers a task between columns", () => {
      const store = new Store()
      const board = makeBoard([
        makeColumn({ id: 1, tasks: [makeTask({ id: 1, columnId: 1, position: 0 })] }),
        makeColumn({ id: 2, tasks: [] }),
      ])
      store.setBoardDetail(board)

      store.applyTaskMoved(board.id, makeTask({ id: 1, columnId: 2, position: 0 }))
      expect(store.state.boardDetails[board.id].columns[0].tasks).toHaveLength(0)
      expect(store.state.boardDetails[board.id].columns[1].tasks.map((t) => t.id)).toEqual([1])
    })

    it("applyTaskDeleted removes the task from its column", () => {
      const store = new Store()
      const board = makeBoard([
        makeColumn({ id: 1, tasks: [makeTask({ id: 1, columnId: 1, position: 0 }), makeTask({ id: 2, columnId: 1, position: 1 })] }),
      ])
      store.setBoardDetail(board)

      store.applyTaskDeleted(board.id, 1)
      const tasks = store.state.boardDetails[board.id].columns[0].tasks
      expect(tasks).toHaveLength(1)
      expect(tasks[0].id).toBe(2)
    })
  })

  describe("apply(event)", () => {
    it("board.created upserts a summary", () => {
      const store = new Store()
      store.apply(makeEvent("b1", "board.created", { id: "b1", name: "New" }))
      expect(store.state.boards).toEqual([{ id: "b1", name: "New" }])
    })

    it("board.updated refreshes a loaded detail but never creates one", () => {
      const store = new Store()
      const board = makeBoard([makeColumn({ id: 1 })])
      store.setBoardDetail(board)

      store.apply(
        makeEvent(board.id, "board.updated", { id: board.id, name: "Renamed", columns: [makeColumn({ id: 2 })] }),
      )
      const detail = store.state.boardDetails[board.id]
      expect(detail.name).toBe("Renamed")
      expect(detail.columns.map((c) => c.id)).toEqual([2])

      // not loaded -> summary only
      store.apply(makeEvent("b9", "board.updated", { id: "b9", name: "Other", columns: [] }))
      expect(store.state.boardDetails["b9"]).toBeUndefined()
      expect(store.state.boards.some((b) => b.id === "b9")).toBe(true)
    })

    it("board.deleted removes the board", () => {
      const store = new Store()
      const board = makeBoard([makeColumn()])
      store.setBoards([makeBoardSummary(board)])
      store.setBoardDetail(board)

      store.apply(makeEvent(board.id, "board.deleted", {}))
      expect(store.state.boards).toHaveLength(0)
      expect(store.state.boardDetails[board.id]).toBeUndefined()
    })

    it("column.* events patch a loaded detail", () => {
      const store = new Store()
      const board = makeBoard([makeColumn({ id: 1, name: "A", position: 0 })])
      store.setBoardDetail(board)

      store.apply(makeEvent(board.id, "column.added", makeColumn({ id: 2, name: "B", position: 1 })))
      expect(store.state.boardDetails[board.id].columns).toHaveLength(2)

      store.apply(makeEvent(board.id, "column.updated", { ...makeColumn({ id: 1 }), name: "A2" }))
      expect(store.state.boardDetails[board.id].columns[0].name).toBe("A2")

      store.apply(makeEvent(board.id, "column.reordered", { columns: [makeColumn({ id: 2, position: 0 }), makeColumn({ id: 1, name: "A2", position: 1 })] }))
      expect(store.state.boardDetails[board.id].columns.map((c) => c.id)).toEqual([2, 1])

      store.apply(makeEvent(board.id, "column.deleted", { id: 2 }))
      expect(store.state.boardDetails[board.id].columns).toHaveLength(1)
    })

    it("task events for an unloaded detail are no-ops but still advance seq", () => {
      const store = new Store()
      const board = makeBoard([makeColumn()])
      store.setBoards([makeBoardSummary(board)])
      // no setBoardDetail: the board was never opened

      store.apply(makeEvent(board.id, "task.created", makeTask({ id: 99, columnId: 1 }), { seq: 77 }))
      expect(store.state.boardDetails).toEqual({})
      expect(store.state.lastSeq).toBe(77)
    })

    it("ignores genuinely unknown event types but still advances seq", () => {
      const store = new Store()
      const board = makeBoard([makeColumn()])
      store.setBoards([makeBoardSummary(board)])
      store.setBoardDetail(board)

      store.apply(
        makeEvent(board.id, "board.archived" as never, {}, { seq: 77 }),
      )
      expect(store.state.boardDetails[board.id].columns).toHaveLength(1)
      expect(store.state.lastSeq).toBe(77)
    })

    it("task.* events upsert, move, and delete within a loaded detail", () => {
      const store = new Store()
      const board = makeBoard([
        makeColumn({ id: 1, name: "Todo", position: 0, tasks: [makeTask({ id: 1, columnId: 1, position: 0 })] }),
        makeColumn({ id: 2, name: "Done", position: 1, tasks: [] }),
      ])
      store.setBoardDetail(board)
      const detail = () => store.state.boardDetails[board.id]

      store.apply(makeEvent(board.id, "task.created", makeTask({ id: 2, columnId: 1, position: 1 })))
      expect(detail().columns[0].tasks.map((t) => t.id)).toEqual([1, 2])

      store.apply(makeEvent(board.id, "task.claimed", makeTask({ id: 1, columnId: 1, position: 0, claimedBy: "agent-1" })))
      expect(detail().columns[0].tasks[0].claimedBy).toBe("agent-1")

      store.apply(makeEvent(board.id, "task.moved", makeTask({ id: 2, columnId: 2, position: 0 })))
      expect(detail().columns[0].tasks.map((t) => t.id)).toEqual([1])
      expect(detail().columns[1].tasks.map((t) => t.id)).toEqual([2])

      store.apply(makeEvent(board.id, "task.deleted", { id: 1, name: "Task 1", columnId: 1 }))
      expect(detail().columns[0].tasks).toHaveLength(0)
      expect(detail().columns[1].tasks.map((t) => t.id)).toEqual([2])
    })

    it("is idempotent: events with seq <= lastSeq are ignored", () => {
      const store = new Store()
      const created = makeEvent("b1", "board.created", { id: "b1", name: "A" })
      store.apply(created)
      const version = store.state.version

      // same seq again (optimistic sync + SSE round trip)
      store.apply({ ...created, type: "board.updated", payload: { id: "b1", name: "A", columns: [] } })
      expect(store.state.version).toBe(version)
      expect(store.state.boards).toHaveLength(1)

      // a lower seq is dropped too
      const dup = makeEvent("b0", "board.created", { id: "b0", name: "Dup" }, { seq: store.state.lastSeq - 1 })
      store.apply(dup)
      expect(store.state.boards.some((b) => b.id === "b0")).toBe(false)
    })

    it("advances lastSeq to the applied event's seq", () => {
      const store = new Store()
      store.apply(makeEvent("b1", "board.created", { id: "b1", name: "A" }, { seq: 41 }))
      expect(store.state.lastSeq).toBe(41)
    })
  })
})


