/**
 * Unit tests for the cadence presets + describer (anton-1sa6). The contract these lock down is
 * agreement: what the picker builds, what a stored cron opens on, and what the row summary says are
 * all the same cadence.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULES } from "../schedules";
import {
  CADENCE_PRESETS,
  cronForPreset,
  dailyEquivalentOf,
  describeCron,
  FAST_CADENCE_MINUTES,
  isFastCadence,
  presetById,
  presetForCron,
  WEEKDAY_LABELS,
} from "./cadence";
import { isValidCron } from "./cron";

describe("describeCron", () => {
  it("names every cron shipped in DEFAULT_SCHEDULES", () => {
    const phrases = Object.fromEntries(
      DEFAULT_SCHEDULES.map((d) => [d.type, describeCron(d.cron)]),
    );
    expect(phrases).toEqual({
      "review-fix": "Every 15 minutes",
      "nightly-stringer": "Daily at 03:00",
      "orphan-grooming": "Weekly on Monday at 04:00",
      "run-health": "Hourly, on the hour",
      unstick: "Hourly at :10",
      "gate-check": "Every 10 minutes",
      gardener: "Daily at 05:00",
      "product-master": "Weekly on Monday at 06:00",
      "board-picker": "Every 10 minutes",
      "worktree-reaper": "Daily at 04:30",
    });
  });

  it("names the cron of every preset", () => {
    for (const preset of CADENCE_PRESETS) {
      if (preset.id === "custom") continue;
      const cron = cronForPreset(preset.id);
      const phrase = describeCron(cron);
      expect(phrase, preset.id).not.toBe(cron); // a phrase, never the raw expression
      expect(phrase.length, preset.id).toBeGreaterThan(0);
    }
  });

  it("phrases each named shape the way an operator reads it", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/30 * * * *")).toBe("Every 30 minutes");
    expect(describeCron("0 * * * *")).toBe("Hourly, on the hour");
    expect(describeCron("5 * * * *")).toBe("Hourly at :05");
    expect(describeCron("30 14 * * *")).toBe("Daily at 14:30");
    expect(describeCron("0 9 * * 0")).toBe("Weekly on Sunday at 09:00");
    expect(describeCron("0 9 * * 7")).toBe("Weekly on Sunday at 09:00"); // 7 is Sunday too
  });

  it("falls back to the raw expression for anything it cannot name", () => {
    expect(describeCron("0,30 9-17 * * 1-5")).toBe("0,30 9-17 * * 1-5");
    expect(describeCron("0 0 1 * *")).toBe("0 0 1 * *"); // day-of-month is outside the table
    expect(describeCron("0 0 * 6 *")).toBe("0 0 * 6 *"); // so is a restricted month
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});

describe("cronForPreset", () => {
  it("builds a valid cron for every preset", () => {
    for (const preset of CADENCE_PRESETS) {
      if (preset.id === "custom") continue;
      expect(isValidCron(cronForPreset(preset.id)), preset.id).toBe(true);
    }
  });

  it("applies the operator's inputs", () => {
    expect(cronForPreset("hourly-at", { minute: 45 })).toBe("45 * * * *");
    expect(cronForPreset("daily", { hour: 6, minute: 15 })).toBe("15 6 * * *");
    expect(cronForPreset("weekly", { weekday: 5, hour: 18, minute: 0 })).toBe("0 18 * * 5");
  });

  it("has no cron for custom, and rejects out-of-range inputs", () => {
    expect(() => cronForPreset("custom")).toThrow(/custom preset/);
    expect(() => cronForPreset("daily", { hour: 24 })).toThrow(/hour/);
    expect(() => cronForPreset("hourly-at", { minute: -1 })).toThrow(/minute/);
    expect(() => cronForPreset("weekly", { weekday: 7 })).toThrow(/weekday/);
  });
});

describe("presetForCron", () => {
  it("round-trips every preset — a preset's cron reopens on that preset", () => {
    for (const preset of CADENCE_PRESETS) {
      if (preset.id === "custom") continue;
      const cron = cronForPreset(preset.id);
      const selection = presetForCron(cron);
      expect(selection.presetId, preset.id).toBe(preset.id);
      // The prefilled inputs rebuild the same expression, so reopening changes nothing.
      expect(cronForPreset(selection.presetId, selection.parts), preset.id).toBe(cron);
    }
  });

  it("round-trips the inputs a preset was configured with", () => {
    const cases = [
      { id: "hourly-at", parts: { minute: 25 } },
      { id: "daily", parts: { hour: 21, minute: 5 } },
      { id: "weekly", parts: { weekday: 3, hour: 7, minute: 45 } },
    ] as const;
    for (const c of cases) {
      const cron = cronForPreset(c.id, c.parts);
      const selection = presetForCron(cron);
      expect(selection.presetId, cron).toBe(c.id);
      expect(selection.parts).toMatchObject(c.parts);
      expect(cronForPreset(selection.presetId, selection.parts)).toBe(cron);
    }
  });

  it("opens every DEFAULT_SCHEDULES cron on a real preset", () => {
    for (const d of DEFAULT_SCHEDULES) {
      const selection = presetForCron(d.cron);
      expect(selection.presetId, d.type).not.toBe("custom");
      expect(cronForPreset(selection.presetId, selection.parts), d.type).toBe(d.cron);
    }
  });

  it("resolves a hand-written expression to custom", () => {
    for (const expr of ["0,30 9-17 * * 1-5", "*/7 * * * *", "0 0 1 * *", "garbage"]) {
      expect(presetForCron(expr).presetId, expr).toBe("custom");
    }
  });

  it("puts minute 0 on the plain hourly item and other minutes on the parameterised one", () => {
    expect(presetForCron("0 * * * *").presetId).toBe("hourly");
    expect(presetForCron("20 * * * *")).toEqual({
      presetId: "hourly-at",
      parts: expect.objectContaining({ minute: 20 }),
    });
  });
});

