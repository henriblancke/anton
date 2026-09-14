/**
 * Shared harness for the `runner.*.test.ts` suites (anton-tart). The runner's durability contract is
 * wide enough that its cases live in sibling files by concern — lifecycle, dispatch, burn sampling,
 * budget governor — and every one of them needs the same three things: a fresh in-memory anton.db
 * per case, a clock the test drives rather than waits on, and a `JobRunner` wired onto both.
 *
 * {@link useRunnerHarness} installs its own `beforeEach`/`afterEach`, so a suite declares it once at
 * the top of its `describe` and the setup exists in exactly one place — the split files share this
 * rather than each carrying a copy that drifts.
 *
 * Test-only.
 */
import { afterEach, beforeEach } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import type { ClaudeUsage } from "../claude/usage";
import type { Clock, JobType } from "./queue";
import {
  DEFAULT_CONFIG,
  JobRunner,
  type JobHandler,
  type RunnerConfig,
} from "./runner";
import { insertProject } from "@/lib/testing/project";

/** Fixed start-of-test wall clock, so every suite reads its deadlines off the same epoch. */
export const BASE_TIME_MS = 1_700_000_000_000;

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
  set(ms: number) {
    this.t = ms;
  }
}

/** Tight, deterministic timings — every suite's baseline config, overridable per case. */
export const CONFIG: RunnerConfig = {
  ...DEFAULT_CONFIG,
  leaseMs: 10_000,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  quotaCooloffMs: 30 * 60_000,
  maxConcurrent: 2,
  tickMs: 1_000,
};

type RunnerDeps = ConstructorParameters<typeof JobRunner>[0];

export interface MakeRunnerOptions extends Omit<RunnerDeps, "db" | "clock" | "config"> {
  /** One handler per job type the case enqueues. */
  handlers: Partial<Record<JobType, JobHandler>>;
  /** Merged over {@link CONFIG}. */
  config?: Partial<RunnerConfig>;
}

export interface RunnerHarness {
  readonly tdb: TestDb;
  readonly db: TestDb["db"];
  readonly clock: FakeClock;
  /** A runner on this case's db + clock, with every dependency injectable. */
  makeRunner(opts: MakeRunnerOptions): JobRunner;
  /** The common shape: one execute-epic handler on {@link CONFIG}. */
  runner(handler: JobHandler, config?: Partial<RunnerConfig>): JobRunner;
  /** Seed project rows so `jobs.project_id` FKs resolve when a case scopes jobs to a project. */
  seedProjects(...ids: string[]): void;
}

/**
 * Per-case db + clock, and the runner builders on top of them. Call once inside a `describe`.
 */
export function useRunnerHarness(): RunnerHarness {
  let tdb: TestDb;
  let clock: FakeClock;

  beforeEach(() => {
    tdb = makeTestDb();
    clock = new FakeClock(BASE_TIME_MS);
  });
  afterEach(() => tdb.close());

  const makeRunner = ({ handlers, config, ...deps }: MakeRunnerOptions): JobRunner => {
    const r = new JobRunner({ db: tdb.db, clock, config: { ...CONFIG, ...config }, ...deps });
    for (const [type, handler] of Object.entries(handlers)) {
      if (handler) r.registerHandler(type as JobType, handler);
    }
    return r;
  };

  return {
    get tdb() {
      return tdb;
    },
    get db() {
      return tdb.db;
    },
    get clock() {
      return clock;
    },
    makeRunner,
    runner: (handler, config) => makeRunner({ handlers: { "execute-epic": handler }, config }),
    seedProjects: (...ids) => {
      for (const id of ids) {
        insertProject(tdb.db, { id, slug: id.toLowerCase(), name: id, repoPath: `/tmp/${id}` });
      }
    },
  };
}

/** A usage snapshot at a comfortable baseline; override only the field the case is about. */
export const usage = (over: Partial<ClaudeUsage> = {}): ClaudeUsage => ({
  sessionPct: 10,
  weeklyPct: 0,
  sessionResetAt: null,
  weeklyResetAt: null,
  plan: "max",
  ...over,
});

/** Poll `pred` on real timers until it holds (used with in-flight jobs the FakeClock can't drive). */
export async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  { timeoutMs = 1_000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
