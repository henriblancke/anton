/**
 * Test-only: drive ONE job through a REAL `JobRunner`, end to end.
 *
 * Every job suite — unit and integration — repeats the same five-line arrange block: build a
 * runner, register the one handler under test, enqueue, `tickOnce()`, `whenIdle()`. `driveJob`
 * is that block, once, so a suite says *what* it drives and asserts only on the outcome.
 *
 * This lives beside `integration.ts` rather than inside it on purpose: `integration.ts` probes
 * `bd`/`git` with `execFileSync` at import time (for `describeBd`), a cost unit suites like
 * `runner.test.ts` should not pay just to reach this helper.
 */
import { expect } from "vitest";
import type { AntonDb, Clock, JobType } from "@/lib/jobs/queue";
import { JobRunner, type JobHandler, type RunnerConfig } from "@/lib/jobs/runner";

export interface DriveJobOptions {
  db: AntonDb;
  clock: Clock;
  /** The single job type registered on the runner — also the type enqueued. */
  type: JobType;
  /** Handler factory, handed the same `{ db, clock }` the runner itself runs on. */
  handler: (deps: { db: AntonDb; clock: Clock }) => JobHandler;
  projectId?: string;
  /** Defaults to `{ projectId }`, the payload every project-scoped job takes. */
  payload?: unknown;
  /** Merged over `{ maxConcurrent: 1 }` — e.g. `leaseMs`, `quotaCooloffMs`. */
  config?: Partial<RunnerConfig>;
}

/**
 * Build a one-handler runner without driving it — for suites that must hold the runner across
 * several ticks (a clock jump, a park-then-resume) and so cannot use `driveJob`'s single-tick
 * shape. `driveJob` is this plus enqueue/tick/settle.
 */
export function makeJobRunner(
  opts: Pick<DriveJobOptions, "db" | "clock" | "type" | "handler" | "config">,
): JobRunner {
  const { db, clock, type, handler, config } = opts;

  const runner = new JobRunner({ db, clock, config: { maxConcurrent: 1, ...config } });
  runner.registerHandler(type, handler({ db, clock }));
  return runner;
}

/**
 * Enqueue one job, run exactly one tick, and wait for it to settle. Returns the job id so the
 * caller can assert on the persisted row (`getJob`).
 *
 * Asserts the tick leased exactly one job — driving a second, leftover job would silently change
 * what the caller's assertions are actually measuring.
 */
export async function driveJob(opts: DriveJobOptions): Promise<string> {
  const { type, projectId, payload } = opts;

  const runner = makeJobRunner(opts);

  const jobId = await runner.enqueue({ type, projectId, payload: payload ?? { projectId } });
  expect(await runner.tickOnce()).toBe(1);
  await runner.whenIdle();

  return jobId;
}
