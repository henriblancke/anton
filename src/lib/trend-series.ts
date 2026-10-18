/**
 * Quality, as a spread and an outside view (anton-6b835): the pure weekly fold behind the "quality"
 * slice of a project's trend series (anton-p38kx). `trend-read.ts` resolves the raw rows; everything
 * here is pure arithmetic over them, one point per ISO week.
 *
 * ## Why no mean
 *
 * A self-review score averaged across a week hides exactly the thing worth seeing: a week that
 * mixes a run of 10s with a run of 4 reads the same as a week of flat 7s. `scoreDistributionByWeek`
 * reports the SHARE of that week's scored runs landing in each band (10, 9, 8, 7-and-below) instead —
 * the self-graded average design explicitly rejects (design §D3: these are signals, not a score to
 * average away).
 *
 * ## Absent, never zero
 *
 * Every fold below treats "nothing to measure" and "measured and found none" as different facts,
 * the same distinction `ledgerTotals`/`LedgerFriction` draw for money and friction:
 *
 *  - A week with zero scored runs has no distribution — dividing by zero samples is undefined, not
 *    0% in every band.
 *  - A week with zero delivered features has no zero-touch share, for the same reason.
 *  - A week with zero reviewer threads, once `review_rounds` existed to record them, IS a real
 *    measurement: nothing to review that week, reported as 0. Only weeks that PREDATE the table's
 *    first row read as absent — {@link threadsByWeek}'s `recordingStartedAtMs`.
 *
 * Pure and dependency-free, like `prompt-series.ts`: no db, no node builtins.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * The ISO 8601 week key (`"<year>-W<week>"`, zero-padded) containing `ms`. Computed off the ISO
 * rule — the week's own Thursday decides which year it belongs to — so a date in the last days of
 * December or the first days of January lands in the correct week even when that week's number
 * belongs to the OTHER calendar year (e.g. 2025-12-29 is `2026-W01`).
 *
 * Fixed-width (4-digit year, 2-digit week), so lexical string comparison between two keys agrees
 * with chronological order — {@link threadsByWeek} relies on this to find "predates the record"
 * without re-parsing the key.
 */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Monday=1 ... Sunday=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // the Thursday of this ISO week
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const weekNo = Math.ceil((((date.getTime() - yearStart) / DAY_MS) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** The Monday 00:00 UTC that starts the ISO week containing `ms`. */
function mondayStartMs(ms: number): number {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (dayNum - 1));
  return date.getTime();
}

/**
 * The Monday 00:00 UTC that starts the OLDEST of the last `weeks` ISO weeks ending at (and
 * including) the week containing `nowMs` — the real lower bound {@link weekKeysBack} computes
 * keys for. Exposed so a db read can scope its query to exactly this window without re-deriving a
 * Monday from a formatted `"<year>-W<week>"` key, which needs this same week math to invert.
 */
export function windowStartMs(weeks: number, nowMs: number = Date.now()): number {
  return mondayStartMs(nowMs) - (weeks - 1) * WEEK_MS;
}

/**
 * The last `weeks` ISO week keys ending at (and including) the week containing `nowMs`, oldest
 * first. Stepping back in fixed 7-day increments from a Monday always lands on another Monday, so
 * this stays correct across a year boundary without any special-casing.
 */
export function weekKeysBack(weeks: number, nowMs: number = Date.now()): string[] {
  const start = windowStartMs(weeks, nowMs);
  const keys: string[] = [];
  for (let i = 0; i < weeks; i++) {
    keys.push(isoWeekKey(start + i * WEEK_MS));
  }
  return keys;
}

/** One run whose self-review score is known, as the fold needs it. */
export interface ScoredRunPoint {
  /** When the score was recorded, epoch ms. */
  atMs: number;
  /** 0-10, per `runs.review_score`. */
  score: number;
}

/** The self-review score bands the distribution reports shares for — never an average of them. */
export const SCORE_BANDS = ["10", "9", "8", "7-and-below"] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

function bandOf(score: number): ScoreBand {
  if (score >= 10) return "10";
  if (score === 9) return "9";
  if (score === 8) return "8";
  return "7-and-below";
}

/** One week's score spread. `n` is the denominator every share was drawn against. */
export interface ScoreDistribution {
  /** Scored runs this week. */
  n: number;
  /** Each band's share of `n`. Sums to 1 (within floating-point rounding) — never a mean score. */
  shares: Record<ScoreBand, number>;
}

/**
 * Score distribution per ISO week, keyed by {@link weekKeys}. A week with no scored run in it is
 * absent from the returned map rather than a zero-filled distribution — see the module header.
 */
export function scoreDistributionByWeek(
  runs: readonly ScoredRunPoint[],
  weekKeys: readonly string[],
): Map<string, ScoreDistribution> {
  const counts = new Map<string, Record<ScoreBand, number>>();
  for (const key of weekKeys) {
    counts.set(key, { "10": 0, "9": 0, "8": 0, "7-and-below": 0 });
  }
  for (const run of runs) {
    const bucket = counts.get(isoWeekKey(run.atMs));
    if (!bucket) continue; // outside the requested window
    bucket[bandOf(run.score)] += 1;
  }

  const out = new Map<string, ScoreDistribution>();
  for (const [key, bucket] of counts) {
    const n = SCORE_BANDS.reduce((sum, band) => sum + bucket[band], 0);
    if (n === 0) continue;
    const shares = {} as Record<ScoreBand, number>;
    for (const band of SCORE_BANDS) shares[band] = bucket[band] / n;
    out.set(key, { n, shares });
  }
  return out;
}

/** One PR-fix round, as the review-round record (`review_rounds`) holds it. */
export interface ReviewRoundPoint {
  /** When the round was recorded, epoch ms. */
  atMs: number;
  /** Threads claude was actually handed this round (`review_rounds.threads_actionable`). */
  threadsActionable: number;
  /** The same threads, by the reviewer login who opened them (`review_rounds.by_author_json`). */
  byAuthor: Readonly<Record<string, number>>;
}

/** One week's reviewer-thread load — total, and split by who raised them. */
export interface ThreadsPoint {
  /** Actionable threads recorded this week, summed across every PR's rounds. */
  total: number;
  /** The same total, by reviewer login. */
  byReviewer: Record<string, number>;
}

/**
 * Threads per PR, total and per reviewer, per ISO week — folded from the review-round record.
 *
 * `recordingStartedAtMs` is the project's earliest `review_rounds` row, project-wide, or
 * `undefined` when it has none at all. A week whose key sorts before that row's own week is
 * dropped from the result — absent, because `review_rounds` did not exist yet to have recorded
 * anything, which is a different fact from "recorded and found zero". Every week at or after it
 * gets a real point, 0 included, since the table existed and genuinely saw nothing that week.
 */
export function threadsByWeek(
  rounds: readonly ReviewRoundPoint[],
  weekKeys: readonly string[],
  recordingStartedAtMs: number | undefined,
): Map<string, ThreadsPoint> {
  const recordingStartWeek =
    recordingStartedAtMs === undefined ? undefined : isoWeekKey(recordingStartedAtMs);

  const buckets = new Map<string, { total: number; byReviewer: Record<string, number> }>();
  for (const key of weekKeys) {
    if (recordingStartWeek === undefined || key < recordingStartWeek) continue;
    buckets.set(key, { total: 0, byReviewer: Object.create(null) });
  }

  for (const round of rounds) {
    const bucket = buckets.get(isoWeekKey(round.atMs));
    if (!bucket) continue;
    bucket.total += round.threadsActionable;
    for (const [author, n] of Object.entries(round.byAuthor)) {
      bucket.byReviewer[author] = (bucket.byReviewer[author] ?? 0) + n;
    }
  }

  const out = new Map<string, ThreadsPoint>();
  for (const [key, bucket] of buckets) out.set(key, { total: bucket.total, byReviewer: bucket.byReviewer });
  return out;
}

/** One delivered feature, as the zero-touch fold needs it. */
export interface DeliveredFeaturePoint {
  /** When the feature delivered, epoch ms. */
  deliveredAtMs: number;
  /** How many times a person touched it (`LedgerFriction.humanTouches`); absent reads as 0. */
  humanTouches?: number;
}

/** One week's zero-touch share: delivered features that needed no human intervention at all. */
export interface ZeroTouchPoint {
  /** Features delivered this week — the denominator. */
  delivered: number;
  /** Of those, how many recorded zero human touches end to end. */
  zeroTouch: number;
  /** `zeroTouch / delivered`. */
  share: number;
}

/**
 * Share of delivered features with zero human touches, per ISO week. A week with no delivery is
 * absent — a share of zero deliveries is as undefined as a mean of no samples.
 */
export function zeroTouchByWeek(
  features: readonly DeliveredFeaturePoint[],
  weekKeys: readonly string[],
): Map<string, ZeroTouchPoint> {
  const buckets = new Map<string, { delivered: number; zeroTouch: number }>();
  for (const key of weekKeys) buckets.set(key, { delivered: 0, zeroTouch: 0 });

  for (const feature of features) {
    const bucket = buckets.get(isoWeekKey(feature.deliveredAtMs));
    if (!bucket) continue;
    bucket.delivered += 1;
    if ((feature.humanTouches ?? 0) === 0) bucket.zeroTouch += 1;
  }

  const out = new Map<string, ZeroTouchPoint>();
  for (const [key, bucket] of buckets) {
    if (bucket.delivered === 0) continue;
    out.set(key, {
      delivered: bucket.delivered,
      zeroTouch: bucket.zeroTouch,
      share: bucket.zeroTouch / bucket.delivered,
    });
  }
  return out;
}

/** The raw rows {@link qualityWeekPoints} folds — one read per source, already resolved. */
export interface QualityInput {
  scoredRuns: readonly ScoredRunPoint[];
  reviewRounds: readonly ReviewRoundPoint[];
  deliveredFeatures: readonly DeliveredFeaturePoint[];
  /** The project's earliest `review_rounds` row, epoch ms — see {@link threadsByWeek}. */
  recordingStartedAtMs?: number;
}

/** One ISO week's quality point. Every field but `week` is optional — see the module header. */
export interface QualityWeekPoint {
  week: string;
  scoreDistribution?: ScoreDistribution;
  threads?: ThreadsPoint;
  zeroTouch?: ZeroTouchPoint;
}

/**
 * Quality, one point per ISO week over the last `weeks` weeks ending at `opts.nowMs` (defaults to
 * now). The entry point `trend-read.ts` calls once it has resolved {@link QualityInput}.
 */
export function qualityWeekPoints(
  input: QualityInput,
  weeks: number,
  opts: { nowMs?: number } = {},
): QualityWeekPoint[] {
  const weekKeys = weekKeysBack(weeks, opts.nowMs ?? Date.now());
  const scores = scoreDistributionByWeek(input.scoredRuns, weekKeys);
  const threads = threadsByWeek(input.reviewRounds, weekKeys, input.recordingStartedAtMs);
  const zeroTouch = zeroTouchByWeek(input.deliveredFeatures, weekKeys);

  return weekKeys.map((week) => ({
    week,
    ...(scores.has(week) ? { scoreDistribution: scores.get(week) } : {}),
    ...(threads.has(week) ? { threads: threads.get(week) } : {}),
    ...(zeroTouch.has(week) ? { zeroTouch: zeroTouch.get(week) } : {}),
  }));
}

/* ──────────────────────────  change markers (anton-90875)  ───────────────────────── */

/**
 * One `claude_invocations` row's stamp columns, as the change-marker fold needs them — already
 * scoped to one project by the caller, the same contract `QualityInput`'s rows carry. Every field
 * optional so a fixture naming one marker kind does not have to spell the other four, and because a
 * row that predates a column (or whose write failed) genuinely has none.
 */
export interface InvocationStampPoint {
  /** `claude_invocations.recorded_at`, epoch ms. */
  atMs: number;
  /** The model the result reported the usage under — `model_reported`. */
  modelReported?: string | null;
  /** The composed system prompt's digest — `prompt_digest`. */
  promptDigest?: string | null;
  /** The ticket's resolved `agent:<tag>` — `agent_tag`. The prompt lineage's own key. */
  agentTag?: string | null;
  /** The `skill:<id>` a step resolved — `skill_id`. The skill lineage's own key. */
  skillId?: string | null;
  /** The digest of the skill text a step resolved — `skill_digest`. */
  skillDigest?: string | null;
  /** The release + revision that ran it, `describeBuildIdentity`'s own shape — `anton_version`. */
  antonVersion?: string | null;
}

export const CHANGE_MARKER_KINDS = ["model", "prompt", "skill", "release"] as const;
export type ChangeMarkerKind = (typeof CHANGE_MARKER_KINDS)[number];

/** One detected change, named by what moved, when it was first seen, and its before → after values. */
export interface ChangeMarker {
  kind: ChangeMarkerKind;
  /** The ISO week the new value was first seen in. */
  week: string;
  before: string;
  after: string;
}

/** A blank or whitespace-only stamp reads as absent — the never-fail-a-run rule's own reading. */
function stamped(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

/** `rows`, in `weekKeys`' window and chronological order — every marker fold's own starting point. */
function inWindow(
  rows: readonly InvocationStampPoint[],
  weekKeys: readonly string[],
): InvocationStampPoint[] {
  const weekSet = new Set(weekKeys);
  return [...rows]
    .filter((row) => weekSet.has(isoWeekKey(row.atMs)))
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * The model with the most stamped invocations in one week, and its share of that week's stamped
 * total — undefined wherever no model cleared a true majority (nothing stamped at all, or the top
 * model split the week with another at or below 50%). A plurality is not a majority: three models at
 * roughly a third each must read as "no determined model" rather than crown whichever happened to
 * have one more row, or a later tie-break would manufacture a model marker off noise.
 */
function weekMajorityModel(rows: readonly InvocationStampPoint[]): string | undefined {
  const counts = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    const model = stamped(row.modelReported);
    if (!model) continue;
    counts.set(model, (counts.get(model) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return undefined;
  let best: string | undefined;
  let bestCount = 0;
  for (const [model, n] of counts) {
    if (n > bestCount) {
      best = model;
      bestCount = n;
    }
  }
  return best !== undefined && bestCount / total > 0.5 ? best : undefined;
}

/**
 * Model markers: one per week whose majority model crossed 50% as a DIFFERENT model than the last
 * week that had a determined majority. A week with no determined majority (including one with no
 * stamped invocation) carries the prior majority forward unchanged rather than resetting it — a
 * quiet week, or one split evenly between two models, must not read as "no model running" and then
 * manufacture a change marker on the next week that happens to clear 50% again.
 */
export function modelChangeMarkers(
  rows: readonly InvocationStampPoint[],
  weekKeys: readonly string[],
): ChangeMarker[] {
  const byWeek = new Map<string, InvocationStampPoint[]>();
  for (const row of inWindow(rows, weekKeys)) {
    const week = isoWeekKey(row.atMs);
    const bucket = byWeek.get(week);
    if (bucket) bucket.push(row);
    else byWeek.set(week, [row]);
  }

  const markers: ChangeMarker[] = [];
  let current: string | undefined;
  for (const week of weekKeys) {
    const majority = weekMajorityModel(byWeek.get(week) ?? []);
    if (majority === undefined) continue;
    if (current !== undefined && majority !== current) {
      markers.push({ kind: "model", week, before: current, after: majority });
    }
    current = majority;
  }
  return markers;
}

/**
 * Prompt markers: one per invocation whose composed-prompt digest DIFFERS from the last one seen
 * for the SAME `agentTag` lineage. Keyed per agent deliberately — an agent switch starts a fresh
 * lineage with nothing to compare against yet, so alternating specialists never fires a marker on
 * its own; only an edit to the prompt text an agent itself keeps running under does.
 */
export function promptChangeMarkers(
  rows: readonly InvocationStampPoint[],
  weekKeys: readonly string[],
): ChangeMarker[] {
  const lastByAgent = new Map<string, string>();
  const markers: ChangeMarker[] = [];
  for (const row of inWindow(rows, weekKeys)) {
    const digest = stamped(row.promptDigest);
    if (!digest) continue;
    const agent = stamped(row.agentTag) ?? "";
    const previous = lastByAgent.get(agent);
    if (previous !== undefined && previous !== digest) {
      markers.push({ kind: "prompt", week: isoWeekKey(row.atMs), before: previous, after: digest });
    }
    lastByAgent.set(agent, digest);
  }
  return markers;
}

/**
 * Skill markers: one per invocation whose `skill_digest` DIFFERS from the last one seen for the SAME
 * `skill_id` — the sibling of {@link promptChangeMarkers}, keyed on the skill rather than the agent.
 * A row naming a skill id with no digest (or vice versa) names neither lineage cleanly and is
 * skipped rather than guessed at.
 */
export function skillChangeMarkers(
  rows: readonly InvocationStampPoint[],
  weekKeys: readonly string[],
): ChangeMarker[] {
  const lastBySkill = new Map<string, string>();
  const markers: ChangeMarker[] = [];
  for (const row of inWindow(rows, weekKeys)) {
    const skillId = stamped(row.skillId);
    const digest = stamped(row.skillDigest);
    if (!skillId || !digest) continue;
    const previous = lastBySkill.get(skillId);
    if (previous !== undefined && previous !== digest) {
      markers.push({ kind: "skill", week: isoWeekKey(row.atMs), before: previous, after: digest });
    }
    lastBySkill.set(skillId, digest);
  }
  return markers;
}

/**
 * The RELEASE half of an `anton_version` stamp — `"0.5.1 (25ec011)"` → `"0.5.1"`, per
 * `describeBuildIdentity` (`build/identity.mjs`), the sole writer of this column's shape. Everything
 * from the first `" ("` on is the revision (the git commit, plus an `uncommitted …`/`sources …`
 * suffix when the checkout carried more) — stripped here on purpose, since {@link
 * releaseChangeMarkers} must never fire on a revision bump under an unchanged release.
 */
function releasePart(antonVersion: string): string {
  const paren = antonVersion.indexOf(" (");
  return paren === -1 ? antonVersion : antonVersion.slice(0, paren);
}

/**
 * Release markers: one per invocation whose `anton_version` names a different RELEASE than the last
 * one seen, anywhere in the window — `anton`'s own release is one thing the whole system runs under
 * at a time (the same reasoning `prompt-series.ts`'s `REVISION_DIMENSIONS` gives it), so unlike
 * prompt and skill this tracks a single running value rather than a per-key lineage. A revision bump
 * with the release unchanged (a hotfix rebuild, an uncommitted-worktree digest moving) never fires.
 */
export function releaseChangeMarkers(
  rows: readonly InvocationStampPoint[],
  weekKeys: readonly string[],
): ChangeMarker[] {
  const markers: ChangeMarker[] = [];
  let current: string | undefined;
  for (const row of inWindow(rows, weekKeys)) {
    const raw = stamped(row.antonVersion);
    if (!raw) continue;
    const release = releasePart(raw);
    if (current !== undefined && release !== current) {
      markers.push({ kind: "release", week: isoWeekKey(row.atMs), before: current, after: release });
    }
    current = release;
  }
  return markers;
}

/**
 * Every change marker over the last `weeks` weeks ending at `opts.nowMs` (defaults to now) — the
 * entry point `trend-read.ts` calls once it has resolved the project's stamped `claude_invocations`
 * rows. Kind order matches {@link CHANGE_MARKER_KINDS}; within a kind, markers are chronological.
 */
export function changeMarkers(
  rows: readonly InvocationStampPoint[],
  weeks: number,
  opts: { nowMs?: number } = {},
): ChangeMarker[] {
  const weekKeys = weekKeysBack(weeks, opts.nowMs ?? Date.now());
  return [
    ...modelChangeMarkers(rows, weekKeys),
    ...promptChangeMarkers(rows, weekKeys),
    ...skillChangeMarkers(rows, weekKeys),
    ...releaseChangeMarkers(rows, weekKeys),
  ];
}
