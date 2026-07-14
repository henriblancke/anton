import { describe, expect, it } from "vitest";
import { formatExactTime, formatRelativeTime } from "./time";

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
