/**
 * Durable job runner (anton-dzh.1). An in-process loop over the `jobs` table: lease due/reclaimable
 * jobs, run their handler, and settle with durability *policy* — resumability over retry-in-place:
 *
 *   • Leases + crash reclaim — a leased job whose lease expires is re-leased next tick.
 *   • API-limit backoff      — `UsageLimitError` → reschedule past the reset window; the attempt is
 *                              refunded (you can't retry an exhausted quota).
 *   • Poison-pill            — a job that errors `maxAttempts` times (or throws `PoisonError`) is
 *                              parked for a human. Parking is recoverable, not terminal: `resume()`
 *                              (queue.resumeJob) un-parks a job back to `queued` with a fresh budget.
 *
 * The decision logic (`nextAction`) is a pure function so it can be unit-tested without timers.
 * See DESIGN.md §4.
 */
import {
  activeExecuteEpicKeys,
  activeJobIdsForProject,
  complete,
  deleteActiveJobsForProject,
  disabledScheduleKeys,
  enqueue,
  enqueueExecuteEpicDeduped,
  getJob,
  leaseDue,
  park,
  projectIdsWithPendingJobs,
  reclaimRunningJobs,
  renewLease,
  reschedule,
  resumeJob,
  scheduleGateKey,
  systemClock,
  type AntonDb,
  type Clock,
  type JobRow,
  type JobType,
} from "./queue";
import { reconcileInterruptedRuns } from "../runs";
import { isPoisonError, isUsageLimitError } from "./errors";

export interface RunnerConfig {
  /** How long a lease is held before a job is considered crashed. */
  leaseMs: number;
  /** Poison-pill threshold — park after this many failed attempts. */
  maxAttempts: number;
  /** Base for exponential retry backoff (nextRetry = base · 2^(attempts-1), capped). */
  backoffBaseMs: number;
  /** Cap on retry backoff. */
  backoffMaxMs: number;
  /** Fallback park duration for a quota hit with no known reset time. */
  quotaCooloffMs: number;
  /** Max jobs in flight at once. */
  maxConcurrent: number;
  /** Poll interval for the background loop. */
  tickMs: number;
}

export const DEFAULT_CONFIG: RunnerConfig = {
  leaseMs: 60_000,
  maxAttempts: 3,
  backoffBaseMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  quotaCooloffMs: 30 * 60_000,
  maxConcurrent: 1,
  tickMs: 2_000,
};

/**
 * The per-project execution policy the runner applies to a job. Resolved per job from project
 * settings (anton-xbk), falling back to defaults. When no resolver is injected the runner keeps
 * its config-driven behavior (global `maxConcurrent`, `config.maxAttempts`, no timeout).
 */
export interface JobPolicy {
  /** Max concurrent execute-epic runs for this project. */
  concurrency: number;
  /**
   * Autonomy master-switch (anton-y3l). `false` stops the runner from *claiming* execute-epic
   * jobs for this project — they enqueue as usual (approval, retries, resumes) but stay `queued`
   * until the switch is turned back on, when the next tick leases them. Gating at claim (not at
   * enqueue) is deliberate: it covers every enqueue path with one gate, never touches jobs already
   * in flight, and makes re-enabling resume paused work without re-approval. Absent → on.
   */
  autonomy?: boolean;
  /** Wall-clock timeout for one job attempt, in ms. `Infinity` disables the timeout. */
  timeoutMs: number;
  /** Max attempts before the job is parked for a human. */
  maxAttempts: number;
}

/** Resolve a project's job policy. May be async (reads settings from the DB). */
export type JobPolicyResolver = (
  projectId: string | undefined,
) => Promise<JobPolicy> | JobPolicy;

