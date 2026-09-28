/**
 * The mode/threshold matrix decide() exists to get right: shadow and assist compute the same answer
 * auto would, but neither is ever allowed to act on it, and auto only acts once confidence clears the
 * point's own threshold. Every case here shares one fake backend so the only thing that varies between
 * them is the input the pipeline is supposed to react to.
 */
import { describe, expect, it, vi } from "vitest";
import { decide, type ModelAnswer, type ModelCaller } from "./index";
import type { DecisionPoint, HardRule } from "./points";

function choicePoint(overrides: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    id: "review-nit",
    question: { kind: "choice", options: ["fix", "decline", "human"] },
    instruction: "Should this review nit be fixed, declined, or escalated to a human?",
    consequence: "low",
    threshold: 0.8,
    defaultMode: "shadow",
    stateFields: ["nitText"],
    hardRules: [],
    escapeValue: "human",
    ...overrides,
  };
}

function scorePoint(overrides: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    id: "confidence-score",
    question: { kind: "score", min: 0, max: 1 },
    instruction: "How confident is this fix, from 0 to 1?",
    consequence: "med",
    threshold: 0.7,
    defaultMode: "shadow",
    stateFields: [],
    hardRules: [],
    ...overrides,
  };
}

function yesNoPoint(overrides: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    id: "should-retry",
    question: { kind: "yes-no" },
    instruction: "Should this failed job be retried?",
    consequence: "med",
    threshold: 0.7,
    defaultMode: "shadow",
    stateFields: [],
    hardRules: [],
    ...overrides,
  };
}

function askReturning(answer: ModelAnswer): ModelCaller {
  return vi.fn().mockResolvedValue(answer);
}

const MODEL_ANSWER = (overrides: Partial<ModelAnswer> = {}): ModelAnswer => ({
  value: "fix",
  confidence: 0.9,
  distribution: { fix: 0.9, decline: 0.08, human: 0.02 },
  backend: "fake-backend",
  modelVersion: "fake-1",
  ...overrides,
});

describe("mode × threshold matrix", () => {
  const point = choicePoint({ threshold: 0.8 });

  it.each`
    mode        | confidence | expectedActed
    ${"shadow"} | ${0.99}    | ${false}
    ${"shadow"} | ${0.1}     | ${false}
    ${"assist"} | ${0.99}    | ${false}
    ${"assist"} | ${0.1}     | ${false}
    ${"auto"}   | ${0.8}     | ${true}
    ${"auto"}   | ${0.9}     | ${true}
    ${"auto"}   | ${0.79}    | ${false}
    ${"auto"}   | ${0.1}     | ${false}
  `(
    "mode=$mode confidence=$confidence -> acted=$expectedActed",
    async ({ mode, confidence, expectedActed }) => {
      const ask = askReturning(MODEL_ANSWER({ confidence }));
      const result = await decide({ point, state: {}, mode, ask });

      expect(result.decidedBy).toBe("model");
      expect(result.answer).toBe("fix");
      expect(result.confidence).toBe(confidence);
      expect(result.acted).toBe(expectedActed);
      expect(result.mode).toBe(mode);
    },
  );

  it("shadow computes the identical answer auto would have acted on", async () => {
    const answer = MODEL_ANSWER({ confidence: 0.95 });
    const shadow = await decide({ point, state: {}, mode: "shadow", ask: askReturning(answer) });
    const auto = await decide({ point, state: {}, mode: "auto", ask: askReturning(answer) });

    expect(shadow.answer).toBe(auto.answer);
    expect(shadow.confidence).toBe(auto.confidence);
    expect(shadow.decidedBy).toBe(auto.decidedBy);
    expect(shadow.acted).toBe(false);
    expect(auto.acted).toBe(true);
  });

  it("falls back to point.defaultMode when no mode override is given", async () => {
    const defaultShadow = choicePoint({ defaultMode: "shadow", threshold: 0.1 });
    const result = await decide({
      point: defaultShadow,
      state: {},
      ask: askReturning(MODEL_ANSWER({ confidence: 0.99 })),
    });
    expect(result.mode).toBe("shadow");
    expect(result.acted).toBe(false);
  });
});

