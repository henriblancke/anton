/**
 * The picker's board-change nudge (anton-h32k). The recorded plan is only as current as the pass
 * that wrote it, and the cron cadence is ten minutes — so on a board that moves once a minute the
 * Up Next lane spends most of the day reading stale, and the start button bound to that plan's
 * generation is absent. This closes that window to one debounce window, using the signal the app
 * already has.
 *
 * The signal is {@link onBoardChanged} — a completed board read whose content differs from the one
 * the snapshot held. Nothing new watches, polls, or is emitted: the read every local bd write and
 * every remote pull already forces simply gets a second subscriber. Content, not invalidation, is
 * what it subscribes to, and deliberately: the sync coalescer invalidates on every pass that
 * reaches `synced`, so a nudge bound to that would re-decide every 30s on any wired board — the
 * cron backstop's cadence, at a `bd list` under the repo's exclusive Dolt lock apiece.
 *
 * DECIDING stays the job's. This module only enqueues a `board-picker` pass; the plan row is still
 * written by exactly one producer, so a board READ can never write a plan and two surfaces can never
 * disagree about what was decided.
 *
 * Cheap by construction, because the pass is: an extra pass re-reads the board, re-runs a pure
 * decision, and replaces one row — and `planIdFor` reuses the generation when the decision is
 * unchanged, so a redundant pass does not churn the identity the accept record is fenced on.
 */
import { eq } from "drizzle-orm";
import { activeDisarm } from "../autopilot-disarm";
import { onBoardChanged } from "../beads/snapshot";
import * as schema from "../db/schema";
import { scheduleEnabled, scheduleIdFor } from "../schedules";
import { queuedJobId, type AntonDb } from "./queue";
import type { RunnerLogger } from "./runner";

/**
 * How long a burst of board writes folds into one pass.
 *
 * The window IS the rate limit, and that is what it is sized for: a pass spawns `bd list` under the
 * repo's exclusive Dolt lock, so a shorter window would buy freshness the operator cannot see while
 * contending with the very reads it is reacting to. Matched to `ISSUE_SNAPSHOT_MAX_AGE_MS`, which is
 * the app's existing answer to "how fresh does a board read need to be", and still twenty times the
 * cadence it backs.
 */
export const PICKER_NUDGE_WINDOW_MS = 30_000;

const noopLog: RunnerLogger = { info: () => {}, error: () => {} };

export interface BoardPickerNudgeDeps {
  db: AntonDb;
  /**
   * How a pass reaches the queue. Wired to the runner's transactional
   * `enqueueScheduledTypeIfAbsent` in `service-runner.ts` (PR #264 review) — not the bare
   * `enqueue()` — so a scheduler tick or a manual "Run now" fire landing between this module's own
   * `queuedJobId` pre-check (below) and the insert can't double-fire the pass; that check and the
   * insert this calls are still two separate operations, but the insert re-checks freshly inside its
   * own transaction regardless of what this pre-check saw. Refused (project mid-teardown) by the
   * same quiesce barrier every other enqueue path crosses; a test passes its own.
   *
   * `scheduleId` is passed through to the payload the same way the scheduler and `runScheduleNow`
   * both stamp it (PR #264 review): `pendingRunsBySchedule`/`lastRunsBySchedule` key on that payload
   * field, not on type+project, so a nudge job with a bare `{ projectId }` payload was invisible to
   * both — reading as "no fire in flight" to the Automation table's Run now button, and to its
   * Last-run cell, while `runScheduleNow`'s own type+project check still saw it and refused a click
   * with a 409 the UI never explained. Absent when the project has no `board-picker` row yet (a
   * fresh install racing its own seed) — the job still enqueues, just without that visibility.
   */
  enqueue: (projectId: string, scheduleId?: string) => Promise<unknown>;
  windowMs?: number;
  log?: RunnerLogger;
}

