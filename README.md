# react-backdash

Reactive React hooks and imperative actions for the backdash kanban server.

Connect once to a running backdash server (default `http://localhost:3000`) and get:

- **Live-updating hooks** — boards, columns, and tasks pushed over the server's SSE event stream into a reactive in-memory store.
- **Action functions** — create/rename/delete boards, create/update/delete/reorder columns, create/update/delete/move/claim/release tasks.

No state library required: the store is a small external store consumed through `useSyncExternalStore`, so only the hooks whose slice changed re-render.

## How it works

```
┌────────────────┐   REST (actions, hydration)   ┌──────────────────┐
│ BackdashClient │ ─────────────────────────────▶ │  backdash server │
│                │ ◀───────────────────────────── │                  │
└───────┬────────┘   SSE /events (live updates)   └──────────────────┘
        │
        ▼
    Store (event-sourced collections)
        │
        ▼
    useSyncExternalStore → hooks (stable per-slice references)
```

- One client, one SSE connection to `/events`. Events (`board.created`, `column.added`, `column.reordered`, `task.created`, `task.moved`, …) are applied to the store as immutable slice updates; unknown future types are dropped.
- Actions are **server-response sync**: the HTTP response is written to the store, and the corresponding SSE event is applied idempotently (deduped by id) in either order. No optimistic updates, no rollback.
- On connect and on reconnect the store re-hydrates from REST (`GET /kanban`), and re-fetches details for boards you have already loaded. An in-flight detail GET never overwrites events that arrived while it was in flight (stale-write guard).
- Board details (columns) are loaded lazily per board (when a `useBoard(id)` hook first loads it) to keep startup light.
- Self-healing: if an event arrives for a board you have never seen (you were offline through its creation), the client re-fetches the board list.
- SSE reconnects with exponential backoff (500 ms → 30 s by default), resuming from the last seen `seq`. `ping` keep-alive frames are dropped; a `resync` frame (server pruned history) triggers a full re-hydration.

## Install

```sh
npm install react-backdash
```

Peer dependency: `react >= 18`.

## Quick start

```tsx
import {
  BackdashProvider,
  useBoards,
  useBoard,
  useClientActions,
} from "react-backdash"

function App() {
  return (
    <BackdashProvider url="http://localhost:3000">
      <Kanban />
    </BackdashProvider>
  )
}

function Kanban() {
  const boards = useBoards()
  const { createBoard } = useClientActions()
  return (
    <div>
      {boards.map((b) => (
        <BoardLink key={b.id} board={b} />
      ))}
      <button onClick={() => createBoard("New board")}>Create board</button>
    </div>
  )
}

function BoardView({ boardId }) {
  const board = useBoard(boardId)
  if (!board) return <p>Loading…</p>
  return (
    <div>
      <h1>{board.name}</h1>
      {board.columns.map((col) => (
        <Column key={col.id} column={col} />
      ))}
    </div>
  )
}
```

Columns update in place as events arrive (`column.added`, `column.updated`, `column.reordered`), so a `<Column>` re-renders with the new name or order — no diffing needed.

## Provider

```tsx
<BackdashProvider url="http://localhost:3000">…</BackdashProvider>
```

| Prop | Default | Description |
|------|---------|-------------|
| `url` | `http://localhost:3000` | Server base URL |
| `client` | — | Use your own `BackdashClient` (skips create/connect/disconnect on unmount) |
| `connect` | `true` | Connect SSE on mount, disconnect on unmount |
| `reconnect` | `true` | Auto-reconnect with backoff |
| `minBackoffMs` / `maxBackoffMs` | `500` / `30000` | Backoff bounds |
| `fetchImpl` | global `fetch` | Custom fetch (proxies, auth, tests) |
| `headers` | `{}` | Extra headers (e.g. auth) sent on every request |
| `store` | — | Use your own `Store` (tests, shared state) |

`useBackdash()` returns the client for direct access; `useClientActions()` returns a stable object of bound action methods; `useStore(selector)` reads any slice of the raw store state.

## Hooks

