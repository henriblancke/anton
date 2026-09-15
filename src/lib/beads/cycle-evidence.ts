import type { DepCycle } from "./hygiene";
import type { Bead } from "./types";

/**
 * Authoritative `bd dep cycles` output belongs to one board read. A weak sidecar keeps that evidence
 * available to pure consumers of the snapshot without copying transient command output onto beads.
 *
 * Anchored on globalThis via Symbol.for (PR #274 review, round 5 on this file), same as the snapshot
 * and probe registries in snapshot.ts/issues.ts: a module-scoped WeakMap is invisible across a Next.js
 * module registry boundary, so a route reading the global issue snapshot from one registry and this
 * module instantiated fresh in another would see evidence attached in one as permanently missing in
 * the other — a false fail-closed startability result even though the retained snapshot already has
 * valid evidence. A WeakMap's keys stay identity-based regardless of which registry holds the map, so
 * anchoring it changes nothing about lookup semantics.
 */
const CYCLE_EVIDENCE_KEY = Symbol.for("anton.beads.cycleEvidence");

function cyclesByBoard(): WeakMap<readonly Bead[], DepCycle[]> {
  const global = globalThis as unknown as Record<symbol, WeakMap<readonly Bead[], DepCycle[]> | undefined>;
  return (global[CYCLE_EVIDENCE_KEY] ??= new WeakMap());
}

/** Attach cycle evidence to exactly the snapshot that produced it. */
export function attachCycleEvidence<T extends Bead[]>(board: T, cycles: DepCycle[]): T {
  cyclesByBoard().set(board, cycles);
  return board;
}

/** The cycle evidence read with this snapshot, if the caller asked for the authoritative check. */
export function cycleEvidenceFor(board: readonly Bead[]): DepCycle[] | undefined {
  return cyclesByBoard().get(board);
}
