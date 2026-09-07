/**
 * The per-project weekly spend estimate (R6.1/R6.3) — the meter the share governor holds a project
 * against. Two properties carry it, and both are about what the estimate must NOT do: it must not
 * let a failing project run free (every attempt burned quota, not just the ones that finished), and
 * it must not charge one project at another's measured rate.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { recordBurnSample } from "./burn";
import * as schema from "./db/schema";
import { makeTestDb, type TestDb } from "./db/testing";
import { leaseDue, reschedule, resumeJob, type Clock } from "./jobs/queue";
import { projectWeeklySpendPct, weeklyWindowStart } from "./quota-spend";
import { insertProject } from "@/lib/testing/project";
import type { ClaudeUsage } from "./claude/usage";

const NOW = 1_700_000_000_000;
const clock: Clock = { now: () => NOW };

/** A meter whose week reset two days ago, so the window is unambiguous and not a trailing seven days. */
const usage = (): ClaudeUsage => ({
  sessionPct: 10,
  weeklyPct: 40,
  sessionResetAt: null,
  weeklyResetAt: new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString(),
  plan: "max",
});

let tdb: TestDb;

beforeEach(() => {
  tdb = makeTestDb();
});
afterEach(() => tdb.close());

/** One job row inside the window, with `attempts` leases already spent on it. */
async function seedJob(
  projectId: string,
  opts: { status: string; attempts: number; type?: string; id?: string },
): Promise<string> {
  const id = opts.id ?? `${projectId}-${opts.status}-${opts.attempts}-${Math.random()}`;
  await tdb.db.insert(schema.jobs).values({
    id,
    type: opts.type ?? "execute-epic",
    projectId,
    status: opts.status,
    runAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW - 60_000),
    attempts: opts.attempts,
    spentAttempts: opts.attempts,
  });
  return id;
}

/** A full sample window for one project, so its rate is measured (`seeded: false`) rather than the tier seed. */
async function seedSamples(projectId: string | null, weeklyDelta: number): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await recordBurnSample(tdb.db, clock, "execute-epic", projectId, {
      sessionDelta: 20,
      weeklyDelta,
    });
  }
}

describe("projectWeeklySpendPct", () => {
  it("charges every attempt, not only the jobs that finished (R6.1)", async () => {
    // A project whose runs keep failing burns the account's quota exactly as a successful one does.
    // Counting completions alone let it spend past its share with a meter reading zero.
    const failing = insertProject(tdb.db, { id: "F", slug: "f", name: "F", repoPath: "/tmp/F" });
    await seedSamples(failing, 2);
    await seedJob(failing, { status: "failed", attempts: 2 });
    await seedJob(failing, { status: "parked", attempts: 3 });

    expect(await projectWeeklySpendPct(tdb.db, failing, usage(), NOW)).toBe(10); // 5 attempts × 2%
  });

  it("charges a retried job once per attempt, not once per job", async () => {
    const p = insertProject(tdb.db, { id: "R", slug: "r", name: "R", repoPath: "/tmp/R" });
    await seedSamples(p, 2);
    await seedJob(p, { status: "done", attempts: 3 }); // failed twice, then succeeded

    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBe(6);
  });

  it("stays null for a project whose work has never been dispatched", async () => {
    // Unattributed is not zero: a queued job has burned nothing, and a job row alone is no evidence.
    const p = insertProject(tdb.db, { id: "Q", slug: "q", name: "Q", repoPath: "/tmp/Q" });
    await seedSamples(p, 2);
    await seedJob(p, { status: "queued", attempts: 0 });

    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBeNull();
  });

  it("charges a project at its OWN rate, never a neighbour's measured one", async () => {
    // A's runs are expensive and measured; B has never been sampled. Charging B at A's rate would
    // throttle it on spend it never made — B falls back to the type's tier seed instead.
    const a = insertProject(tdb.db, { id: "A", slug: "a", name: "A", repoPath: "/tmp/A" });
    const b = insertProject(tdb.db, { id: "B", slug: "b", name: "B", repoPath: "/tmp/B" });
    await seedSamples(a, 8);
    await seedJob(a, { status: "done", attempts: 1 });
    await seedJob(b, { status: "done", attempts: 1 });

    expect(await projectWeeklySpendPct(tdb.db, a, usage(), NOW)).toBe(8);
    // The L-tier seed (3%), not A's measured 8%.
    expect(await projectWeeklySpendPct(tdb.db, b, usage(), NOW)).toBe(3);
  });

  it("ignores a type that never invokes Claude", async () => {
    const p = insertProject(tdb.db, { id: "S", slug: "s", name: "S", repoPath: "/tmp/S" });
    await seedJob(p, { status: "done", attempts: 4, type: "sync-push" });

    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBeNull();
  });

  it("keeps charging a job's attempts after a resume renews its retry budget (PR #248 review)", async () => {
    // `resumeJob` zeroes `attempts` so the un-parked job gets a fresh run at maxAttempts. The three
    // runs that parked it still burned quota; a meter that forgot them on resume would let each
    // park/resume cycle spend the project's share again.
    const p = insertProject(tdb.db, { id: "P", slug: "p", name: "P", repoPath: "/tmp/P" });
    await seedSamples(p, 2);
    const parked = await seedJob(p, { status: "parked", attempts: 3, id: "parked" });
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBe(6);

    expect(await resumeJob(tdb.db, clock, parked)).toBe(true);
    const resumed = tdb.db.select().from(schema.jobs).where(eq(schema.jobs.id, parked)).get();
    expect(resumed?.attempts).toBe(0);

    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBe(6);
  });

  it("charges the attempt a lease starts, and hands back one a refund withdraws", async () => {
    // The lease is the moment quota starts burning, so the meter moves with it — a running job has
    // spent most of what it will. A refunded reschedule (quota gate, lease held elsewhere, no remote)
    // is an attempt that never reached Claude, so it comes back off the meter as it does off the
    // retry budget.
    const p = insertProject(tdb.db, { id: "L", slug: "l", name: "L", repoPath: "/tmp/L" });
    await seedSamples(p, 2);
    await seedJob(p, { status: "queued", attempts: 0, id: "due" });

    const [leased] = await leaseDue(tdb.db, clock, { leaseMs: 30_000, limit: 1 });
    expect(leased?.id).toBe("due");
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBe(2);

    await reschedule(tdb.db, clock, "due", NOW + 60_000);
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBe(2);

    await leaseDue(tdb.db, { now: () => NOW + 60_000 }, { leaseMs: 30_000, limit: 1 });
    await reschedule(tdb.db, clock, "due", NOW + 120_000, { refundAttempt: true });
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBe(2);
  });

  it("counts only attempts inside the quota week", async () => {
    const p = insertProject(tdb.db, { id: "W", slug: "w", name: "W", repoPath: "/tmp/W" });
    await seedSamples(p, 2);
    const before = weeklyWindowStart(usage(), NOW) - 60_000;
    await tdb.db.insert(schema.jobs).values({
      id: "stale",
      type: "execute-epic",
      projectId: p,
      status: "done",
      runAt: new Date(before),
      updatedAt: new Date(before),
      attempts: 9,
      spentAttempts: 9,
    });

    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBeNull();
  });
});
