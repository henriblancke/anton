/**
 * The score-regression breaker's I/O end (anton-cekf / R4.3): build the project's review-score
 * series out of its recent runs, ask {@link detectScoreSlide} whether the work is getting worse, and
 * latch the disarm if it is.
 *
 * Split the way picker-failure-breaker.ts is split from autopilot-failure-streak.ts — the rules are
 * pure and everything that needs a db lives here. What this module owns is the JOIN: a score is
 * persisted on the run TARGET (jobs/review-score.ts writes a `review-score:<n>` label alongside the
 * per-round comments), and the order those scores happened in is only knowable from the runs. The
 * board alone would give the scores with no reliable sequence; the runs alone would give the
 * sequence with no scores.
 *
 * The label is read off the board the pass ALREADY loaded, so the whole series costs no bd call —
 * which is what lets this sit on a ten-minute cadence. The per-round comment thread is the richer
 * record, but reading it is one bd spawn per target, and the label carries the number this breaker
 * actually judges.
 *
 * The series also STARTS at the last re-arm. Those scores are the case an operator read and
 * overruled; a window that could still reach back past them would re-latch the identical disarm on
 * the next pass — off runs that have not changed and cannot change — and revert the human decision
 * before anything new had been scored at all.
 */
import { reviewScoreOf } from "../ticket-view";
import type { Bead } from "../beads/types";
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
import { listRecentRuns } from "../runs";
import type { AntonDb, Clock } from "./queue";

/**
 * How far back the breaker looks, at minimum. Wider than any sane window so that the runs it skips —
 * the ones still in flight, and the repeat attempts collapsed onto one target — cannot push the
 * oldest member of the series out of the read and silently shorten it.
 */
const MIN_SCORE_WINDOW = 20;

export interface ScoreBreakerInput {
  projectId: string;
  /** The board the pass just read — where each target's score label is, at no extra `bd` call. */
  board: readonly Bead[];
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
 * does not carry a verdict — which includes every degraded read: too few runs, a run whose score
 * never landed, a board that no longer holds a target. Failing open there is deliberate (R4.3): the
 * cost is one more run at the current quality, against a project frozen on evidence nobody recorded.
 */
export async function checkScoreSlide(
  db: AntonDb,
  clock: Clock,
  input: ScoreBreakerInput,
): Promise<ScoreBreakerOutcome | undefined> {
  const { projectId } = input;
  const config = resolveScoreBreaker(await getProjectSettings(db, projectId));
  if (!config) return undefined;
  // Repairs a latch whose escalation write never landed — no later pass would (see activeDisarmForPass).
  if (await activeDisarmForPass(db, clock, projectId)) return undefined;

  const since = await lastReArmAt(db, projectId);
  const series = await readScoreSeries(db, projectId, input.board, config.window, since);
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
 * The project's finished runs with each one's score attached, newest first — nothing from before
 * `reArmedAt`, whose scores the operator already read and overruled.
 */
async function readScoreSeries(
  db: AntonDb,
  projectId: string,
  board: readonly Bead[],
  window: number,
  reArmedAt: number | undefined,
): Promise<ScoredRun[]> {
  const read = await listRecentRuns(db, projectId, Math.max(MIN_SCORE_WINDOW, window * 3));
  // Filtered after the read, never before it: the floor only ever drops the OLDEST rows, so the
  // window still holds the newest `window` runs it was sized to hold.
  const runs = read.filter((run) => settledAfterReArm(run, reArmedAt));
  const scores = scoresByTarget(board);
  const seen = new Set<string>();
  return runs.flatMap((run): ScoredRun[] => {
    // A queued or running run has not been reviewed yet. Skipped rather than counted as a gap: it
    // is not evidence the series is broken, only that it has not happened.
    if (run.status === "queued" || run.status === "running") return [];
    // One score per TARGET. A retried or resumed epic gets a fresh run row, but the label carries
    // only that target's latest score — counting it once per attempt would let a single bad review
    // fill the whole window on its own.
    if (seen.has(run.epicBeadId)) return [];
    seen.add(run.epicBeadId);
    const score = scores.get(run.epicBeadId);
    return [{ id: run.id, targetBeadId: run.epicBeadId, ...(score !== undefined ? { score } : {}) }];
  });
}

/** The board's `review-score:<n>` labels, by bead id — a lookup rather than a scan per run. */
function scoresByTarget(board: readonly Bead[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const bead of board) {
    const score = reviewScoreOf(bead);
    if (score !== undefined) scores.set(bead.id, score);
  }
  return scores;
}
