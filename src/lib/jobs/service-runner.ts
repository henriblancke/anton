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
import { BoardPickerNudge } from "./picker-nudge";
import { systemClock } from "./queue";
import { bootPreflight } from "./service-boot";
import { registerJobHandlers } from "./service-handlers";
import {
  liveRunCheck,
  readBeadLabels,
  resolveBudgetPolicy,
  resolvePolicy,
  resolveProjectSpend,
} from "./service-policy";

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
  pickerNudge: BoardPickerNudge | null;
  /** Reconcile-once guard — process-wide for the same reason (see startRunner). */
  reconciled: boolean;
}

function state(): ServiceState {
  const global = globalThis as unknown as Record<symbol, ServiceState | undefined>;
  return (global[STATE_KEY] ??= {
    runner: null,
    scheduler: null,
    pickerNudge: null,
    reconciled: false,
  });
}

/**
 * Global ceiling on total in-flight jobs across all projects — a safety bound above the per-project
 * caps. Override with ANTON_MAX_CONCURRENT. Must be ≥ the largest project concurrency to not
 * bottleneck it (default 8 comfortably covers the 1–6 per-project range).
 */
const GLOBAL_MAX_CONCURRENT = Number(process.env.ANTON_MAX_CONCURRENT) || 8;

/**
 * Global ceiling on in-flight `review-fix-pr` jobs across all projects (PR #250 review). The
 * per-project `reviewFixConcurrency` bounds one project's fan-out, not the sum: four projects each
 * at the default two would take the whole pool above, and every other job type — execute-epic,
 * gate-check, sync-push — would wait out a long fix. Half the pool by default, so the other half
 * is always there for them. Override with ANTON_MAX_REVIEW_FIX_CONCURRENT.
 */
const GLOBAL_MAX_REVIEW_FIX_CONCURRENT =
  Number(process.env.ANTON_MAX_REVIEW_FIX_CONCURRENT) ||
  Math.max(1, Math.floor(GLOBAL_MAX_CONCURRENT / 2));

export function getRunner(): JobRunner {
  const s = state();
  if (s.runner) return s.runner;
  const db = getDb();
  const runner = new JobRunner({
    db,
    clock: systemClock,
    log,
    config: {
      maxConcurrent: GLOBAL_MAX_CONCURRENT,
      maxReviewFixConcurrent: GLOBAL_MAX_REVIEW_FIX_CONCURRENT,
    },
    resolvePolicy,
    resolveBudgetPolicy,
    resolveProjectSpend,
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
 * The board-change nudge (anton-h32k): a debounced `board-picker` pass whenever a repo's board
 * moves, so the recorded plan trails the board by seconds rather than by the ten-minute cadence
 * that stays behind it as the backstop.
 *
 * Enqueued through the RUNNER's `enqueueScheduledTypeIfAbsent`, not the bare `enqueue()` — a project
 * mid-teardown is refused by the same quiesce barrier every other enqueue path crosses (a nudge
 * racing `deleteProject` must not insert a job row the abort sweep has already been past), and a
 * scheduler tick or a manual "Run now" fire landing between the nudge's own `queuedJobId` check and
 * this insert can't double-fire the pass (PR #264 review) — the check and insert here are ONE
 * transaction. `coveredBy: ["queued"]` preserves the nudge's own semantics: a `running` pass may
 * have read the board before this change landed, so it must not count as covering it (see
 * `BoardPickerNudge.pass`'s doc comment). The payload carries `scheduleId` when the nudge resolved
 * one (PR #264 review), matching the shape `runScheduleNow`/the scheduler both stamp — without it
 * the job was invisible to `pendingRunsBySchedule`/`lastRunsBySchedule` (both keyed on that field)
 * while still counting against `runScheduleNow`'s own "already-running" check, leaving the Automation
 * table's Run now button enabled through a 409 the nudge itself was causing. `scheduleId` is ALSO
 * passed as its own option (PR #264 review), not just folded into the payload: it makes
 * `enqueueScheduledTypeIfAbsent` stamp `schedules.lastRunAt` in the same transaction as the insert,
 * the way `runScheduleNow`/the scheduler both do — without that stamp a first-ever nudge fire would
 * still read "never" in the Automation table, and a later one would date itself against a stale
 * `lastRunAt` from whatever fire last used the scheduler/Run now paths.
 */
export function getPickerNudge(): BoardPickerNudge {
  const s = state();
  if (s.pickerNudge) return s.pickerNudge;
  s.pickerNudge = new BoardPickerNudge({
    db: getDb(),
    enqueue: (projectId, scheduleId) =>
      Promise.resolve(
        getRunner().enqueueScheduledTypeIfAbsent(
          "board-picker",
          projectId,
          scheduleId ? { projectId, scheduleId } : { projectId },
          { coveredBy: ["queued"], scheduleId },
        ),
      ),
    log,
  });
  return s.pickerNudge;
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
  getPickerNudge().start();
  startSyncEngine();
}