describe("off mode", () => {
  it("never calls the backend and answers with no answer at all", async () => {
    const ask = vi.fn();
    const result = await decide({ point: choicePoint(), state: {}, mode: "off", ask });

    expect(ask).not.toHaveBeenCalled();
    expect(result.decidedBy).toBe("fallback");
    expect(result.answer).toBeUndefined();
    expect(result.confidence).toBe(0);
    expect(result.acted).toBe(false);
  });
});

describe("hard rules", () => {
  const forcesHuman: HardRule = (state) =>
    state.riskHigh ? { value: "human", reason: "risk:high" } : undefined;

  it("short-circuits before any model call", async () => {
    const ask = vi.fn();
    const point = choicePoint({ hardRules: [forcesHuman] });
    const result = await decide({ point, state: { riskHigh: true }, mode: "shadow", ask });

    expect(ask).not.toHaveBeenCalled();
    expect(result.decidedBy).toBe("rule");
    expect(result.answer).toBe("human");
    expect(result.confidence).toBe(1);
    expect(result.reason).toBe("risk:high");
  });

  it("never acts outside auto mode even though its confidence is full", async () => {
    const point = choicePoint({ hardRules: [forcesHuman], threshold: 0.99 });
    const result = await decide({
      point,
      state: { riskHigh: true },
      mode: "assist",
      ask: vi.fn(),
    });
    expect(result.acted).toBe(false);
  });

  it("acts in auto mode regardless of the point's threshold — a rule is deterministic, not a guess", async () => {
    const point = choicePoint({ hardRules: [forcesHuman], threshold: 0.99 });
    const result = await decide({
      point,
      state: { riskHigh: true },
      mode: "auto",
      ask: vi.fn(),
    });
    expect(result.acted).toBe(true);
  });

  it("falls back when a hard rule answers outside its own point's question", async () => {
    // `HardRuleOutcome.value` is only the broad `AnswerValue` union, so TypeScript cannot catch a rule
    // that answers with a choice value not in `options` — this is the runtime boundary that must.
    const answersGarbage: HardRule = () => ({ value: "not-an-option", reason: "buggy rule" });
    const point = choicePoint({ hardRules: [answersGarbage], threshold: 0 });
    const ask = vi.fn();
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(ask).not.toHaveBeenCalled();
    expect(result.decidedBy).toBe("fallback");
    expect(result.reason).toBe("invalid hard-rule answer");
    expect(result.answer).toBeUndefined();
    expect(result.acted).toBe(false);
  });

  it("falls back when a hard rule answers an out-of-range score", async () => {
    const answersGarbage: HardRule = () => ({ value: 99, reason: "buggy rule" });
    const point = scorePoint({ hardRules: [answersGarbage], threshold: 0 });
    const result = await decide({ point, state: {}, mode: "auto", ask: vi.fn() });

    expect(result.decidedBy).toBe("fallback");
    expect(result.reason).toBe("invalid hard-rule answer");
    expect(result.acted).toBe(false);
  });

  it("defers to the model when no rule fires", async () => {
    const point = choicePoint({ hardRules: [forcesHuman] });
    const ask = askReturning(MODEL_ANSWER());
    const result = await decide({ point, state: { riskHigh: false }, mode: "shadow", ask });

    expect(ask).toHaveBeenCalledOnce();
    expect(result.decidedBy).toBe("model");
  });

  it("only sends the point's declared stateFields to the backend", async () => {
    const point = choicePoint({ stateFields: ["nitText"] });
    const ask = askReturning(MODEL_ANSWER());
    await decide({
      point,
      state: { nitText: "unused var", authorEmail: "operator@example.com" },
      mode: "shadow",
      ask,
    });

    expect(ask).toHaveBeenCalledWith(point, { nitText: "unused var" });
  });
});

