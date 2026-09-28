/**
 * The registry's own invariants: a bad shape or a duplicate id must fail at {@link definePoint} time,
 * not surface as a wrong decision three calls later.
 */
import { afterEach, describe, expect, it } from "vitest";
import { definePoint, getPoint, listPoints, narrowState, resetRegistryForTests } from "./points";

afterEach(() => resetRegistryForTests());

const CHOICE_POINT = {
  id: "review-nit",
  question: { kind: "choice", options: ["fix", "decline", "human"] },
  instruction: "Should this review nit be fixed, declined, or escalated to a human?",
  consequence: "low",
  threshold: 0.8,
  defaultMode: "shadow",
  stateFields: ["nitText"],
  hardRules: [],
  escapeValue: "human",
} as const;

describe("definePoint", () => {
  it("registers a valid point and makes it findable", () => {
    definePoint({ ...CHOICE_POINT });
    expect(getPoint("review-nit")).toEqual(CHOICE_POINT);
    expect(listPoints()).toEqual([CHOICE_POINT]);
  });

  it("rejects a duplicate id", () => {
    definePoint({ ...CHOICE_POINT });
    expect(() => definePoint({ ...CHOICE_POINT })).toThrow(/duplicate/);
  });

  it("rejects a missing id", () => {
    expect(() => definePoint({ ...CHOICE_POINT, id: "" })).toThrow(/needs an id/);
  });

  it("rejects a missing or blank instruction", () => {
    expect(() => definePoint({ ...CHOICE_POINT, instruction: "" })).toThrow(/needs an instruction/);
    expect(() => definePoint({ ...CHOICE_POINT, instruction: "   " })).toThrow(/needs an instruction/);
  });

  it("rejects a threshold outside [0, 1]", () => {
    expect(() => definePoint({ ...CHOICE_POINT, threshold: 1.5 })).toThrow(/threshold/);
    expect(() => definePoint({ ...CHOICE_POINT, threshold: -0.1 })).toThrow(/threshold/);
  });

  it("rejects a choice question with fewer than two options", () => {
    expect(() =>
      definePoint({ ...CHOICE_POINT, question: { kind: "choice", options: ["human"] } }),
    ).toThrow(/fewer than two options/);
  });

  it("rejects a choice question whose options are all duplicates of one value", () => {
    expect(() =>
      definePoint({
        ...CHOICE_POINT,
        question: { kind: "choice", options: ["fix", "fix"] },
        escapeValue: "fix",
      }),
    ).toThrow(/duplicate choice options/);
  });

  it("rejects a choice question with a duplicate alongside a distinct option", () => {
    // A malformed set like ['fix', 'fix', 'human'] used to pass the "two distinct values"
    // check while still breaking readDistribution's sum-to-1 accounting downstream.
    expect(() =>
      definePoint({ ...CHOICE_POINT, question: { kind: "choice", options: ["fix", "fix", "human"] } }),
    ).toThrow(/duplicate choice options/);
  });

  it("rejects a choice point with no escapeValue", () => {
    const withoutEscape = { ...CHOICE_POINT, escapeValue: undefined };
    expect(() => definePoint(withoutEscape)).toThrow(/escapeValue/);
  });

  it("rejects a choice point whose escapeValue isn't one of its options", () => {
    expect(() => definePoint({ ...CHOICE_POINT, escapeValue: "unknown" })).toThrow(/escapeValue/);
  });

  it("rejects an escapeValue on a score question — it has no in-band escape", () => {
    expect(() =>
      definePoint({
        id: "confidence-score",
        question: { kind: "score", min: 0, max: 1 },
        instruction: "How confident is this fix, from 0 to 1?",
        consequence: "med",
        threshold: 0.9,
        defaultMode: "shadow",
        stateFields: [],
        hardRules: [],
        escapeValue: "human",
      }),
    ).toThrow(/escapeValue only applies to choice/);
  });

  it("rejects an escapeValue on a yes-no question — it has no in-band escape", () => {
    expect(() =>
      definePoint({
        id: "should-retry",
        question: { kind: "yes-no" },
        instruction: "Should this failed job be retried?",
        consequence: "med",
        threshold: 0.9,
        defaultMode: "shadow",
        stateFields: [],
        hardRules: [],
        escapeValue: "human",
      }),
    ).toThrow(/escapeValue only applies to choice/);
  });

  it.each`
    label                          | min          | max
    ${"a non-finite min"}          | ${Number.NaN} | ${1}
    ${"a non-finite max"}          | ${0}          | ${Number.POSITIVE_INFINITY}
    ${"min greater than max"}      | ${1}          | ${0}
  `("rejects a score question with $label", ({ min, max }) => {
    expect(() =>
      definePoint({
        id: "confidence-score",
        question: { kind: "score", min, max },
        instruction: "How confident is this fix, from 0 to 1?",
        consequence: "med",
        threshold: 0.9,
        defaultMode: "shadow",
        stateFields: [],
        hardRules: [],
      }),
    ).toThrow(/score bounds/);
  });

  it("accepts a score question with no escapeValue", () => {
    const point = definePoint({
      id: "confidence-score",
      question: { kind: "score", min: 0, max: 1 },
      instruction: "How confident is this fix, from 0 to 1?",
      consequence: "med",
      threshold: 0.9,
      defaultMode: "shadow",
      stateFields: [],
      hardRules: [],
    });
    expect(point.escapeValue).toBeUndefined();
  });

  it("accepts a yes-no question with no escapeValue", () => {
    const point = definePoint({
      id: "should-retry",
      question: { kind: "yes-no" },
      instruction: "Should this failed job be retried?",
      consequence: "med",
      threshold: 0.9,
      defaultMode: "shadow",
      stateFields: [],
      hardRules: [],
    });
    expect(point.escapeValue).toBeUndefined();
  });
});

describe("resetRegistryForTests", () => {
  it("clears every registered point", () => {
    definePoint({ ...CHOICE_POINT });
    resetRegistryForTests();
    expect(listPoints()).toEqual([]);
    expect(getPoint("review-nit")).toBeUndefined();
  });
});

describe("narrowState", () => {
  it("picks only the point's declared fields", () => {
    const point = { ...CHOICE_POINT, stateFields: ["nitText"] };
    expect(narrowState(point, { nitText: "x", secret: "y" })).toEqual({ nitText: "x" });
  });

  it("preserves a declared field named `__proto__` as an own property instead of the inherited setter", () => {
    // Assigning `picked["__proto__"] = …` on a plain object literal reassigns the object's
    // prototype rather than creating an own property, silently dropping the field from both
    // the backend prompt and decisionInputHash.
    const point = { ...CHOICE_POINT, stateFields: ["__proto__"] };
    // Computed key: an object literal's bare `__proto__:` sets the prototype instead of
    // creating an own property, so the input itself needs the same own-property trick.
    const state = { ["__proto__"]: "malicious-looking-value" };
    const narrowed = narrowState(point, state);

    expect(Object.getOwnPropertyDescriptor(narrowed, "__proto__")?.value).toBe("malicious-looking-value");
    expect(Object.keys(narrowed)).toEqual(["__proto__"]);
  });
});
