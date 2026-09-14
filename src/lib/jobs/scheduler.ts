/**
 * Cron scheduler loop (anton-3t2.1). A lightweight sibling of the JobRunner: on each tick it scans
 * enabled schedules, and for every one that is due (nextRunAt ≤ now) it enqueues the schedule's job
 * and advances lastRunAt/nextRunAt to the next cron time. The runner then leases + executes the
 * enqueued job with its usual durability. See DESIGN §4/§6.
 *
 * The scheduler NEVER runs work itself — it only enqueues — so it stays cheap and crash-safe: a
 * missed tick just means the job enqueues on the next one. Advancing nextRunAt off `now` (not the
 * old nextRunAt) means a machine that was asleep for hours fires each schedule once, not once per
 * missed slot (no thundering herd of backlogged runs).
 */
import { and, eq, inArray, lte } from "drizzle-orm";
import * as schema from "../db/schema";
import { newJobRow, systemClock, type AntonDb, type Clock, type JobType } from "./queue";
import { nextRun } from "./cron";
import type { RunnerLogger } from "./runner";
import { PollingLoop } from "./polling-loop";

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

const noopLog: RunnerLogger = { info: () => {}, error: () => {} };

export interface SchedulerConfig {
  /** Poll interval for the scan loop. Cron granularity is one minute, so ~30s is plenty. */
  tickMs: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  tickMs: 30_000,
};

export class Scheduler {
  private readonly db: AntonDb;
  private readonly clock: Clock;
  private readonly config: SchedulerConfig;
  private readonly log: RunnerLogger;

  private readonly loop: PollingLoop;
  private readonly quiescedProjects = new Set<string>();

