/**
 * The process-wide job runner singleton (anton-dzh.1/.4). Constructed once over the shared
 * anton.db, with every job handler registered. Started from `src/instrumentation.ts` on server
 * boot; API routes enqueue through it. See DESIGN.md §4.
 */
import { getDb } from "../db";
import { makeExecuteEpicHandler } from "./execute-epic";
import { JobRunner, type RunnerLogger } from "./runner";
import { systemClock } from "./queue";

const log: RunnerLogger = {
  info: (msg, meta) => console.log(`[jobs] ${msg}`, meta ?? ""),
  error: (msg, meta) => console.error(`[jobs] ${msg}`, meta ?? ""),
};

let _runner: JobRunner | null = null;

export function getRunner(): JobRunner {
  if (_runner) return _runner;
  const db = getDb();
  const runner = new JobRunner({ db, clock: systemClock, log });
  runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db }));
  // Future job types (review-fix / nightly-stringer / orphan-grooming) register here.
  _runner = runner;
  return runner;
}

/** Idempotent: starts the background loop. Call once at server boot. */
export function startRunner(): void {
  getRunner().start();
}

/** Enqueue an execute-epic job for an approved epic. Returns the job id. */
export function enqueueExecuteEpic(projectId: string, epicBeadId: string): Promise<string> {
  return getRunner().enqueue({
    type: "execute-epic",
    projectId,
    payload: { projectId, epicBeadId },
  });
}
