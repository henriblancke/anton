import { afterEach, describe, expect, it } from "vitest";
import {
  mergeSettings,
  redactSecrets,
  resolveDecisionMode,
  resolveJevConfig,
  resolveWarmConfig,
  type ProjectSettings,
} from "./project-settings";
import { definePoint, resetRegistryForTests, type DecisionPoint } from "./decide/points";

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

  it("deep-merges decisionModes: promoting one point leaves the others", () => {
    const current: ProjectSettings = { decisionModes: { "point-a": "shadow" } };
    const next = mergeSettings(current, { decisionModes: { "point-b": "auto" } });
    expect(next.decisionModes).toEqual({ "point-a": "shadow", "point-b": "auto" });
  });

  // Selecting a point's own default is a per-point delete (anton-528bw review), not an explicit
  // override — resolveDecisionMode must fall back to whatever the point's shipped default is LATER,
  // not the value that happened to be current when the operator picked it.
  it("drops a point set to null, leaving the others, instead of storing an explicit value", () => {
    const current: ProjectSettings = { decisionModes: { "point-a": "auto", "point-b": "assist" } };
    const next = mergeSettings(
      current,
      { decisionModes: { "point-a": null } } as unknown as Partial<ProjectSettings>,
    );
    expect(next.decisionModes).toEqual({ "point-b": "assist" });
  });

  // A point literally named "__proto__" must still land as an own property, not reassign the
  // merged object's prototype via the inherited setter — which would silently drop the override.
  // The computed key below (as opposed to a literal `__proto__:`) is required to actually produce
  // an own "__proto__" property on the patch object rather than triggering the literal's own
  // proto-setting special case.
  it("stores an override for a point named __proto__ as an own property", () => {
    const current: ProjectSettings = { decisionModes: { "point-a": "shadow" } };
    const next = mergeSettings(
      current,
      { decisionModes: { ["__proto__"]: "auto" } } as unknown as Partial<ProjectSettings>,
    );
    expect(Object.prototype.hasOwnProperty.call(next.decisionModes, "__proto__")).toBe(true);
    expect(next.decisionModes?.__proto__).toBe("auto");
    expect(next.decisionModes).toEqual({ "point-a": "shadow", ["__proto__"]: "auto" });
  });

  it("clears a nested object wholesale on an explicit undefined, not just its known knobs", () => {
    const current: ProjectSettings = { budgetPolicy: { daytimeReservePct: 25 } };
    const next = mergeSettings(current, { budgetPolicy: undefined });
    expect(next.budgetPolicy).toBeUndefined();
  });
});

/** The settings half of the warm ladder (anton-z5li2): what absence means on each field. */
describe("resolveWarmConfig", () => {
  it("leaves warming ON for a project that predates the setting", () => {
    expect(resolveWarmConfig({})).toEqual({ command: undefined, enabled: true });
  });

  it("carries a pinned command through", () => {
    expect(resolveWarmConfig({ warmCommand: "make setup" })).toEqual({
      command: "make setup",
      enabled: true,
    });
  });

  // A cleared command is a fall-through to the env var / lockfile table, never a skip.
  it("reads an empty command as absent rather than as an empty shell command", () => {
    expect(resolveWarmConfig({ warmCommand: "" }).command).toBeUndefined();
  });

  it("turns warming off only on an explicit false", () => {
    expect(resolveWarmConfig({ warmEnabled: false }).enabled).toBe(false);
    expect(resolveWarmConfig({ warmEnabled: true }).enabled).toBe(true);
  });
});

