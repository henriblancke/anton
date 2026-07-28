"use client";

import { useCallback, useSyncExternalStore } from "react";

import { isBoardGrouping, type BoardGrouping } from "@/components/board/board-utils";

const STORAGE_PREFIX = "anton:board-grouping:";

/**
 * Fallback for projects whose choice could NOT be written (private mode, blocked cookies) — the
 * preference is still honoured for the session. Storage stays the source of truth everywhere else,
 * so an entry here is deleted the moment a write succeeds.
 */
const unstorable = new Map<string, BoardGrouping>();

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function readGrouping(slug: string): BoardGrouping {
  const fallback = unstorable.get(slug);
  if (fallback) return fallback;
  try {
    const stored = window.localStorage.getItem(STORAGE_PREFIX + slug);
    if (isBoardGrouping(stored)) return stored;
  } catch {
    // Unreadable storage reads as the default, same as an unset preference.
  }
  return "stage";
}

/**
 * The board's grouping choice, remembered per project. It is a view preference, not board state —
 * it belongs to the person looking at the board, so it lives in localStorage rather than costing a
 * round trip or a column in anton.db.
 *
 * Read as an external store so the server and the hydrating client both see the `stage` default and
 * React adopts the stored choice itself after mount. Reading localStorage during render instead
 * would hydrate-mismatch the board on every load.
 */
export function useBoardGrouping(slug: string): [BoardGrouping, (next: BoardGrouping) => void] {
  const grouping = useSyncExternalStore(
    subscribe,
    () => readGrouping(slug),
    () => "stage" as BoardGrouping,
  );

  const choose = useCallback(
    (next: BoardGrouping) => {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + slug, next);
        unstorable.delete(slug);
      } catch {
        unstorable.set(slug, next);
      }
      for (const notify of listeners) notify();
    },
    [slug],
  );

  return [grouping, choose];
}
