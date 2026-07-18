/**
 * Unit tests for the machine-readable outcome parser (anton-j5i8): delivered / blocked / missing,
 * plus the last-line-wins and mid-prose-ignored rules the harness cross-check depends on.
 */
import { describe, expect, it } from "vitest";
import { formatAntonResult, parseAntonResult } from "./anton-result";

describe("parseAntonResult", () => {
  it("parses a bare delivered line", () => {
    expect(parseAntonResult("ANTON-RESULT: delivered")).toEqual({ outcome: "delivered" });
  });

  it("parses a blocked line with an em-dash reason", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked — missing DB migration")).toEqual({
      outcome: "blocked",
      reason: "missing DB migration",
    });
  });

  it("accepts hyphen and colon separators before the reason", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked - red build")).toEqual({
      outcome: "blocked",
      reason: "red build",
    });
    expect(parseAntonResult("ANTON-RESULT: blocked: red build")).toEqual({
      outcome: "blocked",
      reason: "red build",
    });
  });

  it("parses a blocked line with no reason", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked")).toEqual({ outcome: "blocked" });
  });

  it("takes the LAST result line when several appear", () => {
    const text = [
      "ANTON-RESULT: blocked — first attempt",
      "actually, on reflection:",
      "ANTON-RESULT: delivered",
    ].join("\n");
    expect(parseAntonResult(text)).toEqual({ outcome: "delivered" });
  });

  it("finds the line at the end of a longer transcript", () => {
    const text = "Summary of changes.\nRan tests: green.\n\nANTON-RESULT: delivered\n";
    expect(parseAntonResult(text)).toEqual({ outcome: "delivered" });
  });

  it("is case-insensitive on the token", () => {
    expect(parseAntonResult("anton-result: DELIVERED")).toEqual({ outcome: "delivered" });
  });

  it("ignores a mention buried mid-sentence (must start the line)", () => {
    expect(parseAntonResult("I will emit ANTON-RESULT: delivered at the end.")).toBeNull();
  });

  it("returns null for missing / empty / unparseable input", () => {
    expect(parseAntonResult(undefined)).toBeNull();
    expect(parseAntonResult(null)).toBeNull();
    expect(parseAntonResult("")).toBeNull();
    expect(parseAntonResult("all done, tests pass")).toBeNull();
    expect(parseAntonResult("ANTON-RESULT: maybe")).toBeNull();
  });
});

describe("formatAntonResult", () => {
  it("renders each outcome and the missing case", () => {
    expect(formatAntonResult({ outcome: "delivered" })).toBe("delivered");
    expect(formatAntonResult({ outcome: "blocked", reason: "no migration" })).toBe(
      "blocked — no migration",
    );
    expect(formatAntonResult({ outcome: "blocked" })).toBe("blocked — (no reason given)");
    expect(formatAntonResult(null)).toContain("no ANTON-RESULT line");
  });
});