### Boards
| Hook | Returns |
|------|---------|
| `useConnected()` | `boolean` — SSE connection state |
| `useBoards()` | `BoardSummary[]` — every board (`{id, name}`), kept live by `board.*` events and reconnect hydrates |
| `useBoard(id)` | `Board \| undefined` — detail with `columns` (each with `tasks`); auto-loads on first use, then live through `column.*`/`task.*` events. `undefined` until the first load resolves |
| `useLoadBoard()` | `(id) => Promise<void>` — load (or reload) a board detail; deduped, a 404 clears the stale detail and resolves |
| `useTasks(boardId, columnId)` | `Task[]` — tasks of one column, live through `task.*` events |
| `useTags(boardId)` | `Tag[]` — tags defined on the board, live through `tag.*` events |

## Actions

Everything on the client is also available as a stable object from `useClientActions()`, or directly via `useBackdash()`:

```ts
client.listBoards()                  // → BoardSummary[]
client.getBoard(id)                  // → Board (REST, not cached)
client.loadBoard(id)                 // → void (caches detail in the store)
client.createBoard(name)             // → Board
client.renameBoard(id, name)         // → Board
client.deleteBoard(id)               // → void

client.createColumn(boardId, { name, isQueue? })                 // → Column
client.updateColumn(boardId, columnId, { name?, isQueue?, pushDescription?, pullDescription? }) // → Column
client.deleteColumn(boardId, columnId)                           // → void
client.reorderColumns(boardId, columnIds /* number[] */)         // → Column[] (new order)

client.createTask(boardId, columnId, { name, description?, priority?, estimate?, assignee?, dueAt?, tagIds? }) // → Task
client.updateTask(boardId, columnId, taskId, { name?, description?, priority?, estimate?, assignee?, dueAt?, tagIds? }) // → Task
client.deleteTask(boardId, columnId, taskId)                     // → void
client.moveTask(boardId, taskId, { columnId, position? })        // → Task
client.claimTask(boardId, columnId, taskId, actor?)              // → Task (server rejects non-queue columns)
client.releaseTask(boardId, columnId, taskId)                    // → Task

client.listTags(boardId)                                         // → Tag[]
client.createTag(boardId, { name, description?, prompt?, color? }) // → Tag
client.updateTag(boardId, tagId, { name?, description?, prompt?, color? }) // → Tag
client.deleteTag(boardId, tagId)                                 // → void
```

Errors throw `BackdashError` with `.status` and `.body`.

## Development

```sh
npm install
npm test           # vitest: unit + hooks + integration (real HTTP mock server)
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist (ESM + CJS + .d.ts)
```

### Testing approach

| Layer | What's tested |
|-------|---------------|
| Unit | Store reducers: every board/column event, idempotency (SSE event + HTTP response in either order), cascade deletes, stable references for unchanged slices |
| Unit | SSE framing parser + `EventStream`: reconnect/backoff, resume via `lastEventId`, `resync`, abort, malformed frames |
| Unit | Client: REST error mapping (`BackdashError`), request bodies, hydration, load dedupe, stale-write guard on in-flight detail GETs |
| Hooks | `renderHook` against a real client whose store is fed synthetic events |
| Integration | Real `node:http` mock backdash server with live SSE; full connect → hydrate → create → stream cycle, including replayed events that must not duplicate |

Browser-level coverage of the full UI lives in the dash app's e2e suites (`dash/e2e/boards.test.mjs`, `dash/e2e/tasks.test.mjs`), which drive a real board through create → columns → tasks → drag-reorder → claim/release → delete against a real server.

## API notes

- Targets the backdash kanban API: `/kanban`, `/kanban/{id}`, `/kanban/{id}/columns`, `/kanban/{id}/columns/{columnId}`, `/kanban/{id}/columns/order`, `/kanban/{id}/columns/{columnId}/tasks[/{taskId}]` (plus `.../{taskId}/claim|release`), `/kanban/{id}/tasks/{taskId}/move`, and the SSE stream at `/events`.
- The server exposes an OpenAPI spec at `GET /openapi.json` — types in `src/types.ts` are hand-written against it for the entities a frontend needs.
- Events are envelope objects: `{ seq, boardId, type, actor, payload, createdAt }`, sent as unnamed SSE frames with `id: <seq>` (resume via `?lastEventId=N`), plus named `ping` (keep-alive) and `resync` (history pruned) frames.
- Creating a board via the API gives it default columns (`Todo`, `In Progress`, `Done`); the client treats columns as opaque data.
