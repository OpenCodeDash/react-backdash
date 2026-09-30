import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { BackdashClient } from "../src/client/client"
import { createClient } from "../src/client/client"
import { BackdashProvider, useBackdash, useClientActions } from "../src/hooks/provider"
import { useBoard, useBoards, useConnected, useTasks } from "../src/hooks/use-boards"
import { makeColumn, makeTask } from "./fixtures"
import { createFakeServer, type FakeServer } from "./fake-server"

function makeHarness() {
  const server = createFakeServer()
  const client = createClient({ url: "http://fake", fetchImpl: server.fetchMock as unknown as typeof fetch })
  return { server, client }
}

function ProviderFor({ client, children }: { client: BackdashClient; children: React.ReactNode }) {
  return (
    <BackdashProvider client={client} connect={false}>
      {children}
    </BackdashProvider>
  )
}

describe("useBackdash", () => {
  it("throws outside of a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const Probe = () => {
      useBackdash()
      return null
    }
    expect(() => render(<Probe />)).toThrow("useBackdash must be used within")
    spy.mockRestore()
  })
})

describe("useBoards / useConnected", () => {
  it("reflect live store state", () => {
    const { client } = makeHarness()
    const BoardsProbe = () => {
      const boards = useBoards()
      return <div data-testid="boards">{boards.map((b) => b.name).join(",")}</div>
    }
    const ConnectedProbe = () => (
      <div data-testid="connected">{String(useConnected())}</div>
    )

    const { unmount } = render(
      <ProviderFor client={client}>
        <BoardsProbe />
        <ConnectedProbe />
      </ProviderFor>,
    )

    expect(screen.getByTestId("boards").textContent).toBe("")
    expect(screen.getByTestId("connected").textContent).toBe("false")

    act(() => {
      client.store.setBoards([{ id: "b1", name: "Alpha" }, { id: "b2", name: "Beta" }])
      client.store.setConnected(true)
    })

    expect(screen.getByTestId("boards").textContent).toBe("Alpha,Beta")
    expect(screen.getByTestId("connected").textContent).toBe("true")
    unmount()
  })
})

describe("useBoard", () => {
  it("loads the detail on first use and stays live", async () => {
    const { server, client } = makeHarness()
    const column = makeColumn({ id: 1, position: 0 })
    server.seed({ id: "b1", name: "B", columns: [column] })

    const BoardProbe = () => {
      const board = useBoard("b1")
      return (
        <div data-testid="detail">
          {board ? `${board.name}:${board.columns.length}` : "loading"}
        </div>
      )
    }

    render(<ProviderFor client={client}><BoardProbe /></ProviderFor>)
    expect(screen.getByTestId("detail").textContent).toBe("loading")

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByTestId("detail").textContent).toBe("B:1")
    expect(server.calls.some((c) => c.method === "GET" && c.path === "/kanban/b1")).toBe(true)
  })

  it("does not refetch while the detail is already loaded", async () => {
    const { server, client } = makeHarness()
    server.seed({ id: "b1", name: "B" })

    const BoardProbe = () => {
      useBoard("b1")
      return null
    }

    const { unmount } = render(<ProviderFor client={client}><BoardProbe /></ProviderFor>)
    await act(async () => {
      await Promise.resolve()
    })

    // unmount and remount in the same store: the second mount must not refetch
    unmount()
    render(<ProviderFor client={client}><BoardProbe /></ProviderFor>)
    await act(async () => {
      await Promise.resolve()
    })

    const gets = server.calls.filter((c) => c.method === "GET" && c.path === "/kanban/b1")
    expect(gets).toHaveLength(1)
  })
})

