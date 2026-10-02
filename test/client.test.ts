import { describe, expect, it, vi } from "vitest"
import { BackdashClient, BackdashError, createClient } from "../src/client/client"
import { makeColumn, makeTag, makeTask } from "./fixtures"
import { createFakeServer, type FakeServer } from "./fake-server"

function makeClient(server: FakeServer): BackdashClient {
  return createClient({ url: "http://fake", fetchImpl: server.fetchMock as unknown as typeof fetch })
}

describe("BackdashClient HTTP", () => {
  it("normalizes a trailing slash on the base url", async () => {
    const server = createFakeServer()
    const client = createClient({ url: "http://fake/", fetchImpl: server.fetchMock as unknown as typeof fetch })
    await client.listBoards()
    expect(server.calls[0].path).toBe("/kanban")
  })

  it("throws BackdashError with the Nest message on failure", async () => {
    const server = createFakeServer()
    const client = makeClient(server)
    await expect(client.getBoard("missing")).rejects.toMatchObject({
      name: "BackdashError",
      status: 404,
      message: "Board missing not found",
    })
    const error = (await client.getBoard("missing").catch((e: unknown) => e)) as BackdashError
    expect(error.body).toMatchObject({ statusCode: 404 })
  })

  it("listBoards returns summaries", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "Alpha" })
    const client = makeClient(server)
    const boards = await client.listBoards()
    expect(boards).toEqual([{ id: "b1", name: "Alpha" }])
  })
})

describe("BackdashClient boards", () => {
  it("createBoard posts the name and upserts the summary", async () => {
    const server = createFakeServer()
    const client = makeClient(server)

    const board = await client.createBoard("New Board")
    expect(server.calls[0]).toMatchObject({ method: "POST", path: "/kanban", body: { name: "New Board" } })
    expect(board.name).toBe("New Board")
    expect(client.store.state.boards).toEqual([{ id: board.id, name: "New Board" }])
  })

  it("renameBoard updates the summary and, when loaded, the detail", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "Old" })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const renamed = await client.renameBoard("b1", "New")
    expect(server.calls.at(-1)).toMatchObject({ method: "PUT", path: "/kanban/b1", body: { name: "New" } })
    expect(renamed.name).toBe("New")
    expect(client.store.state.boards.find((b) => b.id === "b1")?.name).toBe("New")
    expect(client.store.state.boardDetails["b1"].name).toBe("New")
  })

  it("deleteBoard removes the board from the store", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "Gone" })
    const client = makeClient(server)

    await client.loadBoard("b1")
    await client.deleteBoard("b1")
    expect(server.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/kanban/b1" })
    expect(client.store.state.boards).toHaveLength(0)
    expect(client.store.state.boardDetails["b1"]).toBeUndefined()
  })

  it("loadBoard stores the detail", async () => {
    const server = createFakeServer()
    const column = makeColumn({ id: 1, position: 0 })
    server.seed({ id: "b1", name: "B", columns: [column] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    expect(client.store.state.boardDetails["b1"]).toEqual({
      id: "b1",
      name: "B",
      columns: [column],
      tags: [],
    })
  })

  it("loadBoard resolves on 404 and clears stale detail", async () => {
    const server = createFakeServer()
    const client = makeClient(server)

    await expect(client.loadBoard("ghost")).resolves.toBeUndefined()
    expect(client.store.state.boardDetails["ghost"]).toBeUndefined()

    // a later real load refetches (the board was not remembered as loaded)
    server.seed({ id: "ghost", name: "Ghost" })
    await client.loadBoard("ghost")
    expect(client.store.state.boardDetails["ghost"]?.name).toBe("Ghost")
    const gets = server.calls.filter((c) => c.method === "GET" && c.path === "/kanban/ghost")
    expect(gets).toHaveLength(2)
  })

  it("loadBoard dedupes concurrent loads", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B" })
    const client = makeClient(server)

    await Promise.all([client.loadBoard("b1"), client.loadBoard("b1")])
    const gets = server.calls.filter((c) => c.method === "GET" && c.path === "/kanban/b1")
    expect(gets).toHaveLength(1)
  })
})

