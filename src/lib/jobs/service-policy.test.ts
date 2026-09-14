/**
 * The budget-policy resolution seam (anton-81x2 / R6.1).
 *
 * The claim under test is that the one place deciding whether a project is governed is also the
 * place deciding how much of this machine's single weekly Claude quota it may spend — so an
 * ungoverned project carries no share, and a governed one cannot escape its own.
 *
 * The share lands in `projectWeeklyCapPct`, a ceiling on the project's OWN attributed spend, and
 * never touches `weeklyTargetPct`: that one is measured against the account-wide meter every repo
 * here moves, so shrinking it per share would stop the whole machine at one repo's cut.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { insertProject } from "@/lib/testing/project";
import { DEFAULT_PROJECT_BUDGET_POLICY, type ProjectSettings } from "@/lib/projects";
import type { UsageSnapshot } from "@/lib/usage";

let tdb: TestDb;
vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));

/** Swap in router reads for resolver cases; null routes to the real (network) function. */
type GetRouterUsageCached = typeof import("../claude/router-usage").getRouterUsageCached;
type GetRouterUsageFresh = typeof import("../claude/router-usage").getRouterUsageFresh;
let routerUsageOverride: GetRouterUsageCached | null = null;
let routerUsageFreshOverride: GetRouterUsageFresh | null = null;
vi.mock("../claude/router-usage", async () => {
  const actual = await vi.importActual<typeof import("../claude/router-usage")>(
    "../claude/router-usage",
  );
  return {
    ...actual,
    getRouterUsageCached: ((...args: Parameters<GetRouterUsageCached>) =>
      routerUsageOverride
        ? routerUsageOverride(...args)
        : actual.getRouterUsageCached(...args)) satisfies GetRouterUsageCached,
    getRouterUsageFresh: ((...args: Parameters<GetRouterUsageFresh>) =>
      routerUsageFreshOverride
        ? routerUsageFreshOverride(...args)
        : actual.getRouterUsageFresh(...args)) satisfies GetRouterUsageFresh,
  };
});

const {
  resolveBudgetPolicy,
  resolveProjectGovernor,
  resolveProjectMeterKey,
  resolveProjectSpend,
  resolveProjectUsage,
  resolveProjectUsageFresh,
} = await import("./service-policy");

/** The shipped weekly ceiling a share is a cut OF. */
const TARGET = DEFAULT_PROJECT_BUDGET_POLICY.weeklyTargetPct;
const ACCOUNT_SNAPSHOT = { meterKey: "anthropic", usage: null };

function project(id: string, settings: ProjectSettings): string {
  return insertProject(tdb.db, {
    id,
    slug: id,
    name: id,
    repoPath: `/tmp/${id}`,
    settingsJson: JSON.stringify(settings),
  });
}

const armed = (extra: ProjectSettings = {}): ProjectSettings => ({ budgetAware: true, ...extra });

/** What the picker pass leaves behind: a plan whose target count is the project's eligibility. */
function plan(projectId: string, targetCount: number): void {
  tdb.db
    .insert(schema.boardPickerPlans)
    .values({ projectId, boardDigest: "d", boardObservedAtMs: 1, targetCount })
    .onConflictDoUpdate({ target: schema.boardPickerPlans.projectId, set: { targetCount } })
    .run();
}

