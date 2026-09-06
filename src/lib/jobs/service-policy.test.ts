/**
 * The budget-policy resolution seam (anton-81x2 / R6.1).
 *
 * The claim under test is that the one place deciding whether a project is governed is also the
 * place deciding how much of this machine's single weekly Claude quota it may spend — so an
 * ungoverned project cannot be scaled by a share, and a governed one cannot escape it.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { insertProject } from "@/lib/testing/project";
import { DEFAULT_PROJECT_BUDGET_POLICY, type ProjectSettings } from "@/lib/projects";

let tdb: TestDb;
vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));

const { resolveBudgetPolicy } = await import("./service-policy");

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

    expect((await resolveBudgetPolicy("a"))?.weeklyTargetPct).toBeCloseTo(TARGET / 2, 6);
    expect((await resolveBudgetPolicy("b"))?.weeklyTargetPct).toBeCloseTo(TARGET / 2, 6);
  });

  it("keeps an ungoverned project out of the denominator", async () => {
    project("a", armed());
    project("off", {});

    // Counting the unpaced project would shrink the paced one's cut to fund a repo no share binds.
    expect((await resolveBudgetPolicy("a"))?.weeklyTargetPct).toBe(TARGET);
  });

  it("scales the weekly target by a declared share", async () => {
    project("a", armed({ quotaSharePct: 70 }));
    project("b", armed({ quotaSharePct: 30 }));

    expect((await resolveBudgetPolicy("a"))?.weeklyTargetPct).toBeCloseTo(TARGET * 0.7, 6);
    expect((await resolveBudgetPolicy("b"))?.weeklyTargetPct).toBeCloseTo(TARGET * 0.3, 6);
  });

  it("scales the operator's own weekly target, not the shipped default", async () => {
    project("a", armed({ quotaSharePct: 50, budgetPolicy: { weeklyTargetPct: 50 } }));
    project("b", armed({ quotaSharePct: 50 }));

    // The share is a cut of what this project targets — the two knobs compose, they don't compete.
    expect((await resolveBudgetPolicy("a"))?.weeklyTargetPct).toBe(25);
  });

  it("parks a project that declared a 0% share instead of unpacing it", async () => {
    project("a", armed({ quotaSharePct: 0 }));
    project("b", armed({ quotaSharePct: 100 }));

    // A zero ceiling defers at the weekly cap; a "no weekly signal" reading of 0 would do the
    // opposite and let the parked repo run entirely unpaced.
    expect((await resolveBudgetPolicy("a"))?.weeklyTargetPct).toBe(0);
    expect((await resolveBudgetPolicy("b"))?.weeklyTargetPct).toBe(TARGET);
  });

  it("holds the declared split when no picker pass has observed anybody", async () => {
    project("a", armed({ quotaSharePct: 60 }));
    project("b", armed({ quotaSharePct: 40 }));

    // board-picker ships disabled, so this is the ordinary machine. Renormalizing on the silence
    // would hand every project the whole quota and take the split out of force entirely.
    expect((await resolveBudgetPolicy("a"))?.weeklyTargetPct).toBeCloseTo(TARGET * 0.6, 6);
    expect((await resolveBudgetPolicy("b"))?.weeklyTargetPct).toBeCloseTo(TARGET * 0.4, 6);
  });

  it("renormalizes an idle project's share onto the projects that have work (R6.4)", async () => {
    project("busy", armed({ quotaSharePct: 50 }));
    project("idle", armed({ quotaSharePct: 50 }));
    plan("busy", 2);
    plan("idle", 0);

    // Quota that resets unused is wasted: the idle half is spendable by the repo that has work…
    expect((await resolveBudgetPolicy("busy"))?.weeklyTargetPct).toBe(TARGET);
    // …and the idle project keeps its own ceiling, because resolving one means it is asking to spend.
    expect((await resolveBudgetPolicy("idle"))?.weeklyTargetPct).toBeCloseTo(TARGET / 2, 6);
  });

  it("holds a reserved project's share out of the reallocation (R6.5)", async () => {
    project("busy", armed({ quotaSharePct: 50 }));
    project("quiet", armed({ quotaSharePct: 50, reserveQuotaShare: true }));
    plan("busy", 2);
    plan("quiet", 0);

    // The repo touched irregularly keeps its allocation, so the busy neighbour gains nothing.
    expect((await resolveBudgetPolicy("busy"))?.weeklyTargetPct).toBeCloseTo(TARGET / 2, 6);
  });

  it("gives the share back on the next pass, with no operator action", async () => {
    project("busy", armed({ quotaSharePct: 50 }));
    project("waking", armed({ quotaSharePct: 50 }));
    plan("busy", 2);
    plan("waking", 0);
    expect((await resolveBudgetPolicy("busy"))?.weeklyTargetPct).toBe(TARGET);

    // A repo that wakes up on Friday must not wait a week: the next pass recomputes the divisor.
    plan("waking", 1);

    expect((await resolveBudgetPolicy("busy"))?.weeklyTargetPct).toBeCloseTo(TARGET / 2, 6);
    expect((await resolveBudgetPolicy("waking"))?.weeklyTargetPct).toBeCloseTo(TARGET / 2, 6);
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

    expect((await resolveBudgetPolicy("busy"))?.weeklyTargetPct).toBeCloseTo(TARGET / 2, 6);
  });

  it("says out loud when the declared shares do not sum to 100", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    project("a", armed({ quotaSharePct: 60 }));
    project("b", armed({ quotaSharePct: 60 }));

    const policy = await resolveBudgetPolicy("a");

    // Proportioned, so 120% of declarations still spends exactly the weekly target between them…
    expect(policy?.weeklyTargetPct).toBeCloseTo(TARGET / 2, 6);
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