describe("BackdashClient columns", () => {
  it("createColumn posts and patches a loaded detail", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B", columns: [makeColumn({ id: 1, position: 0 })] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const column = await client.createColumn("b1", { name: "Inbox", isQueue: true })
    expect(server.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/kanban/b1/columns",
      body: { name: "Inbox", isQueue: true },
    })
    expect(column.isQueue).toBe(true)
    expect(client.store.state.boardDetails["b1"].columns).toHaveLength(2)
    expect(client.store.state.boardDetails["b1"].columns.at(-1)?.name).toBe("Inbox")
  })

  it("a replayed column.added event does not duplicate a column already in the detail", async () => {
    const column = makeColumn({ id: 1, name: "Inbox", position: 0 })
    const event = {
      seq: 1,
      boardId: "b1",
      type: "column.added",
      actor: "dashboard",
      payload: column,
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    // the server already has the column (created while we were offline); the
    // preloaded frame replays its creation on connect
    const server = createFakeServer(`id: 1\ndata: ${JSON.stringify(event)}\n\n`)
    server.seed({ id: "b1", name: "B", columns: [column] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    expect(client.store.state.boardDetails["b1"].columns).toHaveLength(1)

    await client.connect()
    // the replayed event must not add a second copy
    await vi.waitFor(() => expect(client.store.state.lastSeq).toBe(1))
    expect(client.store.state.boardDetails["b1"].columns).toHaveLength(1)

    // a fresh create still appends
    const created = await client.createColumn("b1", { name: "Archive" })
    expect(created.id).toBe(2)
    expect(client.store.state.boardDetails["b1"].columns).toHaveLength(2)

    client.disconnect()
  })

  it("createColumn is a store no-op when the detail is not loaded", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B" })
    const client = makeClient(server)

    await client.createColumn("b1", { name: "Orphan" })
    expect(client.store.state.boardDetails).toEqual({})
  })

  it("updateColumn patches the loaded detail", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B", columns: [makeColumn({ id: 1, name: "A", position: 0 })] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const column = await client.updateColumn("b1", 1, { name: "A2", pushDescription: "push" })
    expect(column.name).toBe("A2")
    expect(client.store.state.boardDetails["b1"].columns[0].name).toBe("A2")
  })

  it("deleteColumn removes from the loaded detail", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B", columns: [makeColumn({ id: 1 }), makeColumn({ id: 2, position: 1 })] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    await client.deleteColumn("b1", 1)
    expect(client.store.state.boardDetails["b1"].columns.map((c) => c.id)).toEqual([2])
  })

  it("reorderColumns PUTs the order and repositions the detail", async () => {
    const server = createFakeServer()
    server.seed({
      id: "b1",
      name: "B",
      columns: [makeColumn({ id: 1, name: "A", position: 0 }), makeColumn({ id: 2, name: "B", position: 1 })],
    })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const columns = await client.reorderColumns("b1", [2, 1])
    expect(server.calls.at(-1)).toMatchObject({
      method: "PUT",
      path: "/kanban/b1/columns/order",
      body: { columnIds: [2, 1] },
    })
    expect(columns.map((c) => c.id)).toEqual([2, 1])
    expect(client.store.state.boardDetails["b1"].columns.map((c) => c.id)).toEqual([2, 1])
    expect(client.store.state.boardDetails["b1"].columns.map((c) => c.position)).toEqual([0, 1])
  })
})

