"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { Board } from "@/lib/types";
import { removeEpicFromColumns } from "@/components/board/board-utils";
import { useVisiblePoll } from "@/components/board/use-visible-poll";

/** Board freshness cadence — matches the sync engine's heartbeat so remote changes surface
 * within one beat + one poll (anton-live-sync R8). */
export const BOARD_POLL_MS = 30_000;

/** The live board and every handle the surfaces above it need to move it. */
export interface BoardPoll {
  /** The settled board; `null` until the first read lands (or while one failed with nothing cached). */
  board: Board | null;
  /** Only ever set when there is no board to show — a failed poll keeps the last good one. */
  error: string | null;
  /** Force a fresh read: the error retry, and after a dialog write that may have moved a card. */
  refresh: () => void;
  /** Optimistic writes from a drag; the move response and the next poll settle them. */
  setBoard: Dispatch<SetStateAction<Board | null>>;
  /** Drop a deleted card from every column without waiting for the next poll. */
  removeEpic: (epicId: string) => void;
  /** Mirrors the live drag, so a read landing mid-drag can decline to clobber it. */
  draggingRef: RefObject<boolean>;
  /** The snapshot token the poll sends; a settled move advances it past its own write (anton-4g35). */
  versionRef: RefObject<string | undefined>;
}

/**
 * The board's live read: one conditional GET on a visibility-aware loop, plus the optimistic writes
 * the drag layer and the ticket dialog make on top of it. Held apart from the board's markup so
 * `EpicBoard` is a render of this state rather than the place it is reconciled.
 */
export function useBoardPoll(slug: string, initialBoard: Board | null): BoardPoll {
  const [board, setBoard] = useState<Board | null>(initialBoard);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const draggingRef = useRef(false);
  const versionRef = useRef(initialBoard?.version);
  const loadingRef = useRef(false);

  const load = useCallback(
    async (signal: AbortSignal, force = false) => {
      // Reads that must not happen: a second one racing the first's version write, and any read at
      // all mid-drag — its answer would clobber the optimistic board the operator is holding.
      if (loadingRef.current || draggingRef.current) return;
      loadingRef.current = true;
      try {
        const next = await readBoard(slug, force ? undefined : versionRef.current);
        if (next && !signal.aborted && !draggingRef.current) {
          versionRef.current = next.version;
          setBoard(next);
          setError(null);
        }
      } catch (err) {
        // Only a board-less load surfaces an error UI; a failed poll keeps the last good board.
        if (signal.aborted) return;
        setBoard((prev) => {
          if (prev === null) setError(err instanceof Error ? err.message : "Failed to load board");
          return prev;
        });
      } finally {
        loadingRef.current = false;
      }
    },
    [slug],
  );

  const poll = useCallback((signal: AbortSignal) => load(signal), [load]);
  useVisiblePoll(poll, BOARD_POLL_MS);

  // Kick an immediate, unconditional read when there is no board yet or a refresh was asked for;
  // otherwise the first fetch rides the poll cadence.
  useEffect(() => {
    if (initialBoard !== null && attempt === 0) return;
    const controller = new AbortController();
    void load(controller.signal, true);
    return () => controller.abort();
  }, [initialBoard, attempt, load]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  const removeEpic = useCallback((epicId: string) => {
    setBoard((prev) => (prev ? { ...prev, columns: removeEpicFromColumns(prev.columns, epicId) } : prev));
  }, []);

  return { board, error, refresh, setBoard, removeEpic, draggingRef, versionRef };
}

/**
 * One board read. `undefined` means the server answered 304 — the snapshot the client already holds
 * is still current, so there is nothing to apply. Omitting the version forces a full read.
 */
async function readBoard(slug: string, version: string | undefined): Promise<Board | undefined> {
  const suffix = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
  const res = await fetch(`/api/projects/${slug}/board${suffix}`);
  if (res.status === 304) return undefined;
  if (!res.ok) throw new Error(`Failed to load board (${res.status})`);
  const data = (await res.json()) as { board: Board };
  return data.board;
}
