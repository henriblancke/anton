/**
 * The cohort read (anton-lplyz): `CohortFeature[]` for a real project over a window — what
 * `promptSeries(features, dimension)` needs to answer "did the prompt, agent or skill change make
 * anton better" outside a test fixture.
 *
 * ## The window bounds WHICH run targets are considered, not each one's own figures
 *
 * A feature's cost, friction and stamps are its WHOLE LIFE — `feature-ledger-read.ts`'s own rule,
 * repeated here rather than reinvented: there is no window to bound one feature's ledger by, since
 * spend before a cutoff is still spend that feature incurred. So the window is applied once, at the
 * `claude_invocations` read that decides which run targets even enter the fold — the "windowed
 * project read" the design's own risk table names as covered by `claude_invocations_project_idx` —
 * and every run target that had activity in the window then gets its full, whole-life
 * {@link CohortFeature}. A feature whose LAST invocation lands just inside the window but whose
 * first landed months earlier is not truncated to the window's slice of it; the alternative would
 * shrink `usdPerFeature` by whatever the window happened to clip.
 *
 * ## Composed from the one read a single feature's ledger page already makes
 *
 * `featureLedger` answers `usd` (`totals.totals.usd`) and the three friction counters exactly as
 * {@link CohortFeature}'s own field comments name them, and now also exposes the raw invocation
 * `rows` and `deliveredAtMs` it already folded `totals`/`timing` from — so this module asks it
 * ONCE per feature rather than re-running its invocation and delivery reads over the same scope.
 * Nothing here re-derives what that module already owns — this module's only job is picking WHICH
 * run targets to ask it about and shaping the answer into what the pure fold reads.
 */
import { ACTIVE_RUN_STATUSES } from "@/components/runs/run-view-utils";
import { beads, type Bead } from "./beads/bd";
import { listInvocations } from "./claude-invocations";
import { getDb } from "./db";
import { lastDeliveryMs } from "./feature-ledger";
import { featureLedger } from "./feature-ledger-read";
import { ledgerScope } from "./feature-scope";
import type { AntonDb } from "./jobs/queue";
import { getProjectById } from "./projects";
import type { CohortFeature } from "./prompt-series";
import { listDeliveriesByBead, listRunBeadIdsByStatus } from "./runs";
import { listAllBeads } from "./tickets";
import { boardCards } from "./ticket-view";

/**
 * The run targets `board` currently recognizes among the beads a project's invocations named in
 * the window — resolved the same way `feature-scope.ts`'s `currentRunTargetOf` would (itself a
 * ticket, or the card above it) so a ticket reparented since it ran still lands on the feature
 * that owns it NOW, the "scope moves when the board does" rule that module states for a single
 * ledger. The card index, id index and run-target check are each built ONCE and reused for every
 * row rather than re-derived per row (PR #331 review): an all-time read over a project with
 * hundreds of invocation rows would otherwise rebuild `boardCards(board)` — and repeat
 * `beads.isRunTarget`'s own board scan — once per row instead of once per distinct target.
 *
 * A target in a {@link MAYBE_LIVE_TARGET_STATUSES} status MIGHT have no FINISHED outcome for its
 * current attempt yet, so folding it in now would risk folding partial spend and friction into a
 * cohort's numerators before the run's outcome — delivered, gave-up, or abandoned — is known.
 * `blocked` carries the same risk as `in_progress`: a run can gate a target on a dependency
 * mid-run and leave it `blocked` while it is still live (`execute-epic.gating.integration.test.ts`
 * shows the target's own status doing exactly this), so excluding only `in_progress` missed a
 * target a run had merely paused on, not finished with (PR #331 review).
 *
 * But `blocked` is not ONLY that: an agent that self-reports `ANTON-RESULT: blocked` settles its
 * run `status: "failed"` while leaving the ticket at `status: "blocked"` forever
 * (`execute-epic.abandon-base.integration.test.ts`) — a terminated, failed attempt, not live work.
 * Reading the bead's status alone cannot tell the two apart, so a status match here is only a
 * CANDIDATE: {@link activeRunTargetIds} then asks the `runs` table itself whether the candidate's
 * LAST known attempt actually failed with nothing still open behind it, and only then overrides the
 * status-based default (PR #331 review). Absent from the `runs` table entirely — no row at all for
 * the scope — the candidate's status is the only signal there is, and stays trusted as before; a
 * genuinely still-open run (`ACTIVE_RUN_STATUSES`) always wins over a stale failed one, since a
 * retry can leave both rows behind for the same target. A candidate whose only run evidence is a
 * terminal failure falls through to the "not live" branch below — folded in at its whole life,
 * `delivered: false`, so its spend and friction still land in a cohort's numerators as the failed
 * attempt it is, instead of vanishing.
 *
 * A target already holding a PRIOR delivery is kept regardless of its current status: reopening a
 * delivered feature for another round leaves it live again, but the delivery that already
 * happened is real evidence, not a premature outcome — dropping it would erase an already-shipped
 * feature's whole history for as long as the rerun takes (PR #331 review). Only a target on its
 * very first, still-live attempt — nothing delivered yet — has nothing to report.
 *
 * Such a target's cohort figures still must not reach past that prior delivery: the rerun it is
 * live on has no outcome yet, so its rows are exactly as premature as a first attempt's would be
 * (PR #331 review). The map this returns therefore carries a per-target cutoff — the prior
 * delivery's own timestamp for a target still live on a rerun, `undefined` (whole life, no bound)
 * for every other target — for {@link cohortFeatureOf} to cut the ledger at.
 */
