/**
 * The consecutive-failure breaker's I/O end (anton-rgso / R4.4): read the project's recent runs, ask
 * {@link detectFailureStreak} whether they are a broken environment, and latch the disarm if they
 * are.
 *
 * Split the way board-picker.ts is split from picker-decision.ts — the arithmetic is pure
 * (autopilot-failure-streak.ts) and everything that needs a db lives here. What this module actually
 * owns is the two facts a run row cannot answer about itself:
 *
 *   • whether an operator CANCELLED the job behind it, which jobs/queue.ts records on the job and
 *     never on the run (the run names its job, so the job id is the join);
 *   • whether the work it carried was ABANDONED, which lives on the board.
 *
 * Getting those two wrong in opposite directions is the failure mode worth the extra reads: counting
 * a cancel would disarm a project whose operator was simply tidying up, and skipping an abandon
 * would let a run of give-ups look like an idle week.
 *
 * And a third fact, off the disarm table: WHEN the operator last re-armed. Runs that settled before
 * that instant were the case they already read and overruled, so the streak starts again from the
 * re-arm — otherwise the next pass would re-latch the identical disarm off the identical runs and
 * quietly revert the human decision.
 */
import { beads } from "../beads/bd";
import type { Bead } from "../beads/types";
import {
  describeFailureStreak,
  detectFailureStreak,
  failureStreakEvidence,
  verdictOf,
  type FailureStreak,
  type FailureWeight,
  type RunOutcome,
} from "../autopilot-failure-streak";
import {
  activeDisarmForPass,
  disarmWithEscalation,
  lastReArmAt,
  settledAfterReArm,
} from "../autopilot-disarm";
import { repairedFailureWeight } from "../gardener/repair";
import { isActiveRun } from "@/components/runs/run-view-utils";
import { getProjectSettings, resolveFailureBreaker } from "../projects";
import { listRecentRunOutcomes, type RunDetail } from "../runs";
import { cancelledExecuteEpicJobs, type AntonDb, type CancelledJob, type Clock } from "./queue";

/**
 * How many run rows one page of the streak read costs.
 *
 * The read is PAGED rather than sized once, because cancels and still-running rows count as neither
 * failure nor delivery — they are skipped, not treated as a reset — so how many ROWS a streak spans
 * is not knowable before reading them. A fixed window lets a run of cancels push the streak's oldest
 * member out of sight and quietly shorten it: two failures behind eighteen cancels would report as
 * two, and the project stays armed on a third failure nobody read.
 *
 * A row CAP would be that same bug at a larger size — enough skipped rows and the walk stops before
 * the evidence — so the walk has none. It stops only where the evidence itself does: a delivery, the
 * re-arm fence, a met threshold, or the end of history. What that costs is a project whose whole
 * history is cancels re-reading its runs table each pass to learn nothing; a breaker that silently
 * fails to fire is the worse of the two.
 */
const STREAK_PAGE = 20;

/**
 * How long after a run last moved a cancel may still be its own — the LEGACY join only.
 *
 * A cancel terminalizes the JOB and the handler settles the RUN a moment later, so the two stamps
 * are close but not equal, and both are stored second-granular. The window is [run started, run last
 * moved + slack] rather than an instant for that reason.
 *
 * It is a fallback because the interval is only right for a run the cancel INTERRUPTED. A job parked
 * or queued for retry stops moving its run and then waits — for the quota window, for the operator —
 * so a cancel raised hours later, which is the ordinary case for a park, falls outside every window
 * this slack could sensibly draw. Rows carrying a `jobId` are matched on it instead; only rows
 * written before that column existed reach here.
 */
const CANCEL_MATCH_SLACK_MS = 60_000;

/**
 * When this run stopped being its job's live attempt, or nothing while it is still open.
 *
 * A SETTLED run (`done`/`failed`) is over, and its job may already have queued the retry that
 * follows it — the runner reuses the job row and only opens the retry's own run when that attempt
 * actually starts. So a cancel raised after this run ended stopped whatever came next, never this
 * run: the handler writes the cancel BEFORE the run it interrupts unwinds to `failed`, which is why
 * no slack is allowed on this side.
 *
 * An OPEN run — running, or parked on a quota window or a human — has no such bound. It stops
 * moving and waits, so the cancel that ends it is its own however many hours later it lands.
 */
function settledAtMs(run: RunDetail): number | undefined {
  if (isActiveRun(run.status)) return undefined;
  return (run.endedAt ?? run.updatedAt) * 1000;
}

