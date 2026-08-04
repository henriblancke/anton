/**
 * The typed face of the tier taxonomy. The rules themselves live in `tiers.mjs` — plain JS so the
 * pure-Node launcher (`anton board-check`, which must run inside a user's repo from a release bundle
 * that ships no TypeScript) and this app share ONE definition instead of two that drift. This file
 * adds only types; it re-implements nothing.
 *
 * Why the rules are shaped the way they are — severity, the deliberately-absent "zero tickets is
 * invalid" rule, and why every rule keys on an epic's container-ness — is documented in `tiers.mjs`.
 * Read that first; this is the interface, not the reasoning.
 */
import type { Bead } from "./types";
import {
  FEATURE_TICKET_BUDGET,
  buildStructureReport as buildStructureReportJs,
  formatStructureReport as formatStructureReportJs,
  formatStructureViolations as formatStructureViolationsJs,
  isContainer as isContainerJs,
  parentOf as parentOfJs,
  structureGaps as structureGapsJs,
  validateBoardStructure as validateBoardStructureJs,
} from "./tiers.mjs";

export { FEATURE_TICKET_BUDGET };

export type StructureSeverity = "blocking" | "advisory";

/** Which tier rule a bead breaks. Stable strings — the CLI groups by them and tests assert on them. */
export type StructureRule =
  | "ticket-under-container-epic"
  | "feature-under-non-epic"
  | "parentless-chore"
  | "feature-without-epic"
  | "feature-without-tickets"
  | "feature-over-ticket-budget";

export interface StructureViolation {
  /** The offending bead — the one an author has to move or re-type. */
  id: string;
  rule: StructureRule;
  severity: StructureSeverity;
  /** What is wrong, why it can't run (or why it will cost), and the `bd` command that fixes it. */
  message: string;
}

export interface StructureReport {
  /** Live beads the tier rules apply to — the honest denominator for a conformance rate. */
  judged: number;
  blocking: number;
  advisory: number;
  violations: StructureViolation[];
}

/** Every way this board departs from `epic → feature → ticket`, in board order. */
export const validateBoardStructure = (board: Bead[]): StructureViolation[] =>
  validateBoardStructureJs(board);

/** The violations a single run target owns: its own, plus every descendant's. */
export const structureGaps = (
  targetId: string,
  board: Bead[],
  severity: StructureSeverity,
): StructureViolation[] => structureGapsJs(targetId, board, severity);

/** Violations as one line naming every offender and what is wrong — the body of a 422 or a park note. */
export const formatStructureViolations = (violations: StructureViolation[]): string =>
  formatStructureViolationsJs(violations);

/** The board's tier conformance, for `anton board-check` and `/shape`'s Phase 5 audit. */
export const buildStructureReport = (board: Bead[]): StructureReport => buildStructureReportJs(board);

/** The report as text: a headline, then one line per violation, worst severity first. */
export const formatStructureReport = (report: StructureReport, label = ""): string =>
  formatStructureReportJs(report, label);

/**
 * The two tier-graph predicates the rules read, exported for the parity test that pins them against
 * their `beads.*` twins in bd.ts. Not for general use — call `beads.parentOf` / `beads.isContainer`.
 */
export const parentOf = (bead: Bead): string | undefined => parentOfJs(bead);
export const isContainer = (bead: Bead, board: Bead[]): boolean => isContainerJs(bead, board);