  constructor(deps: {
    db: AntonDb;
    clock?: Clock;
    config?: Partial<SchedulerConfig>;
    log?: RunnerLogger;
  }) {
    this.db = deps.db;
    this.clock = deps.clock ?? systemClock;
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...deps.config };
    this.log = deps.log ?? noopLog;
    this.loop = new PollingLoop({
      tickMs: this.config.tickMs,
      tick: async () => {
        const n = await this.tickOnce();
        if (n > 0) this.log.info(`scheduler enqueued ${n} scheduled job(s)`);
      },
      onError: (e) => this.log.error("scheduler tick failed", e),
    });
  }

  /**
   * Enqueue every due schedule and advance its clock. Returns the number of jobs enqueued.
   * This is the unit the loop repeats and what tests drive directly.
   */
  async tickOnce(): Promise<number> {
    const nowMs = this.clock.now();
    const nowDate = secDate(nowMs);

    const due = await this.db
      .select()
      .from(schema.schedules)
      .where(and(eq(schema.schedules.enabled, true), lte(schema.schedules.nextRunAt, nowDate)));
    if (due.length === 0) return 0;

    // Which (type, projectId) already have a job in flight — so we coalesce instead of piling up a
    // second job for the same work (a pass can outlast its own slot). The overlapped slot is
    // skipped; nextRunAt still advances so we wait for the next cron time rather than firing the
    // moment the in-flight job finishes.
    //
    // The key is the job TYPE, deliberately (anton-y771): work a scheduled pass DISPATCHES carries
    // a type of its own — `review-fix` fans out `review-fix-pr` — so a 45-minute fix on one PR does
    // not suppress the poll that would have found the other PRs' feedback. The scheduler stays
    // generic and never inspects a payload.
    const inflight = await this.db
      .select({ type: schema.jobs.type, projectId: schema.jobs.projectId })
      .from(schema.jobs)
      .where(inArray(schema.jobs.status, ["queued", "running"]));
    const inflightKeys = new Set(inflight.map((j) => `${j.type}\0${j.projectId ?? ""}`));

    let enqueued = 0;
    for (const s of due) {
      try {
        // Re-check inside the loop: deletion can raise the barrier after the due-query snapshot.
        if (this.quiescedProjects.has(s.projectId)) continue;
        // Advance from `now`, not the stale nextRunAt, so a long sleep (or an overlap) fires once.
        // Resolved BEFORE any write: a cron this scheduler can't advance past must not enqueue, or
        // the bad schedule re-fires on every tick.
        const nextRunAt = secDate(nextRun(s.cron, nowMs));

        if (inflightKeys.has(`${s.type}\0${s.projectId}`)) {
          this.log.info(`scheduler: ${s.type} for ${s.projectId} still in flight — skipping this slot`);
          // The slot is skipped, so `lastRunAt` keeps pointing at the fire actually in flight.
          // Guarded by cron+enabled still matching the `due`-query snapshot this `nextRunAt` was
          // computed from (PR #264 review): an operator's settings PATCH landing in the gap between
          // that snapshot and this write already recomputed its own `nextRunAt` off the NEW cron
          // (updateSchedule, schedules.ts) — writing this stale one over it would fire the automation
          // once more on its old cadence despite the successful edit. A no-match here means the PATCH
          // won the race and its own write stands; nothing to advance.
          await this.db
            .update(schema.schedules)
            .set({ nextRunAt })
            .where(
              and(
                eq(schema.schedules.id, s.id),
                eq(schema.schedules.cron, s.cron),
                eq(schema.schedules.enabled, true),
              ),
            );
          continue;
        }

        // The job insert and the `lastRunAt` stamp are ONE transaction, and the stamp IS the job's
        // `createdAt`. The Automation table pairs a fire with its outcome by matching those two
        // (lib/schedule-runs.ts), so splitting the writes would let a crash in between settle a job
        // whose verdict then reads beside an earlier fire's date — or beside "never".
        const row = newJobRow(
          {
            type: s.type as JobType,
            projectId: s.projectId,
            payload: { projectId: s.projectId, scheduleId: s.id },
          },
          nowMs,
        );
        const inserted = this.db.transaction((tx) => {
          // Re-check freshly INSIDE this transaction rather than trusting the batch `inflightKeys`
          // snapshot taken above (PR #264 review): that snapshot is one `await`ed read for the whole
          // tick, so a manual "Run now" fire (schedules.ts's runScheduleNow) landing after it but
          // before this schedule's own insert would be invisible to it, and this tick would insert a
          // SECOND active job for the same (type, project). better-sqlite3 transactions are
          // synchronous and Node is single-threaded, so a check made HERE — immediately before the
          // insert, inside the same uninterruptible transaction — cannot itself be raced; it is the
          // freshest read possible. Mirrors `runScheduleNow`'s own read-then-insert (schedules.ts).
          const active = tx
            .select({ id: schema.jobs.id })
            .from(schema.jobs)
            .where(
              and(
                eq(schema.jobs.type, s.type),
                eq(schema.jobs.projectId, s.projectId),
                inArray(schema.jobs.status, ["queued", "running"]),
              ),
            )
            .limit(1)
            .get();
          if (active) return false;

          tx.insert(schema.jobs).values(row).run();
          tx.update(schema.schedules)
            .set({ lastRunAt: row.createdAt, nextRunAt })
            .where(eq(schema.schedules.id, s.id))
            .run();
          return true;
        });

        if (inserted) {
          enqueued += 1;
        } else {
          // Lost the race to a fire the batch snapshot couldn't see — coalesce exactly like the
          // pre-check above: advance nextRunAt so this slot isn't retried every tick, no error.
          // Same cron+enabled guard as that pre-check (PR #264 review) — a settings PATCH could have
          // landed in this same gap and already written its own recomputed `nextRunAt`.
          this.log.info(
            `scheduler: ${s.type} for ${s.projectId} raced a concurrent enqueue — skipping this slot`,
          );
          await this.db
            .update(schema.schedules)
            .set({ nextRunAt })
            .where(
              and(
                eq(schema.schedules.id, s.id),
                eq(schema.schedules.cron, s.cron),
                eq(schema.schedules.enabled, true),
              ),
            );
        }
      } catch (e) {
        // A bad cron shouldn't wedge the whole loop; log and skip this schedule.
        this.log.error(`scheduler: failed to enqueue schedule ${s.id} (${s.type})`, e);
      }
    }
    return enqueued;
  }

  /** Prevent this scheduler instance from ever enqueueing more work for a deleting project. */
  quiesceProject(projectId: string): void {
    this.quiescedProjects.add(projectId);
  }

  start(): void {
    if (this.loop.start()) this.log.info("scheduler started");
  }

  stop(): void {
    this.loop.stop();
    this.log.info("scheduler stopped");
  }
}