describe("isFastCadence", () => {
  it("fires on cadences tighter than 5 minutes and not on */5", () => {
    expect(isFastCadence("*/1 * * * *")).toBe(true);
    expect(isFastCadence("* * * * *")).toBe(true);
    expect(isFastCadence("*/4 * * * *")).toBe(true);
    expect(isFastCadence("0,1 * * * *")).toBe(true);
    expect(isFastCadence("*/5 * * * *")).toBe(false);
    expect(isFastCadence("*/15 * * * *")).toBe(false);
  });

  it("leaves every default schedule unflagged", () => {
    for (const d of DEFAULT_SCHEDULES) expect(isFastCadence(d.cron), d.type).toBe(false);
  });

  it("counts the wrap into the next hour only when every hour fires", () => {
    expect(isFastCadence("57,59 3 * * *")).toBe(true); // gap within the hour
    expect(isFastCadence("58 3 * * *")).toBe(false); // once a day, no gap at all
    expect(isFastCadence("58 * * * *")).toBe(false); // hourly: 60 minutes apart
    expect(isFastCadence("58,59,0,1 * * * *")).toBe(true);
  });

  it("does not flag an unparseable expression", () => {
    expect(isFastCadence("garbage")).toBe(false);
  });

  it("takes a caller-supplied threshold", () => {
    expect(FAST_CADENCE_MINUTES).toBe(5);
    expect(isFastCadence("*/10 * * * *", 15)).toBe(true);
    expect(isFastCadence("*/10 * * * *", 10)).toBe(false);
  });
});

describe("preset table", () => {
  it("covers the cadences the picker promises", () => {
    expect(CADENCE_PRESETS.map((p) => p.id)).toEqual([
      "every-5-minutes",
      "every-10-minutes",
      "every-15-minutes",
      "every-30-minutes",
      "hourly",
      "hourly-at",
      "daily",
      "weekly",
      "custom",
    ]);
  });

  it("declares the inputs each preset needs and defaults them in range", () => {
    expect(presetById("daily")?.fields).toEqual(["hour", "minute"]);
    expect(presetById("weekly")?.fields).toEqual(["weekday", "hour", "minute"]);
    expect(presetById("hourly-at")?.fields).toEqual(["minute"]);
    expect(presetById("every-5-minutes")?.fields).toEqual([]);
    for (const p of CADENCE_PRESETS) {
      expect(p.defaults.minute, p.id).toBeGreaterThanOrEqual(0);
      expect(p.defaults.minute, p.id).toBeLessThanOrEqual(59);
      expect(p.defaults.hour, p.id).toBeLessThanOrEqual(23);
      expect(WEEKDAY_LABELS[p.defaults.weekday], p.id).toBeTruthy();
    }
  });
});

describe("dailyEquivalentOf (anton-3xa9)", () => {
  it("promotes a weekly cadence to daily at the operator's own time of day", () => {
    // product-master's shipped default: the offer must keep 06:00, not reset it to a preset hour.
    expect(dailyEquivalentOf("0 6 * * 1")).toBe("0 6 * * *");
    expect(describeCron(dailyEquivalentOf("30 22 * * 5")!)).toBe("Daily at 22:30");
  });

  it("has nothing to offer a cadence that is already daily or faster", () => {
    expect(dailyEquivalentOf("0 6 * * *")).toBeNull();
    expect(dailyEquivalentOf("0 * * * *")).toBeNull();
    expect(dailyEquivalentOf("*/10 * * * *")).toBeNull();
  });

  it("refuses to rewrite an expression the operator hand-built", () => {
    // Fires weekly-ish, but it is not the weekly PRESET — rewriting it would lose the choice.
    expect(dailyEquivalentOf("0 6 * * 1,4")).toBeNull();
    expect(dailyEquivalentOf("0 6 1 * 1")).toBeNull();
    expect(dailyEquivalentOf("garbage")).toBeNull();
  });
});
