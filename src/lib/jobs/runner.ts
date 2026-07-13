/**
 * Durable job runner (anton-dzh.1). An in-process loop over the `jobs` table: lease due/reclaimable
 * jobs, run their handler, and settle with durability *policy* — resumability over retry-in-place:
 *
 *   • Leases + crash reclaim — a leased job whose lease expires is re-leased next tick.
 *   • API-limit backoff      — `UsageLimitError` → reschedule past the reset window; the attempt is
 *                              refunded (you can't retry an exhausted quota).
 *   • Poison-pill            — a job that errors `maxAttempts` times (or throws `PoisonError`) is
 *                              parked for a human.
 *
 * The decision logic (`nextAction`) is a pure function so it can be unit-tested without timers.
 * See DESIGN.md §4.
 */
import {
  complete,
  enqueue,
  getJob,
  leaseDue,
  park,
  projectIdsWithPendingJobs,
  renewLease,
  reschedule,
  systemClock,
  type AntonDb,
  type Clock,
  type JobRow,
  type JobType,
} from "./queue";
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
  private readonly log: RunnerLogger;
  private readonly resolvePolicy: JobPolicyResolver | null;

  private readonly inFlight = new Map<string, AbortController>();
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
    return enqueue(this.db, this.clock, input);
  }

  /**
   * Lease and fully process all currently-due jobs (up to available concurrency), awaiting each.
   * This is the unit the background loop repeats — and what tests drive directly.
   * Returns the number of jobs processed.
   */
  async tickOnce(): Promise<number> {
    const capacity = this.config.maxConcurrent - this.inFlight.size;
    if (capacity <= 0) return 0;

    // With a policy resolver, gate execute-epic concurrency per project. Precompute each pending
    // project's cap so leaseDue can decide synchronously; other job types stay ungated (Infinity).
    let capOf: ((job: JobRow) => number) | undefined;
    if (this.resolvePolicy) {
      const projectIds = await projectIdsWithPendingJobs(this.db, "execute-epic");
      const concByProject = new Map<string, number>();
      for (const pid of projectIds) {
        const policy = await this.policyFor(pid ?? undefined);
        concByProject.set(pid ?? "", policy.concurrency);
      }
      capOf = (job) =>
        job.type === "execute-epic"
          ? (concByProject.get(job.projectId ?? "") ?? DEFAULT_CONFIG.maxConcurrent)
          : Infinity;
    }

    const jobs = await leaseDue(this.db, this.clock, {
      leaseMs: this.config.leaseMs,
      limit: capacity,
      capOf,
    });
    if (jobs.length === 0) return 0;

    await Promise.all(jobs.map((job) => this.processJob(job)));
    return jobs.length;
  }

  private async processJob(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type as JobType);
    const controller = new AbortController();
    this.inFlight.set(job.id, controller);

    const policy = await this.policyFor(job.projectId ?? undefined);

    // Keep the lease alive across long handlers so a working job isn't wrongly reclaimed.
    const renewEvery = Math.max(1_000, Math.floor(this.config.leaseMs / 3));
    const renewTimer = setInterval(() => {
      void renewLease(this.db, this.clock, job.id, this.config.leaseMs).catch(() => {});
    }, renewEvery);

    // Wall-clock timeout: abort the handler if it runs past the project's budget, so one stuck run
    // can't hold its concurrency slot forever (a heartbeating handler is never lease-reclaimed).
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
      this.inFlight.delete(job.id);
    }

    await this.settle(job, outcome, policy);
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
