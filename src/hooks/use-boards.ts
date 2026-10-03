import { useCallback, useEffect, useState } from "react"
import { useBackdash, useStore } from "./provider"
import type { Board, BoardSummary, SessionTask, Tag, Task } from "../types"

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

// The kanban task a session is currently linked to, if any. Resolves the link
// from the server by session id, loads that task's board so the task is live,
// then tracks the task from the store (so its todos stay current). `refreshKey`
// re-resolves the link when it changes (e.g. the session's busy flag), which
// picks up a claim made mid-session.
export function useSessionTask(
  sessionId: string | undefined,
  refreshKey?: unknown,
): SessionTask | null {
  const client = useBackdash()
  const [linked, setLinked] = useState<{ boardId: string; taskId: number } | null>(null)
  const [snapshot, setSnapshot] = useState<SessionTask | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setLinked(null)
      setSnapshot(null)
      return
    }

    let cancelled = false
    client
      .getTasksBySession(sessionId)
      .then((found) => {
        if (cancelled) return
        const first = found[0] ?? null
        setSnapshot(first)
        setLinked(first ? { boardId: first.boardId, taskId: first.task.id } : null)
        if (first) void client.loadBoard(first.boardId).catch(() => undefined)
      })
      .catch(() => {
        if (cancelled) return
        setSnapshot(null)
        setLinked(null)
      })

    return () => {
      cancelled = true
    }
  }, [client, sessionId, refreshKey])

  // Select the task object (a stable reference) so this never returns a fresh
  // identity; the boardId is derived outside the selector.
  const liveTask = useStore((state) => {
    if (!linked) return undefined
    const board = state.boardDetails[linked.boardId]
    if (!board) return undefined
    for (const column of board.columns) {
      const task = column.tasks.find((t) => t.id === linked.taskId)
      if (task) return task
    }
    return undefined
  })

  if (linked && liveTask) return { boardId: linked.boardId, task: liveTask }
  return snapshot
}