describe("useTasks", () => {
  it("returns [] until the board detail is loaded", () => {
    const { client } = makeHarness()
    const TasksProbe = () => {
      const tasks = useTasks("b1", 1)
      return <div data-testid="tasks">{tasks.map((t) => t.name).join(",")}</div>
    }

    const { unmount } = render(
      <ProviderFor client={client}>
        <TasksProbe />
      </ProviderFor>,
    )
    expect(screen.getByTestId("tasks").textContent).toBe("")
    unmount()
  })

  it("reflects the column's tasks and stays live through task events", async () => {
    const { server, client } = makeHarness()
    server.seed({
      id: "b1",
      name: "B",
      columns: [makeColumn({ id: 1, position: 0, tasks: [makeTask({ id: 1, columnId: 1, position: 0 })] })],
    })

    const TasksProbe = () => {
      useBoard("b1")
      const tasks = useTasks("b1", 1)
      return <div data-testid="tasks">{tasks.map((t) => t.name).join(",")}</div>
    }

    render(
      <ProviderFor client={client}>
        <TasksProbe />
      </ProviderFor>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId("tasks").textContent).toBe("Task 1")

    act(() => {
      client.store.applyTaskUpsert("b1", makeTask({ id: 2, columnId: 1, position: 1 }))
    })
    expect(screen.getByTestId("tasks").textContent).toBe("Task 1,Task 2")

    act(() => {
      client.store.applyTaskDeleted("b1", 1)
    })
    expect(screen.getByTestId("tasks").textContent).toBe("Task 2")
  })
})

describe("useClientActions", () => {
  it("exposes working actions bound to the client", async () => {
    const { server, client } = makeHarness()

    const ActionsProbe = () => {
      const { createBoard, createColumn } = useClientActions()
      return (
        <div>
          <button onClick={() => void createBoard("From UI")}>create-board</button>
          <button
            onClick={() => {
              const id = client.store.state.boards.find((b) => b.name === "From UI")?.id
              if (id) void createColumn(id, { name: "Col" })
            }}
          >
            create-column
          </button>
        </div>
      )
    }

    render(<ProviderFor client={client}><ActionsProbe /></ProviderFor>)

    await act(async () => {
      screen.getByText("create-board").click()
    })
    await vi.waitFor(() =>
      expect(client.store.state.boards.some((b) => b.name === "From UI")).toBe(true),
    )

    const boardId = client.store.state.boards.find((b) => b.name === "From UI")!.id
    await act(async () => {
      screen.getByText("create-column").click()
    })
    await vi.waitFor(() =>
      expect(server.calls.some((c) => c.method === "POST" && c.path === `/kanban/${boardId}/columns`)).toBe(
        true,
      ),
    )
  })

  it("returns a stable object for the same client", () => {
    const { client } = makeHarness()
    let first: unknown
    let second: unknown
    const StabilityProbe = () => {
      const actions = useClientActions()
      first ??= actions
      second = actions
      return null
    }
    const { rerender } = render(
      <ProviderFor client={client}>
        <StabilityProbe />
      </ProviderFor>,
    )
    rerender(
      <ProviderFor client={client}>
        <StabilityProbe />
      </ProviderFor>,
    )
    expect(second).toBe(first)
  })
})

describe("BackdashProvider lifecycle", () => {
  it("auto-connects a created client and disconnects it on unmount", async () => {
    const server = createFakeServer()
    let seen: BackdashClient | null = null
    const Capture = () => {
      seen = useBackdash()
      return null
    }

    const { unmount } = render(
      <BackdashProvider url="http://fake" fetchImpl={server.fetchMock as unknown as typeof fetch}>
        <Capture />
      </BackdashProvider>,
    )

    await vi.waitFor(() => expect(seen?.store.state.connected).toBe(true))
    unmount()
    await vi.waitFor(() => expect(seen?.store.state.connected).toBe(false))
  })

  it("leaves a provided client untouched on unmount", () => {
    const { client } = makeHarness()
    client.store.setConnected(true)

    const { unmount } = render(
      <ProviderFor client={client}>
        <span>child</span>
      </ProviderFor>,
    )
    unmount()
    expect(client.store.state.connected).toBe(true)
  })
})
