// Wire types mirroring the backdash API responses (BoardSummary, BoardDetail,
// Column, Event). Keep these in sync with the OpenAPI document at /openapi.json.

export interface Task {
  id: number
  columnId: number
  name: string
  description: string | null
  position: number
  claimedBy: string | null
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
export type BackdashEventType = BoardEventType | ColumnEventType | TaskEventType

export interface BoardEventPayload {
  id: string
  name: string
  columns?: Column[]
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
