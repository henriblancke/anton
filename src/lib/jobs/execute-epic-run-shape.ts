/**
 * The one seam the run-shape helpers sit behind (anton-8x1k). Establishing what a run WALKS — its
 * cooked pipeline — and taking the cross-machine lease that makes this machine the only one walking
 * it are the last shape work before any worktree exists, so {@link prepareEpicRun} threads two calls
 * through this module rather than fanning out across the formula/step family and the lease's own
 * dependencies. The checkout-staleness preflight (anton-vzhf) joins them behind this same seam:
 * `assertSelfCheckoutFresh` is FORWARDED from execute-epic-freshness.ts (which owns the self-freshness
 * and breaker modules) so the preparation module reaches it here rather than importing those modules
 * itself (anton-8x1k) — the seam takes on one re-export, not their whole subgraph. The seam is kept
 * deliberately lean: the board-gate half of the lease (the drift/retry decision) is INJECTED by the
 * caller rather than imported here, so it stays with prepare's other board gates.
 */
import { withBeadWriteLock } from "../beads/claim-lock";
import type { Bead } from "../beads/bd";
import { findRunFormulaForBranch, updateRun } from "../runs";
import { assertRunFormulaFloor } from "./formula-floor";
import { validateRunFormula, type ResolvedStep } from "./run-formula";
import { splitFormulaPhases } from "./execute-epic-formula";
import type { EpicRun } from "./execute-epic-run";

// The run-shape types the preparation module re-exports through this seam rather than reaching past
// it to the formula/step family — the whole point of the grouping (anton-8x1k).
export type { ResolvedStep } from "./run-formula";
export type { StepContext } from "./step-registry";
// The checkout-staleness preflight (anton-vzhf) reaches prepare through this same seam: its two
// volatile modules (self-freshness, the breaker) stay in execute-epic-freshness.ts, and this seam
// forwards the gate so the preparation module imports it here rather than fanning those modules out
// into its own top-level graph (anton-8x1k) — the same firewall the type re-exports above serve.
export { assertSelfCheckoutFresh } from "./execute-epic-freshness";

/** Step 0d. Cook, floor-check and pin the pipeline this run walks, then split it into its phases. */
export async function resolveRunPipeline(
  run: EpicRun,
): Promise<{ ticketSteps: ResolvedStep[]; runSteps: ResolvedStep[] }> {
  const { db, clock, projectId, repo, runId, branch, targetId: epicBeadId, settings, existing, target } = run;
  // 0d. Validate the project's run pipeline (anton-hrql). The formula is what a run walks, so a
  //     broken one must fail at the START of a run rather than halfway through: cook it and
  //     resolve every step's handler here — before the lease is published and before any worktree
  //     exists — so an unparseable file, a key bd would silently drop, or a `step:` label that
  //     maps to no handler parks with the file path and the offending step instead of stranding a
  //     half-executed run. PARK, like the gates above: the operator fixes the file (or deletes it
  //     to fall back to anton's default) and resumes. Cheap and read-only — the project copy when
  //     it has one, else anton's bundled default.
  //     Then hold the cooked pipeline to anton's invariant floor (anton-6b99): the project owns
  //     the steps, anton owns the guarantees, so a formula may ADD steps freely but may not omit
  //     implement/commit/pr or order them so the run's work is thrown away (a PR opened before
  //     the commit, an agent dispatched after it). Same park, same place — before the worktree.
  //     WHICH pipeline is a per-label choice (anton-aa3m): the project may map a bead label to a
  //     formula of its own, so this run walks the first mapped label the TARGET carries (one run
  //     is one worktree and one PR, so it walks one pipeline), else the project's default. The
  //     floor is applied to whatever came back — selection only changes which file is loaded —
  //     so a variant cannot escape it. The choice is then recorded ON THE RUN below rather than
  //     left to be inferred from settings and labels that may since have changed.
  //     Selection happens ONCE PER BRANCH, not once per attempt: an attempt that already
  //     recorded a pipeline pins it, and this one re-validates that source instead of selecting
  //     again. Every attempt re-reads the board and the settings, so re-selecting would let a
  //     label added since (`stage:implementing` — which this very job adds below — or an
  //     operator's relabel) or an edited variant map switch pipelines after some tickets had
  //     already committed, while the record below claimed the whole run used the new one. The
  //     pin is not limited to the open run row: an ordinary handler error settles the row
  //     `failed`, so the runner's retry lands here with `existing` undefined while still reusing
  //     that attempt's worktree and its committed tickets — hence the branch-scoped lookup
  //     (findRunFormulaForBranch), which is the same continuity the retry itself resumes by.
  //     `{{var}}` values make this a RUNTIME cook: the pipeline is resolved with the run's own
  //     target, and bd's "every declared variable needs a value" check fires here rather than a
  //     formula anton cannot satisfy walking with literal placeholders in it.
  const pinnedFormula = existing?.formula
    ? { source: existing.formula, variant: existing.formulaVariant ?? undefined }
    : await findRunFormulaForBranch(db, projectId, epicBeadId, branch);
  const formula = await validateRunFormula(repo, {
    labels: target.labels,
    variants: settings.formulaVariants,
    pinned: pinnedFormula,
    vars: { target: epicBeadId },
  });
  assertRunFormulaFloor(formula);
  // `recorded`, not `source`: anton's bundled default is stored as a sentinel rather than an
  // install-absolute path, so a run in flight across an upgrade that moved the install root
  // re-reads the pipeline it pinned instead of parking on a path that only changed.
  await updateRun(db, clock, runId, {
    formula: formula.recorded,
    formulaVariant: formula.variant ?? null,
  });
  // The pipeline this run walks (anton-lnkt), split at the commit into its two phases. Steps run
  // ONE AT A TIME — they share one worktree and one PR, so a formula whose steps could run
  // concurrently is not a licence to fan out.
  const { ticketSteps, runSteps } = splitFormulaPhases(formula);
  return { ticketSteps, runSteps };
}