describe("resolveBudgetPolicy (quota share)", () => {
  beforeEach(() => {
    tdb = makeTestDb();
  });
  afterEach(() => {
    tdb.close();
    vi.restoreAllMocks();
  });

  it("leaves a project with budget-aware execution off ungoverned", async () => {
    project("off", {});
    project("armed", armed());

    // Null is "not governed": the runner never defers it and never reads usage for it, so there is
    // nothing for a share to scale.
    expect(await resolveBudgetPolicy("off")).toBeNull();
    expect(await resolveBudgetPolicy(undefined)).toBeNull();
  });

  it("defaults to an equal split across the projects with autopilot armed", async () => {
    project("a", armed());
    project("b", armed());

    expect((await resolveBudgetPolicy("a"))?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
    expect((await resolveBudgetPolicy("b"))?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
  });

  it("partitions default quota shares across independent meters", async () => {
    project("account", armed());
    project(
      "router",
      armed({
        claudeBaseUrl: "https://router.example/v1",
        claudeAuthTokenEnv: "ROUTER_TOKEN",
        routerConnectionId: "conn_1",
      }),
    );

    // Each project is the only governed consumer of its own meter, so neither loses half its quota.
    expect((await resolveBudgetPolicy("account"))?.projectWeeklyCapPct).toBe(TARGET);
    expect((await resolveBudgetPolicy("router"))?.projectWeeklyCapPct).toBe(TARGET);
  });

  it("splits quota shares only among projects using the same router connection", async () => {
    const connection = {
      claudeBaseUrl: "https://router.example/v1",
      claudeAuthTokenEnv: "ROUTER_TOKEN",
      routerConnectionId: "conn_1",
    };
    project("a", armed(connection));
    project("b", armed(connection));
    project("other", armed({ ...connection, routerConnectionId: "conn_2" }));

    expect((await resolveBudgetPolicy("a"))?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
    expect((await resolveBudgetPolicy("b"))?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
    expect((await resolveBudgetPolicy("other"))?.projectWeeklyCapPct).toBe(TARGET);
  });

  it("keeps an ungoverned project out of the denominator", async () => {
    project("a", armed());
    project("off", {});

    // Counting the unpaced project would shrink the paced one's cut to fund a repo no share binds.
    expect((await resolveBudgetPolicy("a"))?.projectWeeklyCapPct).toBe(TARGET);
  });

  it("cuts the weekly target by a declared share", async () => {
    project("a", armed({ quotaSharePct: 70 }));
    project("b", armed({ quotaSharePct: 30 }));

    expect((await resolveBudgetPolicy("a"))?.projectWeeklyCapPct).toBeCloseTo(TARGET * 0.7, 6);
    expect((await resolveBudgetPolicy("b"))?.projectWeeklyCapPct).toBeCloseTo(TARGET * 0.3, 6);
  });

  it("leaves the machine-wide target whole on every share", async () => {
    project("a", armed({ quotaSharePct: 70 }));
    project("b", armed({ quotaSharePct: 30 }));

    // Shrinking this would gate the SHARED account meter at one project's cut, so both projects
    // would defer at 30% global usage and 60 points of the operator's target would be unspendable
    // every week — the opposite of idle-fill (anton-ld7j).
    expect((await resolveBudgetPolicy("a"))?.weeklyTargetPct).toBe(TARGET);
    expect((await resolveBudgetPolicy("b"))?.weeklyTargetPct).toBe(TARGET);
  });

  it("cuts the operator's own weekly target, not the shipped default", async () => {
    project("a", armed({ quotaSharePct: 50, budgetPolicy: { weeklyTargetPct: 50 } }));
    project("b", armed({ quotaSharePct: 50 }));

    // The share is a cut of what this project targets — the two knobs compose, they don't compete.
    expect((await resolveBudgetPolicy("a"))?.projectWeeklyCapPct).toBe(25);
  });

  it("parks a project that declared a 0% share instead of unpacing it", async () => {
    project("a", armed({ quotaSharePct: 0 }));
    project("b", armed({ quotaSharePct: 100 }));

    // A zero ceiling defers at the weekly cap; a "no weekly signal" reading of 0 would do the
    // opposite and let the parked repo run entirely unpaced.
    expect((await resolveBudgetPolicy("a"))?.projectWeeklyCapPct).toBe(0);
    expect((await resolveBudgetPolicy("b"))?.projectWeeklyCapPct).toBe(TARGET);
  });

  it("holds the declared split when no picker pass has observed anybody", async () => {
    project("a", armed({ quotaSharePct: 60 }));
    project("b", armed({ quotaSharePct: 40 }));

    // board-picker ships disabled, so this is the ordinary machine. Renormalizing on the silence
    // would hand every project the whole quota and take the split out of force entirely.
    expect((await resolveBudgetPolicy("a"))?.projectWeeklyCapPct).toBeCloseTo(TARGET * 0.6, 6);
    expect((await resolveBudgetPolicy("b"))?.projectWeeklyCapPct).toBeCloseTo(TARGET * 0.4, 6);
  });

  it("renormalizes an idle project's share onto the projects that have work (R6.4)", async () => {
    project("busy", armed({ quotaSharePct: 50 }));
    project("idle", armed({ quotaSharePct: 50 }));
    plan("busy", 2);
    plan("idle", 0);

    // Quota that resets unused is wasted: the idle half is spendable by the repo that has work…
    expect((await resolveBudgetPolicy("busy"))?.projectWeeklyCapPct).toBe(TARGET);
    // …and the idle project keeps its own ceiling, because resolving one means it is asking to spend.
    expect((await resolveBudgetPolicy("idle"))?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
  });

  it("holds a reserved project's share out of the reallocation (R6.5)", async () => {
    project("busy", armed({ quotaSharePct: 50 }));
    project("quiet", armed({ quotaSharePct: 50, reserveQuotaShare: true }));
    plan("busy", 2);
    plan("quiet", 0);

    // The repo touched irregularly keeps its allocation, so the busy neighbour gains nothing.
    expect((await resolveBudgetPolicy("busy"))?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
  });

  it("gives the share back on the next pass, with no operator action", async () => {
    project("busy", armed({ quotaSharePct: 50 }));
    project("waking", armed({ quotaSharePct: 50 }));
    plan("busy", 2);
    plan("waking", 0);
    expect((await resolveBudgetPolicy("busy"))?.projectWeeklyCapPct).toBe(TARGET);

    // A repo that wakes up on Friday must not wait a week: the next pass recomputes the divisor.
    plan("waking", 1);

    expect((await resolveBudgetPolicy("busy"))?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
    expect((await resolveBudgetPolicy("waking"))?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
  });

  it("reads queued work as eligible, so reclaim does not wait for a picker pass", async () => {
    project("busy", armed({ quotaSharePct: 50 }));
    project("waking", armed({ quotaSharePct: 50 }));
    plan("busy", 2);
    plan("waking", 0);

    tdb.db
      .insert(schema.jobs)
      .values({
        id: randomUUID(),
        projectId: "waking",
        type: "execute-epic",
        status: "queued",
        payloadJson: "{}",
      })
      .run();

    expect((await resolveBudgetPolicy("busy"))?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
  });

  it("reads the share board ONCE for a whole concurrent governor pass", async () => {
    // A share is a fact about the board, so every governed project's policy needs the same three
    // reads. The governor resolves one policy per governed project on each 2s tick — resolving them
    // together must serve them all from a single board read rather than N identical ones (PR #248
    // review). Counted off the picker-plan query, which fires exactly once per board read.
    project("a", armed());
    project("b", armed());
    project("c", armed());
    const selects = vi.spyOn(tdb.db, "select");
    const boardReads = () =>
      selects.mock.calls.filter(
        ([columns]) => columns !== undefined && "targetCount" in columns,
      ).length;

    await Promise.all(["a", "b", "c"].map((id) => resolveBudgetPolicy(id)));
    expect(boardReads()).toBe(1);

    // Coalescing, not caching: a later pass reads fresh, so a waking repo reclaims its cut on it.
    selects.mockClear();
    for (const id of ["a", "b", "c"]) await resolveBudgetPolicy(id);
    expect(boardReads()).toBe(3);
  });

  it("fails open on an unreadable share board, like every other governor read", async () => {
    // The board read is coalesced across a whole governor pass, so one rejection would be shared by
    // every policy that pass resolves and error the whole tick. A DB hiccup must instead admit the
    // governed project at its full weekly target for that tick — an empty board, on which it is
    // ungoverned — and the next pass reads fresh.
    project("a", armed({ quotaSharePct: 30 }));
    project("b", armed({ quotaSharePct: 70 }));
    // Only the board's own project scan fails; the subject's settings read is untouched.
    const select = tdb.db.select.bind(tdb.db);
    const selects = vi.spyOn(tdb.db, "select").mockImplementation(((
      columns?: Record<string, unknown>,
    ) => {
      if (columns && "id" in columns && "settingsJson" in columns) throw new Error("db down");
      return select(columns as never);
    }) as typeof tdb.db.select);

    expect((await resolveBudgetPolicy("a"))?.projectWeeklyCapPct).toBe(TARGET);

    selects.mockRestore();
    expect((await resolveBudgetPolicy("a"))?.projectWeeklyCapPct).toBeCloseTo(TARGET * 0.3, 6);
  });

  it("says out loud when the declared shares do not sum to 100", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    project("a", armed({ quotaSharePct: 60 }));
    project("b", armed({ quotaSharePct: 60 }));

    const policy = await resolveBudgetPolicy("a");

    // Proportioned, so 120% of declarations still spends exactly the weekly target between them…
    expect(policy?.projectWeeklyCapPct).toBeCloseTo(TARGET / 2, 6);
    // …and the operator who declared 60 is told why their ceiling reads 50.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("total 120%, not 100%"));
  });

  it("does not repeat an imbalance it has already announced", async () => {
    project("a", armed({ quotaSharePct: 45 }));
    project("b", armed({ quotaSharePct: 45 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolveBudgetPolicy("a");
    expect(warn).toHaveBeenCalledTimes(1);

    // The runner resolves per project every tick; the warning tracks a change, not a heartbeat.
    warn.mockClear();
    await resolveBudgetPolicy("a");
    await resolveBudgetPolicy("b");

    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps imbalance announcement suppression separate for independent meters", async () => {
    const router = {
      claudeBaseUrl: "https://router.example/v1",
      claudeAuthTokenEnv: "ROUTER_TOKEN",
      routerConnectionId: "conn_1",
    };
    project("account-a", armed({ quotaSharePct: 44 }));
    project("account-b", armed({ quotaSharePct: 44 }));
    project("router-a", armed({ ...router, quotaSharePct: 55 }));
    project("router-b", armed({ ...router, quotaSharePct: 55 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveBudgetPolicy("account-a");
    await resolveBudgetPolicy("router-a");
    await resolveBudgetPolicy("account-b");
    await resolveBudgetPolicy("router-b");

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("total 88%, not 100%"),
      expect.stringContaining("total 110%, not 100%"),
    ]);
  });
});

/**
 * The meter the share is enforced ON (R6.1/R6.3). `usage.weeklyPct` is the whole account's, so the
 * governor needs a second, per-project reading — approximate by construction, and `null` rather
 * than 0 when nothing is attributable.
 */
describe("resolveProjectSpend", () => {
  beforeEach(() => {
    tdb = makeTestDb();
  });
  afterEach(() => {
    tdb.close();
    vi.restoreAllMocks();
  });

  /**
   * A Claude-burning job charged to `projectId` at its type's burn average — one unit per ATTEMPT,
   * whatever the attempt ended as (the runner samples burn for every outcome, not just success).
   */
  function burned(
    projectId: string | null,
    opts: { attempts?: number; meterKey?: string; status?: string } = {},
  ): void {
    const id = randomUUID();
    const attempts = opts.attempts ?? 1;
    tdb.db
      .insert(schema.jobs)
      .values({
        id,
        projectId,
        type: "execute-epic",
        status: opts.status ?? "done",
        payloadJson: "{}",
        attempts,
        spentAttempts: attempts,
        updatedAt: new Date(),
      })
      .run();
    if (!projectId) return;
    for (let attempt = 0; attempt < attempts; attempt++) {
      tdb.db.insert(schema.quotaAttempts).values({
        id: `${id}-${attempt}`,
        jobId: id,
        projectId,
        jobType: "execute-epic",
        meterKey: opts.meterKey ?? "anthropic",
        createdAt: new Date(),
      }).run();
    }
  }

  it("charges only the attempts this project made", async () => {
    project("mine", armed());
    project("theirs", armed());
    burned("mine");
    burned("mine");
    burned("theirs");

    // execute-epic's L-tier seed is 3 weekly points until real samples accrue.
    expect(await resolveProjectSpend("mine", ACCOUNT_SNAPSHOT)).toBeCloseTo(6, 6);
    expect(await resolveProjectSpend("theirs", ACCOUNT_SNAPSHOT)).toBeCloseTo(3, 6);
  });

  it("keeps spend in the snapshot meter when routing changes during a governor read", async () => {
    const oldSettings = {
      claudeBaseUrl: "https://old-router.example/v1",
      claudeAuthTokenEnv: "GW_TOKEN",
      routerConnectionId: "conn_1",
    };
    project("routed", oldSettings);
    routerUsageOverride = async () => null;
    const snapshot = await resolveProjectUsage("routed", async () => null);
    const oldMeterKey = "router:https://old-router.example/api/usage/conn_1";
    const newMeterKey = "router:https://new-router.example/api/usage/conn_1";
    burned("routed", { meterKey: oldMeterKey });
    burned("routed", { meterKey: newMeterKey });
    burned("routed", { meterKey: newMeterKey });
    await tdb.db
      .update(schema.projects)
      .set({
        settingsJson: JSON.stringify({
          ...oldSettings,
          claudeBaseUrl: "https://new-router.example/v1",
        }),
      })
      .where(eq(schema.projects.id, "routed"));

    // One old-meter attempt is attributed; the two new-meter attempts must never be mixed in.
    expect(await resolveProjectSpend("routed", snapshot)).toBeCloseTo(3, 6);
  });

  it("keeps a governor policy and meter paired when routing changes after resolution", async () => {
    const oldSettings = {
      budgetAware: true,
      quotaSharePct: 100,
      claudeBaseUrl: "https://old-router.example/v1",
      claudeAuthTokenEnv: "GW_TOKEN",
      routerConnectionId: "conn_1",
    };
    project("routed", oldSettings);
    routerUsageOverride = async () => ({
      sessionPct: 10,
      weeklyPct: 20,
      sessionResetAt: null,
      weeklyResetAt: null,
      plan: "router",
    });

    const governor = await resolveProjectGovernor("routed", async () => null);
    await tdb.db
      .update(schema.projects)
      .set({
        settingsJson: JSON.stringify({ ...oldSettings, claudeBaseUrl: "https://new-router.example/v1" }),
      })
      .where(eq(schema.projects.id, "routed"));

    expect(governor?.meterKey).toBe("router:https://old-router.example/api/usage/conn_1");
    expect(governor?.policy.projectWeeklyCapPct).toBe(TARGET);
  });

  it("charges an attempt that failed exactly like one that succeeded", async () => {
    // A project whose runs keep failing spends the account's quota all the same; a meter that
    // counted completions would let it run past its share reading zero.
    project("flaky", armed());
    burned("flaky", { status: "parked", attempts: 3 });

    expect(await resolveProjectSpend("flaky", ACCOUNT_SNAPSHOT)).toBeCloseTo(9, 6);
  });

  it("answers null — unattributed, never zero — when nothing is charged to it", async () => {
    project("quiet", armed());
    burned(null); // anton's own plumbing belongs to nobody's share
    burned("quiet", { status: "queued", attempts: 0 }); // enqueued, never dispatched

    expect(await resolveProjectSpend("quiet", ACCOUNT_SNAPSHOT)).toBeNull();
    expect(await resolveProjectSpend(null, ACCOUNT_SNAPSHOT)).toBeNull();
  });
});

describe("resolveProjectUsage (anton-gnvw)", () => {
  const ACCOUNT_USAGE = { sessionPct: 40, weeklyPct: 20, sessionResetAt: null, weeklyResetAt: null, plan: "max" };
  const ROUTER_USAGE = { sessionPct: 5, weeklyPct: 1, sessionResetAt: null, weeklyResetAt: null, plan: "Claude Code" };

  /**
   * The account meter as the governor passes it: a thunk, plus the call count. The count is the
   * assertion that matters for a routed project — "resolved off the router" and "never asked
   * Anthropic" are different claims, and only the second one is what routing buys.
   */
  function accountThunk(value: UsageSnapshot | null = ACCOUNT_USAGE) {
    let calls = 0;
    const read = async () => {
      calls += 1;
      return value;
    };
    return { read, calls: () => calls };
  }

  beforeEach(() => {
    tdb = makeTestDb();
    routerUsageOverride = null;
    routerUsageFreshOverride = null;
  });
  afterEach(() => {
    tdb.close();
    vi.restoreAllMocks();
  });

  it("reads the router for a routed project, never touching the account read", async () => {
    project("routed", {
      claudeBaseUrl: "https://gw.example.com",
      claudeAuthTokenEnv: "GW_TOKEN",
      routerConnectionId: "conn_1",
    });
    routerUsageOverride = async () => ROUTER_USAGE;
    const account = accountThunk();

    expect(await resolveProjectUsage("routed", account.read)).toEqual({
      meterKey: "router:https://gw.example.com/api/usage/conn_1",
      usage: ROUTER_USAGE,
    });
    expect(account.calls()).toBe(0); // the whole point of routing: no Anthropic request at all
  });

  it("uses the routed resolver for a fresh burn sample too", async () => {
    const settings = {
      claudeBaseUrl: "https://gw.example.com",
      claudeAuthTokenEnv: "GW_TOKEN",
      routerConnectionId: "conn_1",
    };
    project("routed", settings);
    routerUsageFreshOverride = async () => ROUTER_USAGE;
    const account = accountThunk();

    expect(
      await resolveProjectUsageFresh("routed", account.read, await resolveProjectMeterKey("routed")),
    ).toEqual(ROUTER_USAGE);
    expect(account.calls()).toBe(0);
  });

  it("skips a fresh sample when routing changes after the attempt starts", async () => {
    const oldSettings = {
      claudeBaseUrl: "https://old-router.example/v1",
      claudeAuthTokenEnv: "GW_TOKEN",
      routerConnectionId: "conn_1",
    };
    project("routed", oldSettings);
    const expectedMeterKey = await resolveProjectMeterKey("routed");
    await tdb.db
      .update(schema.projects)
      .set({
        settingsJson: JSON.stringify({
          ...oldSettings,
          claudeBaseUrl: "https://new-router.example/v1",
        }),
      })
      .where(eq(schema.projects.id, "routed"));
    const account = accountThunk();

    expect(await resolveProjectUsageFresh("routed", account.read, expectedMeterKey)).toBeNull();
    expect(account.calls()).toBe(0);
  });

  it("returns the account usage unchanged for an unrouted project — byte-identical to today", async () => {
    project("plain", {});
    const account = accountThunk();

    expect(await resolveProjectUsage("plain", account.read)).toEqual({
      meterKey: "anthropic",
      usage: ACCOUNT_USAGE,
    });
    expect(account.calls()).toBe(1);
  });

  it("uses the account meter when the shared meter-key resolver rejects an invalid route", async () => {
    project("invalid-route", {
      claudeBaseUrl: "not-a-url",
      claudeAuthTokenEnv: "GW_TOKEN",
      routerConnectionId: "conn_1",
    });
    const account = accountThunk();

    expect(await resolveProjectUsage("invalid-route", account.read)).toEqual({
      meterKey: "anthropic",
      usage: ACCOUNT_USAGE,
    });
    expect(account.calls()).toBe(1);
  });

  it("fails open to null when a routed project's router cannot be read", async () => {
    project("routed", {
      claudeBaseUrl: "https://gw.example.com",
      claudeAuthTokenEnv: "GW_TOKEN",
      routerConnectionId: "conn_1",
    });
    routerUsageOverride = async () => null; // unreadable: no creds, timeout, non-200, malformed body
    const account = accountThunk();

    expect(await resolveProjectUsage("routed", account.read)).toEqual({
      meterKey: "router:https://gw.example.com/api/usage/conn_1",
      usage: null,
    });
    // Fails open to null rather than silently borrowing the account meter, which is not its traffic.
    expect(account.calls()).toBe(0);
  });

  it("falls back to the account usage for a successfully read but missing project", async () => {
    // A missing row is an actual `{}` settings result, so it remains byte-identical to today's
    // unrouted behavior. A rejected settings read is distinct and must not borrow the account meter.
    const account = accountThunk();

    expect(await resolveProjectUsage("missing", account.read)).toEqual({
      meterKey: "anthropic",
      usage: ACCOUNT_USAGE,
    });
    expect(account.calls()).toBe(1);
  });

  it("fails open when the project's settings cannot be reread", async () => {
    project("routed", {
      claudeBaseUrl: "https://gw.example.com",
      claudeAuthTokenEnv: "GW_TOKEN",
      routerConnectionId: "conn_1",
    });
    const select = tdb.db.select.bind(tdb.db);
    const selects = vi.spyOn(tdb.db, "select").mockImplementation(((columns?: Record<string, unknown>) => {
      if (columns && "settingsJson" in columns) throw new Error("db read failed");
      return select(columns as never);
    }) as typeof tdb.db.select);
    const account = accountThunk();

    expect(await resolveProjectUsage("routed", account.read)).toEqual({
      meterKey: "anthropic",
      usage: null,
    });
    expect(account.calls()).toBe(0);

    selects.mockRestore();
  });

  it("returns the account usage unchanged for the null-project bucket", async () => {
    const account = accountThunk();

    expect(await resolveProjectUsage(null, account.read)).toEqual({
      meterKey: "anthropic",
      usage: ACCOUNT_USAGE,
    });
    expect(account.calls()).toBe(1);
  });
});
