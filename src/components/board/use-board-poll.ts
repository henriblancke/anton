"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import { STAGES, type Board } from "@/lib/types";
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
  /** Read the authoritative board NOW — for a write that invalidates more than it can reconcile. */
  reload: () => Promise<void>;
  /** Optimistic writes from a drag; the move response and the next poll settle them. */
  setBoard: Dispatch<SetStateAction<Board | null>>;
  /** Drop a deleted card from every column without waiting for the next poll. */
  removeEpic: (epicId: string) => void;
  /** A target the operator set aside: stamped locally, and dropped from the recorded plan. */
  vetoBead: (beadId: string, untilMs: number) => void;
  /** Mirrors the live drag, so a read landing mid-drag can decline to clobber it. */
  draggingRef: RefObject<boolean>;
  /** The snapshot token the poll sends; a settled move advances it past its own write (anton-4g35). */
  versionRef: RefObject<string | undefined>;
  /** A board write is starting — polls are suppressed until {@link endWrite}. */
  startWrite: () => void;
  /** The write settled (either way): every poll fetched against the pre-write board is now stale. */
  endWrite: () => void;
}

/**
 * The board's live read: one conditional GET on a visibility-aware loop, plus the optimistic writes
 * the drag layer and the ticket dialog make on top of it. Held apart from the board's markup so
 * `EpicBoard` is a render of this state rather than the place it is reconciled.
 *
 * Every board write is bracketed, because a poll that raced it answers about a board that no longer
 * exists: the route's non-blocking path serves the retained PRE-write snapshot stamped with the
 * version the write already advanced to, so believing it silently undoes the write (anton-4g35).
 * `writesInFlight` covers the window during the write — an optimistic update has nothing
 * authoritative behind it yet — and the sequence covers every poll that left before it settled.
 */
export function useBoardPoll(slug: string, initialBoard: Board | null): BoardPoll {
  const [board, setBoard] = useState<Board | null>(initialBoard);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const draggingRef = useRef(false);
  const versionRef = useRef(initialBoard?.version);
  const loadingRef = useRef(false);
  const writeSeqRef = useRef(0);
  const writesInFlightRef = useRef(0);
  // A forced read that arrived while a poll was out is never dropped on the floor: that poll left
  // before the write and its answer will be discarded on `writeSeq`, so nobody else would re-read.
  const queuedForceRef = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal, force = false) => {
      // Reads that must not happen: a second one racing the first's version write, and any read at
      // all mid-drag — its answer would clobber the optimistic board the operator is holding.
      if (loadingRef.current || draggingRef.current) {
        if (force) queuedForceRef.current = true;
        return;
      }
      loadingRef.current = true;
      try {
        const writeSeq = writeSeqRef.current;
        const next = await readBoard(slug, force ? undefined : versionRef.current);
        if (
          next &&
          !signal?.aborted &&
          !draggingRef.current &&
          writesInFlightRef.current === 0 &&
          writeSeq === writeSeqRef.current
        ) {
          versionRef.current = next.version;
          setBoard(next);
          setError(null);
        }
      } catch (err) {
        // Only a board-less load surfaces an error UI; a failed poll keeps the last good board.
        if (signal?.aborted) return;
        setBoard((prev) => {
          if (prev === null) setError(err instanceof Error ? err.message : "Failed to load board");
          return prev;
        });
      } finally {
        loadingRef.current = false;
        if (queuedForceRef.current && !signal?.aborted) {
          queuedForceRef.current = false;
          await load(signal, true);
        }
      }
    },
    [slug],
  );

  // A read issued during a write is not withheld — returning to the tab must always ask — it is
  // discarded on arrival instead, by the in-flight and sequence checks in `load`.
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

  /**
   * Adopt a REFRESHED server board. `board` is seeded from `initialBoard` once and client-owned
   * after that, so a `router.refresh()` — how `[Release]` answers a lost claim race, and how the
   * ticket dialog answers a save — re-renders the page for nothing: the stale card keeps offering a
   * pick that already 409s until the next beat. The refreshed prop IS the authoritative read, so
   * take it directly rather than spending a second fetch on the same answer.
   *
   * The mount value is skipped (it already seeded state), and an interaction in flight wins: its own
   * settle has the last word on the board it is optimistically showing.
   */
  const seededBoardRef = useRef(initialBoard);
  useEffect(() => {
    if (initialBoard === null || initialBoard === seededBoardRef.current) return;
    seededBoardRef.current = initialBoard;
    if (draggingRef.current || writesInFlightRef.current > 0) return;
    versionRef.current = initialBoard.version;
    setBoard(initialBoard);
  }, [initialBoard]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const reload = useCallback(() => load(undefined, true), [load]);

  const removeEpic = useCallback((epicId: string) => {
    setBoard((prev) => (prev ? { ...prev, columns: removeEpicFromColumns(prev.columns, epicId) } : prev));
  }, []);

  const startWrite = useCallback(() => {
    writesInFlightRef.current += 1;
  }, []);
  // Order matters — the sequence takes over the moment the in-flight suppression lifts, so no poll
  // slips between the two. It bumps on failure too: a rejected write is not proof the server wrote
  // nothing.
  const endWrite = useCallback(() => {
    writeSeqRef.current += 1;
    writesInFlightRef.current -= 1;
  }, []);

  /**
   * A target the operator just set aside (anton-jqvy / R3.9). Stamped locally so the card reads as
   * deferred on the click that deferred it — the hold is server state, and the board's own poll is
   * up to 30s away, which is long enough for an operator to click `not now` twice.
   *
   * It also leaves Up Next on that click. The lane is driven by the recorded plan, which the next
   * picker pass rewrites up to ten minutes from now — so without this the declined target would keep
   * its place in the ranking it was just refused a place in.
   *
   * Only the sequence moves, unlike the reorder and move paths, which also bracket their write: this
   * is called once the veto route has recorded the deferral, so it is already durable and every
   * later read sees it. There is no in-flight window left to suppress.
   */
  const vetoBead = useCallback((beadId: string, untilMs: number) => {
    writeSeqRef.current += 1;
    setBoard((prev) => {
      if (!prev) return prev;
      const columns = { ...prev.columns };
      const standalone = { ...prev.standalone };
      for (const stage of STAGES) {
        columns[stage] = (columns[stage] ?? []).map((e) =>
          e.id === beadId ? { ...e, notNowUntil: untilMs } : e,
        );
        standalone[stage] = (standalone[stage] ?? []).map((i) =>
          i.id === beadId ? { ...i, notNowUntil: untilMs } : i,
        );
      }
      // The lane is ABSENT, never empty (types.ts): vetoing its last card drops it rather than
      // leaving an "Up Next" heading over nothing, which reads as "anton has nothing to start".
      const { upNext: ranked, ...rest } = prev;
      const upNext = ranked?.filter((entry) => entry.beadId !== beadId);
      return { ...rest, columns, standalone, ...(upNext?.length ? { upNext } : {}) };
    });
  }, []);

  return {
    board,
    error,
    refresh,
    reload,
    setBoard,
    removeEpic,
    vetoBead,
    draggingRef,
    versionRef,
    startWrite,
    endWrite,
  };
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