describe("BackdashClient tasks", () => {
  it("createTask posts and patches a loaded detail", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B", columns: [makeColumn({ id: 1, position: 0 })] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const task = await client.createTask("b1", 1, { name: "Ship it", description: "do it" })
    expect(server.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/kanban/b1/columns/1/tasks",
      body: { name: "Ship it", description: "do it" },
    })
    expect(task.columnId).toBe(1)
    expect(client.store.state.boardDetails["b1"].columns[0].tasks.map((t) => t.id)).toEqual([task.id])
  })

  it("updateTask PUTs and patches the loaded detail", async () => {
    const server = createFakeServer()
    const task = makeTask({ id: 1, columnId: 1, name: "Old", position: 0 })
    server.seed({ id: "b1", name: "B", columns: [makeColumn({ id: 1, position: 0, tasks: [task] })] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const updated = await client.updateTask("b1", 1, 1, { name: "New" })
    expect(server.calls.at(-1)).toMatchObject({
      method: "PUT",
      path: "/kanban/b1/columns/1/tasks/1",
      body: { name: "New" },
    })
    expect(updated.name).toBe("New")
    expect(client.store.state.boardDetails["b1"].columns[0].tasks[0].name).toBe("New")
  })

  it("deleteTask removes from the loaded detail", async () => {
    const server = createFakeServer()
    const serverTasks = [makeTask({ id: 1, columnId: 1, position: 0 }), makeTask({ id: 2, columnId: 1, position: 1 })]
    server.seed({ id: "b1", name: "B", columns: [makeColumn({ id: 1, position: 0, tasks: serverTasks })] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    await client.deleteTask("b1", 1, 1)
    expect(server.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/kanban/b1/columns/1/tasks/1" })
    expect(client.store.state.boardDetails["b1"].columns[0].tasks.map((t) => t.id)).toEqual([2])
  })

  it("moveTask transfers a task between columns and patches the detail", async () => {
    const server = createFakeServer()
    const task = makeTask({ id: 1, columnId: 1, position: 0 })
    server.seed({
      id: "b1",
      name: "B",
      columns: [makeColumn({ id: 1, position: 0, tasks: [task] }), makeColumn({ id: 2, position: 1 })],
    })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const moved = await client.moveTask("b1", 1, { columnId: 2 })
    expect(server.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/kanban/b1/tasks/1/move",
      body: { columnId: 2 },
    })
    expect(moved.columnId).toBe(2)
    expect(client.store.state.boardDetails["b1"].columns[0].tasks).toHaveLength(0)
    expect(client.store.state.boardDetails["b1"].columns[1].tasks.map((t) => t.id)).toEqual([1])
  })

  it("claimTask sets claimedBy and patches the detail", async () => {
    const server = createFakeServer()
    const task = makeTask({ id: 1, columnId: 1, position: 0 })
    server.seed({ id: "b1", name: "B", columns: [makeColumn({ id: 1, position: 0, tasks: [task] })] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const claimed = await client.claimTask("b1", 1, 1, "agent-1")
    expect(server.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/kanban/b1/columns/1/tasks/1/claim",
      body: { actor: "agent-1" },
    })
    expect(claimed.claimedBy).toBe("agent-1")
    expect(client.store.state.boardDetails["b1"].columns[0].tasks[0].claimedBy).toBe("agent-1")
  })

  it("releaseTask clears claimedBy and patches the detail", async () => {
    const server = createFakeServer()
    const task = makeTask({ id: 1, columnId: 1, position: 0, claimedBy: "agent-1" })
    server.seed({ id: "b1", name: "B", columns: [makeColumn({ id: 1, position: 0, tasks: [task] })] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const released = await client.releaseTask("b1", 1, 1)
    expect(server.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/kanban/b1/columns/1/tasks/1/release",
    })
    expect(released.claimedBy).toBeNull()
    expect(client.store.state.boardDetails["b1"].columns[0].tasks[0].claimedBy).toBeNull()
  })

  it("createTask is a store no-op when the detail is not loaded", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B", columns: [makeColumn({ id: 1, position: 0 })] })
    const client = makeClient(server)

    await client.createTask("b1", 1, { name: "Orphan" })
    expect(client.store.state.boardDetails).toEqual({})
  })

  it("createTask sends metadata and tagIds, and patches the detail", async () => {
    const server = createFakeServer()
    server.seed({
      id: "b1",
      name: "B",
      columns: [makeColumn({ id: 1, position: 0 })],
      tags: [makeTag({ id: 5, name: "backend" })],
    })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const task = await client.createTask("b1", 1, {
      name: "API",
      priority: "high",
      estimate: 3,
      assignee: "alice",
      dueAt: "2026-11-01",
      tagIds: [5],
    })
    expect(server.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/kanban/b1/columns/1/tasks",
      body: { name: "API", priority: "high", estimate: 3, tagIds: [5] },
    })
    expect(task.tags.map((t) => t.name)).toEqual(["backend"])
    expect(client.store.state.boardDetails["b1"].columns[0].tasks[0].tags).toHaveLength(1)
  })

  it("updateTask replaces tags and clears nullable fields", async () => {
    const server = createFakeServer()
    const task = makeTask({
      id: 1,
      columnId: 1,
      position: 0,
      priority: "low",
      tags: [makeTag({ id: 5, name: "backend" })],
    })
    server.seed({
      id: "b1",
      name: "B",
      columns: [makeColumn({ id: 1, position: 0, tasks: [task] })],
      tags: [makeTag({ id: 5, name: "backend" }), makeTag({ id: 6, name: "frontend" })],
    })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const updated = await client.updateTask("b1", 1, 1, { priority: null, tagIds: [6] })
    expect(server.calls.at(-1)).toMatchObject({
      method: "PUT",
      path: "/kanban/b1/columns/1/tasks/1",
      body: { priority: null, tagIds: [6] },
    })
    expect(updated.priority).toBeNull()
    expect(updated.tags.map((t) => t.name)).toEqual(["frontend"])
    expect(client.store.state.boardDetails["b1"].columns[0].tasks[0].tags.map((t) => t.name)).toEqual([
      "frontend",
    ])
  })
})

describe("BackdashClient tags", () => {
  it("createTag posts and patches the board's tag list", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B", columns: [] })
    const client = makeClient(server)

    await client.loadBoard("b1")
    const tag = await client.createTag("b1", { name: "frontend", color: "#0af" })
    expect(server.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/kanban/b1/tags",
      body: { name: "frontend", color: "#0af" },
    })
    expect(client.store.state.boardDetails["b1"].tags.map((t) => t.name)).toEqual(["frontend"])
    expect(tag.id).toBeGreaterThan(0)
  })

  it("listTags returns the board's tags", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B", columns: [], tags: [makeTag({ id: 1, name: "a" })] })
    const client = makeClient(server)
    const tags = await client.listTags("b1")
    expect(tags.map((t) => t.name)).toEqual(["a"])
  })

  it("updateTag patches the tag list and every task carrying it", async () => {
    const server = createFakeServer()
    const tag = makeTag({ id: 5, name: "old" })
    const task = makeTask({ id: 1, columnId: 1, position: 0, tags: [tag] })
    server.seed({
      id: "b1",
      name: "B",
      columns: [makeColumn({ id: 1, position: 0, tasks: [task] })],
      tags: [tag],
    })
    const client = makeClient(server)

    await client.loadBoard("b1")
    await client.updateTag("b1", 5, { name: "new" })
    expect(client.store.state.boardDetails["b1"].tags.map((t) => t.name)).toEqual(["new"])
    expect(
      client.store.state.boardDetails["b1"].columns[0].tasks[0].tags.map((t) => t.name),
    ).toEqual(["new"])
  })

  it("deleteTag removes it from the tag list and from tasks", async () => {
    const server = createFakeServer()
    const tag = makeTag({ id: 5, name: "gone" })
    const task = makeTask({ id: 1, columnId: 1, position: 0, tags: [tag] })
    server.seed({
      id: "b1",
      name: "B",
      columns: [makeColumn({ id: 1, position: 0, tasks: [task] })],
      tags: [tag],
    })
    const client = makeClient(server)

    await client.loadBoard("b1")
    await client.deleteTag("b1", 5)
    expect(server.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/kanban/b1/tags/5" })
    expect(client.store.state.boardDetails["b1"].tags).toEqual([])
    expect(client.store.state.boardDetails["b1"].columns[0].tasks[0].tags).toEqual([])
  })

  it("tags are a store no-op when the detail is not loaded", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "B" })
    const client = makeClient(server)

    await client.createTag("b1", { name: "orphan" })
    expect(client.store.state.boardDetails).toEqual({})
  })
})

