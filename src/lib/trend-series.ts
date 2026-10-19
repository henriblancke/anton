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
import { DESCRIBER_STEP_HANDLER, MIN_COHORT } from "./prompt-series";

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
  /** The PR this round belongs to (`review_rounds.pr_number`) — what `byPr` sums over. */
  prNumber: number;
  /** Threads claude was actually handed this round (`review_rounds.threads_actionable`). */
  threadsActionable: number;
  /** The same threads, by the reviewer login who opened them (`review_rounds.by_author_json`). */
  byAuthor: Readonly<Record<string, number>>;
}

/** One week's reviewer-thread load — total, and split two ways: by who raised them, and by which PR. */
export interface ThreadsPoint {
  /** Actionable threads recorded this week, summed across every PR's rounds. */
  total: number;
  /** The same total, by reviewer login. */
  byReviewer: Record<string, number>;
  /**
   * The same total, by PR number — a distinct dimension from `byReviewer`: a week whose threads all
   * landed on one PR reads differently than the same total spread evenly across several, a
   * difference `byReviewer` alone cannot show.
   */
  byPr: Record<number, number>;
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

  const buckets = new Map<
    string,
    { total: number; byReviewer: Record<string, number>; byPr: Record<number, number> }
  >();
  for (const key of weekKeys) {
    if (recordingStartWeek === undefined || key < recordingStartWeek) continue;
    buckets.set(key, { total: 0, byReviewer: Object.create(null), byPr: Object.create(null) });
  }

  for (const round of rounds) {
    const bucket = buckets.get(isoWeekKey(round.atMs));
    if (!bucket) continue;
    bucket.total += round.threadsActionable;
    bucket.byPr[round.prNumber] = (bucket.byPr[round.prNumber] ?? 0) + round.threadsActionable;
    for (const [author, n] of Object.entries(round.byAuthor)) {
      bucket.byReviewer[author] = (bucket.byReviewer[author] ?? 0) + n;
    }
  }

