/**
 * Unit tests for the machine-readable outcome parser (anton-j5i8): delivered / blocked /
 * needs-human / missing, plus the last-line-wins and mid-prose-ignored rules the harness
 * cross-check depends on — and the block classification (anton-ie05 / R5.1, R5.2), whose whole
 * job is to tell the classified format from the legacy one without ever guessing.
 */
import { describe, expect, it } from "vitest";
import { BLOCK_CLASSES, formatAntonResult, isBlockClass, parseAntonResult } from "./anton-result";

describe("parseAntonResult", () => {
  it("parses a bare delivered line", () => {
    expect(parseAntonResult("ANTON-RESULT: delivered")).toEqual({ outcome: "delivered" });
  });

  it("parses a blocked line with an em-dash reason", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked — missing DB migration")).toEqual({
      outcome: "blocked",
      klass: "other",
      reason: "missing DB migration",
    });
  });

  it("accepts hyphen and colon separators before the reason", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked - red build")).toEqual({
      outcome: "blocked",
      klass: "other",
      reason: "red build",
    });
    expect(parseAntonResult("ANTON-RESULT: blocked: red build")).toEqual({
      outcome: "blocked",
      klass: "other",
      reason: "red build",
    });
  });

  it("parses a blocked line with no reason", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked")).toEqual({ outcome: "blocked", klass: "other" });
  });

  it("parses a needs-human line with an ask", () => {
    expect(parseAntonResult("ANTON-RESULT: needs-human — needs a Stripe API key")).toEqual({
      outcome: "needs-human",
      reason: "needs a Stripe API key",
    });
  });

  it("parses a needs-human line with no ask", () => {
    expect(parseAntonResult("ANTON-RESULT: needs-human")).toEqual({ outcome: "needs-human" });
  });

  it("accepts every separator before the needs-human ask", () => {
    for (const line of [
      "ANTON-RESULT: needs-human — click deploy in the dashboard",
      "ANTON-RESULT: needs-human – click deploy in the dashboard",
      "ANTON-RESULT: needs-human - click deploy in the dashboard",
      "ANTON-RESULT: needs-human: click deploy in the dashboard",
      "ANTON-RESULT: needs-human click deploy in the dashboard",
    ]) {
      expect(parseAntonResult(line)).toEqual({
        outcome: "needs-human",
        reason: "click deploy in the dashboard",
      });
    }
  });

  it("is case-insensitive on the needs-human token", () => {
    expect(parseAntonResult("anton-result: Needs-Human — approve the account")).toEqual({
      outcome: "needs-human",
      reason: "approve the account",
    });
  });

  it("ignores a needs-human mention buried mid-sentence (must start the line)", () => {
    expect(
      parseAntonResult("If I cannot proceed I emit ANTON-RESULT: needs-human — a credential."),
    ).toBeNull();
  });

  it("takes the LAST result line when a run corrects itself to needs-human", () => {
    const text = [
      "ANTON-RESULT: delivered",
      "on reflection, the last step needs an account only a person can create:",
      "ANTON-RESULT: needs-human — someone must create the Vercel project",
    ].join("\n");
    expect(parseAntonResult(text)).toEqual({
      outcome: "needs-human",
      reason: "someone must create the Vercel project",
    });
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

describe("parseAntonResult — block classification (anton-ie05)", () => {
  it("parses every class in the closed enum, with the prose kept whole", () => {
    for (const klass of BLOCK_CLASSES) {
      expect(parseAntonResult(`ANTON-RESULT: blocked — ${klass} — the reason, in prose`)).toEqual({
        outcome: "blocked",
        klass,
        reason: "the reason, in prose",
      });
    }
  });

  it("accepts every separator between the class and the prose", () => {
    for (const line of [
      "ANTON-RESULT: blocked — ref-stale — src/a.ts moved",
      "ANTON-RESULT: blocked — ref-stale – src/a.ts moved",
      "ANTON-RESULT: blocked — ref-stale - src/a.ts moved",
      "ANTON-RESULT: blocked — ref-stale : src/a.ts moved",
    ]) {
      expect(parseAntonResult(line)).toEqual({
        outcome: "blocked",
        klass: "ref-stale",
        reason: "src/a.ts moved",
      });
    }
  });

  it("parses a class with no prose after it", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked — env")).toEqual({
      outcome: "blocked",
      klass: "env",
    });
    expect(parseAntonResult("ANTON-RESULT: blocked — oversized —")).toEqual({
      outcome: "blocked",
      klass: "oversized",
    });
  });

  it("keeps only the FIRST split — an em dash inside the prose is prose", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked — dep-missing — needs anton-x — which is open")).toEqual({
      outcome: "blocked",
      klass: "dep-missing",
      reason: "needs anton-x — which is open",
    });
  });

  it("degrades an UNKNOWN class to `other`, text untouched", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked — kaboom — the thing broke")).toEqual({
      outcome: "blocked",
      klass: "other",
      reason: "kaboom — the thing broke",
    });
  });

  it("degrades a classless blocked line to `other` (R5.2)", () => {
    expect(parseAntonResult("ANTON-RESULT: blocked")).toEqual({ outcome: "blocked", klass: "other" });
    expect(parseAntonResult("ANTON-RESULT: blocked — the build was already red")).toEqual({
      outcome: "blocked",
      klass: "other",
      reason: "the build was already red",
    });
  });

  it("never classifies `delivered` or `needs-human`", () => {
    expect(parseAntonResult("ANTON-RESULT: delivered")).toEqual({ outcome: "delivered" });
    expect(parseAntonResult("ANTON-RESULT: delivered — ref-stale — noise")).toEqual({
      outcome: "delivered",
    });
    expect(parseAntonResult("ANTON-RESULT: needs-human — env — needs a Stripe key")).toEqual({
      outcome: "needs-human",
      reason: "env — needs a Stripe key",
    });
  });

  it("takes the LAST classified line, as with any other result line", () => {
    const text = [
      "ANTON-RESULT: blocked — ref-stale — src/a.ts moved",
      "on reflection, the pointer is fine and the dependency is not:",
      "ANTON-RESULT: blocked — dep-missing — anton-x has to land first",
    ].join("\n");
    expect(parseAntonResult(text)).toEqual({
      outcome: "blocked",
      klass: "dep-missing",
      reason: "anton-x has to land first",
    });
  });
});

