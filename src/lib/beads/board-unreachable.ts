import { IDENTITY_MISMATCH_TEXT } from "./bd-env";

/**
 * Which board dependency a bd failure cannot reach. The cause stays named because a project's
 * identity mismatch needs a different remedy from a shared-server outage.
 */
export type BoardUnreachableCause =
  | "identity-mismatch"
  | "server-unreachable"
  | "dolt-missing"
  | "disk-full";

const BOARD_UNREACHABLE_CAUSES: ReadonlyArray<{
  cause: Exclude<BoardUnreachableCause, "identity-mismatch">;
  pattern: RegExp;
}> = [
  { cause: "server-unreachable", pattern: /Dolt server unreachable/i },
  { cause: "dolt-missing", pattern: /dolt is not installed|not found in PATH/i },
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