  const out = new Map<string, ThreadsPoint>();
  for (const [key, bucket] of buckets) {
    out.set(key, { total: bucket.total, byReviewer: bucket.byReviewer, byPr: bucket.byPr });
  }
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
  /**
   * The resolved formula-step handler this row ran under (`claude-invocations.ts`'s `stepHandler`) —
   * read only so {@link promptChangeMarkers} can exclude `step:describe`'s own invocations, the same
   * carve-out `prompt-series.ts`'s {@link DESCRIBER_STEP_HANDLER} documents: `describe.ts` composes a
   * structurally narrower prompt (base+seed, no agent layer) than `step:implement` does, so an
   * agent-tagged feature running both would otherwise read that structural difference as a prompt edit.
   */
  stepHandler?: string | null;
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
 * The majority model as of right before `beforeWeek` — the seed {@link modelChangeMarkers} starts
 * its carry-forward from, folded chronologically over every week strictly earlier than `beforeWeek`.
 * Without this, the oldest requested week has no history to compare against: a change whose only
 * predecessor value sits just outside the window would read as that lineage's first-ever value
 * instead of a change (P2, PR #348 review).
 */
function seedMajorityModel(rows: readonly InvocationStampPoint[], beforeWeek: string): string | undefined {
  const byWeek = new Map<string, InvocationStampPoint[]>();
  for (const row of rows) {
    const week = isoWeekKey(row.atMs);
    if (week >= beforeWeek) continue;
    const bucket = byWeek.get(week);
    if (bucket) bucket.push(row);
    else byWeek.set(week, [row]);
  }
  let current: string | undefined;
  for (const week of [...byWeek.keys()].sort()) {
    const majority = weekMajorityModel(byWeek.get(week)!);
    if (majority !== undefined) current = majority;
  }
  return current;
}

/**
 * Model markers: one per week whose majority model crossed 50% as a DIFFERENT model than the last
 * week that had a determined majority. A week with no determined majority (including one with no
 * stamped invocation) carries the prior majority forward unchanged rather than resetting it — a
 * quiet week, or one split evenly between two models, must not read as "no model running" and then
 * manufacture a change marker on the next week that happens to clear 50% again.
 *
 * `current` seeds from {@link seedMajorityModel} rather than `undefined`, so a change whose only
 * predecessor landed before the requested window still fires in the oldest requested week instead
 * of reading as that lineage's first value (P2, PR #348 review). `rows` may carry history before
 * `weekKeys[0]` for exactly this reason — {@link inWindow} still confines every EMITTED marker to
 * the requested weeks.
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
  let current: string | undefined = weekKeys.length > 0 ? seedMajorityModel(rows, weekKeys[0]) : undefined;
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
 * Each agent lineage's last prompt digest as of right before `beforeWeek` — the seed
 * {@link promptChangeMarkers} starts each lineage from, folded chronologically over every week
 * strictly earlier than `beforeWeek`. Without this, a lineage's digest change landing in the oldest
 * requested week has no predecessor to compare against and is silently read as its first value
 * rather than a change (P2, PR #348 review).
 */
function seedByAgent(rows: readonly InvocationStampPoint[], beforeWeek: string): Map<string, string> {
  const lastByAgent = new Map<string, string>();
  const prior = rows.filter((row) => isoWeekKey(row.atMs) < beforeWeek).sort((a, b) => a.atMs - b.atMs);
  for (const row of prior) {
    if (row.stepHandler === DESCRIBER_STEP_HANDLER) continue;
    const digest = stamped(row.promptDigest);
    if (!digest) continue;
    const agent = stamped(row.agentTag) ?? "";
    lastByAgent.set(agent, digest);
  }
  return lastByAgent;
}

/**
 * Prompt markers: one per invocation whose composed-prompt digest DIFFERS from the last one seen
 * for the SAME `agentTag` lineage. Keyed per agent deliberately — an agent switch starts a fresh
 * lineage with nothing to compare against yet, so alternating specialists never fires a marker on
 * its own; only an edit to the prompt text an agent itself keeps running under does.
 *
 * `lastByAgent` seeds from {@link seedByAgent} rather than empty, so a lineage change whose only
 * predecessor landed before the requested window still fires in the oldest requested week (P2, PR
 * #348 review). `rows` may carry history before `weekKeys[0]` for exactly this reason —
 * {@link inWindow} still confines every EMITTED marker to the requested weeks.
 */
export function promptChangeMarkers(
  rows: readonly InvocationStampPoint[],
  weekKeys: readonly string[],
): ChangeMarker[] {
  const lastByAgent = weekKeys.length > 0 ? seedByAgent(rows, weekKeys[0]) : new Map<string, string>();
  const markers: ChangeMarker[] = [];
  for (const row of inWindow(rows, weekKeys)) {
    // The describer's own system prompt is structurally narrower than the implementer's (no agent
    // layer) — see DESCRIBER_STEP_HANDLER. Counting it here would read every agent-tagged feature's
    // describe pass as a prompt edit on the common implement-then-describe path.
    if (row.stepHandler === DESCRIBER_STEP_HANDLER) continue;
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
 * Each skill lineage's last skill digest as of right before `beforeWeek` — the seed
 * {@link skillChangeMarkers} starts each lineage from, the sibling of {@link seedByAgent}. Without
 * this, a lineage's digest change landing in the oldest requested week has no predecessor to compare
 * against and is silently read as its first value rather than a change (P2, PR #348 review).
 */
function seedBySkill(rows: readonly InvocationStampPoint[], beforeWeek: string): Map<string, string> {
  const lastBySkill = new Map<string, string>();
  const prior = rows.filter((row) => isoWeekKey(row.atMs) < beforeWeek).sort((a, b) => a.atMs - b.atMs);
  for (const row of prior) {
    const skillId = stamped(row.skillId);
    const digest = stamped(row.skillDigest);
    if (!skillId || !digest) continue;
    lastBySkill.set(skillId, digest);
  }
  return lastBySkill;
}

/**
 * Skill markers: one per invocation whose `skill_digest` DIFFERS from the last one seen for the SAME
 * `skill_id` — the sibling of {@link promptChangeMarkers}, keyed on the skill rather than the agent.
 * A row naming a skill id with no digest (or vice versa) names neither lineage cleanly and is
 * skipped rather than guessed at.
 *
 * `lastBySkill` seeds from {@link seedBySkill} rather than empty — see {@link promptChangeMarkers}'s
 * own note on why (P2, PR #348 review).
 */
export function skillChangeMarkers(
  rows: readonly InvocationStampPoint[],
  weekKeys: readonly string[],
): ChangeMarker[] {
  const lastBySkill = weekKeys.length > 0 ? seedBySkill(rows, weekKeys[0]) : new Map<string, string>();
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
 * The running RELEASE as of right before `beforeWeek` — the seed {@link releaseChangeMarkers} starts
 * from, folded chronologically over every week strictly earlier than `beforeWeek`. Without this, a
 * release bump landing in the oldest requested week has no predecessor to compare against and is
 * silently read as the first release ever seen rather than a change (P2, PR #348 review).
 */
function seedRelease(rows: readonly InvocationStampPoint[], beforeWeek: string): string | undefined {
  let current: string | undefined;
  const prior = rows.filter((row) => isoWeekKey(row.atMs) < beforeWeek).sort((a, b) => a.atMs - b.atMs);
  for (const row of prior) {
    const raw = stamped(row.antonVersion);
    if (!raw) continue;
    current = releasePart(raw);
  }
  return current;
}

/**
 * Release markers: one per invocation whose `anton_version` names a different RELEASE than the last
 * one seen, anywhere in the window — `anton`'s own release is one thing the whole system runs under
 * at a time (the same reasoning `prompt-series.ts`'s `REVISION_DIMENSIONS` gives it), so unlike
 * prompt and skill this tracks a single running value rather than a per-key lineage. A revision bump
 * with the release unchanged (a hotfix rebuild, an uncommitted-worktree digest moving) never fires.
 *
 * `current` seeds from {@link seedRelease} rather than `undefined` — see {@link modelChangeMarkers}'s
 * own note on why (P2, PR #348 review).
 */
export function releaseChangeMarkers(
  rows: readonly InvocationStampPoint[],
  weekKeys: readonly string[],
): ChangeMarker[] {
  const markers: ChangeMarker[] = [];
  let current: string | undefined = weekKeys.length > 0 ? seedRelease(rows, weekKeys[0]) : undefined;
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

/* ──────────────────  cost, phase spend & the review loop (anton-d6kw7)  ───────────────── */

/**
 * The second slice of a project's trend series, after quality (anton-6b835): what delivery cost,
 * where the tokens and dollars went by phase, and how much self-review/PR-fix looping a feature
 * needed. Same ground rules as above — pure, dependency-free, nothing averaged that should be a
 * share, absence kept distinct from a measured zero.
 *
 * ## The numerator rule, inherited from `promptSeries`
 *
 * {@link costByWeek} follows `prompt-series.ts`'s own denominator rule verbatim: every feature's
 * spend sums into a week's numerator whether it delivered or gave up, while only DELIVERED features
 * count toward the denominator a per-feature average divides by. Dropping a gave-up feature's spend
 * would make the prompt (or week) that gives up earliest read as the cheapest — exactly the trap
 * `prompt-series.ts`'s header warns against.
 *
 * ## Invocations, never jobs
 *
 * {@link reviewLoopByFeature} counts raw `claude_invocations` rows, not `runs`/job rows — one job
 * can dispatch several invocations (a gate retry, a resumed attempt), and counting jobs would
 * undercount exactly the runaway features this fold exists to name.
 */

/** One feature as {@link costByWeek} needs it — delivered or not, spend included either way. */
export interface CostFeaturePoint {
  /** Whether the feature delivered. Only deliveries count toward the per-feature denominator. */
  delivered: boolean;
  /** When it delivered, epoch ms. Buckets a delivered feature's spend — absent if never delivered. */
  deliveredAtMs?: number;
  /** Its latest recorded activity, epoch ms. Buckets an UNDELIVERED feature's spend by last activity. */
  activityAtMs?: number;
  /** What it cost, or undefined when anton could price none of its rows — never 0. */
  usd: number | undefined;
  /**
   * Rows this feature's own `usd` could NOT price (`CohortFeature.unpricedRows`). A defined `usd`
   * beside a non-zero count here is only a FLOOR for the feature — the same distinction
   * `PhaseWeekTotals.unpricedRows` draws at the phase level, carried through so a week mixing priced
   * and unpriced features does not let the priced subtotal pass for a complete total (P1, PR #348
   * review).
   */
  unpricedRows?: number;
}

/** One week's cost: total spend (every attributed feature) over deliveries (the denominator) alone. */
export interface CostWeekPoint {
  /** Delivered features bucketed into this week — the denominator. */
  delivered: number;
  /** Σ usd over every feature bucketed here, delivered or not — undefined when none could be priced. */
  usd: number | undefined;
  /** `usd / delivered`, or undefined when there is no delivery to divide by, or nothing to divide. */
  usdPerFeature: number | undefined;
  /**
   * Σ `unpricedRows` over every feature bucketed here. With this non-zero, {@link usd} and
   * {@link usdPerFeature} are a FLOOR, not a total — some of the week's spend has no dollar figure
   * at all, so the priced subtotal alone understates it (P1, PR #348 review).
   */
  unpricedRows: number;
}

/**
 * Cost per ISO week, bucketed by delivery for a delivered feature and by last activity for one that
 * never delivered (the ticket's own bucketing rule). A week with no feature bucketed into it at all
 * — delivered or not — is absent, the same "nothing measured" reading {@link zeroTouchByWeek} gives
 * a week with no delivery. A week that saw ONLY undelivered spend still gets a real point: `usd` is
 * set but `delivered` is 0, so `usdPerFeature` reads as undefined rather than a division by zero.
 *
 * A week mixing priced and unpriced features sums only what priced — the alternative, dropping the
 * week's `usd` entirely because one feature couldn't be priced, would hide real spend the project DID
 * price. {@link CostWeekPoint.unpricedRows} carries the count through instead, so a caller can mark
 * the total as a floor rather than read it as complete (P1, PR #348 review).
 */
export function costByWeek(
  features: readonly CostFeaturePoint[],
  weekKeys: readonly string[],
): Map<string, CostWeekPoint> {
  const weekSet = new Set(weekKeys);
  const buckets = new Map<string, { delivered: number; usd: number | undefined; unpricedRows: number }>();

  for (const feature of features) {
    const atMs = feature.delivered ? feature.deliveredAtMs : feature.activityAtMs;
    if (atMs === undefined) continue;
    const week = isoWeekKey(atMs);
    if (!weekSet.has(week)) continue;

    let bucket = buckets.get(week);
    if (!bucket) {
      bucket = { delivered: 0, usd: undefined, unpricedRows: 0 };
      buckets.set(week, bucket);
    }
    if (feature.usd !== undefined) bucket.usd = (bucket.usd ?? 0) + feature.usd;
    bucket.unpricedRows += feature.unpricedRows ?? 0;
    if (feature.delivered) bucket.delivered += 1;
  }

  const out = new Map<string, CostWeekPoint>();
  for (const [week, bucket] of buckets) {
    out.set(week, {
      delivered: bucket.delivered,
      usd: bucket.usd,
      usdPerFeature:
        bucket.usd !== undefined && bucket.delivered > 0 ? bucket.usd / bucket.delivered : undefined,
      unpricedRows: bucket.unpricedRows,
    });
  }
  return out;
}

/** One invocation row's phase spend, as {@link phaseSpendByWeek} needs it — one row, one invocation. */
export interface PhaseSpendPoint {
  /** `claude_invocations.recorded_at`, epoch ms. */
  atMs: number;
  /** The ledger phase this invocation classified to (`feature-ledger.ts`'s `ledgerPhase`). */
  phase: string;
  /** Tokens this invocation reported, already summed by the caller. */
  tokens: number;
  /** What it cost, or undefined when anton could not price it — never 0. */
  usd: number | undefined;
  /**
   * Groups the rows written by the same REAL invocation — a sidecar row shares its primary's key.
   * {@link phaseSpendByWeek} counts distinct keys for {@link PhaseWeekTotals.invocations}, never
   * rows, so an opus invocation and its haiku sidecar read as one invocation, not two (P2, PR #348
   * review). Tokens and usd still sum every row regardless of key — those are real spend either way.
   */
  invocationKey: string;
}

/** One phase's totals for one ISO week. */
export interface PhaseWeekTotals {
  /** Real invocations folded in, deduped by {@link PhaseSpendPoint.invocationKey} — never rows. */
  invocations: number;
  tokens: number;
  /** Σ usd over the rows anton could price, or undefined when it priced none of them. */
  usd: number | undefined;
  /** Rows that produced no dollar figure — with this non-zero, {@link usd} is a floor, not a total. */
  unpricedRows: number;
}

/**
 * Tokens and USD per phase, per ISO week. A week with no invocation at all is absent; a week that
 * had invocations only in some phases carries an entry for exactly those phases, the same "renders
 * only what happened" reading a feature's own ledger breakdown gives.
 */
export function phaseSpendByWeek(
  rows: readonly PhaseSpendPoint[],
  weekKeys: readonly string[],
): Map<string, Record<string, PhaseWeekTotals>> {
  const weekSet = new Set(weekKeys);
  const buckets = new Map<string, Map<string, { tokens: number; usd: number | undefined; unpricedRows: number; invocationKeys: Set<string> }>>();

  for (const row of rows) {
    const week = isoWeekKey(row.atMs);
    if (!weekSet.has(week)) continue;

    let phases = buckets.get(week);
    if (!phases) {
      phases = new Map();
      buckets.set(week, phases);
    }
    let totals = phases.get(row.phase);
    if (!totals) {
      totals = { tokens: 0, usd: undefined, unpricedRows: 0, invocationKeys: new Set() };
      phases.set(row.phase, totals);
    }
    totals.invocationKeys.add(row.invocationKey);
    totals.tokens += row.tokens;
    if (row.usd === undefined) totals.unpricedRows += 1;
    else totals.usd = (totals.usd ?? 0) + row.usd;
  }

  const out = new Map<string, Record<string, PhaseWeekTotals>>();
  for (const [week, phases] of buckets) {
    const phaseTotals: Record<string, PhaseWeekTotals> = {};
    for (const [phase, totals] of phases) {
      phaseTotals[phase] = {
        invocations: totals.invocationKeys.size,
        tokens: totals.tokens,
        usd: totals.usd,
        unpricedRows: totals.unpricedRows,
      };
    }
    out.set(week, phaseTotals);
  }
  return out;
}

/** One failed/parked run as {@link runsByCauseByWeek} needs it — `runsByCause`'s own `RunCause` shape. */
export interface RunCausePoint {
  /** When it settled, epoch ms (`RunCause.settledAt`, converted from epoch seconds by the caller). */
  settledAtMs: number;
  /** Its classified cause (`FailureCause`, kept as a plain string here — see the module header). */
  cause: string;
}

/** One week's failed/parked runs — total, and split by cause. */
export interface CauseWeekPoint {
  total: number;
  byCause: Record<string, number>;
}

/**
 * Failed/parked runs per cause, per ISO week, bucketed straight from `runsByCause`'s rows. Unlike
 * {@link threadsByWeek}, every week gets a real point — `runs` has recorded failures since the
 * project's first run, so a week with none is a genuine zero, never "table didn't exist yet".
 */
export function runsByCauseByWeek(
  runs: readonly RunCausePoint[],
  weekKeys: readonly string[],
): Map<string, CauseWeekPoint> {
  const buckets = new Map<string, { total: number; byCause: Record<string, number> }>();
  for (const key of weekKeys) buckets.set(key, { total: 0, byCause: Object.create(null) });

  for (const run of runs) {
    const bucket = buckets.get(isoWeekKey(run.settledAtMs));
    if (!bucket) continue;
    bucket.total += 1;
    bucket.byCause[run.cause] = (bucket.byCause[run.cause] ?? 0) + 1;
  }

  const out = new Map<string, CauseWeekPoint>();
  for (const [week, bucket] of buckets) out.set(week, { total: bucket.total, byCause: bucket.byCause });
  return out;
}

/** One `claude_invocations` row as {@link reviewLoopByFeature} needs it — one row, one invocation. */
export interface ReviewLoopInvocationPoint {
  /** The feature's run target id. */
  beadId: string;
  /** This invocation's ledger phase. Only `"self-review"` and `"pr-fix"` are counted; others are ignored. */
  phase: string;
}

/**
 * How many times the multiplier a feature's loop invocations must clear ITS OWN median to be named
 * runaway. 3x is a conservative first cut — loud enough that a feature at 2x the typical loop still
 * reads as normal variance, quiet enough that a feature needing many times the typical looping still
 * gets named. Exported so a caller can explain the number it is showing, and a future tuning pass has
 * one constant to change rather than a magic number buried in the fold.
 */
export const RUNAWAY_MEDIAN_MULTIPLE = 3;

/**
 * The absolute floor `prFixInvocations` must still clear, even on a multiple of the median — since
 * most features need zero PR-fix rounds, a cohort's median is commonly 0, and
 * `prFixInvocations > RUNAWAY_MEDIAN_MULTIPLE * 0` degenerates to `prFixInvocations > 0`: any single,
 * completely ordinary correction round would then read as runaway alongside a feature that genuinely
 * needed many (PR #348 review). Requiring at least this many PR-fix invocations regardless of the
 * median keeps one normal round in an otherwise-clean cohort from misfiring.
 */
export const MIN_RUNAWAY_COUNT = 3;

/** The median of `values`, or undefined for an empty input — never 0 for "nothing to compare against". */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** One feature's self-review/PR-fix invocation counts, and whether they are a runaway outlier. */
export interface ReviewLoopPoint {
  beadId: string;
  /** Self-review GATE invocations — `step_handler: "review"`, not the fix round after it. */
  selfReviewInvocations: number;
  /** PR-fix invocations — the correction round after a failed self-review or a reviewer's findings. */
  prFixInvocations: number;
  /** `selfReviewInvocations + prFixInvocations`, for display — NOT what `runaway` is computed over. */
  loopInvocations: number;
  /**
   * Whether `prFixInvocations` exceeds the larger of {@link MIN_RUNAWAY_COUNT} and
   * {@link RUNAWAY_MEDIAN_MULTIPLE} times the cohort's median PR-fix count — the floor keeps a
   * median of 0 (the common case) from flagging a single ordinary correction round.
   */
  runaway: boolean;
}

/**
 * Self-review and PR-fix invocations per feature, counted from raw `claude_invocations` rows (never
 * jobs — one job can dispatch several invocations, and counting jobs would undercount the exact
 * features this fold exists to name). `runaway` is relative to the MEDIAN `prFixInvocations` of every
 * feature passed in — PR-fix rounds specifically, since those are the correction loop a reviewer or a
 * failed self-review triggers, not the self-review gate itself — so the threshold adapts to a
 * project's own typical amount of correction looping rather than a fixed count that would misfire on
 * a project whose formula naturally runs more rounds than another's.
 */
export function reviewLoopByFeature(
  invocations: readonly ReviewLoopInvocationPoint[],
): ReviewLoopPoint[] {
  const byFeature = new Map<string, { selfReview: number; prFix: number }>();
  for (const invocation of invocations) {
    let bucket = byFeature.get(invocation.beadId);
    if (!bucket) {
      bucket = { selfReview: 0, prFix: 0 };
      byFeature.set(invocation.beadId, bucket);
    }
    if (invocation.phase === "self-review") bucket.selfReview += 1;
    else if (invocation.phase === "pr-fix") bucket.prFix += 1;
  }

  const entries = [...byFeature.entries()];
  const prFixTotals = entries.map(([, bucket]) => bucket.prFix);
  const med = median(prFixTotals);

  return entries.map(([beadId, bucket], i) => {
    const prFixInvocations = prFixTotals[i];
    return {
      beadId,
      selfReviewInvocations: bucket.selfReview,
      prFixInvocations,
      loopInvocations: bucket.selfReview + prFixInvocations,
      runaway:
        med !== undefined && prFixInvocations > Math.max(MIN_RUNAWAY_COUNT, RUNAWAY_MEDIAN_MULTIPLE * med),
    };
  });
}

/* ──────────────────────  trendSeries: the whole trend, one series (anton-p38kx)  ───────────────────── */

/**
 * Everything {@link trendSeries} folds, already resolved by `trend-read.ts` — one slice per fold
 * above. Nothing here does its own db work.
 */
export interface TrendSeriesInput {
  quality: QualityInput;
  costFeatures: readonly CostFeaturePoint[];
  phaseSpend: readonly PhaseSpendPoint[];
  runCauses: readonly RunCausePoint[];
  invocationStamps: readonly InvocationStampPoint[];
  reviewLoopInvocations: readonly ReviewLoopInvocationPoint[];
}

/** One ISO week's whole trend — quality, cost, phase spend and failure causes, independently present or absent. */
export interface TrendWeekPoint {
  week: string;
  scoreDistribution?: ScoreDistribution;
  threads?: ThreadsPoint;
  zeroTouch?: ZeroTouchPoint;
  cost?: CostWeekPoint;
  phaseSpend?: Record<string, PhaseWeekTotals>;
  /** Failed/parked runs this week — always present; see {@link runsByCauseByWeek}. */
  runCauses: CauseWeekPoint;
  /**
   * Whether this week delivered fewer features than {@link MIN_COHORT} — too few to read the
   * figures above as a trend rather than noise. Always present, never optional: unlike the figures
   * above, underpowered is a verdict about the week itself, and a week with ZERO deliveries is the
   * clearest case of it, not a gap to leave out.
   */
  underpowered: boolean;
}

/**
 * The whole trend: one point per ISO week, plus the change events and per-feature review-loop
 * figures that do not themselves bucket to a single week — see {@link changeMarkers} and
 * {@link reviewLoopByFeature}.
 */
export interface TrendSeries {
  weeks: TrendWeekPoint[];
  changeMarkers: ChangeMarker[];
  reviewLoop: ReviewLoopPoint[];
}

/** Delivered features per ISO week — the denominator {@link trendSeries} checks against {@link MIN_COHORT}. */
function deliveredCountByWeek(
  features: readonly DeliveredFeaturePoint[],
  weekKeys: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of weekKeys) counts.set(key, 0);
  for (const feature of features) {
    const key = isoWeekKey(feature.deliveredAtMs);
    const current = counts.get(key);
    if (current !== undefined) counts.set(key, current + 1);
  }
  return counts;
}

/**
 * The whole trend, one point per ISO week over the last `weeks` weeks ending at `opts.nowMs`
 * (defaults to now): quality (anton-6b835), cost/phase-spend/review-loop (anton-d6kw7) and change
 * markers (anton-90875), merged into a single week-keyed series. `trend-read.ts` calls this once it
 * has resolved {@link TrendSeriesInput}.
 *
 * `changeMarkers` and `reviewLoop` ride alongside `weeks` rather than nested inside each week's
 * point: a change event and a feature's review loop are not themselves scalar to one ISO week (a
 * marker already carries its own `week`; a feature's loop spans its whole life), so folding them
 * into the per-week point would force a join neither source fold makes.
 *
 * `underpowered` reuses {@link MIN_COHORT} from `prompt-series.ts` rather than a second floor under
 * a different name: "too few delivered features to read as a trend" is the same question whether
 * it's asked of an attribution cohort or a calendar week.
 */
export function trendSeries(
  input: TrendSeriesInput,
  weeks: number,
  opts: { nowMs?: number } = {},
): TrendSeries {
  const nowMs = opts.nowMs ?? Date.now();
  const weekKeys = weekKeysBack(weeks, nowMs);

  const quality = qualityWeekPoints(input.quality, weeks, { nowMs });
  const cost = costByWeek(input.costFeatures, weekKeys);
  const phaseSpendByWeekMap = phaseSpendByWeek(input.phaseSpend, weekKeys);
  const runCausesByWeek = runsByCauseByWeek(input.runCauses, weekKeys);
  const delivered = deliveredCountByWeek(input.quality.deliveredFeatures, weekKeys);

  const weekPoints: TrendWeekPoint[] = weekKeys.map((week, i) => {
    const q = quality[i];
    return {
      week,
      ...(q.scoreDistribution ? { scoreDistribution: q.scoreDistribution } : {}),
      ...(q.threads ? { threads: q.threads } : {}),
      ...(q.zeroTouch ? { zeroTouch: q.zeroTouch } : {}),
      ...(cost.has(week) ? { cost: cost.get(week) } : {}),
      ...(phaseSpendByWeekMap.has(week) ? { phaseSpend: phaseSpendByWeekMap.get(week) } : {}),
      runCauses: runCausesByWeek.get(week) ?? { total: 0, byCause: {} },
      underpowered: (delivered.get(week) ?? 0) < MIN_COHORT,
    };
  });

  return {
    weeks: weekPoints,
    changeMarkers: changeMarkers(input.invocationStamps, weeks, { nowMs }),
    reviewLoop: reviewLoopByFeature(input.reviewLoopInvocations),
  };
}
