import { useCallback, useEffect } from "react"
import { useBackdash, useStore } from "./provider"
import type { Board, BoardSummary, Tag, Task } from "../types"

const EMPTY_TASKS: Task[] = []
const EMPTY_TAGS: Tag[] = []

export function useConnected(): boolean {
  return useStore((state) => state.connected)
}

// Summary of every board, kept live by board.* events and reconnected hydrates.
export function useBoards(): BoardSummary[] {
  return useStore((state) => state.boards)
}

// Detail (with columns) of a board. Loads it on first use; the columns stay
// live through column.* events. Undefined until the first load resolves.
export function useBoard(id: string): Board | undefined {
  const client = useBackdash()
  const board = useStore((state) => state.boardDetails[id])

  useEffect(() => {
    if (!client.store.state.boardDetails[id]) {
      void client.loadBoard(id).catch(() => undefined)
    }
  }, [client, id])

  return board
}

export function useLoadBoard(): (id: string) => Promise<void> {
  const client = useBackdash()
  return useCallback((id: string) => client.loadBoard(id), [client])
}

// Tasks of a single column, kept live through task.* events. The board must
// already be loaded (useBoard does that on the board page); this only reads.
// Selects the column object (a stable reference) and derives the tasks array
// outside the selector, so getSnapshot never returns a fresh array identity.
export function useTasks(boardId: string, columnId: number): Task[] {
  const column = useStore((state) =>
    state.boardDetails[boardId]?.columns.find((c) => c.id === columnId),
  )
  return column?.tasks ?? EMPTY_TASKS
}

// Tags defined on a board, kept live through tag.* events. The board must
// already be loaded (useBoard does that on the board page); this only reads.
export function useTags(boardId: string): Tag[] {
  const board = useStore((state) => state.boardDetails[boardId])
  return board?.tags ?? EMPTY_TAGS
}