/**
 * Whether an operator cancelled the job behind this run.
 *
 * The join is the run's own `jobId` — the job that started or last resumed this attempt — so a
 * cancel counts as this run's however long after the run last moved the operator raised it, and a
 * cancel of some OTHER job of the same epic (a queued attempt stopped before it ever ran) counts as
 * nothing here. Exact in both directions, which the window below can only approximate.
 *
 * Two bounds keep one job id from claiming a cancel for every attempt it spans, because a job id is
 * not one attempt: the runner's automatic retry reuses the job row and gives the retry a fresh run
 * (see `findRunFormulaForBranch`).
 *
 *   • `nextAttemptStartMs` — when the SAME epic's next attempt started. A cancel raised after that
 *     belongs to that attempt, not to this one; without it, cancelling a retry would mark every
 *     earlier attempt of its job cancelled too.
 *   • {@link settledAtMs} — when THIS run settled. It is what covers the retry that never started:
 *     a cancel during the backoff has no next attempt to be bounded by, and the id join alone would
 *     hand it back to the failure it followed and dissolve a real failure out of the streak.
 *
 * The legacy window needs both for its own reason: a retry beginning inside the slack, or a cancel
 * of one queued inside it, shares that stretch with the attempt before it.
 */
function wasCancelled(
  run: RunDetail,
  cancels: readonly CancelledJob[] | undefined,
  nextAttemptStartMs: number | undefined,
): boolean {
  if (!cancels?.length) return false;
  const settledAt = settledAtMs(run);
  const couldBeThisRun = (at: number) =>
    (nextAttemptStartMs === undefined || at < nextAttemptStartMs) &&
    (settledAt === undefined || at <= settledAt);
  if (run.jobId !== undefined) {
    return cancels.some((cancel) => cancel.id === run.jobId && couldBeThisRun(cancel.at));
  }
  const from = (run.startedAt ?? run.updatedAt) * 1000;
  const until = (run.endedAt ?? run.updatedAt) * 1000 + CANCEL_MATCH_SLACK_MS;
  return cancels.some(({ at }) => at >= from && at <= until && couldBeThisRun(at));
}

/** The board's won't-do beads, by id — a lookup rather than a scan per run. */
function abandonedIds(board: readonly Bead[]): Set<string> {
  return new Set(board.filter((bead) => beads.isAbandoned(bead)).map((bead) => bead.id));
}

export interface FailureBreakerInput {
  projectId: string;
  /** The board the pass just read — how an abandoned target is recognised, at no extra `bd` call. */
  board: readonly Bead[];
  /**
   * How a failed run is priced against the threshold. Absent → {@link repairedFailureWeight} over
   * `board`, which is the live rule: a failure that followed an auto-repair counts double (R5.8).
   * Passed explicitly only by tests pinning the arithmetic itself.
   */
  weigh?: FailureWeight;
}

export interface FailureBreakerOutcome {
  streak: FailureStreak;
  /** False when the project was already disarmed — the idempotent path. */
  latched: boolean;
  /** The disarm now freezing the project, whether this pass latched it or found it. */
  disarmId: string;
}

/**
 * Disarm the project's picker if its recent runs are a streak of failures, else do nothing.
 *
 * Returns `undefined` when the breaker is off, when the project is already disarmed (nothing to
 * decide — a latch does not clear itself, and re-deciding could only produce a second freeze the
 * operator has to clear twice), or when the streak is short of the threshold.
 */
export async function checkFailureStreak(
  db: AntonDb,
  clock: Clock,
  input: FailureBreakerInput,
): Promise<FailureBreakerOutcome | undefined> {
  const { projectId } = input;
  // Reconciled BEFORE the config is honoured, not after: this call is the only second chance either
  // half-written latch gets (see activeDisarmForPass), and both halves outlive the setting that
  // raised them. An operator who turns the breakers off while a strip row is stranded — an open
  // `autopilot-disarm` whose latch a re-arm already lifted — would otherwise leave it in "Needs you"
  // forever, since re-arming answers `not-disarmed` and dismissal refuses the kind.
  const disarmed = await activeDisarmForPass(db, clock, projectId);
  const config = resolveFailureBreaker(await getProjectSettings(db, projectId));
  if (!config || disarmed) return undefined;

  const since = await lastReArmAt(db, projectId);
  const weigh = input.weigh ?? repairedFailureWeight(input.board);
  const outcomes = await readRunOutcomes(db, projectId, input.board, {
    threshold: config.threshold,
    weigh,
    reArmedAt: since,
  });
  const streak = detectFailureStreak(outcomes, { ...config, weigh });
  if (!streak) return undefined;

  const { disarm, created } = await disarmWithEscalation(db, clock, {
    projectId,
    reason: "consecutive-failures",
    detail: describeFailureStreak(streak),
    evidence: failureStreakEvidence(streak),
  });
  return { streak, latched: created, disarmId: disarm.id };
}

