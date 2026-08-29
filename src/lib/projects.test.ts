import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

let workDir: string;
let dbFile: string;
let addProject: typeof import("./projects").addProject;
let listProjects: typeof import("./projects").listProjects;
let getProjectBySlug: typeof import("./projects").getProjectBySlug;
let resolveVerifyGates: typeof import("./projects").resolveVerifyGates;
let resolveReviewConfig: typeof import("./projects").resolveReviewConfig;
let DEFAULT_REVIEW_MAX_ROUNDS: typeof import("./projects").DEFAULT_REVIEW_MAX_ROUNDS;
let DEFAULT_REVIEW_MIN_SCORE: typeof import("./projects").DEFAULT_REVIEW_MIN_SCORE;
let DEFAULT_REVIEW_LOW_SCORE_ROUNDS: typeof import("./projects").DEFAULT_REVIEW_LOW_SCORE_ROUNDS;
let budgetPolicySchema: typeof import("./projects").budgetPolicySchema;
let resolveProjectBudgetPolicy: typeof import("./projects").resolveProjectBudgetPolicy;
let resolveBudgetPolicy: typeof import("./projects").resolveBudgetPolicy;
let DEFAULT_PROJECT_BUDGET_POLICY: typeof import("./projects").DEFAULT_PROJECT_BUDGET_POLICY;
let updateProjectSettings: typeof import("./projects").updateProjectSettings;
let getProjectSettingsBySlug: typeof import("./projects").getProjectSettingsBySlug;
let isBudgetAwareEnabledAnywhere: typeof import("./projects").isBudgetAwareEnabledAnywhere;
let resolveValueLabels: typeof import("./projects").resolveValueLabels;
let valueLabelsSchema: typeof import("./projects").valueLabelsSchema;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "anton-projects-test-"));
  dbFile = join(workDir, "anton.db");
  process.env.ANTON_DB = dbFile;

  const migrationSql = readFileSync(
    join(process.cwd(), "drizzle", "0000_lumpy_captain_flint.sql"),
    "utf-8",
  );
  const setup = new Database(dbFile);
  setup.exec(migrationSql);
  setup.close();

  const mod = await import("./projects");
  addProject = mod.addProject;
  listProjects = mod.listProjects;
  getProjectBySlug = mod.getProjectBySlug;
  resolveVerifyGates = mod.resolveVerifyGates;
  resolveReviewConfig = mod.resolveReviewConfig;
  DEFAULT_REVIEW_MAX_ROUNDS = mod.DEFAULT_REVIEW_MAX_ROUNDS;
  DEFAULT_REVIEW_MIN_SCORE = mod.DEFAULT_REVIEW_MIN_SCORE;
  DEFAULT_REVIEW_LOW_SCORE_ROUNDS = mod.DEFAULT_REVIEW_LOW_SCORE_ROUNDS;
  budgetPolicySchema = mod.budgetPolicySchema;
  resolveProjectBudgetPolicy = mod.resolveProjectBudgetPolicy;
  resolveBudgetPolicy = mod.resolveBudgetPolicy;
  DEFAULT_PROJECT_BUDGET_POLICY = mod.DEFAULT_PROJECT_BUDGET_POLICY;
  updateProjectSettings = mod.updateProjectSettings;
  getProjectSettingsBySlug = mod.getProjectSettingsBySlug;
  isBudgetAwareEnabledAnywhere = mod.isBudgetAwareEnabledAnywhere;
  resolveValueLabels = mod.resolveValueLabels;
  valueLabelsSchema = mod.valueLabelsSchema;
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeRepoDir(name: string, opts: { withBeads?: boolean } = {}): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  if (opts.withBeads) {
    mkdirSync(join(dir, ".beads"), { recursive: true });
  }
  return dir;
}