/**
 * The rollout regressions: a fleet mid-rollout emits both formats, and every one of these lines is
 * LEGACY PROSE. Each asserts `other` plus a reason byte-identical to what the pre-classification
 * parser returned — the whole text after the outcome separator, trimmed and nothing else.
 */
describe("parseAntonResult — legacy prose is never mistaken for a class", () => {
  const LEGACY = [
    "ref to the missing component — see X",
    "ref to the missing component",
    "env ironment is fine, the test is not",
    "dep on anton-x that nobody drew",
    "acceptance is missing the third criterion",
    "oversized? no — the API is just undocumented",
    "REF-STALE — shouting is not the contract",
    "Ref-stale — neither is title case",
    "ref-stale-ish — a longer word that merely starts the same way",
    "dep-missing-thing — a hyphen inside a word is not a separator",
    "other things went wrong",
  ];

  it("parses each as class `other`, with the reason byte-identical to today's parse", () => {
    for (const prose of LEGACY) {
      expect(parseAntonResult(`ANTON-RESULT: blocked — ${prose}`)).toEqual({
        outcome: "blocked",
        klass: "other",
        reason: prose,
      });
    }
  });
});

describe("isBlockClass", () => {
  it("accepts exactly the enum, and nothing that merely resembles it", () => {
    for (const klass of BLOCK_CLASSES) expect(isBlockClass(klass)).toBe(true);
    for (const notAClass of ["ref", "REF-STALE", "Ref-stale", "ref-stale-ish", "dep", "", undefined]) {
      expect(isBlockClass(notAClass)).toBe(false);
    }
  });
});

describe("formatAntonResult", () => {
  it("renders each outcome and the missing case", () => {
    expect(formatAntonResult({ outcome: "delivered" })).toBe("delivered");
    expect(formatAntonResult({ outcome: "blocked", reason: "no migration" })).toBe(
      "blocked — no migration",
    );
    expect(formatAntonResult({ outcome: "blocked" })).toBe("blocked — (no reason given)");
    expect(formatAntonResult({ outcome: "needs-human", reason: "needs a Stripe key" })).toBe(
      "needs-human — needs a Stripe key",
    );
    expect(formatAntonResult({ outcome: "needs-human" })).toBe("needs-human — (no ask given)");
    expect(formatAntonResult(null)).toContain("no ANTON-RESULT line");
  });

  it("names the class when there is one to name, and stays quiet on `other`", () => {
    expect(formatAntonResult({ outcome: "blocked", klass: "ref-stale", reason: "src/a.ts moved" })).toBe(
      "blocked — ref-stale — src/a.ts moved",
    );
    expect(formatAntonResult({ outcome: "blocked", klass: "other", reason: "no migration" })).toBe(
      "blocked — no migration",
    );
    expect(formatAntonResult({ outcome: "blocked", klass: "env" })).toBe(
      "blocked — env — (no reason given)",
    );
  });
});
