/**
 * Direct suite for bd-json.ts (anton-ql1n): the pure readers over bd's raw `--json` stdout, tested
 * against the module itself rather than through a consuming seam (./gate, ./cook, ./hygiene, ./bd).
 */
import { describe, expect, it } from "vitest";
import { asArray, num, parseJsonTail, pick, str, strings } from "@/lib/beads/bd-json";

describe("asArray", () => {
  it("passes a top-level array through unchanged", () => {
    expect(asArray('[{"id":"a"}]')).toEqual([{ id: "a" }]);
  });

  it("unwraps the issues/results/molecules envelopes bd uses", () => {
    expect(asArray('{"issues":[{"id":"a"}]}')).toEqual([{ id: "a" }]);
    expect(asArray('{"results":[{"id":"b"}]}')).toEqual([{ id: "b" }]);
    expect(asArray('{"count":1,"molecules":[{"id":"c"}]}')).toEqual([{ id: "c" }]);
  });

  it("falls back to [] for an empty string and for an unrecognised envelope", () => {
    expect(asArray("")).toEqual([]);
    expect(asArray('{"schema_version":1}')).toEqual([]);
    expect(asArray("null")).toEqual([]);
  });
});

describe("parseJsonTail", () => {
  it("pulls the trailing JSON object out of progress lines bd printed before it", () => {
    const raw = "gate 1: ok\ngate 2: ok\nChecked 2 gates\n" + JSON.stringify({ ok: true, n: 2 });
    expect(parseJsonTail(raw)).toEqual({ ok: true, n: 2 });
  });

  it("finds the summary even when an earlier line happens to contain a brace", () => {
    const raw = `note: {not json}\n${JSON.stringify({ ok: true })}`;
    expect(parseJsonTail(raw)).toEqual({ ok: true });
  });

  it("returns undefined when nothing in the string parses as JSON", () => {
    expect(parseJsonTail("no braces here at all")).toBeUndefined();
    expect(parseJsonTail("")).toBeUndefined();
  });
});

describe("str", () => {
  it("keeps a non-empty string and drops everything else", () => {
    expect(str("hello")).toBe("hello");
    expect(str("")).toBeUndefined();
    expect(str(undefined)).toBeUndefined();
    expect(str(null)).toBeUndefined();
    expect(str(42)).toBeUndefined();
  });
});

describe("strings", () => {
  it("filters an array down to its string members", () => {
    expect(strings(["a", 1, "b", null])).toEqual(["a", "b"]);
  });

  it("returns undefined for a non-array, and for an array with no strings", () => {
    expect(strings("a")).toBeUndefined();
    expect(strings(undefined)).toBeUndefined();
    expect(strings([1, 2, 3])).toBeUndefined();
  });
});

describe("pick", () => {
  it("includes the key only when the value is defined", () => {
    expect(pick("latestCommit", "abc1234")).toEqual({ latestCommit: "abc1234" });
    expect(pick("latestCommit", undefined)).toEqual({});
  });

  it("carries a falsy-but-defined value through (0, empty string)", () => {
    expect(pick("priority", 0)).toEqual({ priority: 0 });
    expect(pick("note", "")).toEqual({ note: "" });
  });
});

describe("num", () => {
  it("keeps a finite number and drops everything else", () => {
    expect(num(3)).toBe(3);
    expect(num(0)).toBe(0);
    expect(num(Number.NaN)).toBeUndefined();
    expect(num(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(num("3")).toBeUndefined();
    expect(num(undefined)).toBeUndefined();
  });
});
