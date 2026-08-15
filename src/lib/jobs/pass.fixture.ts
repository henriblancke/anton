/**
 * Shared fixture for the pass-step suites (gardener-hygiene, gardener-proposals,
 * product-master-steps): the two things every extracted step needs and neither should have to build
 * a job queue to get — a `JobContext` and a {@link PassScope}.
 *
 * The point of the split those steps came out of (anton-l4do) is that they run without a runner, so
 * the stand-ins here are deliberately dumb: the heartbeat counts, the signal is a real
 * `AbortController`'s, and the log collects. A suite that needs a REAL runner drives the handler
 * instead (gardener.test.ts, product-master.test.ts).
 *
 * Test-only.
 */
import { resolveProposalAutonomyPolicy } from "../gardener/autonomy";
import { MAX_APPLIES_PER_PASS } from "../gardener/emit";
import type { PassScope } from "./pass-preamble";
import type { Clock } from "./queue";
import type { JobContext } from "./runner";

export interface FakeJobContext extends JobContext {
  /** How many times the step under test extended its lease. */
  beats: number;
  /** Abort the step mid-flight, the way a cancelled job does. */
  abort: () => void;
  /** What the step reported as its live handle (anton-susu). */
  reported: Array<Record<string, unknown>>;
}

export function fakeJobContext(overrides: Partial<JobContext> = {}): FakeJobContext {
  const controller = new AbortController();
  const ctx: FakeJobContext = {
    jobId: "job-1",
    type: "gardener",
    payload: {},
    attempt: 1,
    beats: 0,
    reported: [],
    heartbeat: async () => {
      ctx.beats += 1;
    },
    signal: controller.signal,
    abort: () => controller.abort(),
    report: (info) => {
      ctx.reported.push(info as Record<string, unknown>);
    },
    ...overrides,
  };
  return ctx;
}

export interface FakeScope extends PassScope {
  ctx: FakeJobContext;
  /** Everything the pass wrote to its session log, in order. */
  logged: string[];
  /** Every project the pass asked to propagate a write for. */
  nudged: Array<{ id: string; repoPath: string }>;
}

/** A pass scope over `repo`, with the log and the nudge captured rather than performed. */
export function fakeScope(repo: string, overrides: Partial<PassScope> = {}): FakeScope {
  const ctx = (overrides.ctx as FakeJobContext) ?? fakeJobContext();
  const logged: string[] = [];
  const nudged: Array<{ id: string; repoPath: string }> = [];
  const clock: Clock = { now: () => 1_700_000_000_000 };
  return {
    project: { id: "project-1", repoPath: repo },
    slug: "sandbox",
    policy: resolveProposalAutonomyPolicy(undefined),
    // A first attempt: nothing of the write cap spent yet. A suite that wants a retry's budget
    // overrides it.
    applyBudget: MAX_APPLIES_PER_PASS,
    clock,
    nudge: (project) => nudged.push(project),
    log: async (chunk) => {
      logged.push(chunk);
    },
    ...overrides,
    ctx,
    logged,
    nudged,
  };
}