/** The board-facing half of the lease: re-confirm the selection once the lease can be SEEN. */
export type ConfirmLeasedSelection = (run: EpicRun, children: Bead[]) => Promise<Bead[]>;

/**
 * Steps 1 → 1c. Take the lease under the target's write lock, then — still holding it — re-confirm
 * the ticket selection against a board that can now SEE this run, handing back the confirmed
 * children the caller re-gates on.
 */
export async function takeRunLease(
  run: EpicRun,
  preCheckTrusted: boolean,
  children: Bead[],
  confirmSelection: ConfirmLeasedSelection,
): Promise<Bead[]> {
  const { repo, targetId: epicBeadId, lease } = run;
  // 1. Publish the cross-machine run-liveness lease BEFORE any slow setup — worktree creation,
  //    operator resolution, the epic claim — and keep it fresh while this run executes
  //    (anton-jz1). Acquiring it up front closes the window where another machine's Force run
  //    (whose local jobs table is empty) sees no lease during our setup and starts a second
  //    concurrent run; the fresh foreign-lease gate above already ruled out an existing one. The
  //    initial publish fails closed (`lease.claim` throws if the label can't be written OR
  //    pushed to the shared remote) — a run whose lease no other machine can see must not
  //    proceed. `claim` also settles the post-publish race (step 1b) before it returns, so
  //    reaching the confirmation below means this run is the only one holding the target.
  //    `preCheckTrusted` is what forbids arbitrating by owner order after a stale pre-check.
  // Steps 1 → 1c run under the TARGET's own bead write lock (anton-e42l). The lease and the
  // confirmation read are what stop an approved gardener re-parent attaching a ticket to a set this
  // run has already selected — but a read alone serializes nothing: the gardener writes under
  // `withBeadWriteLock` (gardener/apply.ts `applyStep` locks the subject AND the home), and it
  // yields between passing `homeUnusable` and running the write. Outside that lock, the confirmation
  // could land in exactly that gap, see the old ticket set, and let the run proceed while the
  // delayed re-parent hangs a ticket nothing will dispatch — later closed unrun with the target.
  // Holding the home's lock across the publish AND the injected confirmation makes the two orders
  // real: either the re-parent completes first and the read sees the drift (retry), or it queues
  // behind this block and its own locked re-read finds the live lease (refuse). Released before the
  // claim in step 3, which takes this same lock (beads/claim.ts) — nothing inside here may take it,
  // on pain of deadlock. The confirmation is INJECTED (a board gate the caller owns) so this seam
  // keeps only the lease mechanism; it runs under the lock precisely because that is what serializes
  // it against the re-parent.
  let confirmed = children;
  await withBeadWriteLock(repo, epicBeadId, async () => {
    await lease.claim(preCheckTrusted);
    confirmed = await confirmSelection(run, children);
  });
  return confirmed;
}
