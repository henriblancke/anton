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
import type { ClaudeInvocationRow } from "./claude-invocations";
import { listInvocations } from "./claude-invocations";
import { cohortFeatures } from "./cohort-read";
import { getDb, schema } from "./db";
import { runsByCause } from "./failure-cause-read";
import { ledgerPhase } from "./feature-ledger";
import type { AntonDb } from "./jobs/queue";
import { groupInvocations, modelsMatch } from "./model-divergence";
import { costOf } from "./model-pricing";
import {
  qualityWeekPoints,
  trendSeries as foldTrendSeries,
  windowStartMs,
  type CostFeaturePoint,
  type DeliveredFeaturePoint,
  type InvocationStampPoint,
  type PhaseSpendPoint,
  type QualityInput,
  type QualityWeekPoint,
  type ReviewLoopInvocationPoint,
  type ReviewRoundPoint,
  type RunCausePoint,
  type ScoredRunPoint,
  type TrendSeries,
  type TrendSeriesInput,
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
      prNumber: schema.reviewRounds.prNumber,
      threadsActionable: schema.reviewRounds.threadsActionable,
      byAuthorJson: schema.reviewRounds.byAuthorJson,
    })
    .from(schema.reviewRounds)
    .where(and(eq(schema.reviewRounds.projectId, projectId), gte(schema.reviewRounds.recordedAt, since)));

  return rows.map((row) => ({
    atMs: row.recordedAt.getTime(),
    prNumber: row.prNumber,
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

/* ──────────────────  cost, phase spend, failures & review loop (anton-d6kw7 / anton-90875)  ───────────────── */

/** The token fields `costOf` prices, minus `webSearchRequests` — not a token count, never summed in. */
function totalTokens(
  row: Pick<
    ClaudeInvocationRow,
    "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens"
  >,
): number {
  return (
    (row.inputTokens ?? 0) +
    (row.outputTokens ?? 0) +
    (row.cacheReadInputTokens ?? 0) +
    (row.cacheCreationInputTokens ?? 0)
  );
}

/**
 * One project's `claude_invocations` rows in the window — shared by {@link phaseSpendPoints},
 * {@link invocationStampPoints} and {@link reviewLoopInvocationPoints} below, each of which needs a
 * different slice of the same rows. One query rather than three.
 */
function invocationWindowRows(db: AntonDb, projectId: string, since: Date): Promise<ClaudeInvocationRow[]> {
  return listInvocations(db, projectId, { since });
}

/**
 * Tokens and USD per invocation ROW, phase-classified by {@link ledgerPhase} — never grouped by
 * invocation first, matching {@link PhaseWeekTotals.invocations}'s own "rows, never jobs" grain. A
 * row `ledgerPhase` cannot classify (an unknown job type, a row from before `step_handler` existed)
 * is dropped: an unattributed row has no phase to bucket it under, and `phaseSpendByWeek` carries no
 * "unattributed" bucket to put it in.
 */
function phaseSpendPoints(rows: readonly ClaudeInvocationRow[]): PhaseSpendPoint[] {
  const out: PhaseSpendPoint[] = [];
  for (const row of rows) {
    const phase = ledgerPhase(row);
    if (phase === undefined) continue;
    out.push({
      atMs: row.recordedAt.getTime(),
      phase,
      tokens: totalTokens(row),
      usd: costOf(row.modelReported, row, row.endpointHost),
    });
  }
  return out;
}

/**
 * The stamp columns {@link changeMarkers} reads, one point per real INVOCATION rather than per row:
 * essentially every real opus invocation also writes a haiku sidecar row (same invocation, a second
 * `modelReported`), so folding raw rows would double-count every model change and corrupt the
 * majority vote {@link modelChangeMarkers} takes over a week. Grouped via {@link groupInvocations},
 * the same regrouping {@link ledgerTotals} applies before classifying a row.
 *
 * `promptDigest`/`agentTag`/`skillId`/`skillDigest`/`antonVersion`/`stepHandler` are genuinely
 * invariant across an invocation's rows (`claude-invocations.ts`'s `invocationRows` stamps them once
 * into the `shared` object every row of the call copies), so `fact.rows[0]` carries them regardless
 * of row order. The
 * model is the opposite case — it is the ONE column that differs row to row BY DESIGN — so picking
 * `rows[0]`'s would silently report the sidecar's model on ties, since `listInvocations` orders rows
 * `desc(recordedAt), desc(rowid)` and a sidecar row is written after (so sorts before) its primary.
 * The model that answered anton's OWN request — the one {@link modelsMatch} confirms against
 * `modelRequested` — is what a change marker means to track; a sidecar/subagent row never matches it.
 * Falls back to the first reported model only when the request diverged outright (no row matches).
 */
function invocationStampPoints(rows: readonly ClaudeInvocationRow[]): InvocationStampPoint[] {
  return groupInvocations(rows).map((fact) => {
    const row = fact.rows[0];
    const servedModel = fact.modelsReported.find((model) => modelsMatch(fact.modelRequested, model));
    return {
      atMs: row.recordedAt.getTime(),
      modelReported: servedModel ?? fact.modelsReported[0] ?? null,
      promptDigest: row.promptDigest,
      agentTag: row.agentTag,
      skillId: row.skillId,
      skillDigest: row.skillDigest,
      antonVersion: row.antonVersion,
      stepHandler: row.stepHandler,
    };
  });
}

/**
 * The self-review/PR-fix invocations {@link reviewLoopByFeature} counts, one point per real
 * invocation for the same sidecar-row reason {@link invocationStampPoints} groups: a raw-row count
 * overcounts by the sidecar factor, corrupting both the displayed per-feature counts and the
 * median-based runaway comparison. A fact with no `beadId` (a scheduled pass, never a feature) has
 * nothing to bucket a loop count under and is dropped.
 */
function reviewLoopInvocationPoints(rows: readonly ClaudeInvocationRow[]): ReviewLoopInvocationPoint[] {
  const out: ReviewLoopInvocationPoint[] = [];
  for (const fact of groupInvocations(rows)) {
    if (fact.beadId === null) continue;
    const phase = ledgerPhase(fact.rows[0]);
    if (phase !== "self-review" && phase !== "pr-fix") continue;
    out.push({ beadId: fact.beadId, phase });
  }
  return out;
}

/** Failed/parked runs in the window, as {@link runsByCauseByWeek} needs them — see {@link runsByCause}. */
async function runCausePoints(db: AntonDb, projectId: string, since: Date): Promise<RunCausePoint[]> {
  const runs = await runsByCause(db, projectId, since);
  return runs.map((run) => ({ settledAtMs: run.settledAt * 1000, cause: run.cause }));
}

/**
 * The whole trend, one point per ISO week over the last `weeks` weeks — quality, cost, phase spend,
 * change markers and failure causes, merged by {@link foldTrendSeries}. `undefined` only when
 * `projectId` names no project `cohortFeatures` can resolve — the same contract {@link trendQuality}
 * carries.
 *
 * `cohortFeatures` is read exactly once here, never twice the way calling both `trendQuality` and a
 * separate cost read would: its rows back both the delivered-feature figures quality needs and the
 * cost figures the cost fold needs, and it is expensive enough (one `bd` shell call per run target,
 * bounded concurrency) that a second call over the same window would double real work for no new data.
 */
export async function trendSeries(
  db: AntonDb,
  projectId: string,
  weeks: number,
  opts: { nowMs?: number } = {},
): Promise<TrendSeries | undefined> {
  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(windowStartMs(weeks, nowMs));

  const [scoredRuns, reviewRounds, recordingStart, features, invocationRows, runCauses] = await Promise.all([
    scoredRunPoints(db, projectId, since),
    reviewRoundPoints(db, projectId, since),
    recordingStartedAtMs(db, projectId),
    cohortFeatures(db, projectId, { since }),
    invocationWindowRows(db, projectId, since),
    runCausePoints(db, projectId, since),
  ]);
  if (features === undefined) return undefined;

  const deliveredFeatures: DeliveredFeaturePoint[] = features
    .filter((f) => f.delivered && f.deliveredAtMs !== undefined)
    .map((f) => ({ deliveredAtMs: f.deliveredAtMs as number, humanTouches: f.humanTouches }));
  const costFeatures: CostFeaturePoint[] = features.map((f) => ({
    delivered: f.delivered,
    deliveredAtMs: f.deliveredAtMs,
    activityAtMs: f.activityAtMs,
    usd: f.usd,
  }));

  const input: TrendSeriesInput = {
    quality: { scoredRuns, reviewRounds, deliveredFeatures, recordingStartedAtMs: recordingStart },
    costFeatures,
    phaseSpend: phaseSpendPoints(invocationRows),
    runCauses,
    invocationStamps: invocationStampPoints(invocationRows),
    reviewLoopInvocations: reviewLoopInvocationPoints(invocationRows),
  };
  return foldTrendSeries(input, weeks, { nowMs });
}

/** UI/read path over the shared anton.db — see {@link trendSeries}. */
export function projectTrendSeries(
  projectId: string,
  weeks: number,
  opts?: { nowMs?: number },
): Promise<TrendSeries | undefined> {
  return trendSeries(getDb(), projectId, weeks, opts);
}
