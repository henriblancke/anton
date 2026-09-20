import { describe, expect, it } from "vitest";
import { mergeSettings, type ProjectSettings } from "./project-settings";

/**
 * Direct unit tests for `mergeSettings`'s per-key merge precedence (anton-33h0) — the pure function
 * `updateProjectSettingsIf`/`updateProjectSettings` apply under the write lock. Each rule below is a
 * distinct branch in the function; these exercise it directly rather than only through the
 * DB-backed writers in projects.test.ts.
 */
describe("mergeSettings", () => {
  it("overwrites a plain key with the patch value", () => {
    const current: ProjectSettings = { model: "claude-sonnet-5" };
    const next = mergeSettings(current, { model: "claude-opus-5" });
    expect(next.model).toBe("claude-opus-5");
  });

  it("leaves keys the patch does not mention untouched", () => {
    const current: ProjectSettings = { model: "claude-sonnet-5", concurrency: 2 };
    const next = mergeSettings(current, { model: "claude-opus-5" });
    expect(next.concurrency).toBe(2);
  });

  it("deletes a key set to undefined, reverting it to its default", () => {
    const current: ProjectSettings = { model: "claude-sonnet-5" };
    const next = mergeSettings(current, { model: undefined });
    expect(next.model).toBeUndefined();
    expect("model" in next).toBe(false);
  });

  it("deletes a key set to an empty string, same as undefined", () => {
    const current: ProjectSettings = { testCommand: "bun run test" };
    const next = mergeSettings(current, { testCommand: "" });
    expect(next.testCommand).toBeUndefined();
    expect("testCommand" in next).toBe(false);
  });

  it("deep-merges budgetPolicy: a partial patch layers onto the stored policy", () => {
    const current: ProjectSettings = {
      budgetPolicy: { dayWindow: [7, 20], minSessionHeadroomPct: 10 },
    };
    const next = mergeSettings(current, { budgetPolicy: { daytimeReservePct: 25 } });
    expect(next.budgetPolicy).toEqual({
      dayWindow: [7, 20],
      minSessionHeadroomPct: 10,
      daytimeReservePct: 25,
    });
  });

  it("deep-merges runHealth: a partial patch layers onto the stored thresholds", () => {
    const current: ProjectSettings = { runHealth: { parkedRunMinutes: 45 } };
    const next = mergeSettings(current, { runHealth: { stalePrHours: 48 } });
    expect(next.runHealth).toEqual({ parkedRunMinutes: 45, stalePrHours: 48 });
  });

  it("deep-merges scanSeverity: re-weighting one severity leaves the others", () => {
    const current: ProjectSettings = {
      scanSeverity: { critical: { risk: "high", priority: 0 } },
    };
    const next = mergeSettings(current, {
      scanSeverity: { high: { risk: "high", priority: 1 } },
    });
    expect(next.scanSeverity).toEqual({
      critical: { risk: "high", priority: 0 },
      high: { risk: "high", priority: 1 },
    });
  });

  it("deep-merges proposalAutonomy: arming one kind leaves the others", () => {
    const current: ProjectSettings = { proposalAutonomy: { stale: "shadow" } };
    const next = mergeSettings(current, { proposalAutonomy: { oversized: "apply" } });
    expect(next.proposalAutonomy).toEqual({ stale: "shadow", oversized: "apply" });
  });

  it("deep-merges repairAutonomy: arming one class leaves the others", () => {
    const current: ProjectSettings = { repairAutonomy: { "ref-stale": "shadow" } };
    const next = mergeSettings(current, { repairAutonomy: { "dep-missing": "apply" } });
    expect(next.repairAutonomy).toEqual({ "ref-stale": "shadow", "dep-missing": "apply" });
  });

  it("clears a nested object wholesale on an explicit undefined, not just its known knobs", () => {
    const current: ProjectSettings = { budgetPolicy: { daytimeReservePct: 25 } };
    const next = mergeSettings(current, { budgetPolicy: undefined });
    expect(next.budgetPolicy).toBeUndefined();
  });
});
