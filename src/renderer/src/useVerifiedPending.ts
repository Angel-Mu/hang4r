import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptItem } from './state/store'
import { hasPendingWork, pendingParts, pendingTaskPaths, pendingWork, type PendingPart } from './pendingWork'

/**
 * What the last turn is still waiting on, with the background commands actually
 * verified.
 *
 * The transcript alone is not enough: it only learns a command finished if some
 * later note names it, so a command that exited quietly leaves the footer stuck
 * on "waiting" until the next message happens to move things along. Whether a
 * writer still holds the output file open is the real answer, and only the main
 * process can ask — so the sync read renders immediately and the probe corrects
 * it a moment later.
 *
 * Re-probes while anything is still believed running: a command that finishes
 * with the session idle has no other event to trigger a re-render.
 */
const PROBE_INTERVAL_MS = 4000

export function useVerifiedPending(
  sessionId: string,
  items: TranscriptItem[],
  turnLive: boolean,
  liveAgentIds?: ReadonlySet<string>
): PendingPart[] | null {
  const [finished, setFinished] = useState<ReadonlySet<string>>(new Set())
  const paths = useMemo(() => (turnLive ? [] : pendingTaskPaths(items)), [items, turnLive])
  const pathsKey = paths.join('|')
  const finishedRef = useRef(finished)
  finishedRef.current = finished

  useEffect(() => {
    if (!pathsKey) return
    let stop = false
    const probe = async (): Promise<void> => {
      const done = new Set(finishedRef.current)
      for (const path of pathsKey.split('|')) {
        if (done.has(path)) continue
        const state = await window.hang4r
          .backgroundTaskState(sessionId, path)
          .catch(() => null)
        if (state && state.state !== 'running') done.add(path)
      }
      if (!stop && done.size !== finishedRef.current.size) setFinished(done)
    }
    void probe()
    const iv = setInterval(() => void probe(), PROBE_INTERVAL_MS)
    return () => {
      stop = true
      clearInterval(iv)
    }
  }, [pathsKey, sessionId])

  return useMemo(() => {
    if (turnLive) return null
    const p = pendingWork(items, turnLive, finished, liveAgentIds)
    return hasPendingWork(p) ? pendingParts(p) : null
  }, [items, turnLive, finished, liveAgentIds])
}