/**
 * Statuses a run CAN leave its target in while still genuinely executing — no finished outcome
 * recorded on the bead itself. `deferred` is deliberately left out: snoozed work is rare to have
 * accrued fresh invocations against in the first place (PR #331 review).
 *
 * Only a candidate set: a status match here does not by itself mean live — see
 * {@link activeRunTargetIds}'s own note on why `blocked` needs the `runs` table to confirm it.
 */
const MAYBE_LIVE_TARGET_STATUSES = new Set(["in_progress", "blocked"]);

async function activeRunTargetIds(
  db: AntonDb,
  projectId: string,
  board: Bead[],
  since: Date | undefined,
): Promise<Map<string, number | undefined>> {
  const rows = await listInvocations(db, projectId, since ? { since } : {});
  const byId = new Map(board.map((b) => [b.id, b]));
  const cards = boardCards(board);
  const runTargetCache = new Map<string, boolean>();
  const isRunTargetCached = (bead: Bead): boolean => {
    const cached = runTargetCache.get(bead.id);
    if (cached !== undefined) return cached;
    const result = beads.isRunTarget(bead, board);
    runTargetCache.set(bead.id, result);
    return result;
  };

  const candidates = new Map<string, Bead>();
  for (const row of rows) {
    if (!row.beadId) continue;
    const bead = byId.get(row.beadId);
    if (!bead) continue;
    const targetId = isRunTargetCached(bead) ? bead.id : cards.cardOf(bead) ?? bead.id;
    const target = byId.get(targetId);
    if (target && isRunTargetCached(target)) candidates.set(targetId, target);
  }

  const scopeCache = new Map<string, string[]>();
  const scopeOf = (id: string): string[] => {
    const cached = scopeCache.get(id);
    if (cached) return cached;
    const scope = ledgerScope(board, id).ids;
    scopeCache.set(id, scope);
    return scope;
  };

  const maybeLive = [...candidates.values()].filter((t) => MAYBE_LIVE_TARGET_STATUSES.has(t.status));
  const maybeLiveScopeIds = maybeLive.flatMap((t) => scopeOf(t.id));
  const [activeRunIds, failedRunIds] =
    maybeLiveScopeIds.length === 0
      ? [new Set<string>(), new Set<string>()]
      : await Promise.all([
          listRunBeadIdsByStatus(db, projectId, maybeLiveScopeIds, ACTIVE_RUN_STATUSES),
          listRunBeadIdsByStatus(db, projectId, maybeLiveScopeIds, ["failed"]),
        ]);
  // A candidate's status is trusted UNLESS the `runs` table itself says its last known attempt
  // already failed with nothing still open behind it — see the note above
  // `MAYBE_LIVE_TARGET_STATUSES`. No run row at all for the scope leaves the status as the only
  // signal, same as before this check existed.
  const liveTargets = maybeLive.filter((t) => {
    const scope = scopeOf(t.id);
    const hasOpenRun = scope.some((id) => activeRunIds.has(id));
    const hasFailedRun = scope.some((id) => failedRunIds.has(id));
    return hasOpenRun || !hasFailedRun;
  });
  const priorDeliveries =
    liveTargets.length === 0
      ? new Map<string, number[]>()
      : await listDeliveriesByBead(db, projectId, liveTargets.flatMap((t) => scopeOf(t.id)), {
          includeLocalCommits: false,
        });
  const liveIds = new Set(liveTargets.map((t) => t.id));

  const ids = new Map<string, number | undefined>();
  for (const target of candidates.values()) {
    if (liveIds.has(target.id)) {
      const deliveredAtMs = lastDeliveryMs(priorDeliveries, scopeOf(target.id));
      if (deliveredAtMs === undefined) continue;
      ids.set(target.id, deliveredAtMs);
      continue;
    }
    ids.set(target.id, undefined);
  }
  return ids;
}

