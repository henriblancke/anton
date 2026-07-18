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
import { enqueue, systemClock, type AntonDb, type Clock } from "./queue";
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
    // second job for the same work (a review-fix sweep can outlast its 15-min slot). The overlapped
    // slot is skipped; nextRunAt still advances so we wait for the next cron time rather than firing
    // the moment the in-flight job finishes.
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
        const overlapped = inflightKeys.has(`${s.type}\0${s.projectId}`);
        if (!overlapped) {
          await enqueue(this.db, this.clock, {
            type: s.type as Parameters<typeof enqueue>[2]["type"],
            projectId: s.projectId,
            payload: { projectId: s.projectId, scheduleId: s.id },
          });
          enqueued += 1;
        } else {
          this.log.info(`scheduler: ${s.type} for ${s.projectId} still in flight — skipping this slot`);
        }
        // Advance from `now`, not the stale nextRunAt, so a long sleep (or an overlap) fires once.
        const next = nextRun(s.cron, nowMs);
        await this.db
          .update(schema.schedules)
          .set({ lastRunAt: overlapped ? s.lastRunAt : nowDate, nextRunAt: secDate(next) })
          .where(eq(schema.schedules.id, s.id));
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
