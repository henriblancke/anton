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
  activeExecuteEpicId,
  activeExecuteEpicKeys,
  activeJobIdsForProject,
  cancelJob,
  complete,
  deferQueuedJobs,
  deleteActiveJobsForProject,
  disabledScheduleKeys,
  enqueue,
  enqueueExecuteEpicDeduped,
  enqueueExecuteEpicIfAbsent,
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
import { isPoisonError, isRunAlreadyLiveError, isUsageLimitError } from "./errors";
import { PollingLoop } from "./polling-loop";
import { sampleJobBurn } from "../burn";
import { getClaudeUsageCached, type ClaudeUsage } from "../claude/usage";
import { budgetGate, type BudgetPolicy } from "./budget";

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

/**
 * Resolve a project's budget policy for the governor (anton-szld). May be async (reads settings).
 * Returns `null` when the project has budget-aware execution turned off (anton-7mpv.1) — the runner
 * treats that project as ungoverned and, when NO project is budget-aware, skips the usage read
 * entirely so the governor never touches the pill's shared usage cache.
 */
export type BudgetPolicyResolver = (
  projectId: string | undefined,
) => Promise<BudgetPolicy | null> | BudgetPolicy | null;

/**
 * Job types the budget governor may proactively defer (anton-szld). An allowlist by design: only
 * anton's *autonomous* background work is held when the governor says the budget is scarce, and the
 * governor only delays when the runner *leases* a job — a human-approved epic still *enqueues* the
 * moment it's approved, exactly like the schedule master-switch.
 *
 * `review-fix` and `nightly-stringer` are deliberately NOT governed (anton-d8i4): review-fix responds
 * to a human's PR review / failing CI and must land promptly, and the nightly scan is a fixed, cheap,
 * off-peak sweep — pacing either just adds latency without meaningfully shaping the weekly burn. So
 * only autonomous *epic execution* and the `orphan-grooming` cleanup sweep are paced; and even an
 * execute-epic job the operator approved for immediate run (the `bypassBudget` payload flag) skips
 * the pacing holds, keeping only the session-headroom floor (see `applyBudgetGovernor`).
 */
export const GOVERNED_JOB_TYPES: readonly JobType[] = ["execute-epic", "orphan-grooming"];

/**
 * Is an execute-epic run already live for this project + epic on ANOTHER machine? (anton-jz1)
 * Reads run-liveness from the shared board (beads/dolt) — the `jobs` table is machine-local and
 * disposable, so it can't see a run executing on a different operator's machine. Used to gate a
 * Force run so it can't double-run an epic already in flight elsewhere. Best-effort: returns false
 * (fail open) on any error so a transient beads hiccup never blocks a legitimate run.
 */
export type LiveRunCheck = (
  projectId: string,
  epicBeadId: string,
) => Promise<boolean> | boolean;

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
  | { kind: "lease-held"; error: string }
  | { kind: "poison"; error: string }
  | { kind: "error"; error: string };

export type Action =
  | { action: "complete" }
  | { action: "reschedule"; runAtMs: number; refundAttempt: boolean; lastError?: string }
  | { action: "park"; lastError: string };

