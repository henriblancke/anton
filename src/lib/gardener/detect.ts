/**
 * The gardener's JUDGMENT tier (anton-02oc): one pass over a board snapshot plus the patrol's
 * hygiene report, producing evidenced detections of everything the mechanical tier is not entitled
 * to touch.
 *
 * Pure over its input — no bd spawn, no db, no clock of its own — so a fixture board is a complete
 * test of what a patrol would find, and so emission (anton-9qwq) can be added around it without this
 * module gaining the ability to write anything.
 *
 * Entry point for every caller; the per-class detectors are exported from their own modules for
 * tests and for a future pass that wants one class in isolation.
 */
import type { Bead } from "../beads/bd";
import type { HygieneFinding } from "../hygiene";
import { indexBoard } from "./board-index";
import {
  dedupeDetections,
  isProposalBead,
  sortDetections,
  type GardenerDetection,
} from "./detections";
import { detectImpliedOrdering } from "./relink";
import { detectContainerOrphans, detectParentlessClusters } from "./reparent";
import { detectRetirementCandidates } from "./retire";

export interface DetectInput {
  /** The whole board (`bd list --json`), closed beads INCLUDED: container-ness, superseding twins
   * and card attribution are all read off the full graph. */
  board: Bead[];
  /** The patrol's report tier. Absent (or empty) ⇒ no retirement candidates — see retire.ts. */
  hygiene?: { findings: HygieneFinding[] };
  /** ms epoch, for the age-gated detectors. Injectable so a fixture board dates deterministically. */
  now?: number;
}

/**
 * Every board-shape detection the input supports, deduplicated by fingerprint and in a deterministic
 * order — two passes over an unchanged board return byte-identical output, which is what lets a
 * caller answer "is this new?" without re-reading the board.
 */
export function detectBoard(input: DetectInput): GardenerDetection[] {
  // The gardener's own proposals are excluded from the shape it judges: they are beads ABOUT the
  // board, and a parentless one would read as a cluster candidate — the patrol proposing to garden
  // itself. They still reach emission, which needs them to recognise a claim it already made.
  const index = indexBoard(input.board.filter((b) => !isProposalBead(b)));
  const now = input.now ?? Date.now();
  const findings = input.hygiene?.findings ?? [];

  return sortDetections(
    dedupeDetections([
      ...detectContainerOrphans(index, now),
      ...detectParentlessClusters(index, now),
      ...detectImpliedOrdering(index),
      ...detectRetirementCandidates(index, findings, now),
    ]),
  );
}

export { detectContainerOrphans, detectParentlessClusters } from "./reparent";
export { detectImpliedOrdering } from "./relink";
export {
  detectRetirementCandidates,
  RETIRE_STALE_IN_PROGRESS_DAYS,
  RETIRE_STALE_OPEN_DAYS,
} from "./retire";
export { indexBoard, type BoardIndex } from "./board-index";
export * from "./detections";
