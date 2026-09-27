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
import { beads, type Bead } from "./beads/bd";
import { listInvocations } from "./claude-invocations";
import { getDb } from "./db";
import { featureLedger } from "./feature-ledger-read";
import { currentRunTargetOf } from "./feature-scope";
import type { AntonDb } from "./jobs/queue";
import { getProjectById } from "./projects";
import type { CohortFeature } from "./prompt-series";
import { listAllBeads } from "./tickets";

/**
 * The run targets `board` currently recognizes among the beads a project's invocations named in
 * the window — resolved through {@link currentRunTargetOf} so a ticket reparented since it ran
 * still lands on the feature that owns it NOW, the same "scope moves when the board does" rule
 * `feature-scope.ts` states for a single ledger.
 */
async function activeRunTargetIds(
  db: AntonDb,
  projectId: string,
  board: Bead[],
  since: Date | undefined,
): Promise<Set<string>> {
  const rows = await listInvocations(db, projectId, since ? { since } : {});
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.beadId) continue;
    const targetId = currentRunTargetOf(board, row.beadId);
    const target = board.find((b) => b.id === targetId);
    if (target && beads.isRunTarget(target, board)) ids.add(targetId);
  }
  return ids;
}

/** One run target's whole-life {@link CohortFeature}, composed from the reads named in the header. */
async function cohortFeatureOf(
  db: AntonDb,
  projectId: string,
  board: Bead[],
  beadId: string,
): Promise<CohortFeature> {
  // `featureLedger` already runs the scope's invocation and delivery reads to fold `totals`/`timing`
  // — reusing its `rows`/`deliveredAtMs` instead of re-fetching keeps this a single pass over the
  // scope rather than two (PR #331 review).
  const ledger = await featureLedger(db, projectId, beadId, { board });
  const deliveredAtMs = ledger?.deliveredAtMs;

  return {
    beadId,
    delivered: deliveredAtMs !== undefined,
    ...(deliveredAtMs !== undefined ? { deliveredAtMs } : {}),
    usd: ledger?.totals.totals.usd,
    reviewRounds: ledger?.friction.reviewRounds,
    humanTouches: ledger?.friction.humanTouches,
    escalations: ledger?.friction.escalations,
    rows: ledger?.rows ?? [],
  };
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
  const targetIds = await activeRunTargetIds(db, projectId, board, opts.since);
  return Promise.all([...targetIds].map((id) => cohortFeatureOf(db, projectId, board, id)));
}

/** UI/read path over the shared anton.db — see {@link cohortFeatures}. */
export function projectCohortFeatures(
  projectId: string,
  opts?: { since?: Date },
): Promise<CohortFeature[] | undefined> {
  return cohortFeatures(getDb(), projectId, opts);
}