export function classifyError(e: unknown): Outcome {
  if (isUsageLimitError(e)) return { kind: "quota", resetAt: e.resetAt };
  if (isRunAlreadyLiveError(e)) return { kind: "lease-held", error: e.message };
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
    case "lease-held": {
      // A run is live on another machine (anton-jz1). Retry after a cool-off, refunding the attempt:
      // it's not this job's failure and the foreign run may hold its lease for a long time, so it
      // must never park for a human — it re-checks liveness each time until the lease clears.
      const runAtMs = nowMs + config.quotaCooloffMs;
      return {
        action: "reschedule",
        runAtMs,
        refundAttempt: true,
        lastError: `run live elsewhere: retries at ${new Date(runAtMs).toISOString()}`,
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
  private readonly resolveBudgetPolicy: BudgetPolicyResolver | null;
  private readonly liveRunCheck: LiveRunCheck | null;
  private readonly readUsage: () => Promise<ClaudeUsage | null>;

  private readonly inFlight = new Map<string, AbortController>();
  /** Settlement promises for jobs dispatched but not yet settled — the drain set for whenIdle(). */
  private readonly pending = new Set<Promise<void>>();
  private readonly loop: PollingLoop;

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
    /**
     * Per-project budget-policy source for the proactive governor (anton-szld). When set, each tick
     * consults `budgetGate(usage, policy, now)` per project with pending autonomous jobs and, on a
     * DEFER verdict, holds that project's governed buckets and pushes their queued runAt out to the
     * governor's retryAt. Omit to disable the proactive gate (the reactive UsageLimitError backstop
     * is unaffected either way).
     */
    resolveBudgetPolicy?: BudgetPolicyResolver;
    /**
     * Cross-machine run-liveness source (anton-jz1). When set, a fresh execute-epic enqueue that
     * has no active job in THIS machine's store is gated on it: if a run is already live for the
     * epic on another machine (read from the shared beads board), no second run is started. Omit
     * to keep the pre-jz1 behavior (machine-local dedupe only).
     */
    liveRunCheck?: LiveRunCheck;
    /**
     * Live Claude-usage reader for the per-job burn sampler (anton-w8ny). Defaults to the shared,
     * cached read so bursts collapse to one upstream fetch. Injectable for deterministic tests.
     */
    readUsage?: () => Promise<ClaudeUsage | null>;
  }) {
    this.db = deps.db;
    this.clock = deps.clock ?? systemClock;
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.log = deps.log ?? noopLog;
    this.resolvePolicy = deps.resolvePolicy ?? null;
    this.resolveBudgetPolicy = deps.resolveBudgetPolicy ?? null;
    this.liveRunCheck = deps.liveRunCheck ?? null;
    this.readUsage = deps.readUsage ?? getClaudeUsageCached;
    this.loop = new PollingLoop({
      tickMs: this.config.tickMs,
      tick: async () => {
        await this.tickOnce();
      },
      onError: (e) => this.log.error("runner tick failed", e),
    });
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
   * Enqueue an execute-epic run, deduped against any active run for the same project + epic —
   * both this machine's `jobs` table (anton-761) AND, when a `liveRunCheck` is wired, the shared
   * beads board (anton-jz1). Returns the active job's id when one already exists in THIS store;
   * `undefined` when a run is live on ANOTHER machine (nothing enqueued here — the other run
   * covers it); otherwise the id of a freshly-created `queued` job. Race-safe locally via a
   * transactional guard + partial unique index.
   */
  async enqueueExecuteEpic(
    projectId: string,
    epicBeadId: string,
    opts?: { bypassBudget?: boolean },
  ): Promise<string | undefined> {
    if (this.quiescedProjects.has(projectId)) {
      throw new Error(`Project is being deleted: ${projectId}`);
    }
    // A job already active in this store (queued|running) short-circuits the cross-machine check: it
    // IS this machine's live/pending run for the epic. Re-run the dedupe path anyway (not a bare
    // return) so an immediate "Approve" (bypassBudget) can promote an already-queued paced job —
    // pull it due now + set the bypass flag — instead of leaving it stuck behind the pace-line.
    const localActive = activeExecuteEpicId(this.db, projectId, epicBeadId);
    if (localActive) {
      return enqueueExecuteEpicDeduped(this.db, this.clock, projectId, epicBeadId, opts);
    }

    // No local job. Before starting a fresh run, consult the shared board: if a run is live on
    // another machine, don't double-run — the `jobs` table can't see it because it's machine-local
    // and disposable (anton-jz1). Fail open so a beads hiccup never blocks a legitimate run.
    if (this.liveRunCheck) {
      let live = false;
      try {
        live = await this.liveRunCheck(projectId, epicBeadId);
      } catch (e) {
        this.log.error(`liveRunCheck failed for ${projectId}/${epicBeadId}; enqueuing anyway`, e);
      }
      if (live) return undefined;
    }

    // Re-check quiescence AFTER the await (anton-jz1). `liveRunCheck` yields, and `quiesceProject()`
    // can run during it: it sets the flag then calls `abortProject`, which saw no active job for us
    // (our row isn't inserted yet) and proceeded to tear the project down. Enqueuing now would strand
    // an execute-epic row for a project being deleted, so re-gate exactly like the pre-await check
    // above before inserting. (`abortProject`'s own post-sweep leftover guard fails loud if a row
    // still slips in after this, so the two together close the window.)
    if (this.quiescedProjects.has(projectId)) {
      throw new Error(`Project is being deleted: ${projectId}`);
    }

    return enqueueExecuteEpicDeduped(this.db, this.clock, projectId, epicBeadId, opts);
  }

  /**
   * Enqueue an execute-epic run for an owner-changing take-over: creates a job only when this
   * instance has no job for the epic (any status), so a cross-instance take-over gets a runnable
   * local job while a same-instance one reuses the existing (resumable) job. Returns the new job id,
   * or `undefined` when a local job already covers the epic. See `enqueueExecuteEpicIfAbsent`.
   */
  enqueueExecuteEpicIfAbsent(
    projectId: string,
    epicBeadId: string,
    opts?: { bypassBudget?: boolean },
  ): string | undefined {
    if (this.quiescedProjects.has(projectId)) {
      throw new Error(`Project is being deleted: ${projectId}`);
    }
    return enqueueExecuteEpicIfAbsent(this.db, this.clock, projectId, epicBeadId, opts);
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
   * Force-kill a single job (anton-a4jj): terminalize it as `cancelled` so no durability path revives
   * it, then abort its in-flight child if this process holds one. Order matters — terminalize FIRST,
   * so the aborted handler's settle (which classifies an AbortError as a retryable `error`) lands as a
   * no-op against the now-terminal row instead of rescheduling it back to `queued`. The DB write runs
   * regardless of `inFlight` membership, so a `running` row leased by a since-restarted process (no
   * local controller) is still terminalized and lease-expiry reclaim can't re-run it. Returns whether
   * it acted (false = the job was already terminal or unknown).
   */
  async cancel(jobId: string): Promise<boolean> {
    const acted = await cancelJob(this.db, this.clock, jobId);
    this.inFlight.get(jobId)?.abort();
    return acted;
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

    // Budget governor (anton-szld): before leasing, ask the pace-line whether autonomous work may
    // run *now*. A DEFER verdict adds the project's governed buckets here (same hold as the
    // master-switch) and pushes their queued runAt out to retryAt. Proactive back-off past the
    // reset/night boundary — the reactive UsageLimitError path below still backstops a wall we hit
    // anyway. Fails OPEN on a null usage read, so a broken meter never halts anton.
    await this.applyBudgetGovernor(heldBucketKeys);

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

  /**
   * Proactive budget gate (anton-szld). For each project with pending governed jobs, ask
   * `budgetGate` whether autonomous work may run now; on a DEFER verdict, hold that project's
   * governed buckets for this tick and push their queued jobs' runAt out to the governor's retryAt.
   * Only runs when a budget-policy resolver is injected. Fails OPEN: a null usage read defers nothing
   * (a missing meter must never starve the queue), mirroring `budgetGate`'s own contract.
   */
  private async applyBudgetGovernor(heldBucketKeys: Set<string>): Promise<void> {
    if (!this.resolveBudgetPolicy) return;

    // The gate decides per project (day window / reserve are per-project knobs), so gather every
    // project — including the null-project bucket — that has a pending job of a governed type.
    const projectIds = new Set<string | null>();
    for (const type of GOVERNED_JOB_TYPES) {
      for (const pid of await projectIdsWithPendingJobs(this.db, type)) projectIds.add(pid);
    }
    if (projectIds.size === 0) return;

    // Resolve each project's budget policy FIRST. A null policy means budget-aware execution is off
    // for that project (anton-7mpv.1) — the default — so it isn't governed. Reading usage only AFTER
    // finding a governed project is deliberate: when no project has opted in (the default state), the
    // governor never calls the usage endpoint, so it can't cache a transient null into the shared
    // cache the nav pill reads (which is what darkened the pill on this branch) or hammer the keychain.
    const governed: Array<{ pid: string | null; policy: BudgetPolicy }> = [];
    for (const pid of projectIds) {
      const policy = await this.resolveBudgetPolicy(pid ?? undefined);
      if (policy) governed.push({ pid, policy });
    }
    if (governed.length === 0) return; // no project is budget-aware → never read usage

    const usage = await this.readUsageSafe();
    if (!usage) return; // fail open — a broken/absent meter never holds work

    const now = this.clock.now();
    for (const { pid, policy } of governed) {
      const decision = budgetGate(usage, policy, now);
      if (decision.admit) continue; // budget healthy → nothing paced this tick, immediate or not
      const retryAtMs = decision.retryAt.getTime();
      const pacedError = `budget: ${decision.reason} — resumes at ${new Date(retryAtMs).toISOString()}`;

      // Fully-governed types (everything except execute-epic) — held + deferred wholesale to the
      // pace boundary. There's no per-job bypass for these; the whole bucket is paced.
      const otherTypes = GOVERNED_JOB_TYPES.filter((t) => t !== "execute-epic");
      for (const type of otherTypes) heldBucketKeys.add(scheduleGateKey(type, pid));
      if (otherTypes.length > 0) {
        await deferQueuedJobs(this.db, this.clock, {
          types: otherTypes,
          projectId: pid,
          retryAtMs,
          lastError: pacedError,
        });
      }

      // execute-epic splits on the per-job `bypassBudget` flag (anton-d8i4):
      //  • paced ("Queue for optimal usage") rows are deferred to the pace boundary like before.
      await deferQueuedJobs(this.db, this.clock, {
        types: ["execute-epic"],
        projectId: pid,
        retryAtMs,
        lastError: pacedError,
        bypass: "exclude",
      });

      //  • immediate ("Approve" / run-directly) rows skip weekly/daytime pacing but still honor the
      //    session-headroom floor: defer them ONLY when the session itself is nearly exhausted.
      const immediate = budgetGate(usage, policy, now, { skipPacing: true });
      if (!immediate.admit) {
        const immRetryMs = immediate.retryAt.getTime();
        await deferQueuedJobs(this.db, this.clock, {
          types: ["execute-epic"],
          projectId: pid,
          retryAtMs: immRetryMs,
          lastError: `budget: ${immediate.reason} — resumes at ${new Date(immRetryMs).toISOString()}`,
          bypass: "only",
        });
        // Every execute-epic row for the project is now deferred (paced + immediate), so hold the
        // whole bucket as the starvation guard, matching the schedule master-switch.
        heldBucketKeys.add(scheduleGateKey("execute-epic", pid));
      }
      // else: immediate rows run this tick — do NOT hold the execute-epic bucket. The paced rows were
      // just pushed to a future runAt, so they're not runnable and can't crowd the finite scan window
      // (the reason the bucket is normally held); the immediate rows stay due and lease as usual.
    }
  }

  private async processJob(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type as JobType);
    const controller = new AbortController();
    // Held for the whole lifetime (handler + settle) so the slot isn't freed until the job is
    // durably settled — that's what keeps global/per-project capacity from oversubscribing.
    this.inFlight.set(job.id, controller);

    // Burn sampler (anton-w8ny): snapshot Claude usage before the job so we can attribute the
    // session%/weekly% that moves across it to this job's TYPE. maxConcurrent=1 makes that clean.
    // Fail-soft — a null read just means no sample; it never gates dispatch.
    const burnBefore = await this.readUsageSafe();

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
      // Close the burn window: a fresh read minus the pre-job snapshot is this type's cost. Runs
      // for every outcome (even a failed attempt burned quota) and is fully fail-soft — sampleJobBurn
      // records nothing on a null read or a mid-job meter reset and swallows its own errors.
      await sampleJobBurn(this.db, this.clock, job.type as JobType, burnBefore, () =>
        this.readUsageSafe(),
      );
      this.inFlight.delete(job.id);
    }
  }

  /** Read live Claude usage for the burn sampler, fail-soft to `null` (never throws into dispatch). */
  private async readUsageSafe(): Promise<ClaudeUsage | null> {
    try {
      return await this.readUsage();
    } catch {
      return null;
    }
  }

  private async settle(job: JobRow, outcome: Outcome, policy: JobPolicy): Promise<void> {
    // Re-read attempts (a heartbeat/lease may have advanced updatedAt, not attempts, but be safe).
    const fresh = (await getJob(this.db, job.id)) ?? job;
    // Fast-path a cancel already visible at this read. The queue transition below also compares from
    // `running`, which closes the remaining race where cancel lands after this check but before the
    // settle write.
    if (fresh.status === "cancelled") return;
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
    if (this.loop.start()) this.log.info("job runner started");
  }

  /**
   * Stop the loop and abort in-flight jobs. Aborted jobs keep their `running` lease and are
   * reclaimed after it expires on the next boot — that is the durability contract.
   */
  async stop(): Promise<void> {
    this.loop.stop();
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