describe("addProject", () => {
  it("slugifies the provided name", async () => {
    const repoPath = makeRepoDir("Repo One");
    const project = await addProject({ name: "My Cool Project!", repoPath });
    expect(project.slug).toBe("my-cool-project");
  });

  it("falls back to the repoPath basename when name is omitted", async () => {
    const repoPath = makeRepoDir("basename-fallback-repo");
    const project = await addProject({ repoPath });
    expect(project.slug).toBe("basename-fallback-repo");
    expect(project.name).toBe("basename-fallback-repo");
  });

  it("disambiguates slug collisions", async () => {
    const repoA = makeRepoDir("collide-a");
    const repoB = makeRepoDir("collide-b");
    const first = await addProject({ name: "Collide", repoPath: repoA });
    const second = await addProject({ name: "Collide", repoPath: repoB });
    expect(first.slug).toBe("collide");
    expect(second.slug).toBe("collide-2");
  });

  it("detects hasBeads via a .beads directory", async () => {
    const withBeads = makeRepoDir("with-beads", { withBeads: true });
    const withoutBeads = makeRepoDir("without-beads");

    const projectA = await addProject({ name: "With Beads", repoPath: withBeads });
    const projectB = await addProject({ name: "Without Beads", repoPath: withoutBeads });

    expect(projectA.hasBeads).toBe(true);
    expect(projectB.hasBeads).toBe(false);
  });

  it("falls back to 'main' when the repo has no resolvable HEAD", async () => {
    const repoPath = makeRepoDir("no-git-here");
    const project = await addProject({ name: "No Git", repoPath });
    expect(project.defaultBranch).toBe("main");
  });

  it("throws a clear error when repoPath does not exist", async () => {
    await expect(
      addProject({ name: "Ghost", repoPath: join(workDir, "does-not-exist") }),
    ).rejects.toThrow(/does not exist/);
  });

  it("persists the project so it is retrievable by slug and in the listing", async () => {
    const repoPath = makeRepoDir("persisted-repo");
    const created = await addProject({ name: "Persisted", repoPath });

    const bySlug = await getProjectBySlug(created.slug);
    expect(bySlug).toMatchObject({ id: created.id, slug: created.slug, repoPath });

    const all = await listProjects();
    expect(all.some((p) => p.id === created.id)).toBe(true);
  });

  it("returns null for an unknown slug", async () => {
    expect(await getProjectBySlug("does-not-exist-slug")).toBeNull();
  });

  it("is idempotent by repoPath — re-adding the same repo returns the existing row (anton-uez)", async () => {
    const repoPath = makeRepoDir("idempotent-repo");
    const first = await addProject({ name: "Idem", repoPath });
    const second = await addProject({ name: "Idem Again", repoPath });

    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);

    const matches = (await listProjects()).filter((p) => p.repoPath === repoPath);
    expect(matches).toHaveLength(1);
  });
});

describe("resolveVerifyGates (anton-3oh8)", () => {
  it("returns no gates when nothing is configured (unchanged behavior)", () => {
    expect(resolveVerifyGates({})).toEqual([]);
  });

  it("maps each configured command to a labeled gate, in test→lint→typecheck→build order", () => {
    const gates = resolveVerifyGates({
      buildCommand: "b",
      testCommand: "t",
      typecheckCommand: "tc",
      lintCommand: "l",
    });
    expect(gates).toEqual([
      { label: "tests", command: "t" },
      { label: "lint", command: "l" },
      { label: "typecheck", command: "tc" },
      { label: "build", command: "b" },
    ]);
  });

  it("skips unset commands so partial config only runs what's pinned", () => {
    expect(resolveVerifyGates({ testCommand: "t", buildCommand: "b" })).toEqual([
      { label: "tests", command: "t" },
      { label: "build", command: "b" },
    ]);
  });
});

