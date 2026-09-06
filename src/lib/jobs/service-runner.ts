/**
 * The process-wide job runner + scheduler singletons (anton-dzh/anton-3t2) and the boot lifecycle
 * that starts them. Constructed once over the shared anton.db, with every job handler registered
 * (./service-handlers), the policy sources wired in (./service-policy) and the cron scheduler
 * started. Called from `src/instrumentation.ts` on server boot via ./service, which re-exports
 * these; API routes enqueue through the runner. See DESIGN §4.
 */
import { getDb } from "../db";
import { startSyncEngine } from "../beads/sync-engine";
import { JobRunner, type RunnerLogger } from "./runner";
import { Scheduler } from "./scheduler";
import { systemClock } from "./queue";
import { bootPreflight } from "./service-boot";
import { registerJobHandlers } from "./service-handlers";
import { liveRunCheck, readBeadLabels, resolveBudgetPolicy, resolvePolicy } from "./service-policy";

const log: RunnerLogger = {
  info: (msg, meta) => console.log(`[jobs] ${msg}`, meta ?? ""),
  error: (msg, meta) => console.error(`[jobs] ${msg}`, meta ?? ""),
};

/**
 * The runner/scheduler singletons live on globalThis, not in module scope, because Next compiles
 * `instrumentation.ts` and the app layer (RSC pages, route handlers) into SEPARATE module
 * registries: a module-level `let` yields one runner PER registry. The instrumentation copy is the
 * only one that ever runs jobs, so every in-memory read from a page or route would hit a second,
 * never-started runner with an empty `inFlight` map — live job handles (observe/investigate,
 * anton-susu) resolve to nothing, and `cancel()`'s abort never reaches the running child. Only the
 * DB-backed paths survive that split, which is why it stayed invisible until the first feature
 * needed live state. Symbol.for keyed, matching the convention for process-wide state here.
 */
const STATE_KEY = Symbol.for("anton.jobs.serviceState");

interface ServiceState {
  runner: JobRunner | null;
  scheduler: Scheduler | null;
  /** Reconcile-once guard — process-wide for the same reason (see startRunner). */
  reconciled: boolean;
}

function state(): ServiceState {
  const global = globalThis as unknown as Record<symbol, ServiceState | undefined>;
  return (global[STATE_KEY] ??= { runner: null, scheduler: null, reconciled: false });
}

/**
 * Global ceiling on total in-flight jobs across all projects — a safety bound above the per-project
 * caps. Override with ANTON_MAX_CONCURRENT. Must be ≥ the largest project concurrency to not
 * bottleneck it (default 8 comfortably covers the 1–6 per-project range).
 */
const GLOBAL_MAX_CONCURRENT = Number(process.env.ANTON_MAX_CONCURRENT) || 8;

export function getRunner(): JobRunner {
  const s = state();
  if (s.runner) return s.runner;
  const db = getDb();
  const runner = new JobRunner({
    db,
    clock: systemClock,
    log,
    config: { maxConcurrent: GLOBAL_MAX_CONCURRENT },
    resolvePolicy,
    resolveBudgetPolicy,
    liveRunCheck,
    readBeadLabels,
  });
  registerJobHandlers(runner, db);
  s.runner = runner;
  return runner;
}

export function getScheduler(): Scheduler {
  const s = state();
  if (s.scheduler) return s.scheduler;
  s.scheduler = new Scheduler({ db: getDb(), clock: systemClock, log });
  return s.scheduler;
}

/**
 * Idempotent: reconcile crash-orphaned jobs/runs (anton-nbd), then start the background runner loop
 * + the cron scheduler + the beads sync engine. Meant to be called once at server boot, but tolerant
 * of re-entry (dev hot-reload, tests): reconciliation runs at most once — the first call only —
 * because it expires every `running` lease, and a second call while this process already has jobs in
 * flight would reclaim its own live leases and let the next tick dispatch those job ids a second
 * time. `start()`, the scheduler, and the sync engine are themselves idempotent. Reconciliation runs
 * before the loop so a restart re-dispatches in-flight work on the first tick rather than after a
 * lease window; it's best-effort and never blocks startup.
 */
export async function startRunner(): Promise<void> {
  await bootPreflight(log);
  const s = state();
  if (!s.reconciled) {
    // Set before awaiting so a concurrent second call can't slip past into a second reconcile.
    s.reconciled = true;
    await getRunner().reconcile();
  }
  getRunner().start();
  getScheduler().start();
  startSyncEngine();
}