describe("fallback on a bad backend", () => {
  const point = choicePoint();

  it("falls back when ask throws", async () => {
    const ask: ModelCaller = vi.fn().mockRejectedValue(new Error("timeout"));
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(result.decidedBy).toBe("fallback");
    expect(result.answer).toBeUndefined();
    expect(result.acted).toBe(false);
    expect(result.reason).toBe("model call failed");
  });

  it("falls back when the answer isn't one of the choice's options", async () => {
    const ask = askReturning(MODEL_ANSWER({ value: "not-an-option" }));
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(result.decidedBy).toBe("fallback");
    expect(result.reason).toBe("invalid model answer");
  });

  it("preserves backend/modelVersion on an invalid answer, so the log still attributes the attempt", async () => {
    // Dropping these here would erase which model just failed: recordDecision() would store null
    // attribution, and agreement()'s cohort lookup would keep reading a predecessor model as
    // "current" for as long as the replacement keeps failing every call (PR #332 review).
    const ask = askReturning(MODEL_ANSWER({ value: "not-an-option", backend: "claude-local", modelVersion: "claude-6" }));
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(result.decidedBy).toBe("fallback");
    expect(result.answer).toBeUndefined();
    expect(result.backend).toBe("claude-local");
    expect(result.modelVersion).toBe("claude-6");
  });

  it.each([-0.1, 1.1, Number.NaN])("falls back on an out-of-range confidence %s", async (confidence) => {
    const ask = askReturning(MODEL_ANSWER({ confidence }));
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(result.decidedBy).toBe("fallback");
  });

  it("never lets a fallback act, however permissive the threshold", async () => {
    const permissive = choicePoint({ threshold: 0 });
    const ask: ModelCaller = vi.fn().mockRejectedValue(new Error("timeout"));
    const result = await decide({ point: permissive, state: {}, mode: "auto", ask });

    expect(result.acted).toBe(false);
  });
});

describe("score questions", () => {
  it("accepts a value within [min, max]", async () => {
    const point = scorePoint({ threshold: 0.5 });
    const ask = askReturning({
      value: 0.6,
      confidence: 0.6,
      backend: "fake-backend",
      modelVersion: "fake-1",
    });
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(result.decidedBy).toBe("model");
    expect(result.answer).toBe(0.6);
    expect(result.acted).toBe(true);
  });

  it("falls back on a value outside [min, max]", async () => {
    const point = scorePoint();
    const ask = askReturning({
      value: 1.5,
      confidence: 0.9,
      backend: "fake-backend",
      modelVersion: "fake-1",
    });
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(result.decidedBy).toBe("fallback");
  });

  it("falls back on a non-numeric value", async () => {
    const point = scorePoint();
    const ask = askReturning({
      value: "0.5" as unknown as number,
      confidence: 0.9,
      backend: "fake-backend",
      modelVersion: "fake-1",
    });
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(result.decidedBy).toBe("fallback");
  });
});

describe("yes-no questions", () => {
  it("accepts a boolean answer", async () => {
    const point = yesNoPoint({ threshold: 0.5 });
    const ask = askReturning({
      value: true,
      confidence: 0.8,
      backend: "fake-backend",
      modelVersion: "fake-1",
    });
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(result.decidedBy).toBe("model");
    expect(result.answer).toBe(true);
    expect(result.acted).toBe(true);
  });

  it("falls back on a non-boolean value", async () => {
    const point = yesNoPoint();
    const ask = askReturning({
      value: "yes" as unknown as boolean,
      confidence: 0.9,
      backend: "fake-backend",
      modelVersion: "fake-1",
    });
    const result = await decide({ point, state: {}, mode: "auto", ask });

    expect(result.decidedBy).toBe("fallback");
  });
});

describe("model answer passthrough", () => {
  it("carries distribution, backend and modelVersion into the result", async () => {
    const point = choicePoint();
    const answer = MODEL_ANSWER({
      distribution: { fix: 0.7, decline: 0.2, human: 0.1 },
      backend: "claude-local",
      modelVersion: "claude-5-2026-09",
    });
    const result = await decide({ point, state: {}, mode: "shadow", ask: askReturning(answer) });

    expect(result.distribution).toEqual(answer.distribution);
    expect(result.backend).toBe("claude-local");
    expect(result.modelVersion).toBe("claude-5-2026-09");
  });
});
