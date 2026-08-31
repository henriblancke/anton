/**
 * The score-regression breaker's I/O end (anton-cekf / R4.3): build the project's review-score
 * series out of its recent runs, ask {@link detectScoreSlide} whether the work is getting worse, and
 * latch the disarm if it is.
 *
 * Split the way picker-failure-breaker.ts is split from autopilot-failure-streak.ts — the rules are
 * pure and everything that needs a db lives here.
 *
 * The score is read off the RUN that earned it, not off the target's `review-score:<n>` label. The
 * label is the target's LATEST score across every attempt, so joining it to the newest run row would
 * lend an old review to a new run: a rerun that settles without reaching the review gate — cancelled,
 * failed early, a recovery attempt — would carry the score of the attempt before it, and the breaker
 * could freeze a project on reviews that happened before those runs ran, or before the operator's
 * last re-arm lifted the freeze those same reviews caused. One score per ATTEMPT (execute-epic
 * stamps it as the gate reports it) is the only join that cannot lie about which run was judged.
 *
 * A run that predates that column reads as unscored, which is a GAP — and a series with a gap yields
 * no verdict at all, so an upgraded install fails open until it has re-scored a window's worth of
 * runs. That is the same trade every degraded read here makes (see {@link checkScoreSlide}).
 *
 * The series also STARTS at the last re-arm. Those scores are the case an operator read and
 * overruled; a window that could still reach back past them would re-latch the identical disarm on
 * the next pass — off runs that have not changed and cannot change — and revert the human decision
 * before anything new had been scored at all.
 */
import {
  describeScoreSlide,
  detectScoreSlide,
  scoreSlideEvidence,
  type ScoreSlide,
  type ScoredRun,
} from "../autopilot-score-slide";
import {
  activeDisarmForPass,
  disarmWithEscalation,
  lastReArmAt,
  settledAfterReArm,
} from "../autopilot-disarm";
import { getProjectSettings, resolveScoreBreaker } from "../projects";
import { listRecentRunOutcomes } from "../runs";
import type { AntonDb, Clock } from "./queue";

/**
 * How many run rows one page of the series read costs.
 *
 * The read is PAGED rather than sized once, because how many rows a window costs is not knowable
 * before reading them: the series skips runs still in flight and collapses a target's repeat
 * attempts onto one entry, so a project retrying two targets ten times each fills any fixed read
 * with two entries and reports the series as short — failing open on evidence that is sitting one
 * row further back.
 */
const SCORE_PAGE = 20;

export interface ScoreBreakerInput {
  projectId: string;
}

export interface ScoreBreakerOutcome {
  slide: ScoreSlide;
  /** False when the project was already disarmed — the idempotent path. */
  latched: boolean;
  /** The disarm now freezing the project, whether this pass latched it or found it. */
  disarmId: string;
}

/**
 * Disarm the project's picker if its recent runs are scoring below the floor, else do nothing.
 *
 * Returns `undefined` when the breaker is off, when the project is already disarmed (a latch does
 * not clear itself, and re-deciding could only produce a second freeze to clear), or when the series
 * does not carry a verdict — which includes every degraded read: too few runs, and a run that left
 * no score of its own. Failing open there is deliberate (R4.3): the cost is one more run at the
 * current quality, against a project frozen on evidence nobody recorded.
 */
export async function checkScoreSlide(
  db: AntonDb,
  clock: Clock,
  input: ScoreBreakerInput,
): Promise<ScoreBreakerOutcome | undefined> {
  const { projectId } = input;
  // Reconciled BEFORE the config is honoured — same reason as its sibling breaker: a half-written
  // latch, or a strip row left open by a re-arm whose settle failed, outlives the setting that
  // raised it, and nothing else ever repairs either one.
  const disarmed = await activeDisarmForPass(db, clock, projectId);
  const config = resolveScoreBreaker(await getProjectSettings(db, projectId));
  if (!config || disarmed) return undefined;

  const since = await lastReArmAt(db, projectId);
  const series = await readScoreSeries(db, projectId, config.window, since);
  const slide = detectScoreSlide(series, config);
  if (!slide) return undefined;

  const { disarm, created } = await disarmWithEscalation(db, clock, {
    projectId,
    reason: "score-regression",
    detail: describeScoreSlide(slide),
    evidence: scoreSlideEvidence(slide),
  });
  return { slide, latched: created, disarmId: disarm.id };
}

/**
 * The project's finished runs with each one's own score attached, newest first — nothing from before
 * `reArmedAt`, whose scores the operator already read and overruled.
 *
 * Pages back until the window is full, the history runs out, or the read reaches past the re-arm.
 * That last stop is what keeps the paging bounded: without it, a project whose overruled scores are
 * the only ones it has would walk its whole runs table on every ten-minute pass to learn nothing.
 */
async function readScoreSeries(
  db: AntonDb,
  projectId: string,
  window: number,
  reArmedAt: number | undefined,
): Promise<ScoredRun[]> {
  const series: ScoredRun[] = [];
  const seen = new Set<string>();
  for (let offset = 0; series.length < window; offset += SCORE_PAGE) {
    const page = await listRecentRunOutcomes(db, projectId, SCORE_PAGE, offset);
    for (const run of page) {
      // Filtered per row, not per page: the floor only ever drops the OLDEST rows, so dropping one
      // costs the series nothing the next page cannot supply.
      if (!settledAfterReArm(run, reArmedAt)) continue;
      // A queued or running run has not been reviewed yet. Skipped rather than counted as a gap: it
      // is not evidence the series is broken, only that it has not happened.
      if (run.status === "queued" || run.status === "running") continue;
      // One entry per TARGET, and it is the target's NEWEST attempt: a feature retried three times
      // is one piece of work being judged, and counting each attempt would let a single bad review
      // fill the window on its own. When that newest attempt left no score, the target reads as a
      // gap — which is the honest answer, not a licence to reach back to what an older attempt
      // scored.
      if (seen.has(run.epicBeadId)) continue;
      seen.add(run.epicBeadId);
      const score = run.reviewScore;
      series.push({
        id: run.id,
        targetBeadId: run.epicBeadId,
        ...(score !== undefined ? { score } : {}),
      });
      if (series.length === window) break;
    }
    const oldest = page.at(-1);
    if (page.length < SCORE_PAGE || oldest === undefined) break;
    // `updatedAt` — not the fence's own `endedAt ?? updatedAt` — is what the page order is on, so
    // it is the only value that proves every row BEHIND this one is also pre-re-arm.
    if (reArmedAt !== undefined && oldest.updatedAt <= reArmedAt) break;
  }
  return series;
}
