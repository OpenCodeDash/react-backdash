// Wire types mirroring the backdash API responses (BoardSummary, BoardDetail,
// Column, Event). Keep these in sync with the OpenAPI document at /openapi.json.

export type TaskPriority = "low" | "medium" | "high" | "urgent"

export interface Tag {
  id: number
  name: string
  description: string | null
  prompt: string | null
  color: string | null
  createdAt: string
  updatedAt: string
}

export interface Task {
  id: number
  columnId: number
  name: string
  description: string | null
  position: number
  claimedBy: string | null
  priority: TaskPriority | null
  estimate: number | null
  assignee: string | null
  dueAt: string | null
  createdAt: string
  updatedAt: string
  tags: Tag[]
}

export interface Column {
  id: number
  name: string
  position: number
  isQueue: boolean
  pushDescription: string | null
  pullDescription: string | null
  tasks: Task[]
}

export interface BoardSummary {
  id: string
  name: string
}

export interface Board extends BoardSummary {
  columns: Column[]
  tags: Tag[]
}

export type BoardEventType = "board.created" | "board.updated" | "board.deleted"
export type ColumnEventType =
  | "column.added"
  | "column.updated"
  | "column.deleted"
  | "column.reordered"
export type TaskEventType =
  | "task.created"
  | "task.updated"
  | "task.claimed"
  | "task.moved"
  | "task.released"
  | "task.deleted"
export type TagEventType = "tag.added" | "tag.updated" | "tag.deleted"
export type BackdashEventType = BoardEventType | ColumnEventType | TaskEventType | TagEventType

export interface BoardEventPayload {
  id: string
  name: string
  columns?: Column[]
  tags?: Tag[]
}

export interface ColumnEventPayload {
  id: number
  name: string
  position?: number
  isQueue?: boolean
  pushDescription?: string | null
  pullDescription?: string | null
  columns?: Column[]
}

export interface BackdashEvent {
  seq: number
  boardId: string
  type: BackdashEventType
  actor: string
  payload: unknown
  createdAt: string
}