export interface JobContext {
  jobId: string;
  type: JobType;
  projectId?: string;
  payload: unknown;
  attempt: number;
  /** Extend the lease while doing long work. */
  heartbeat: () => Promise<void>;
  /** Aborted when the runner stops or the lease is lost — pass to child processes. */
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export type Outcome =
  | { kind: "success" }
  | { kind: "quota"; resetAt?: number }
  | { kind: "poison"; error: string }
  | { kind: "error"; error: string };

export type Action =
  | { action: "complete" }
  | { action: "reschedule"; runAtMs: number; refundAttempt: boolean; lastError?: string }
  | { action: "park"; lastError: string };

export function classifyError(e: unknown): Outcome {
  if (isUsageLimitError(e)) return { kind: "quota", resetAt: e.resetAt };
  if (isPoisonError(e)) return { kind: "poison", error: e.message };
  return { kind: "error", error: e instanceof Error ? e.message : String(e) };
}

/** Pure durability policy: given a job + outcome, what does the runner do next? */
export function nextAction(
  config: RunnerConfig,
  job: Pick<JobRow, "attempts">,
  outcome: Outcome,
  nowMs: number,
): Action {
  switch (outcome.kind) {
    case "success":
      return { action: "complete" };
    case "quota": {
      const runAtMs = outcome.resetAt ? outcome.resetAt * 1000 : nowMs + config.quotaCooloffMs;
      return {
        action: "reschedule",
        runAtMs,
        refundAttempt: true,
        lastError: `usage-limit: resumes at ${new Date(runAtMs).toISOString()}`,
      };
    }
    case "poison":
      return { action: "park", lastError: `poison: ${outcome.error}` };
    case "error": {
      if (job.attempts >= config.maxAttempts) {
        return { action: "park", lastError: `failed ${job.attempts}×: ${outcome.error}` };
      }
      const backoff = Math.min(
        config.backoffBaseMs * 2 ** Math.max(0, job.attempts - 1),
        config.backoffMaxMs,
      );
      return {
        action: "reschedule",
        runAtMs: nowMs + backoff,
        refundAttempt: false,
        lastError: outcome.error,
      };
    }
  }
}

export interface RunnerLogger {
  info: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}
const noopLog: RunnerLogger = { info: () => {}, error: () => {} };

export class JobRunner {
  private readonly db: AntonDb;
  private readonly clock: Clock;
  private readonly config: RunnerConfig;
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly quiescedProjects = new Set<string>();
  private readonly log: RunnerLogger;
  private readonly resolvePolicy: JobPolicyResolver | null;

  private readonly inFlight = new Map<string, AbortController>();
  /** Settlement promises for jobs dispatched but not yet settled — the drain set for whenIdle(). */
  private readonly pending = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;

  constructor(deps: {
    db: AntonDb;
    clock?: Clock;
    config?: Partial<RunnerConfig>;
    log?: RunnerLogger;
    /**
     * Per-project policy source. When set, the runner gates execute-epic concurrency per project,
     * applies each job's timeout, and parks after that project's retry budget. When omitted, the
     * runner falls back to its config (global maxConcurrent / maxAttempts, no timeout).
     */
    resolvePolicy?: JobPolicyResolver;
  }) {
    this.db = deps.db;
    this.clock = deps.clock ?? systemClock;
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.log = deps.log ?? noopLog;
    this.resolvePolicy = deps.resolvePolicy ?? null;
  }

  /** The effective policy for a job's project — the injected resolver, or config-derived defaults. */
  private async policyFor(projectId: string | undefined): Promise<JobPolicy> {
    if (this.resolvePolicy) return this.resolvePolicy(projectId);
    return {
      concurrency: this.config.maxConcurrent,
      timeoutMs: Infinity,
      maxAttempts: this.config.maxAttempts,
    };
  }

