/**
 * The db read behind the "quality" slice of a project's trend series (anton-6b835): resolves
 * {@link QualityInput} from `runs.review_score`, the `review_rounds` table, and the per-feature
 * friction `cohort-read.ts` already folds out of `feature-ledger.ts` — then hands it to
 * `trend-series.ts`'s pure fold. Nothing here does arithmetic beyond shaping rows.
 *
 * Zero-touch share reuses {@link cohortFeatures} rather than re-reading invocations and friction
 * itself, the same reuse `prompt-series.ts`'s own read layer is built on: that fold already
 * resolves a project's run targets to their whole-life `delivered`/`deliveredAtMs`/`humanTouches`,
 * and re-deriving it here would be a second, driftable copy of the same board + ledger walk.
 */
import { and, asc, eq, gte, isNotNull } from "drizzle-orm";
import { cohortFeatures } from "./cohort-read";
import { getDb, schema } from "./db";
import type { AntonDb } from "./jobs/queue";
import {
  qualityWeekPoints,
  windowStartMs,
  type DeliveredFeaturePoint,
  type QualityInput,
  type QualityWeekPoint,
  type ReviewRoundPoint,
  type ScoredRunPoint,
} from "./trend-series";

/** One run's score, as the quality fold needs it — see {@link scoredRunPoints}. */
async function scoredRunPoints(
  db: AntonDb,
  projectId: string,
  since: Date,
): Promise<ScoredRunPoint[]> {
  const rows = await db
    .select({
      reviewScore: schema.runs.reviewScore,
      endedAt: schema.runs.endedAt,
      updatedAt: schema.runs.updatedAt,
    })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        isNotNull(schema.runs.reviewScore),
        gte(schema.runs.updatedAt, since),
      ),
    );

  const out: ScoredRunPoint[] = [];
  for (const row of rows) {
    // `endedAt`, falling back to `updatedAt` for a row settled before it was recorded — the same
    // "when did this settle" reasoning `listDeliveriesByBead` applies to a delivery timestamp.
    const atMs = (row.endedAt ?? row.updatedAt)?.getTime();
    if (atMs === undefined || row.reviewScore === null) continue;
    out.push({ atMs, score: row.reviewScore });
  }
  return out;
}

/** `review_rounds.by_author_json`, parsed defensively — a model-controlled blob, never trusted raw. */
function parseByAuthor(json: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = Object.create(null);
    for (const [author, n] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n)) out[author] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** One project's review rounds since `since`, shaped for the quality fold. */
async function reviewRoundPoints(
  db: AntonDb,
  projectId: string,
  since: Date,
): Promise<ReviewRoundPoint[]> {
  const rows = await db
    .select({
      recordedAt: schema.reviewRounds.recordedAt,
      threadsActionable: schema.reviewRounds.threadsActionable,
      byAuthorJson: schema.reviewRounds.byAuthorJson,
    })
    .from(schema.reviewRounds)
    .where(and(eq(schema.reviewRounds.projectId, projectId), gte(schema.reviewRounds.recordedAt, since)));

  return rows.map((row) => ({
    atMs: row.recordedAt.getTime(),
    threadsActionable: row.threadsActionable,
    byAuthor: parseByAuthor(row.byAuthorJson),
  }));
}

/**
 * This project's EARLIEST `review_rounds` row, project-wide — never bounded by the requested
 * window, since a window that starts after the table's real first row would otherwise read every
 * week in it as "predates the record" (`threadsByWeek`'s own rule). `undefined` means the project
 * has no rows at all, which reads every week as absent, honestly: nothing has ever been recorded.
 */
async function recordingStartedAtMs(db: AntonDb, projectId: string): Promise<number | undefined> {
  const rows = await db
    .select({ recordedAt: schema.reviewRounds.recordedAt })
    .from(schema.reviewRounds)
    .where(eq(schema.reviewRounds.projectId, projectId))
    .orderBy(asc(schema.reviewRounds.recordedAt))
    .limit(1);
  return rows[0]?.recordedAt.getTime();
}

/**
 * Delivered features in the window, as the zero-touch fold needs them — {@link cohortFeatures}
 * filtered down to the two fields that fold reads. A feature that delivered without a recorded
 * time (`deliveredAtMs` absent — see `CohortFeature`'s own note) has nowhere to be bucketed and is
 * dropped, the same gap `promptSeries` already lives with for the same reason.
 *
 * `undefined` only when `projectId` names no project `cohortFeatures` can resolve — passed through
 * rather than collapsed to `[]`, so {@link trendQuality} can tell "no project" from "no deliveries".
 */
async function deliveredFeaturePoints(
  db: AntonDb,
  projectId: string,
  since: Date,
): Promise<DeliveredFeaturePoint[] | undefined> {
  const features = await cohortFeatures(db, projectId, { since });
  if (features === undefined) return undefined;
  return features
    .filter((f) => f.delivered && f.deliveredAtMs !== undefined)
    .map((f) => ({ deliveredAtMs: f.deliveredAtMs as number, humanTouches: f.humanTouches }));
}

/**
 * This project's quality, one point per ISO week over the last `weeks` weeks. `undefined` only
 * when `projectId` names no project this `cohortFeatures` read can resolve — see its own contract.
 */
export async function trendQuality(
  db: AntonDb,
  projectId: string,
  weeks: number,
  opts: { nowMs?: number } = {},
): Promise<QualityWeekPoint[] | undefined> {
  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(windowStartMs(weeks, nowMs));

  const [scoredRuns, reviewRounds, recordingStart, deliveredFeatures] = await Promise.all([
    scoredRunPoints(db, projectId, since),
    reviewRoundPoints(db, projectId, since),
    recordingStartedAtMs(db, projectId),
    deliveredFeaturePoints(db, projectId, since),
  ]);
  if (deliveredFeatures === undefined) return undefined;

  const input: QualityInput = {
    scoredRuns,
    reviewRounds,
    deliveredFeatures,
    recordingStartedAtMs: recordingStart,
  };
  return qualityWeekPoints(input, weeks, { nowMs });
}

/** UI/read path over the shared anton.db — see {@link trendQuality}. */
export function projectTrendQuality(
  projectId: string,
  weeks: number,
  opts?: { nowMs?: number },
): Promise<QualityWeekPoint[] | undefined> {
  return trendQuality(getDb(), projectId, weeks, opts);
}
