/**
 * The per-project weekly spend estimate (R6.1/R6.3) — the meter the share governor holds a project
 * against. Two properties carry it, and both are about what the estimate must NOT do: it must not
 * let a failing project run free (every attempt burned quota, not just the ones that finished), and
 * it must not charge one project at another's measured rate.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { recordBurnSample } from "./burn";
import * as schema from "./db/schema";
import { makeTestDb, type TestDb } from "./db/testing";
import { chargeSpentAttempt, leaseDue, reschedule, resumeJob, type Clock } from "./jobs/queue";
import { projectWeeklySpendPct, quotaShareProjects, weeklyWindowStart } from "./quota-spend";
import { insertProject } from "@/lib/testing/project";
import type { ClaudeUsage } from "./claude/usage";
import type { ProjectSettings } from "./projects";

const routerUsageForTest = new Map<string, ClaudeUsage | null>();
let accountUsageReads = 0;
vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return { ...actual, getDb: () => tdb.db };
});
vi.mock("./projects", async () => {
  const actual = await vi.importActual<typeof import("./projects")>("./projects");
  return { ...actual, listProjects: async () => actual.listProjects() };
});
vi.mock("./claude/usage", async () => {
  const actual = await vi.importActual<typeof import("./claude/usage")>("./claude/usage");
  return {
    ...actual,
    getClaudeUsageCached: async () => {
      accountUsageReads += 1;
      return usage();
    },
  };
});
vi.mock("./claude/router-usage", async () => {
  const actual = await vi.importActual<typeof import("./claude/router-usage")>("./claude/router-usage");
  return {
    ...actual,
    getRouterUsageCached: async (settings: ProjectSettings) =>
      routerUsageForTest.get(`${settings.routerConnectionId ?? ""}:${settings.claudeAuthTokenEnv ?? ""}`) ??
      routerUsageForTest.get(settings.routerConnectionId ?? "") ??
      null,
  };
});
vi.mock("./quota-eligibility", async () => {
  const actual = await vi.importActual<typeof import("./quota-eligibility")>("./quota-eligibility");
  return { ...actual, observedWorkEligibility: async () => new Map<string, boolean | null>() };
});

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
  routerUsageForTest.clear();
  accountUsageReads = 0;
});
afterEach(() => tdb.close());

/** One job row inside the window, with one immutable ledger entry for each Claude reach. */
async function seedJob(
  projectId: string,
  opts: { status: string; attempts: number; type?: string; id?: string; meterKey?: string },
): Promise<string> {
  const id = opts.id ?? `${projectId}-${opts.status}-${opts.attempts}-${Math.random()}`;
  const type = opts.type ?? "execute-epic";
  const meterKey = opts.meterKey ?? "anthropic";
  await tdb.db.insert(schema.jobs).values({
    id,
    type,
    projectId,
    status: opts.status,
    runAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW - 60_000),
    attempts: opts.attempts,
    spentAttempts: opts.attempts,
  });
  for (let i = 0; i < opts.attempts; i++) {
    await tdb.db.insert(schema.quotaAttempts).values({
      id: `${id}-attempt-${i}`,
      jobId: id,
      projectId,
      jobType: type,
      meterKey,
      createdAt: new Date(NOW - 60_000),
    });
  }
  return id;
}

/** A full sample window for one project, so its rate is measured (`seeded: false`) rather than the tier seed. */
async function seedSamples(
  projectId: string | null,
  weeklyDelta: number,
  meterKey: string = "anthropic",
): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await recordBurnSample(tdb.db, clock, "execute-epic", projectId, {
      sessionDelta: 20,
      weeklyDelta,
    }, meterKey);
  }
}

