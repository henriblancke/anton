"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { isBoardGrouping, type BoardGrouping } from "@/components/board/board-utils";
import {
  BOARD_GROUPING_COOKIE_MAX_AGE,
  boardGroupingCookieName,
  parseBoardGrouping,
} from "@/lib/board-grouping";

/**
 * Fallback for projects whose choice could NOT be written (private mode, blocked cookies) — the
 * preference is still honoured for the session. The cookie stays the source of truth everywhere
 * else, so an entry here is deleted the moment a write succeeds.
 */
const unwritable = new Map<string, BoardGrouping>();

/** Where the preference lived before the server had to read it (anton-wds3). */
const LEGACY_STORAGE_PREFIX = "anton:board-grouping:";

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function readCookie(name: string): string | undefined {
  try {
    for (const pair of document.cookie.split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0 && pair.slice(0, eq).trim() === name) return decodeURIComponent(pair.slice(eq + 1));
    }
  } catch {
    // Unreadable cookies read as an unset preference, same as never having chosen.
  }
  return undefined;
}

function readGrouping(slug: string): BoardGrouping {
  const fallback = unwritable.get(slug);
  if (fallback) return fallback;
  return parseBoardGrouping(readCookie(boardGroupingCookieName(slug)));
}

/**
 * Writes the choice where the SERVER will read it on the next load, and reports whether it landed.
 * `document.cookie` fails silently when cookies are blocked, so the write is read back rather than
 * assumed. Choosing the default deletes the cookie instead of storing it: one cookie per board that
 * left `stage`, not one per board ever opened.
 */
function writeGrouping(slug: string, next: BoardGrouping): boolean {
  const name = boardGroupingCookieName(slug);
  try {
    document.cookie =
      next === "stage"
        ? `${name}=; path=/; max-age=0; samesite=lax`
        : `${name}=${next}; path=/; max-age=${BOARD_GROUPING_COOKIE_MAX_AGE}; samesite=lax`;
  } catch {
    return false;
  }
  return parseBoardGrouping(readCookie(name)) === next;
}

/** Take a choice as this tab's answer for the board, wherever it came from, and republish it. */
function adopt(slug: string, next: BoardGrouping): void {
  if (writeGrouping(slug, next)) unwritable.delete(slug);
  else unwritable.set(slug, next);
  for (const notify of listeners) notify();
}

/**
 * Carry a preference stored under the pre-cookie key across the format change (PR #226 review).
 *
 * Without it the switch to cookies silently reset every board an operator had put on Epic grouping,
 * back to the `stage` default, with nothing to say why. So the old value is read once and adopted as
 * the cookie the server reads — and only then dropped, so a browser that refuses the cookie keeps
 * the one durable copy it has rather than trading it for a session-only one.
 */
function adoptLegacyGrouping(slug: string): void {
  const key = LEGACY_STORAGE_PREFIX + slug;
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(key);
  } catch {
    return; // Unreadable storage holds nothing to rescue.
  }
  if (stored === null) return;
  // A cookie already answers for this board: the choice has been made in the new format, and the old
  // key is dead rather than a preference to restore.
  if (readCookie(boardGroupingCookieName(slug)) === undefined && isBoardGrouping(stored)) {
    adopt(slug, stored);
    if (unwritable.has(slug)) return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Left behind; the cookie answers first, so the next load never reads it again.
  }
}

/**
 * The board's grouping choice, remembered per project. It is a view preference, not board state —
 * it belongs to the person looking at the board — so it lives in a cookie rather than costing a
 * round trip or a column in anton.db.
 *
 * `initial` is that same cookie as the SERVER read it, and it is what the server snapshot serves:
 * the first paint is already the operator's grouping, so nothing has to be un-painted on mount
 * (anton-wds3). Read as an external store all the same, so a choice made elsewhere in the tab — or
 * a preference only this session could hold — is still adopted after hydration. Reading the cookie
 * during render instead would hydrate-mismatch the board on every load.
 */
export function useBoardGrouping(
  slug: string,
  initial: BoardGrouping = "stage",
): [BoardGrouping, (next: BoardGrouping) => void] {
  const grouping = useSyncExternalStore(
    subscribe,
    () => readGrouping(slug),
    () => initial,
  );

  // One-time rescue of the pre-cookie choice (PR #226 review), in an effect rather than in the read
  // above: the snapshot must stay pure, and this writes.
  useEffect(() => adoptLegacyGrouping(slug), [slug]);

  const choose = useCallback((next: BoardGrouping) => adopt(slug, next), [slug]);

  return [grouping, choose];
}
