/**
 * One-time, idempotent backfill of legacy PR pointers (anton-ftar). Live boards created before the
 * metadata.pr cutover (anton-is7x) carry their PR link in `external_ref` as `gh-<n>`. Without moving
 * those over, the cutover would strand every in-flight PR — the guard and sweep read only
 * `metadata.pr` now. This walks a board, moves each gh- ref to `metadata.pr`, and clears external_ref
 * for those refs only. Runs at cutover alongside the code repoint; safe to re-run (a no-op once done).
 */
import { beads, GH_PR_REF, type Bead } from "./bd";

/** A single planned move: bead `id` whose gh- external_ref `ref` should become metadata.pr. */
export interface PrRefMove {
  id: string;
  ref: string;
}

/**
 * Which beads need migrating, and to what. Pure (no bd calls) so the selection rule is unit-tested.
 * A bead is planned iff its external_ref is gh- shaped AND metadata.pr is not already set — the two
 * clauses together make the migration idempotent (a re-run sees metadata.pr and skips) and scoped
 * (a Linear/tracker URL never matches GH_PR_REF, so it is left in external_ref untouched).
 */
export function planPrRefMigration(list: Bead[]): PrRefMove[] {
  const plan: PrRefMove[] = [];
  for (const b of list) {
    if (b.metadata?.pr) continue; // already migrated — idempotent no-op
    const ref = b.external_ref;
    if (ref && GH_PR_REF.test(ref)) plan.push({ id: b.id, ref });
  }
  return plan;
}

/**
 * Every status a PR pointer could live on. In-flight PRs sit on open/in_progress/blocked beads, but
 * a merged/closed bead can still carry a stale gh- ref; deferred beads keep their fields too. bd's
 * default `list` hides everything but open, so the cutover must sweep them all or it would strand
 * pointers on non-open beads.
 */
const ALL_STATUSES = "open,in_progress,blocked,closed,deferred";

/**
 * Run the backfill over one board (`cwd`). Reads every bead, plans the gh- moves, and applies each
 * as a single atomic `bd update` (beads.migratePrRef). Returns the moves it made so a caller/CLI can
 * report them. Idempotent: a second run finds metadata.pr already set and does nothing.
 */
export async function migratePrRefs(cwd: string): Promise<PrRefMove[]> {
  const list = await beads.list(cwd, ["--status", ALL_STATUSES]);
  const plan = planPrRefMigration(list);
  for (const { id, ref } of plan) {
    await beads.migratePrRef(cwd, id, ref);
  }
  return plan;
}
