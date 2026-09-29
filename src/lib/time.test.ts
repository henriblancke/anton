import { describe, expect, it } from "vitest";
import { formatDuration, formatExactTime, formatRelativeTime } from "./time";

const NOW = Date.parse("2026-07-13T12:00:00Z");

describe("formatRelativeTime", () => {
  it("renders seconds/minutes/hours/days buckets", () => {
    expect(formatRelativeTime("2026-07-13T11:59:30Z", NOW)).toBe("30s ago");
    expect(formatRelativeTime("2026-07-13T11:45:00Z", NOW)).toBe("15m ago");
    expect(formatRelativeTime("2026-07-13T09:00:00Z", NOW)).toBe("3h ago");
    expect(formatRelativeTime("2026-07-10T12:00:00Z", NOW)).toBe("3d ago");
  });

  it("clamps future timestamps to 0s rather than negative", () => {
    expect(formatRelativeTime("2026-07-13T12:00:30Z", NOW)).toBe("0s ago");
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatRelativeTime(null)).toBeNull();
    expect(formatRelativeTime(undefined)).toBeNull();
    expect(formatRelativeTime("")).toBeNull();
    expect(formatRelativeTime("not-a-date")).toBeNull();
  });
});

describe("formatExactTime", () => {
  it("returns a non-empty formatted string for a valid timestamp", () => {
    expect(formatExactTime("2026-07-13T12:00:00Z")).toBeTruthy();
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatExactTime(null)).toBeNull();
    expect(formatExactTime("nope")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("reports at most two units, largest first", () => {
    expect(formatDuration(18_000)).toBe("18s");
    expect(formatDuration(272_000)).toBe("4m 32s");
    expect(formatDuration(8_100_000)).toBe("2h 15m");
    expect(formatDuration(275_400_000)).toBe("3d 4h");
  });

  it("drops a trailing zero unit rather than padding it", () => {
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(7_200_000)).toBe("2h");
    expect(formatDuration(172_800_000)).toBe("2d");
  });

  it("keeps a sub-second span visible instead of rounding it to nothing", () => {
    // Real work that took a moment is not the same fact as no work at all, and the ledger's floor
    // markers can only mean something if a measured span never reads as zero.
    expect(formatDuration(400)).toBe("<1s");
    expect(formatDuration(0)).toBe("0s");
    // The half of the sub-second range that rounding-before-checking used to carry up to "1s".
    expect(formatDuration(500)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
  });

  it("rounds a full second up only once the span reaches 1000ms", () => {
    expect(formatDuration(1000)).toBe("1s");
  });

  it("clamps a negative span to zero rather than rendering a minus sign", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});
