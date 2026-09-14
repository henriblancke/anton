/**
 * The value-label backfill (drizzle/0018, for anton-prng).
 *
 * `jobValueScore` stopped hardcoding `risk:high` / `blocking-PR` and now defaults to NO nominations.
 * That default is right for a board anton has never seen and a REGRESSION for one it has already
 * been ranking: without the backfill, a project upgrading into this release drops every governed job
 * into the age band, where the on-pace threshold holds it indefinitely.
 *
 * So this suite asserts the migration end to end, through the real path a running project takes —
 * settings row → `resolveBudgetPolicy` → `jobValueScore` → `admitJob` — and asserts the two ways it
 * must NOT overreach: an operator's own nominations are never rewritten, and a project created after
 * the migration still starts with none.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestDb, type TestDb } from "./testing";
import * as schema from "./schema";
import { getProjectSettings, resolveBudgetPolicy } from "../projects";
import { admitJob, jobValueScore } from "../jobs/budget";
import type { ClaudeUsage } from "../claude/usage";

const BACKFILL_SQL = readFileSync(
  join(process.cwd(), "drizzle", "0018_backfill_value_labels.sql"),
  "utf8",
);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-16T12:00:00Z");

/**
 * Usage that is neither scarce nor abundant: half the week elapsed and half the plan spent, with a
 * session at 50%. This is the ordinary state anton spends most of its time in — and the one where a
 * lost nomination is fatal, because the on-pace bar (0.5) sits above the whole age band (0…0.4).
 */
const ON_PACE: ClaudeUsage = {
  sessionPct: 50,
  weeklyPct: 45,
  sessionResetAt: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
  weeklyResetAt: new Date(NOW + 0.5 * WEEK_MS).toISOString(),
  plan: "max",
};

/** A project as it was stored BEFORE this release — budget-aware, and never asked to nominate. */
function seedProject(t: TestDb, id: string, settings: object): void {
  t.db
    .insert(schema.projects)
    .values({
      id,
      slug: id,
      name: id,
      repoPath: `/tmp/${id}`,
      settingsJson: JSON.stringify(settings),
    })
    .run();
}

/** Would this project's day-old `risk:high` epic be admitted right now? */
function admitsRiskHigh(settings: Parameters<typeof resolveBudgetPolicy>[0]): boolean {
  const policy = resolveBudgetPolicy(settings);
  const value = jobValueScore({ labels: ["risk:high", "size:M"], ageMs: DAY_MS }, policy);
  return admitJob(ON_PACE, policy, NOW, { value, sessionCost: 2 }).admit;
}

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => t.close());

describe("drizzle/0018 — the nominations anton used to assume", () => {
  it("keeps an upgraded project's risk:high work admissible on-pace", async () => {
    seedProject(t, "old", { budgetAware: true });
    // The regression, stated before the fix: with no nominations the same job scores in the age
    // band and the on-pace bar holds it.
    expect(admitsRiskHigh(await getProjectSettings(t.db, "old"))).toBe(false);

    t.sqlite.exec(BACKFILL_SQL);

    const settings = await getProjectSettings(t.db, "old");
    expect(settings.valueLabels).toEqual(["risk:high", "blocking-PR"]);
    expect(admitsRiskHigh(settings)).toBe(true);
  });

  it("reproduces the scores the hardcoded scorer produced", async () => {
    seedProject(t, "old", {});
    t.sqlite.exec(BACKFILL_SQL);
    const policy = resolveBudgetPolicy(await getProjectSettings(t.db, "old"));

    // The two shipped bands, exactly as they were: [0.8, 1.0] for the top tier, [0.5, 0.7] below it.
    expect(jobValueScore({ labels: ["risk:high"], ageMs: 0 }, policy)).toBe(0.8);
    expect(jobValueScore({ labels: ["risk:high"], ageMs: 30 * DAY_MS }, policy)).toBe(1);
    expect(jobValueScore({ labels: ["blocking-PR"], ageMs: 0 }, policy)).toBe(0.5);
    expect(jobValueScore({ labels: ["blocking-PR"], ageMs: 30 * DAY_MS }, policy)).toBe(0.7);
  });

  it("never rewrites what the operator nominated — including a deliberately empty list", async () => {
    seedProject(t, "tuned", { valueLabels: ["severity:sev1"] });
    seedProject(t, "opted-out", { valueLabels: [] });

    t.sqlite.exec(BACKFILL_SQL);

    expect((await getProjectSettings(t.db, "tuned")).valueLabels).toEqual(["severity:sev1"]);
    expect((await getProjectSettings(t.db, "opted-out")).valueLabels).toEqual([]);
  });

  it("is a one-time upgrade, not a shipped default — a project created after it nominates nothing", async () => {
    // `makeTestDb` applies every committed migration to an EMPTY database, so 0018 has already run
    // and never runs again: this row is created after it and is never visited. anton still ships no
    // vocabulary — the backfill only writes down what it had already been assuming.
    seedProject(t, "fresh", { budgetAware: true });

    expect((await getProjectSettings(t.db, "fresh")).valueLabels).toBeUndefined();
  });
});
