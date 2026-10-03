export { BackdashProvider, useBackdash, useStore, useClientActions } from "./hooks/provider"
export {
  useConnected,
  useBoards,
  useBoard,
  useLoadBoard,
  useTasks,
  useTags,
  useSessionTask,
} from "./hooks/use-boards"
export { BackdashClient, BackdashError, createClient } from "./client/client"
export { Store, createInitialStoreState } from "./client/store"
export { EventStream, parseSseFrames } from "./client/events"
export type { StoreState } from "./client/store"
export type {
  BackdashClientOptions,
  CreateTagInput,
  CreateTaskInput,
  UpdateTagInput,
  UpdateTaskInput,
} from "./client/client"
export type { EventStreamOptions, SseFrame } from "./client/events"
export type {
  BackdashEvent,
  BackdashEventType,
  Board,
  BoardEventPayload,
  BoardEventType,
  BoardSummary,
  Column,
  ColumnEventPayload,
  ColumnEventType,
  SessionTask,
  Tag,
  TagEventType,
  Task,
  TaskEventType,
  TaskPriority,
  TaskTodo,
  TaskTodoStatus,
  Account,
  AccountKind,
  AuthSession,
} from "./types"
