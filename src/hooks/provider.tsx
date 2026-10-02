import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { BackdashClient, type BackdashClientOptions, type CreateTagInput, type CreateTaskInput, type UpdateTagInput, type UpdateTaskInput } from "../client/client"
import type { StoreState } from "../client/store"

interface BackdashContextValue {
  client: BackdashClient
}

const BackdashContext = createContext<BackdashContextValue | null>(null)

export interface BackdashProviderProps extends BackdashClientOptions {
  client?: BackdashClient
  children: ReactNode
  connect?: boolean
}

export function BackdashProvider(props: BackdashProviderProps) {
  const { client: provided, children, connect = true, ...options } = props
  const created = useRef<BackdashClient | null>(null)
  if (!provided && !created.current) created.current = new BackdashClient(options)
  const client = provided ?? created.current!

  useEffect(() => {
    if (!provided && connect) client.connect()
    return () => {
      if (!provided && connect) client.disconnect()
    }
  }, [client, connect, provided])

  return <BackdashContext.Provider value={{ client }}>{children}</BackdashContext.Provider>
}

export function useBackdash(): BackdashClient {
  const ctx = useContext(BackdashContext)
  if (!ctx) throw new Error("useBackdash must be used within <BackdashProvider>")
  return ctx.client
}

export function useStore<T>(selector: (state: StoreState) => T): T {
  const client = useBackdash()
  const store = client.store
  return useSyncExternalStore(store.subscribe, () => selector(store.state), () =>
    selector(store.state),
  )
}

export function useClientActions() {
  const client = useBackdash()
  return useMemo(
    () => ({
      createBoard: (name: string) => client.createBoard(name),
      renameBoard: (id: string, name: string) => client.renameBoard(id, name),
      deleteBoard: (id: string) => client.deleteBoard(id),
      loadBoard: (id: string) => client.loadBoard(id),
      createColumn: (boardId: string, input: { name: string; isQueue?: boolean }) =>
        client.createColumn(boardId, input),
      updateColumn: (
        boardId: string,
        columnId: number,
        input: {
          name?: string
          isQueue?: boolean
          pushDescription?: string | null
          pullDescription?: string | null
        },
      ) => client.updateColumn(boardId, columnId, input),
      deleteColumn: (boardId: string, columnId: number) => client.deleteColumn(boardId, columnId),
      reorderColumns: (boardId: string, columnIds: number[]) =>
        client.reorderColumns(boardId, columnIds),
      listTags: (boardId: string) => client.listTags(boardId),
      createTag: (boardId: string, input: CreateTagInput) => client.createTag(boardId, input),
      updateTag: (boardId: string, tagId: number, input: UpdateTagInput) =>
        client.updateTag(boardId, tagId, input),
      deleteTag: (boardId: string, tagId: number) => client.deleteTag(boardId, tagId),
      createTask: (boardId: string, columnId: number, input: CreateTaskInput) =>
        client.createTask(boardId, columnId, input),
      updateTask: (
        boardId: string,
        columnId: number,
        taskId: number,
        input: UpdateTaskInput,
      ) => client.updateTask(boardId, columnId, taskId, input),
      deleteTask: (boardId: string, columnId: number, taskId: number) =>
        client.deleteTask(boardId, columnId, taskId),
      moveTask: (boardId: string, taskId: number, input: { columnId: number; position?: number }) =>
        client.moveTask(boardId, taskId, input),
      claimTask: (boardId: string, columnId: number, taskId: number, actor?: string) =>
        client.claimTask(boardId, columnId, taskId, actor),
      releaseTask: (boardId: string, columnId: number, taskId: number) =>
        client.releaseTask(boardId, columnId, taskId),
    }),
    [client],
  )
}
