import type { DepCycle } from "./hygiene";
import type { Bead } from "./types";

/**
 * Authoritative `bd dep cycles` output belongs to one board read. A weak sidecar keeps that evidence
 * available to pure consumers of the snapshot without copying transient command output onto beads.
 */
const cyclesByBoard = new WeakMap<readonly Bead[], DepCycle[]>();

/** Attach cycle evidence to exactly the snapshot that produced it. */
export function attachCycleEvidence<T extends Bead[]>(board: T, cycles: DepCycle[]): T {
  cyclesByBoard.set(board, cycles);
  return board;
}

/** The cycle evidence read with this snapshot, if the caller asked for the authoritative check. */
export function cycleEvidenceFor(board: readonly Bead[]): DepCycle[] | undefined {
  return cyclesByBoard.get(board);
}
