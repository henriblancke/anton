/**
 * Test-only: drive ONE job through a REAL `JobRunner`, end to end — and assert on how it settled.
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
import {
  getJob,
  type AntonDb,
  type Clock,
  type JobRow,
  type JobStatus,
  type JobType,
} from "@/lib/jobs/queue";
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

  const runner = new JobRunner({ db, clock, config: { maxConcurrent: 1, ...config }, log: TEST_LOG });
  runner.registerHandler(type, handler({ db, clock }));
  return runner;
}

/**
 * The runner's own diagnostics, on stderr (anton-3dpp).
 *
 * Without a logger the runner falls back to `noopLog`, and the error it classified — the ONLY thing
 * that says why a job rescheduled or parked — is discarded at the moment it is known. A flake that
 * then reproduces once a month in CI leaves an assertion diff and nothing else; the classified cause
 * has to be re-derived from a run that no longer exists. Errors only: `info` would narrate every
 * tick of every suite.
 */
const TEST_LOG = {
  info: () => {},
  error: (msg: string, meta?: unknown) => console.error(`[runner] ${msg}`, meta ?? ""),
};

/**
 * Assert a driven job settled in `expected`, and return the row so a caller can go on asserting on
 * it.
 *
 * The reason it exists rather than `expect((await getJob(db, id))?.status).toBe(...)`: these suites
 * build the runner with no logger, so `noopLog` swallows the error the runner classified — and the
 * bare assertion then reports only `expected 'queued' to be 'done'`, with the actual failure (which
 * the row is holding in `lastError`) nowhere in the CI log. Attaching it costs nothing on the green
 * path and turns a red one into a single look.
 */
export async function expectJobStatus(
  db: AntonDb,
  jobId: string,
  expected: JobStatus,
): Promise<JobRow> {
  const job = await getJob(db, jobId);
  expect(
    job?.status,
    `job ${jobId} settled "${job?.status ?? "missing"}" after ${job?.attempts ?? 0} attempt(s): ` +
      `${job?.lastError ?? "no error recorded"}`,
  ).toBe(expected);
  return job as JobRow;
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