/** The project that owns this repo path, or undefined when none does. */
function projectByRepoPath(db: AntonDb, repoPath: string): { id: string } | undefined {
  return db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.repoPath, repoPath))
    .limit(1)
    .all()[0];
}

/**
 * Turns "this repo's board moved" into "re-decide this project's plan", debounced per repo.
 *
 * Lifecycle-shaped like the `Scheduler` beside it — `start()` subscribes, `stop()` unsubscribes
 * and drops what it owes — so the boot path treats the two the same and a test can drive `nudge`
 * directly without touching the global listener registry.
 */
export class BoardPickerNudge {
  private readonly db: AntonDb;
  private readonly enqueueJob: (projectId: string, scheduleId?: string) => Promise<unknown>;
  private readonly windowMs: number;
  private readonly log: RunnerLogger;

  /** Repos with a pass already owed, keyed by repo path — the debounce itself. */
  private readonly owed = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;

  constructor(deps: BoardPickerNudgeDeps) {
    this.db = deps.db;
    this.enqueueJob = deps.enqueue;
    this.windowMs = deps.windowMs ?? PICKER_NUDGE_WINDOW_MS;
    this.log = deps.log ?? noopLog;
  }

  /**
   * Fold a board change into the pass this repo is already owed, or open a window and owe one.
   *
   * A fixed window, not a resetting one: the first change opens it and every change riding it is
   * dropped, so N moves cost exactly one pass and a board that never stops moving still gets one
   * pass per window rather than none. The pass fires at the END of that window on purpose — a burst
   * (a claim, a label, a note) is one board move to a reader, and deciding on its first write would
   * rank a board halfway through it.
   */
  nudge(repoPath: string): void {
    if (this.owed.has(repoPath)) return;
    const timer = setTimeout(() => {
      this.owed.delete(repoPath);
      void this.pass(repoPath);
    }, this.windowMs);
    // Never a reason to hold the process open: a pass owed at shutdown is one the cron backstop
    // covers on the next boot.
    timer.unref?.();
    this.owed.set(repoPath, timer);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onBoardChanged((repoPath) => this.nudge(repoPath));
    this.log.info(`board-picker nudge listening (${this.windowMs}ms window)`);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.owed.values()) clearTimeout(timer);
    this.owed.clear();
  }

  /**
   * Enqueue the pass this window owes — unless something says not to decide at all.
   *
   * The refusals, in the order an operator would ask about them: a repo no project owns has nothing
   * to decide for; a project whose `board-picker` SCHEDULE is switched off has had the picker turned
   * off by hand, and this listener must not become the enqueuer that outlives that switch — at
   * `apply` a pass writes `approved`, claims the target and starts a run, so a nudge past a disabled
   * schedule autonomously starts the very run the operator switched it off to prevent; a FROZEN
   * project (the disarm latch — anton's word for it throughout the picker) needs a human to re-arm
   * before its picks mean anything, and a nudge that kept ranking for it would spend the lock on a
   * plan nothing may act on; and a pass already queued covers this change too. A `running` pass does
   * NOT cover it — it may have read the board before this change landed — which is why the dedupe is
   * on the queued row only.
   *
   * Never throws: this runs off a timer with no caller to catch it, and a nudge that fails costs one
   * cadence of staleness, which is exactly what the cron backstop is for.
   */
  private async pass(repoPath: string): Promise<void> {
    try {
      const project = projectByRepoPath(this.db, repoPath);
      if (!project) return;
      if (!(await scheduleEnabled(this.db, project.id, "board-picker"))) return;
      if (await activeDisarm(this.db, project.id)) return;
      if (queuedJobId(this.db, "board-picker", project.id)) return;
      const scheduleId = await scheduleIdFor(this.db, project.id, "board-picker");
      await this.enqueueJob(project.id, scheduleId);
    } catch (e) {
      this.log.error(`board-picker nudge failed for ${repoPath}`, e);
    }
  }
}