/** How far a decide() call may go on this project, per point (anton-xky9e). */
describe("resolveDecisionMode", () => {
  afterEach(resetRegistryForTests);

  function point(overrides: Partial<DecisionPoint> = {}): DecisionPoint {
    return definePoint({
      id: "test-point",
      question: { kind: "yes-no" },
      instruction: "Test-only decision point.",
      consequence: "low",
      threshold: 0.8,
      defaultMode: "shadow",
      stateFields: [],
      hardRules: [],
      ...overrides,
    });
  }

  it("falls back to the point's own defaultMode when nothing is stored", () => {
    expect(resolveDecisionMode({}, point())).toBe("shadow");
  });

  it("reads the operator's override for that point", () => {
    const settings: ProjectSettings = { decisionModes: { "test-point": "auto" } };
    expect(resolveDecisionMode(settings, point())).toBe("auto");
  });

  it("leaves a different point's mode alone", () => {
    const settings: ProjectSettings = { decisionModes: { "other-point": "auto" } };
    expect(resolveDecisionMode(settings, point())).toBe("shadow");
  });

  it("falls back to defaultMode on a hand-edited, unreadable value", () => {
    const settings = { decisionModes: { "test-point": "armed" } } as unknown as ProjectSettings;
    expect(resolveDecisionMode(settings, point())).toBe("shadow");
  });
});

/**
 * The jev API key is "the one value this settings row carries that must never reach the browser"
 * (redactSecrets' own doc comment) — a direct test here, not just an indirect one through the
 * route's `toMatchObject` assertions (those only check the listed keys, so they would not fail
 * even if this function were deleted entirely).
 */
describe("redactSecrets", () => {
  it("strips a stored jevApiKey", () => {
    const settings: ProjectSettings = { jevEnabled: true, jevApiKey: "sk-secret", jevModel: "jev-1.13.0" };
    const redacted = redactSecrets(settings);
    expect(redacted.jevApiKey).toBeUndefined();
    expect("jevApiKey" in redacted).toBe(false);
  });

  it("leaves a row with no key untouched", () => {
    const settings: ProjectSettings = { jevEnabled: false, model: "claude-sonnet-5" };
    expect(redactSecrets(settings)).toEqual(settings);
  });

  it("does not mutate the settings object it's given", () => {
    const settings: ProjectSettings = { jevApiKey: "sk-secret" };
    redactSecrets(settings);
    expect(settings.jevApiKey).toBe("sk-secret");
  });
});

/** Whether a project may actually call the jev backend (anton-p32iy) — collapsing every reason it
 * can't into one `undefined` answer. */
describe("resolveJevConfig", () => {
  it("is undefined when Jev is off, even with a key and a pinned model stored", () => {
    expect(resolveJevConfig({ jevEnabled: false, jevApiKey: "sk-key", jevModel: "jev-1.13.0" })).toBeUndefined();
  });

  it("is undefined when enabled but no key is stored", () => {
    expect(resolveJevConfig({ jevEnabled: true, jevModel: "jev-1.13.0" })).toBeUndefined();
  });

  it("is undefined when enabled but no model is stored", () => {
    expect(resolveJevConfig({ jevEnabled: true, jevApiKey: "sk-key" })).toBeUndefined();
  });

  it("is undefined when the stored model is not an exact pinned version", () => {
    expect(
      resolveJevConfig({ jevEnabled: true, jevApiKey: "sk-key", jevModel: "jev-latest" }),
    ).toBeUndefined();
  });

  it("resolves the apiKey and model when fully configured", () => {
    expect(
      resolveJevConfig({ jevEnabled: true, jevApiKey: "sk-key", jevModel: "jev-1.13.0" }),
    ).toEqual({ apiKey: "sk-key", model: "jev-1.13.0" });
  });

  it("is undefined when the stored key is whitespace-only (predates the write-time boundary check)", () => {
    expect(
      resolveJevConfig({ jevEnabled: true, jevApiKey: "   ", jevModel: "jev-1.13.0" }),
    ).toBeUndefined();
  });

  it("trims a stored key with incidental surrounding whitespace (predates the write-time boundary check)", () => {
    expect(
      resolveJevConfig({ jevEnabled: true, jevApiKey: "  sk-key  ", jevModel: "jev-1.13.0" }),
    ).toEqual({ apiKey: "sk-key", model: "jev-1.13.0" });
  });
});
