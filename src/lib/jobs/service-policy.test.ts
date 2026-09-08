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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { insertProject } from "@/lib/testing/project";
import { DEFAULT_PROJECT_BUDGET_POLICY, type ProjectSettings } from "@/lib/projects";

let tdb: TestDb;
vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));

const { resolveBudgetPolicy, resolveProjectSpend } = await import("./service-policy");

/** The shipped weekly ceiling a share is a cut OF. */
const TARGET = DEFAULT_PROJECT_BUDGET_POLICY.weeklyTargetPct;

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
    opts: { attempts?: number; status?: string } = {},
  ): void {
    tdb.db
      .insert(schema.jobs)
      .values({
        id: randomUUID(),
        projectId,
        type: "execute-epic",
        status: opts.status ?? "done",
        payloadJson: "{}",
        attempts: opts.attempts ?? 1,
        spentAttempts: opts.attempts ?? 1,
        updatedAt: new Date(),
      })
      .run();
  }

  it("charges only the attempts this project made", async () => {
    project("mine", armed());
    project("theirs", armed());
    burned("mine");
    burned("mine");
    burned("theirs");

    // execute-epic's L-tier seed is 3 weekly points until real samples accrue.
    expect(await resolveProjectSpend("mine", null)).toBeCloseTo(6, 6);
    expect(await resolveProjectSpend("theirs", null)).toBeCloseTo(3, 6);
  });

  it("charges an attempt that failed exactly like one that succeeded", async () => {
    // A project whose runs keep failing spends the account's quota all the same; a meter that
    // counted completions would let it run past its share reading zero.
    project("flaky", armed());
    burned("flaky", { status: "parked", attempts: 3 });

    expect(await resolveProjectSpend("flaky", null)).toBeCloseTo(9, 6);
  });

  it("answers null — unattributed, never zero — when nothing is charged to it", async () => {
    project("quiet", armed());
    burned(null); // anton's own plumbing belongs to nobody's share
    burned("quiet", { status: "queued", attempts: 0 }); // enqueued, never dispatched

    expect(await resolveProjectSpend("quiet", null)).toBeNull();
    expect(await resolveProjectSpend(null, null)).toBeNull();
  });
});