async function setSettings(projectId: string, settings: ProjectSettings): Promise<void> {
  await tdb.db
    .update(schema.projects)
    .set({ settingsJson: JSON.stringify(settings) })
    .where(eq(schema.projects.id, projectId));
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

  it("charges an attempt when it reaches Claude, never at the lease (PR #248 review)", async () => {
    // A lease is not evidence of spend: a preflight can exit — or the process can die — before Claude
    // is ever invoked. A charge taken at the lease needed a refund on every such exit, and a crash
    // in that window (no settle, so no refund) left it on the row for the reclaim to charge AGAIN.
    // So the meter moves only when the handler reports the spawn, and a lease that never gets there
    // costs nothing however many times it is reclaimed.
    const p = insertProject(tdb.db, { id: "L", slug: "l", name: "L", repoPath: "/tmp/L" });
    await seedSamples(p, 2);
    await seedJob(p, { status: "queued", attempts: 0, id: "due" });

    const [leased] = await leaseDue(tdb.db, clock, { leaseMs: 30_000, limit: 1 });
    expect(leased?.id).toBe("due");
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBeNull();

    // The process dies in preflight: the lease lapses and the reclaim leases it again. No spend.
    await leaseDue(tdb.db, { now: () => NOW + 60_000 }, { leaseMs: 30_000, limit: 1 });
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBeNull();

    // This attempt reaches Claude: charged at the spawn, and a quota hit that refunds the RETRY
    // budget keeps the charge — Claude was reached, and a multi-call handler may have finished real
    // work before the wall.
    await chargeSpentAttempt(tdb.db, leased!, "anthropic", clock);
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBe(2);
    await reschedule(tdb.db, clock, "due", NOW + 120_000, { refundAttempt: true });
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBe(2);

    // A later attempt that exits in preflight (lease held elsewhere) was never charged.
    await leaseDue(tdb.db, { now: () => NOW + 120_000 }, { leaseMs: 30_000, limit: 1 });
    await reschedule(tdb.db, clock, "due", NOW + 180_000, { refundAttempt: true });
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBe(2);
  });

  it("counts only attempts inside the quota week", async () => {
    const p = insertProject(tdb.db, { id: "W", slug: "w", name: "W", repoPath: "/tmp/W" });
    await seedSamples(p, 2);
    const before = weeklyWindowStart(usage(), NOW) - 60_000;
    const id = await seedJob(p, { status: "done", attempts: 1, id: "stale" });
    await tdb.db
      .update(schema.quotaAttempts)
      .set({ createdAt: new Date(before) })
      .where(eq(schema.quotaAttempts.jobId, id));

    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW)).toBeNull();
  });

  it("does not price history from a former meter in the project's current meter", async () => {
    const p = insertProject(tdb.db, { id: "M", slug: "m", name: "M", repoPath: "/tmp/M" });
    const oldMeter = "router:https://router.example/api/usage/old";
    const currentMeter = "router:https://router.example/api/usage/current";
    await seedSamples(p, 9, oldMeter);
    await seedJob(p, { status: "done", attempts: 2, meterKey: oldMeter });
    await seedSamples(p, 2, currentMeter);
    await seedJob(p, { status: "done", attempts: 1, meterKey: currentMeter });

    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW, currentMeter)).toBe(2);
    expect(await projectWeeklySpendPct(tdb.db, p, usage(), NOW, oldMeter)).toBe(18);
  });
});