/**
 * The project's recent runs as the breaker reads them, newest first — nothing from before
 * `reArmedAt`, which is the evidence the operator already adjudicated.
 *
 * Pages back until the streak is CLOSED (a delivery, the re-arm fence, or the end of history) or the
 * threshold is already met. Reading on past a met threshold within the page
 * in hand is deliberate: the streak the operator is shown is the whole run of failures, not just
 * the first N of it, and the page is already read by then.
 */
async function readRunOutcomes(
  db: AntonDb,
  projectId: string,
  board: readonly Bead[],
  { threshold, weigh, reArmedAt }: { threshold: number; weigh: FailureWeight; reArmedAt?: number },
): Promise<RunOutcome[]> {
  const cancelsRead = cancelledExecuteEpicJobs(db, projectId);
  const abandoned = abandonedIds(board);
  // When each epic's next attempt started, filled in as the walk moves from newest to oldest — the
  // bound that keeps one cancel from being claimed by two attempts of the same epic. Spans pages,
  // because so does an epic's retry chain.
  const nextAttemptStart = new Map<string, number>();
  const outcomes: RunOutcome[] = [];
  let weight = 0;
  let delivered = false;

  // A delivery ends the streak, so nothing older can extend it; a met threshold already latches, and
  // evidence older than that is not worth another read.
  for (let offset = 0; !delivered && weight < threshold; offset += STREAK_PAGE) {
    const [page, cancels] = await Promise.all([
      listRecentRunOutcomes(db, projectId, STREAK_PAGE, offset),
      cancelsRead,
    ]);
    for (const run of page) {
      // Filtered per row, not per page: the fence only ever drops the OLDEST rows, so dropping one
      // costs the walk nothing the next page cannot supply.
      if (!settledAfterReArm(run, reArmedAt)) continue;
      const startedAt = run.startedAt ?? run.updatedAt;
      const nextStart = nextAttemptStart.get(run.epicBeadId);
      nextAttemptStart.set(run.epicBeadId, startedAt);
      const outcome: RunOutcome = {
        id: run.id,
        epicBeadId: run.epicBeadId,
        // The bead a repair would have acted on inside a grouped run, and when this attempt began —
        // the two facts the repair weigher orders a failure against (gardener/repair.ts). The
        // ATTEMPT's start, not the row's: a parked run resumes in place, so the row's `startedAt`
        // would place a post-resume failure before the repair that parked it. Rows written before
        // the column existed fall back to it.
        ticketBeadId: run.ticketBeadId,
        startedAt: run.attemptStartedAt ?? startedAt,
        status: run.status,
        error: run.error,
        // A newer row that somehow starts no later than this one is not a later attempt, so it
        // bounds nothing — `updatedAt` orders the read, and it can tie with `startedAt`.
        cancelled: wasCancelled(
          run,
          cancels.get(run.epicBeadId),
          nextStart !== undefined && nextStart > startedAt ? nextStart * 1000 : undefined,
        ),
        // The ticket counts as well as the target: abandoning a child kills the run executing it,
        // and that run ended on work somebody gave up on however its own row reads.
        abandoned:
          abandoned.has(run.epicBeadId) ||
          (run.ticketBeadId !== undefined && abandoned.has(run.ticketBeadId)),
      };
      outcomes.push(outcome);
      const verdict = verdictOf(outcome);
      if (verdict === "delivered") {
        delivered = true;
        break;
      }
      if (verdict === "failure") weight += weigh(outcome);
    }
    const oldest = page.at(-1);
    if (page.length < STREAK_PAGE || oldest === undefined) break;
    // `updatedAt` — not the fence's own `endedAt ?? updatedAt` — is what the page order is on, so
    // it is the only value that proves every row BEHIND this one is also pre-re-arm.
    if (reArmedAt !== undefined && oldest.updatedAt <= reArmedAt) break;
  }
  return outcomes;
}
