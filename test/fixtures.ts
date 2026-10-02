import type { BackdashEvent, Board, BoardSummary, Column, Tag, Task } from "../src/types"

let boardCounter = 0
let columnCounter = 0
let taskCounter = 0
let tagCounter = 0
let seqCounter = 0

const nextBoardId = () => `b${String(++boardCounter).padStart(5, "0")}`

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: ++taskCounter,
    columnId: 1,
    name: `Task ${taskCounter}`,
    description: null,
    position: 0,
    claimedBy: null,
    priority: null,
    estimate: null,
    assignee: null,
    dueAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    ...overrides,
  }
}

export function makeTag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: ++tagCounter,
    name: `tag-${tagCounter}`,
    description: null,
    prompt: null,
    color: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

export function makeColumn(overrides: Partial<Column> = {}): Column {
  return {
    id: ++columnCounter,
    name: `Column ${columnCounter}`,
    position: columnCounter - 1,
    isQueue: false,
    pushDescription: null,
    pullDescription: null,
    tasks: [],
    ...overrides,
  }
}

export function makeBoardSummary(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return { id: nextBoardId(), name: `Board ${boardCounter}`, ...overrides }
}

export function makeBoard(
  columns: Column[] = [],
  overrides: Partial<Board> = {},
): Board {
  const summary = makeBoardSummary(overrides)
  return { ...summary, columns, tags: overrides.tags ?? [] }
}

export function makeEvent(
  boardId: string,
  type: BackdashEvent["type"],
  payload: unknown,
  overrides: Partial<BackdashEvent> = {},
): BackdashEvent {
  return {
    seq: ++seqCounter,
    boardId,
    type,
    actor: "dashboard",
    payload,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

export function resetCounters(): void {
  boardCounter = 0
  columnCounter = 0
  taskCounter = 0
  tagCounter = 0
  seqCounter = 0
}
