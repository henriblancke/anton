/**
 * `findRunFormulaForBranch` (anton-aa3m): which pipeline a later attempt on a branch pins to.
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
import { findRunFormulaForBranch } from "./runs";

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
    startedAt: new Date(run.updatedAt),
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