describe("resolveReviewConfig (anton-of1m)", () => {
  it("is ON with the default round cap and score alarm when nothing is configured", () => {
    expect(resolveReviewConfig({})).toEqual({
      enabled: true,
      agent: undefined,
      prompt: undefined,
      maxRounds: DEFAULT_REVIEW_MAX_ROUNDS,
      scoreAlarm: {
        minScore: DEFAULT_REVIEW_MIN_SCORE,
        rounds: DEFAULT_REVIEW_LOW_SCORE_ROUNDS,
      },
    });
  });

  it("honors an explicit off switch", () => {
    expect(resolveReviewConfig({ reviewEnabled: false }).enabled).toBe(false);
  });

  it("carries the swapped reviewer, prompt override and round cap", () => {
    expect(
      resolveReviewConfig({
        reviewAgent: "my-reviewer",
        reviewPrompt: "Only data loss.",
        reviewMaxRounds: 4,
      }),
    ).toMatchObject({
      enabled: true,
      agent: "my-reviewer",
      prompt: "Only data loss.",
      maxRounds: 4,
    });
  });

  it("treats an empty stored agent/prompt as absent, so callers never dispatch a blank override", () => {
    const resolved = resolveReviewConfig({ reviewAgent: "", reviewPrompt: "" });
    expect(resolved.agent).toBeUndefined();
    expect(resolved.prompt).toBeUndefined();
  });

  it("carries the operator's score-alarm thresholds (anton-i98r)", () => {
    expect(resolveReviewConfig({ reviewMinScore: 7, reviewLowScoreRounds: 3 }).scoreAlarm).toEqual({
      minScore: 7,
      rounds: 3,
    });
  });

  it("resolves a minimum score of 0 to NO alarm — that is the operator's off switch", () => {
    expect(resolveReviewConfig({ reviewMinScore: 0 }).scoreAlarm).toBeUndefined();
    // The streak length is still stored; turning the alarm back on must restore it, not reset it.
    expect(resolveReviewConfig({ reviewMinScore: 0, reviewLowScoreRounds: 4 }).scoreAlarm).toBeUndefined();
  });
});