/**
 * One run target's {@link CohortFeature}, composed from the reads named in the header.
 *
 * `asOfMs` is the one exception to "whole life": for a target still live on a rerun of an
 * already-delivered feature ({@link activeRunTargetIds}), it is that prior delivery's own
 * timestamp, and everything recorded strictly after it — invocations, jobs, escalations, review
 * rounds, send-back notes — belongs to the rerun's own unfinished attempt. No outcome yet, so none
 * of it may inflate the delivered feature's cost or friction, or, worse, change its stamp and throw
 * an otherwise-clean cohort membership into {@link SpanningFeatures} (PR #331 review). `undefined`
 * for every other target, which reads as the module header's own rule: no bound at all, the whole
 * life. `featureLedger` owns the actual cut (`FeatureLedgerOptions.asOfMs`) — every source it folds
 * into `totals`, `friction` and `rows` is cut at the same instant, so nothing here can drift out of
 * step with what it returns by re-deriving one figure on its own.
 */
async function cohortFeatureOf(
  db: AntonDb,
  projectId: string,
  board: Bead[],
  beadId: string,
  asOfMs: number | undefined,
): Promise<CohortFeature> {
  const ledger = await featureLedger(db, projectId, beadId, { board, asOfMs });
  const deliveredAtMs = ledger?.deliveredAtMs;
  // The feature's last recorded activity regardless of outcome — what `promptSeries` places a
  // feature that never delivered by, since it has no `deliveredAtMs` of its own (PR #331 review).
  const activityAtMs = ledger?.rows.reduce<number | undefined>((latest, row) => {
    const at = row.recordedAt?.getTime();
    return at !== undefined && (latest === undefined || at > latest) ? at : latest;
  }, undefined);

  return {
    beadId,
    delivered: deliveredAtMs !== undefined,
    ...(deliveredAtMs !== undefined ? { deliveredAtMs } : {}),
    ...(activityAtMs !== undefined ? { activityAtMs } : {}),
    usd: ledger?.totals.totals.usd,
    // A defined `usd` beside a non-zero `unpricedRows` is still only a FLOOR for this feature — some
    // of its rows priced and some didn't. Carrying the count through lets `promptSeries` mark the
    // cohort average as partial instead of reading it as complete (PR #331 review).
    unpricedRows: ledger?.totals.totals.unpricedRows,
    reviewRounds: ledger?.friction.reviewRounds,
    humanTouches: ledger?.friction.humanTouches,
    escalations: ledger?.friction.escalations,
    rows: ledger?.rows ?? [],
  };
}

/**
 * How many {@link cohortFeatureOf} calls may run at once. Each one shells out to `bd` for its
 * review rounds ({@link reviewRoundsOf}), so an all-time read over a project with hundreds of run
 * targets must not fire every call at the same instant — past the host's process limit, the spawn
 * itself starts failing, and {@link reviewRoundsOf} swallows that failure into an empty round list
 * rather than surfacing it, silently undercounting review friction instead of erroring the page.
 */
const COHORT_FEATURE_CONCURRENCY = 8;

/** `items.map(fn)`, run at most {@link COHORT_FEATURE_CONCURRENCY} at a time, order preserved. */
async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Every run target a project's cohorts may fold over, or `undefined` when `projectId` names no
 * project on this anton.db.
 */
export async function cohortFeatures(
  db: AntonDb,
  projectId: string,
  opts: { since?: Date } = {},
): Promise<CohortFeature[] | undefined> {
  const project = await getProjectById(db, projectId);
  if (!project) return undefined;

  const board = await listAllBeads(project);
  const targets = await activeRunTargetIds(db, projectId, board, opts.since);
  return mapWithBoundedConcurrency([...targets], COHORT_FEATURE_CONCURRENCY, ([id, asOfMs]) =>
    cohortFeatureOf(db, projectId, board, id, asOfMs),
  );
}

/** UI/read path over the shared anton.db — see {@link cohortFeatures}. */
export function projectCohortFeatures(
  projectId: string,
  opts?: { since?: Date },
): Promise<CohortFeature[] | undefined> {
  return cohortFeatures(getDb(), projectId, opts);
}