describe("quotaShareProjects", () => {
  it("keeps mixed account and router history in each project's current meter window", async () => {
    const account = insertProject(tdb.db, { id: "account", slug: "account", name: "Account", repoPath: "/tmp/account" });
    const routerA = insertProject(tdb.db, { id: "router-a", slug: "router-a", name: "Router A", repoPath: "/tmp/router-a" });
    const routerB = insertProject(tdb.db, { id: "router-b", slug: "router-b", name: "Router B", repoPath: "/tmp/router-b" });
    const routerSettings = (connectionId: string): ProjectSettings => ({
      budgetAware: true,
      claudeBaseUrl: "https://router.example/v1",
      claudeAuthTokenEnv: "ROUTER_TOKEN",
      routerConnectionId: connectionId,
    });
    await setSettings(account, { budgetAware: true });
    await setSettings(routerA, routerSettings("conn-a"));
    await setSettings(routerB, routerSettings("conn-b"));

    const resetSoon = new Date(NOW + 2 * 24 * 60 * 60 * 1000).toISOString();
    const resetLate = new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString();
    routerUsageForTest.set("conn-a", { ...usage(), weeklyResetAt: resetSoon });
    routerUsageForTest.set("conn-b", { ...usage(), weeklyResetAt: resetLate });

    const meterA = "router:https://router.example/api/usage/conn-a";
    const meterB = "router:https://router.example/api/usage/conn-b";
    await seedSamples(account, 1);
    await seedSamples(routerA, 2, meterA);
    await seedSamples(routerB, 4, meterB);
    await seedJob(account, { status: "done", attempts: 2 });
    await seedJob(routerA, { status: "done", attempts: 3, meterKey: meterA });
    await seedJob(routerB, { status: "done", attempts: 1, meterKey: meterB });
    // Router A's window starts five days ago, while router B's starts one day ago. The prior A
    // attempt belongs in A's independently reset window and must not affect another meter's pool.
    const oldRouterA = await seedJob(routerA, {
      status: "done",
      attempts: 5,
      meterKey: meterA,
      id: "old-router-a",
    });
    await tdb.db
      .update(schema.quotaAttempts)
      .set({ createdAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.quotaAttempts.jobId, oldRouterA));

    const shares = await quotaShareProjects(NOW);
    expect(shares).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: account, meterKey: "anthropic", spentWeeklyPct: 2 }),
        expect.objectContaining({ id: routerA, meterKey: meterA, spentWeeklyPct: 16 }),
        expect.objectContaining({ id: routerB, meterKey: meterB, spentWeeklyPct: 4 }),
      ]),
    );
  });

  it("keeps a successful weekly reset for a shared meter when another project's credential fails", async () => {
    const valid = insertProject(tdb.db, { id: "valid", slug: "valid", name: "Valid", repoPath: "/tmp/valid" });
    const rejected = insertProject(tdb.db, { id: "rejected", slug: "rejected", name: "Rejected", repoPath: "/tmp/rejected" });
    const settings = (tokenEnv: string): ProjectSettings => ({
      budgetAware: true,
      claudeBaseUrl: "https://router.example/v1",
      claudeAuthTokenEnv: tokenEnv,
      routerConnectionId: "shared",
    });
    await setSettings(valid, settings("VALID_ROUTER_TOKEN"));
    await setSettings(rejected, settings("REJECTED_ROUTER_TOKEN"));

    const meter = "router:https://router.example/api/usage/shared";
    routerUsageForTest.set("shared:VALID_ROUTER_TOKEN", {
      ...usage(),
      weeklyResetAt: new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString(),
    });
    routerUsageForTest.set("shared:REJECTED_ROUTER_TOKEN", null);
    await seedSamples(valid, 2, meter);
    await seedSamples(rejected, 2, meter);
    const stale = await seedJob(valid, { status: "done", attempts: 1, meterKey: meter, id: "stale" });
    await seedJob(valid, { status: "done", attempts: 1, meterKey: meter });
    await seedJob(rejected, { status: "done", attempts: 1, meterKey: meter });
    await tdb.db
      .update(schema.quotaAttempts)
      .set({ createdAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.quotaAttempts.jobId, stale));

    const shares = await quotaShareProjects(NOW);

    expect(shares).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: valid, spentWeeklyPct: 2 }),
      expect.objectContaining({ id: rejected, spentWeeklyPct: 2 }),
    ]));
  });

  it("does not read Anthropic usage for a router-only board", async () => {
    const first = insertProject(tdb.db, { id: "router-a", slug: "router-a", name: "Router A", repoPath: "/tmp/router-a" });
    const second = insertProject(tdb.db, { id: "router-b", slug: "router-b", name: "Router B", repoPath: "/tmp/router-b" });
    const routerSettings = (connectionId: string): ProjectSettings => ({
      budgetAware: true,
      claudeBaseUrl: "https://router.example/v1",
      claudeAuthTokenEnv: "ROUTER_TOKEN",
      routerConnectionId: connectionId,
    });
    await setSettings(first, routerSettings("conn-a"));
    await setSettings(second, routerSettings("conn-b"));
    routerUsageForTest.set("conn-a", usage());
    routerUsageForTest.set("conn-b", usage());

    await quotaShareProjects(NOW);

    expect(accountUsageReads).toBe(0);
  });

  it("splits default shares only among projects on the same meter", async () => {
    const first = insertProject(tdb.db, { id: "router-a", slug: "router-a", name: "Router A", repoPath: "/tmp/router-a" });
    const second = insertProject(tdb.db, { id: "router-b", slug: "router-b", name: "Router B", repoPath: "/tmp/router-b" });
    const other = insertProject(tdb.db, { id: "router-c", slug: "router-c", name: "Router C", repoPath: "/tmp/router-c" });
    const routerSettings = (connectionId: string): ProjectSettings => ({
      budgetAware: true,
      claudeBaseUrl: "https://router.example/v1",
      claudeAuthTokenEnv: "ROUTER_TOKEN",
      routerConnectionId: connectionId,
    });
    await setSettings(first, routerSettings("shared"));
    await setSettings(second, routerSettings("shared"));
    await setSettings(other, routerSettings("other"));
    routerUsageForTest.set("shared", usage());
    routerUsageForTest.set("other", usage());

    const shares = await quotaShareProjects(NOW);

    expect(shares).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first, sharePct: 50 }),
        expect.objectContaining({ id: second, sharePct: 50 }),
        expect.objectContaining({ id: other, sharePct: 100 }),
      ]),
    );
  });
});
