/**
 * The process-wide job runner + scheduler singletons (anton-dzh/anton-3t2). Constructed once over
 * the shared anton.db, with every job handler registered and the cron scheduler wired in. Started
 * from `src/instrumentation.ts` on server boot; API routes enqueue through the runner. See DESIGN §4.
 */
import { getDb } from "../db";
import { makeExecuteEpicHandler } from "./execute-epic";
import { makeReviewFixHandler } from "./review-fix";
import { makeNightlyStringerHandler } from "./nightly-stringer";
import { makeOrphanGroomingHandler } from "./orphan-grooming";
import { JobRunner, type RunnerLogger } from "./runner";
import { Scheduler } from "./scheduler";
import { systemClock } from "./queue";

const log: RunnerLogger = {
  info: (msg, meta) => console.log(`[jobs] ${msg}`, meta ?? ""),
  error: (msg, meta) => console.error(`[jobs] ${msg}`, meta ?? ""),
};

let _runner: JobRunner | null = null;
let _scheduler: Scheduler | null = null;

export function getRunner(): JobRunner {
  if (_runner) return _runner;
  const db = getDb();
  const runner = new JobRunner({ db, clock: systemClock, log });
  runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db }));
  runner.registerHandler("review-fix", makeReviewFixHandler({ db }));
  runner.registerHandler("nightly-stringer", makeNightlyStringerHandler({ db }));
  runner.registerHandler("orphan-grooming", makeOrphanGroomingHandler({ db }));
  _runner = runner;
  return runner;
}

export function getScheduler(): Scheduler {
  if (_scheduler) return _scheduler;
  _scheduler = new Scheduler({ db: getDb(), clock: systemClock, log });
  return _scheduler;
}

/** Idempotent: starts the background runner loop + the cron scheduler. Call once at server boot. */
export function startRunner(): void {
  getRunner().start();
  getScheduler().start();
}

/** Enqueue an execute-epic job for an approved epic. Returns the job id. */
export function enqueueExecuteEpic(projectId: string, epicBeadId: string): Promise<string> {
  return getRunner().enqueue({
    type: "execute-epic",
    projectId,
    payload: { projectId, epicBeadId },
  });
}
