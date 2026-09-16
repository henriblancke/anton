import { IDENTITY_MISMATCH_TEXT } from "./bd-env";

/**
 * Which board dependency a bd failure cannot reach. The cause stays named because a project's
 * identity mismatch needs a different remedy from a shared-server outage.
 *
 * `database-unreadable` and `board-timeout` are never matched from raw text (see
 * {@link boardUnreachableCause}) — a preflight's board-read probe and a wedged bd invocation don't
 * produce a reliable, greppable message, so the thrower assigns these directly on
 * `BoardUnreachableError.boardCause` instead of relying on this classifier (PR #277 review).
 */
export type BoardUnreachableCause =
  | "identity-mismatch"
  | "server-unreachable"
  | "dolt-missing"
  | "disk-full"
  | "database-unreadable"
  | "board-timeout";

const BOARD_UNREACHABLE_CAUSES: ReadonlyArray<{
  cause: Exclude<BoardUnreachableCause, "identity-mismatch">;
  pattern: RegExp;
}> = [
  // bd's failed auto-start names both its absent binary and the unavailable target; the binary is
  // the actionable cause, so it must win over the generic server phrase.
  { cause: "dolt-missing", pattern: /dolt is not installed|not found in PATH/i },
  // "Dolt server unreachable" is bd's own wrapper message; `dial tcp` is the raw Go net-package text
  // a shared-server transport failure surfaces AS, unwrapped, at any call site that talks to the
  // server directly instead of through a probe that already classifies by context (e.g.
  // review-fix.ts's `beads.list`, which bypasses preflightSharedServer's ANY-failure fallback) — left
  // unmatched, those diagnostics fell through as a plain Error and burned an ordinary retry budget
  // per job instead of collapsing into run-health's one outage finding (PR #277 review).
  { cause: "server-unreachable", pattern: /Dolt server unreachable|dial tcp\b/i },
  { cause: "disk-full", pattern: /no space left|ENOSPC/i },
];

/**
 * Which board-unreachable cause bd/dolt's failure text names, or undefined for an ordinary bd
 * error. Kept at this dependency leaf so both the raw bd process boundary and sync can classify
 * the same output without an import cycle.
 */
export function boardUnreachableCause(output: string): BoardUnreachableCause | undefined {
  if (output.includes(IDENTITY_MISMATCH_TEXT)) return "identity-mismatch";
  return BOARD_UNREACHABLE_CAUSES.find(({ pattern }) => pattern.test(output))?.cause;
}

export function isBoardUnreachableOutput(output: string): boolean {
  return boardUnreachableCause(output) !== undefined;
}
