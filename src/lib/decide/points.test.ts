/**
 * The registry's own invariants: a bad shape or a duplicate id must fail at {@link definePoint} time,
 * not surface as a wrong decision three calls later.
 */
import { afterEach, describe, expect, it } from "vitest";
import { definePoint, getPoint, listPoints, resetRegistryForTests } from "./points";

afterEach(() => resetRegistryForTests());

const CHOICE_POINT = {
  id: "review-nit",
  question: { kind: "choice", options: ["fix", "decline", "human"] },
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

  it("rejects a threshold outside [0, 1]", () => {
    expect(() => definePoint({ ...CHOICE_POINT, threshold: 1.5 })).toThrow(/threshold/);
    expect(() => definePoint({ ...CHOICE_POINT, threshold: -0.1 })).toThrow(/threshold/);
  });

  it("rejects a choice question with fewer than two options", () => {
    expect(() =>
      definePoint({ ...CHOICE_POINT, question: { kind: "choice", options: ["human"] } }),
    ).toThrow(/fewer than two options/);
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
        consequence: "med",
        threshold: 0.9,
        defaultMode: "shadow",
        stateFields: [],
        hardRules: [],
        escapeValue: "human",
      }),
    ).toThrow(/escapeValue only applies to choice/);
  });

  it("accepts a score question with no escapeValue", () => {
    const point = definePoint({
      id: "confidence-score",
      question: { kind: "score", min: 0, max: 1 },
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
