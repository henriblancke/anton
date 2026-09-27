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

/**
 * "Last verified" timestamp for the cycle evidence attached to ONE specific board array — keyed by
 * that array's identity, same as `cyclesByBoard` above, not by repo path (P2 review, PR #274,
 * issues.ts:296). A repo-keyed timestamp is shared by every `loadAllIssues({ withCycles: true })`
 * call for that cwd, including independent reads background jobs make into their own arrays that
 * never become the retained UI snapshot — each of those bumped the shared clock without touching
 * the retained board's own freshness, so `probeCycleEvidence` could read a stale retained board as
 * "recently checked" and skip re-verifying it. Anchoring the timestamp to the exact array that
 * carries the evidence means only a check of THAT board can ever refresh it.
 */
const CYCLE_EVIDENCE_CHECKED_AT_KEY = Symbol.for("anton.beads.cycleEvidenceCheckedAt");

function checkedAtByBoard(): WeakMap<readonly Bead[], number> {
  const global = globalThis as unknown as Record<symbol, WeakMap<readonly Bead[], number> | undefined>;
  return (global[CYCLE_EVIDENCE_CHECKED_AT_KEY] ??= new WeakMap());
}

/**
 * Attach cycle evidence to exactly the snapshot that produced it, stamping when it was verified.
 * `checkedAt` defaults to now; pass the original board's own stamp when re-keying the SAME,
 * already-verified evidence onto a rebuilt array (e.g. `refreshAllIssuesRead`'s post-hydration
 * re-attach) so that carry-over doesn't read as a fresh check that never happened.
 */
export function attachCycleEvidence<T extends Bead[]>(board: T, cycles: DepCycle[], checkedAt = Date.now()): T {
  cyclesByBoard().set(board, cycles);
  checkedAtByBoard().set(board, checkedAt);
  return board;
}

/** The cycle evidence read with this snapshot, if the caller asked for the authoritative check. */
export function cycleEvidenceFor(board: readonly Bead[]): DepCycle[] | undefined {
  return cyclesByBoard().get(board);
}

/** When this exact board's cycle evidence was last verified, if it was ever attached. */
export function cycleEvidenceCheckedAtFor(board: readonly Bead[]): number | undefined {
  return checkedAtByBoard().get(board);
}

/**
 * Drop evidence that a refresh attempt just failed to renew, so `cycleEvidenceFor` reports it
 * missing rather than keep handing back a verdict past its trust window (PR #274 review round
 * 24: an empty catch around a failed re-check left the expired entry in place).
 */
export function clearCycleEvidence(board: readonly Bead[]): void {
  cyclesByBoard().delete(board);
  checkedAtByBoard().delete(board);
}

/** Test-only reset for the checked-at sidecar, mirroring the other registries' resets. */
export function resetCycleEvidenceCheckedAt(): void {
  const global = globalThis as unknown as Record<symbol, WeakMap<readonly Bead[], number> | undefined>;
  global[CYCLE_EVIDENCE_CHECKED_AT_KEY] = new WeakMap();
}
