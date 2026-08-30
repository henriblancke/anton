/**
 * `findRunFormulaForBranch` (anton-aa3m): which pipeline a later attempt on a branch pins to, and
 * the order `listRecentRunOutcomes` hands the autopilot breakers their evidence in (anton-rgso).
 *
 * The failure it exists to prevent: an ordinary handler error settles the run row `failed`, and the
 * runner's automatic retry reuses the prior attempt's worktree and skips its committed tickets — but
 * `findOpenRunForEpic` never returns a failed row, so that retry would re-SELECT its pipeline from
 * labels and a variant map that may have changed during the backoff. Half the branch would then have
 * walked one formula and half another.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import { createRun, findRunFormulaForBranch, listRecentRunOutcomes, updateRun } from "./runs";
import type { Clock } from "./jobs/queue";

let t: TestDb;
const PROJECT = "p1";
const EPIC = "anton-abc";
const BRANCH = "anton/anton-abc";

beforeEach(async () => {
  t = makeTestDb();
  await t.db.insert(schema.projects).values({
    id: PROJECT,
    slug: "p1",
    name: "P1",
    repoPath: "/repo",
  });
});
afterEach(() => t.close());

interface SeedRun {
  id: string;
  status: string;
  updatedAt: number;
  formula?: string;
  formulaVariant?: string;
  branch?: string;
  epicBeadId?: string;
  projectId?: string;
  startedAt?: number;
}

async function seed(run: SeedRun): Promise<void> {
  await t.db.insert(schema.runs).values({
    id: run.id,
    projectId: run.projectId ?? PROJECT,
    epicBeadId: run.epicBeadId ?? EPIC,
    branch: run.branch ?? BRANCH,
    status: run.status,
    formula: run.formula,
    formulaVariant: run.formulaVariant,
    startedAt: new Date(run.startedAt ?? run.updatedAt),
    updatedAt: new Date(run.updatedAt),
  });
}

describe("findRunFormulaForBranch", () => {
  it("recovers the pipeline a FAILED attempt recorded — the retry's row is not open", async () => {
    await seed({
      id: "r1",
      status: "failed",
      updatedAt: 1_000_000,
      formula: "/repo/.beads/formulas/heavy.formula.toml",
      formulaVariant: "risk:high",
    });

    expect(await findRunFormulaForBranch(t.db, PROJECT, EPIC, BRANCH)).toEqual({
      source: "/repo/.beads/formulas/heavy.formula.toml",
      variant: "risk:high",
    });
  });

  it("reports no variant when the attempt walked the default", async () => {
    await seed({
      id: "r1",
      status: "failed",
      updatedAt: 1_000_000,
      formula: "/repo/.beads/formulas/anton-run.formula.toml",
    });

    expect(await findRunFormulaForBranch(t.db, PROJECT, EPIC, BRANCH)).toEqual({
      source: "/repo/.beads/formulas/anton-run.formula.toml",
      variant: undefined,
    });
  });

  it("takes the MOST RECENT attempt that recorded one, skipping rows that never got that far", async () => {
    await seed({ id: "old", status: "failed", updatedAt: 1_000_000, formula: "/repo/first.toml" });
    await seed({ id: "newer", status: "failed", updatedAt: 2_000_000, formula: "/repo/second.toml" });
    // Crashed before the formula was validated — it pins nothing, so the choice above still stands.
    await seed({ id: "newest", status: "running", updatedAt: 3_000_000 });

    expect(await findRunFormulaForBranch(t.db, PROJECT, EPIC, BRANCH)).toEqual({
      source: "/repo/second.toml",
      variant: undefined,
    });
  });

  it("selects fresh for a branch nothing has walked", async () => {
    await seed({
      id: "other-branch",
      status: "failed",
      updatedAt: 1_000_000,
      branch: "anton/anton-xyz",
      formula: "/repo/other.toml",
    });

    expect(await findRunFormulaForBranch(t.db, PROJECT, EPIC, BRANCH)).toBeUndefined();
  });

  it("never crosses epics or projects", async () => {
    await seed({
      id: "other-epic",
      status: "failed",
      updatedAt: 1_000_000,
      epicBeadId: "anton-zzz",
      formula: "/repo/other.toml",
    });

    expect(await findRunFormulaForBranch(t.db, PROJECT, "anton-zzz", BRANCH)).toEqual({
      source: "/repo/other.toml",
      variant: undefined,
    });
    expect(await findRunFormulaForBranch(t.db, "p2", "anton-zzz", BRANCH)).toBeUndefined();
  });
});

describe("listRecentRunOutcomes", () => {
  // Whole seconds; `updatedAt` stores nothing finer, so concurrent runs settle onto the same value.
  const SETTLED = 1_800_000_000_000;

  it("orders same-second settlements by attempt, not by whatever SQLite returns", async () => {
    // The breakers read this list as a SEQUENCE. Left to tie, a delivered run could come back either
    // side of two same-second failures — resetting a streak on one read and latching a disarm on the
    // next, off rows that never changed.
    await seed({ id: "earlier", status: "failed", updatedAt: SETTLED, startedAt: SETTLED - 600_000 });
    await seed({ id: "later", status: "done", updatedAt: SETTLED, startedAt: SETTLED - 60_000 });

    const runs = await listRecentRunOutcomes(t.db, PROJECT, 10);

    expect(runs.map((r) => r.id)).toEqual(["later", "earlier"]);
  });

  it("orders same-second settlements by which run SETTLED last, not which started last", async () => {
    // Start order is only a proxy, and it inverts exactly where it matters: two runs overlap, the
    // one that started first settles second. Read by start order the later-started delivery sorts
    // newest and resets the streak that the failure settling after it should have kept.
    const clock: Clock = { now: () => SETTLED };
    await createRun(t.db, clock, { id: "started-first", projectId: PROJECT, epicBeadId: EPIC });
    await createRun(t.db, clock, { id: "started-second", projectId: PROJECT, epicBeadId: EPIC });
    await updateRun(t.db, clock, "started-second", { status: "done", endedAt: SETTLED });
    await updateRun(t.db, clock, "started-first", { status: "failed", endedAt: SETTLED });

    expect((await listRecentRunOutcomes(t.db, PROJECT, 10)).map((r) => r.id)).toEqual([
      "started-first",
      "started-second",
    ]);
  });

  it("is still total when the attempts also started in the same second", async () => {
    await seed({ id: "first", status: "failed", updatedAt: SETTLED, startedAt: SETTLED - 60_000 });
    await seed({ id: "second", status: "failed", updatedAt: SETTLED, startedAt: SETTLED - 60_000 });

    // Insertion order is the last thing left that says which run came after which.
    expect((await listRecentRunOutcomes(t.db, PROJECT, 10)).map((r) => r.id)).toEqual([
      "second",
      "first",
    ]);
    // And the `limit` boundary takes the same row every time rather than an arbitrary one.
    expect((await listRecentRunOutcomes(t.db, PROJECT, 1)).map((r) => r.id)).toEqual(["second"]);
  });
});