  registerHandler(type: JobType, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  /** Enqueue a job on this runner's DB/clock. */
  enqueue(input: { type: JobType; projectId?: string; payload?: unknown; runAt?: number }) {
    if (input.projectId && this.quiescedProjects.has(input.projectId)) {
      return Promise.reject(new Error(`Project is being deleted: ${input.projectId}`));
    }
    return enqueue(this.db, this.clock, input);
  }

  /**
   * Enqueue an execute-epic run, deduped against any active (queued|running) job for the same
   * project + epic. Returns the existing job's id when one is active; else creates a fresh job.
   * Race-safe via a transactional guard + partial unique index (anton-761).
   */
  enqueueExecuteEpic(projectId: string, epicBeadId: string): string {
    if (this.quiescedProjects.has(projectId)) {
      throw new Error(`Project is being deleted: ${projectId}`);
    }
    return enqueueExecuteEpicDeduped(this.db, this.clock, projectId, epicBeadId);
  }

  /**
   * Un-park a parked job, returning it to `queued` with a fresh attempt budget so it is picked up
   * on the next tick. The recovery path for a job that exhausted its retries (or hit a permanent
   * error a human has since resolved). Resolves true if a parked job was resumed, false otherwise.
   * The manual-resume UI (anton's separate ticket) drives this; parking is no longer terminal.
   */
  async resume(jobId: string): Promise<boolean> {
    const job = await getJob(this.db, jobId);
    if (job?.projectId && this.quiescedProjects.has(job.projectId)) return false;
    return resumeJob(this.db, this.clock, jobId);
  }

  /**
   * Crash/restart reconciliation (anton-nbd). Call ONCE at boot, before `start()`, while nothing is
   * in flight. Two steps make the durable state consistent again:
   *
   *   1. Reclaim orphaned leases — every `running` job is a lease the dead process never released;
   *      expiring the lease makes the next tick re-dispatch it immediately (rolling dispatch),
   *      instead of stalling for the whole `leaseMs` window.
   *   2. Reconcile orphaned runs — a `runs` row stuck in `running` whose execute-epic job is NOT
   *      coming back (no active job for its epic) is marked `failed`; a run whose job WILL resume is
   *      left untouched so the resume reuses it idempotently (no duplicate run / PR / commit).
   *
   * Best-effort: a reconciliation failure is logged but never blocks boot (the lease-expiry path
   * still recovers jobs, just a window later).
   */
  async reconcile(): Promise<{ reclaimedJobs: number; reconciledRuns: number }> {
    try {
      const reclaimedJobs = await reclaimRunningJobs(this.db, this.clock);
      const activeKeys = await activeExecuteEpicKeys(this.db);
      const reconciledRuns = await reconcileInterruptedRuns(this.db, this.clock, activeKeys);
      if (reclaimedJobs > 0 || reconciledRuns > 0) {
        this.log.info(
          `boot reconcile: reclaimed ${reclaimedJobs} orphaned job lease(s), ` +
            `failed ${reconciledRuns} interrupted run(s)`,
        );
      }
      return { reclaimedJobs, reconciledRuns };
    } catch (e) {
      this.log.error("boot reconcile failed (lease expiry will still recover jobs)", e);
      return { reclaimedJobs: 0, reconciledRuns: 0 };
    }
  }

  /**
   * Lease all currently-due jobs (up to available concurrency) and dispatch them **without awaiting
   * completion** — rolling dispatch. A long-running job stays in flight while the loop keeps
   * ticking every `tickMs`, so newly-enqueued work is leased within about one tick instead of after
   * the long job finishes. Returns the number of jobs leased/dispatched this tick.
   *
   * In-flight jobs count against `maxConcurrent` (the global cap) and against `leaseDue`'s
   * per-project `capOf` (via their `running` rows), so capacity never oversubscribes across the
   * rolling set. Use `whenIdle()` to await settlement of everything dispatched (tests, shutdown).
   */
  async tickOnce(): Promise<number> {
    const capacity = this.config.maxConcurrent - this.inFlight.size;
    if (capacity <= 0) return 0;

    // Schedule master-switch (anton-7l7): a DISABLED schedule caps its jobs at 0, so an
    // already-queued or backoff/quota-rescheduled review-fix (or any scheduled type) is NOT leased
    // while the toggle is off. Gating at *claim* — not just at the scheduler's enqueue — is what
    // makes disabling actually stop in-flight-but-queued work; re-enabling clears the key and the
    // still-queued job resumes on the next tick. Read every tick so a mid-run toggle takes effect.
    const disabledSchedules = await disabledScheduleKeys(this.db);

    // Hard-held buckets (cap 0 regardless of load) are excluded from leaseDue's scan window at the
    // SQL level, not just skipped by capOf — otherwise a large backlog of disabled/autonomy-off jobs
    // (the earliest by runAt) fills the finite scan window every tick and starves leasable work for
    // other schedules and projects (anton-7l7). Seed with disabled schedules; autonomy-off projects
    // are added below. capOf still enforces cap 0 as a backstop for anything not excluded (quiesce).
    const heldBucketKeys = new Set<string>(disabledSchedules);

    // With a policy resolver, gate execute-epic concurrency per project. Precompute each pending
    // project's cap so leaseDue can decide synchronously; other job types stay ungated (Infinity).
    let policyCapOf: ((job: JobRow) => number) | undefined;
    if (this.resolvePolicy) {
      const projectIds = await projectIdsWithPendingJobs(this.db, "execute-epic");
      const concByProject = new Map<string, number>();
      for (const pid of projectIds) {
        const policy = await this.policyFor(pid ?? undefined);
        // Autonomy master-switch: off → cap 0, so no execute-epic job for this project is leased
        // (they stay queued and resume when the switch turns back on). See JobPolicy.autonomy.
        const cap = policy.autonomy === false ? 0 : policy.concurrency;
        concByProject.set(pid ?? "", cap);
        // Cap 0 is a hard hold — exclude the whole bucket from the scan window so its backlog can't
        // starve other work (same rationale as disabled schedules above).
        if (cap === 0) heldBucketKeys.add(scheduleGateKey("execute-epic", pid));
      }
      policyCapOf = (job) =>
        job.type === "execute-epic"
          ? (concByProject.get(job.projectId ?? "") ?? DEFAULT_CONFIG.maxConcurrent)
          : Infinity;
    }
    const capOf = (job: JobRow) => {
      if (job.projectId && this.quiescedProjects.has(job.projectId)) return 0;
      if (disabledSchedules.has(scheduleGateKey(job.type, job.projectId))) return 0;
      return policyCapOf?.(job) ?? Infinity;
    };

    const jobs = await leaseDue(this.db, this.clock, {
      leaseMs: this.config.leaseMs,
      limit: capacity,
      capOf,
      excludeBucketKeys: heldBucketKeys,
      // Never re-lease a job already dispatched in this process. Rolling dispatch keeps a running
      // job in `inFlight` while its handler works; if its lease lapses (missed renewal from sleep or
      // a transient DB failure) its row looks reclaimable, and without this a spare-capacity tick
      // would dispatch it twice against the same worktree.
      exclude: this.inFlight.keys(),
    });
    if (jobs.length === 0) return 0;

    // Rolling dispatch: kick each leased job off without awaiting it, tracking its settlement
    // promise so whenIdle() (tests) and stop() (shutdown) can drain deterministically.
    for (const job of jobs) {
      const p = this.processJob(job);
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
    return jobs.length;
  }

  private async processJob(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type as JobType);
    const controller = new AbortController();
    // Held for the whole lifetime (handler + settle) so the slot isn't freed until the job is
    // durably settled — that's what keeps global/per-project capacity from oversubscribing.
    this.inFlight.set(job.id, controller);

    try {
      const policy = await this.policyFor(job.projectId ?? undefined);

      // Keep the lease alive across long handlers so a working job isn't wrongly reclaimed.
      const renewEvery = Math.max(1_000, Math.floor(this.config.leaseMs / 3));
      const renewTimer = setInterval(() => {
        void renewLease(this.db, this.clock, job.id, this.config.leaseMs).catch(() => {});
      }, renewEvery);

      // Wall-clock timeout: abort the handler if it runs past the project's budget, so one stuck
      // run can't hold its concurrency slot forever (a heartbeating handler is never reclaimed).
      let timedOut = false;
      const timeoutTimer =
        Number.isFinite(policy.timeoutMs) && policy.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, policy.timeoutMs)
          : null;
      // Don't let the timeout keep the process alive when idle.
      if (timeoutTimer && typeof timeoutTimer.unref === "function") timeoutTimer.unref();

      let outcome: Outcome;
      try {
        if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
        const ctx: JobContext = {
          jobId: job.id,
          type: job.type as JobType,
          projectId: job.projectId ?? undefined,
          payload: parsePayload(job.payloadJson),
          attempt: job.attempts,
          heartbeat: () => renewLease(this.db, this.clock, job.id, this.config.leaseMs),
          signal: controller.signal,
        };
        await handler(ctx);
        outcome = { kind: "success" };
      } catch (e) {
        // A timeout abort is a retryable failure with a clear reason (not a poison/quota misread).
        outcome = timedOut
          ? { kind: "error", error: `timed out after ${Math.round(policy.timeoutMs / 60_000)}m` }
          : classifyError(e);
        this.log.error(`job ${job.id} (${job.type}) failed: ${outcome.kind}`, e);
      } finally {
        clearInterval(renewTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }

      await this.settle(job, outcome, policy);
    } catch (e) {
      // Policy resolution or the settle write itself failed — log and release the slot; the lease
      // expires and the job is reclaimed on a later tick.
      this.log.error(`job ${job.id} (${job.type}) did not settle`, e);
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  private async settle(job: JobRow, outcome: Outcome, policy: JobPolicy): Promise<void> {
    // Re-read attempts (a heartbeat/lease may have advanced updatedAt, not attempts, but be safe).
    const fresh = (await getJob(this.db, job.id)) ?? job;
    // The project's retry budget governs when we park; backoff/quota stay from the runner config.
    const config = { ...this.config, maxAttempts: policy.maxAttempts };
    const action = nextAction(config, fresh, outcome, this.clock.now());
    switch (action.action) {
      case "complete":
        await complete(this.db, this.clock, job.id);
        break;
      case "reschedule":
        await reschedule(this.db, this.clock, job.id, action.runAtMs, {
          lastError: action.lastError,
          refundAttempt: action.refundAttempt,
        });
        break;
      case "park":
        await park(this.db, this.clock, job.id, action.lastError);
        break;
    }
  }

  /** Start the background polling loop (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      if (!this.ticking) {
        this.ticking = true;
        try {
          await this.tickOnce();
        } catch (e) {
          this.log.error("runner tick failed", e);
        } finally {
          this.ticking = false;
        }
      }
      if (this.running) this.timer = setTimeout(loop, this.config.tickMs);
    };
    this.timer = setTimeout(loop, 0);
    this.log.info("job runner started");
  }

  /**
   * Stop the loop and abort in-flight jobs. Aborted jobs keep their `running` lease and are
   * reclaimed after it expires on the next boot — that is the durability contract.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.inFlight.values()) controller.abort();
    // Give aborting handlers a moment to unwind; they settle their own job state.
    const start = Date.now();
    while (this.inFlight.size > 0 && Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.log.info("job runner stopped");
  }

  /**
   * Project teardown (anton-adt): force-abort every in-flight job for `projectId`, then delete its
   * `queued`/`running` rows so nothing re-claims the project's work mid-teardown. Sweeps until no
   * active row remains — the polling loop can lease a row between one read and its delete, so a
   * single pass isn't a guarantee. Row deletion makes an aborted handler's settle a no-op (its
   * UPDATE hits nothing), and settled rows (done/parked/failed) hold no lease, so they're left for
   * the caller's full project delete.
   *
   * Fails loud rather than half-stopping: throws if an aborted handler doesn't unwind within the
   * grace window or active rows keep reappearing (a racing enqueue) — the caller must not proceed
   * to worktree/db teardown while work may still be running.
   */
  async abortProject(projectId: string): Promise<void> {
    const aborted = new Set<string>();
    for (let sweep = 0; sweep < 5; sweep++) {
      const activeIds = await activeJobIdsForProject(this.db, projectId);
      if (activeIds.length === 0) break;
      for (const id of activeIds) {
        const controller = this.inFlight.get(id);
        if (controller) {
          controller.abort();
          aborted.add(id);
        }
      }
      await deleteActiveJobsForProject(this.db, projectId);
    }

    // Give aborted handlers a bounded window to unwind (mirrors stop()) so teardown doesn't race
    // a live job — e.g. removing a worktree a child process is still writing to.
    const start = Date.now();
    while ([...aborted].some((id) => this.inFlight.has(id)) && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const stuck = [...aborted].filter((id) => this.inFlight.has(id));
    if (stuck.length > 0) {
      throw new Error(
        `abortProject(${projectId}): aborted job(s) ${stuck.join(", ")} did not unwind in time`,
      );
    }
    const leftover = await activeJobIdsForProject(this.db, projectId);
    if (leftover.length > 0) {
      throw new Error(
        `abortProject(${projectId}): active job(s) ${leftover.join(", ")} still present after abort`,
      );
    }
  }

  /**
   * Permanently stop this process from accepting or leasing more work for a project, then drain
   * all work that crossed the barrier before it was raised. Project deletion calls this before
   * reading worktree state, closing the approval/tick race identified in PR review.
   */
  async quiesceProject(projectId: string): Promise<void> {
    this.quiescedProjects.add(projectId);
    await this.abortProject(projectId);
  }

  /**
   * Resolve once every dispatched job has fully settled (handler run + durability write). The
   * deterministic drain point: rolling dispatch never awaits a job itself, so tests await this to
   * observe settled state and shutdown uses it to finish in-flight work.
   */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  get activeCount(): number {
    return this.inFlight.size;
  }
}

function parsePayload(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
