/**
 * Unit tests for the cron parser + nextRun (anton-3t2.1). Times are local; tests build Dates with
 * local constructors so they don't depend on the runner's timezone.
 */
import { describe, expect, it } from "vitest";
import { isValidCron, matches, nextRun, parseCron } from "./cron";

/** Local-time Date builder (month is 1-based here for readability). */
function d(y: number, mo: number, day: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, day, h, mi, 0, 0);
}

describe("parseCron", () => {
  it("expands *, ranges, lists and steps", () => {
    const c = parseCron("0,30 9-17 * * 1-5");
    expect([...c.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect([...c.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...c.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(c.domRestricted).toBe(false);
    expect(c.dowRestricted).toBe(true);
  });

  it("supports */n steps", () => {
    const c = parseCron("*/15 * * * *");
    expect([...c.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it("treats day-of-week 7 as Sunday (0)", () => {
    const c = parseCron("0 0 * * 7");
    expect(c.dow.has(0)).toBe(true);
  });

  it("rejects malformed / out-of-range expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 25 * * *")).toThrow(/out of range/);
    expect(isValidCron("*/0 * * * *")).toBe(false);
    expect(isValidCron("0 0 * * *")).toBe(true);
  });
});

describe("matches", () => {
  it("honors the DOM/DOW OR rule when both are restricted", () => {
    // "on the 1st OR on Monday"
    const c = parseCron("0 0 1 * 1");
    expect(matches(c, d(2026, 7, 1, 0, 0))).toBe(true); // the 1st (a Wednesday)
    expect(matches(c, d(2026, 7, 6, 0, 0))).toBe(true); // a Monday
    expect(matches(c, d(2026, 7, 7, 0, 0))).toBe(false); // Tuesday, not the 1st
  });

  it("ANDs the day fields when only one is restricted", () => {
    const c = parseCron("0 0 15 * *");
    expect(matches(c, d(2026, 7, 15, 0, 0))).toBe(true);
    expect(matches(c, d(2026, 7, 16, 0, 0))).toBe(false);
  });
});

describe("nextRun", () => {
  it("returns the next matching minute strictly after `after`", () => {
    const after = d(2026, 7, 11, 3, 0).getTime();
    // daily at 03:00 → next is tomorrow 03:00
    const next = new Date(nextRun("0 3 * * *", after));
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(6); // July (0-based)
    expect(next.getDate()).toBe(12);
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
  });

  it("advances within the same day for a later slot", () => {
    const after = d(2026, 7, 11, 3, 0).getTime();
    const next = new Date(nextRun("30 3 * * *", after));
    expect(next.getDate()).toBe(11);
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(30);
  });

  it("is strictly after — never returns `after` itself", () => {
    const at = d(2026, 7, 11, 3, 0);
    const next = nextRun("0 3 * * *", at.getTime());
    expect(next).toBeGreaterThan(at.getTime());
    expect(new Date(next).getDate()).toBe(12); // skipped to tomorrow
  });

  it("handles */15 every quarter hour", () => {
    const after = d(2026, 7, 11, 3, 7).getTime();
    const next = new Date(nextRun("*/15 * * * *", after));
    expect(next.getMinutes()).toBe(15);
    expect(next.getHours()).toBe(3);
  });
});