describe("BackdashClient connection", () => {
  it("connect() opens the stream, marks connected, and hydrates boards", async () => {
    const server = createFakeServer()
    server.seed({ id: "b1", name: "Hydrated" })
    const client = makeClient(server)

    await client.connect()
    await vi.waitFor(() => expect(client.store.state.connected).toBe(true))
    await vi.waitFor(() =>
      expect(client.store.state.boards).toEqual([{ id: "b1", name: "Hydrated" }]),
    )
    expect(server.calls.some((c) => c.method === "GET" && c.path === "/events")).toBe(true)

    client.disconnect()
    await vi.waitFor(() => expect(client.store.state.connected).toBe(false))
  })

  it("self-heals by refetching boards on an event for an unknown board", async () => {
    const event = {
      seq: 1,
      boardId: "b-unknown",
      type: "column.added",
      actor: "dashboard",
      payload: makeColumn({ id: 9 }),
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    const server = createFakeServer(`id: 1\ndata: ${JSON.stringify(event)}\n\n`)
    server.seed({ id: "b1", name: "Known" })
    const client = makeClient(server)

    await client.connect()
    // initial hydrate (1 GET /kanban) + self-heal refetch after the unknown-board event (2nd)
    await vi.waitFor(
      () => {
        const gets = server.calls.filter((c) => c.method === "GET" && c.path === "/kanban")
        expect(gets.length).toBeGreaterThanOrEqual(2)
      },
      { timeout: 2_000 },
    )
    // the server still only knows b1, so the summary list reflects it
    await vi.waitFor(() => expect(client.store.state.boards).toEqual([{ id: "b1", name: "Known" }]))

    client.disconnect()
  })
})