describe("budget policy (anton-egrg)", () => {
  it("applies safe defaults when the policy is absent", () => {
    expect(resolveProjectBudgetPolicy({})).toEqual(DEFAULT_PROJECT_BUDGET_POLICY);
    expect(DEFAULT_PROJECT_BUDGET_POLICY).toMatchObject({
      dayWindow: [9, 18],
      daytimeReservePct: 15,
      weeklyTargetPct: 90,
      minSessionHeadroomPct: 5,
      preferNightForHeavy: true,
    });
  });

  it("overlays a partial policy onto the defaults, keeping untouched fields", () => {
    const resolved = resolveProjectBudgetPolicy({
      budgetPolicy: { daytimeReservePct: 30, weeklyTargetPct: 75 },
    });
    expect(resolved.daytimeReservePct).toBe(30);
    expect(resolved.weeklyTargetPct).toBe(75);
    // Untouched fields fall back to the defaults.
    expect(resolved.dayWindow).toEqual([9, 18]);
    expect(resolved.minSessionHeadroomPct).toBe(5);
    expect(resolved.preferNightForHeavy).toBe(true);
  });

  it("projects onto the governor BudgetPolicy — knobs ride on the shipped defaults", () => {
    const policy = resolveBudgetPolicy({
      budgetPolicy: { daytimeReservePct: 25, weeklyTargetPct: 80 },
    });
    expect(policy.daytimeReservePct).toBe(25);
    expect(policy.weeklyTargetPct).toBe(80);
    expect(policy.dayStartHour).toBe(9);
    expect(policy.dayEndHour).toBe(18);
    expect(policy.minSessionHeadroomPct).toBe(5);
    // A governor-only field the operator can't set keeps its shipped default.
    expect(policy.paceSlackPct).toBeGreaterThan(0);
    expect(policy.nightValueDiscount).toBeGreaterThan(0);
  });

  it("applies this machine's UTC offset so the local dayWindow is evaluated in local time", () => {
    // dayWindow is documented as local hours; the governor compares against a fixed-offset clock,
    // so resolving must carry the machine's offset (PR #68 review) — a 0 offset would evaluate a
    // Pacific-afternoon 13:00 as 20:00 UTC and skip the daytime reserve during the local day.
    const policy = resolveBudgetPolicy({});
    expect(policy.utcOffsetMinutes).toBe(-new Date().getTimezoneOffset());
  });

  it("zeroes the night discount when preferNightForHeavy is off", () => {
    expect(resolveBudgetPolicy({ budgetPolicy: { preferNightForHeavy: false } }).nightValueDiscount).toBe(0);
    expect(resolveBudgetPolicy({ budgetPolicy: { preferNightForHeavy: true } }).nightValueDiscount).toBeGreaterThan(0);
  });

  it("accepts an in-range policy", () => {
    const parsed = budgetPolicySchema.safeParse({
      dayWindow: [8, 20],
      daytimeReservePct: 0,
      weeklyTargetPct: 100,
      minSessionHeadroomPct: 5,
      preferNightForHeavy: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects out-of-range percentages (fail loud)", () => {
    expect(budgetPolicySchema.safeParse({ daytimeReservePct: 101 }).success).toBe(false);
    expect(budgetPolicySchema.safeParse({ weeklyTargetPct: -1 }).success).toBe(false);
    expect(budgetPolicySchema.safeParse({ minSessionHeadroomPct: 3.5 }).success).toBe(false);
  });

  it("rejects a zero weekly target — 0 would disable pacing, not target zero usage", () => {
    expect(budgetPolicySchema.safeParse({ weeklyTargetPct: 0 }).success).toBe(false);
    expect(budgetPolicySchema.safeParse({ weeklyTargetPct: 1 }).success).toBe(true);
    // Zero stays valid where it means "no reserve/floor", which IS a coherent setting.
    expect(budgetPolicySchema.safeParse({ daytimeReservePct: 0 }).success).toBe(true);
    expect(budgetPolicySchema.safeParse({ minSessionHeadroomPct: 0 }).success).toBe(true);
  });

  it("rejects a day window whose start is not before its end", () => {
    expect(budgetPolicySchema.safeParse({ dayWindow: [18, 9] }).success).toBe(false);
    expect(budgetPolicySchema.safeParse({ dayWindow: [12, 12] }).success).toBe(false);
    expect(budgetPolicySchema.safeParse({ dayWindow: [0, 24] }).success).toBe(false); // hour out of range
  });

  it("rejects unknown keys so a typo can't silently persist", () => {
    expect(budgetPolicySchema.safeParse({ daytimeReserve: 15 }).success).toBe(false);
  });
});

describe("nominated value labels (anton-prng)", () => {
  it("nominates nothing by default — a repo anton has never seen ranks on native fields alone", () => {
    expect(resolveValueLabels({})).toEqual([]);
    expect(resolveBudgetPolicy({}).valueLabels).toEqual([]);
  });

  it("carries the operator's nominations, in order, onto the governor policy", () => {
    const policy = resolveBudgetPolicy({ valueLabels: ["risk:high", "blocking-PR"] });
    expect(policy.valueLabels).toEqual(["risk:high", "blocking-PR"]);
  });

  it("rejects a repeat nomination — a second entry could never reach its tier", () => {
    expect(valueLabelsSchema.safeParse(["risk:high", "risk:high"]).success).toBe(false);
    expect(valueLabelsSchema.safeParse(["risk:high", "blocking-PR"]).success).toBe(true);
    expect(valueLabelsSchema.safeParse([""]).success).toBe(false);
    expect(valueLabelsSchema.safeParse(Array.from({ length: 9 }, (_, i) => `l${i}`)).success).toBe(
      false,
    );
  });

  it("replaces the nominations wholesale — the array order IS the band order", async () => {
    const created = await addProject({ name: "Value Labels", repoPath: makeRepoDir("value-labels") });
    await updateProjectSettings(created.slug, { valueLabels: ["risk:high", "blocking-PR"] });
    const settings = await updateProjectSettings(created.slug, { valueLabels: ["blocking-PR"] });
    // A merge would have kept the demoted label; re-ranking has to be able to drop one.
    expect(settings.valueLabels).toEqual(["blocking-PR"]);
    expect((await updateProjectSettings(created.slug, { valueLabels: undefined })).valueLabels)
      .toBeUndefined();
  });
});

describe("updateProjectSettings budgetPolicy deep-merge", () => {
  it("merges a partial patch into the stored policy instead of replacing it wholesale", async () => {
    const created = await addProject({ name: "Budget Merge", repoPath: makeRepoDir("budget-merge") });
    await updateProjectSettings(created.slug, {
      budgetPolicy: { dayWindow: [7, 20], minSessionHeadroomPct: 10, preferNightForHeavy: false },
    });
    // A save exposing only the two UI knobs must not wipe the API-set knobs above.
    const settings = await updateProjectSettings(created.slug, {
      budgetPolicy: { daytimeReservePct: 25, weeklyTargetPct: 80 },
    });
    expect(settings.budgetPolicy).toEqual({
      dayWindow: [7, 20],
      minSessionHeadroomPct: 10,
      preferNightForHeavy: false,
      daytimeReservePct: 25,
      weeklyTargetPct: 80,
    });
  });

  it("still clears the whole policy on an explicit undefined (back to defaults)", async () => {
    const created = await addProject({ name: "Budget Clear", repoPath: makeRepoDir("budget-clear") });
    await updateProjectSettings(created.slug, { budgetPolicy: { daytimeReservePct: 25 } });
    const settings = await updateProjectSettings(created.slug, { budgetPolicy: undefined });
    expect(settings.budgetPolicy).toBeUndefined();
  });
});

describe("updateProjectSettings runHealth deep-merge", () => {
  it("merges a partial patch into the stored thresholds instead of replacing them wholesale", async () => {
    // The thresholds are partial-by-design (each absent knob resolves to its default), so a PATCH
    // carrying one of them must not silently revert the operator's other tuned values.
    const created = await addProject({ name: "Health Merge", repoPath: makeRepoDir("health-merge") });
    await updateProjectSettings(created.slug, {
      runHealth: { parkedRunMinutes: 45, deadLeaseMinutes: 15 },
    });
    const settings = await updateProjectSettings(created.slug, { runHealth: { stalePrHours: 48 } });
    expect(settings.runHealth).toEqual({
      parkedRunMinutes: 45,
      deadLeaseMinutes: 15,
      stalePrHours: 48,
    });
  });

  it("still clears the whole object on an explicit undefined (back to defaults)", async () => {
    const created = await addProject({ name: "Health Clear", repoPath: makeRepoDir("health-clear") });
    await updateProjectSettings(created.slug, { runHealth: { stalePrHours: 48 } });
    const settings = await updateProjectSettings(created.slug, { runHealth: undefined });
    expect(settings.runHealth).toBeUndefined();
  });
});

/**
 * Every settings writer rewrites the WHOLE settingsJson blob, and the settings page has several of
 * them in flight independently — the global Save, the automation table, the work-policy panel. A
 * read-modify-write that is not atomic loses one of them silently: both requests report success and
 * the later write erases the earlier one's keys.
 */
describe("updateProjectSettings is atomic against a concurrent write", () => {
  it("keeps both patches when two saves are in flight at once", async () => {
    const created = await addProject({
      name: "Concurrent Save",
      repoPath: makeRepoDir("concurrent-save"),
    });
    // Started together, deliberately: this is the settings page with one PATCH per section.
    await Promise.all([
      updateProjectSettings(created.slug, { model: "claude-sonnet-5" }),
      updateProjectSettings(created.slug, { pickerPolicy: { types: ["bug"] } }),
    ]);
    const settings = await getProjectSettingsBySlug(created.slug);
    expect(settings.model).toBe("claude-sonnet-5");
    expect(settings.pickerPolicy).toEqual({ types: ["bug"] });
  });
});

describe("isBudgetAwareEnabledAnywhere (anton-7mpv.1)", () => {
  it("is false when no project has budget-aware execution on (the default)", async () => {
    const created = await addProject({ name: "Budget Off", repoPath: makeRepoDir("budget-off") });
    // A project with an unrelated setting is still 'off'.
    await updateProjectSettings(created.slug, { model: "claude-sonnet-5" });
    expect(await isBudgetAwareEnabledAnywhere()).toBe(false);
  });

  it("is true once any project turns it on", async () => {
    const created = await addProject({ name: "Budget On", repoPath: makeRepoDir("budget-on") });
    await updateProjectSettings(created.slug, { budgetAware: true });
    expect(await isBudgetAwareEnabledAnywhere()).toBe(true);
  });
});
