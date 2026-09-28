/**
 * The write → settle → replay round trip the decision log exists for (anton-q5ixf): a decide() result
 * is recorded, the operator's own answer lands later, and `agreement` folds the settled pairs into the
 * figure a Settings row shows.
 *
 * The cases that matter most are the three ways the fold can invert — an unsettled row counted as a
 * disagreement, an answerless row counted as evidence, and a window that does not roll — plus the
 * digest's own promise that it only ever covers state the point declared.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import { decide, type ModelAnswer } from "./index";
import type { DecisionPoint } from "./points";
import {
  DECISION_AGREEMENT_WINDOW,
  agreement,
  decisionInputHash,
  listDecisions,
  recordDecision,
  recordDecisionOutcome,
  settleDecision,
} from "./log";

const POINT: DecisionPoint = {
  id: "review-nit",
  question: { kind: "choice", options: ["fix", "decline", "human"] },
  instruction: "Should this review nit be fixed, declined, or escalated to a human?",
  consequence: "low",
  threshold: 0.8,
  defaultMode: "shadow",
  stateFields: ["nitText"],
  hardRules: [],
  escapeValue: "human",
};

const ANSWER = (overrides: Partial<ModelAnswer> = {}): ModelAnswer => ({
  value: "fix",
  confidence: 0.91,
  distribution: { fix: 0.91, decline: 0.07, human: 0.02 },
  backend: "claude-local",
  modelVersion: "claude-opus-5",
  ...overrides,
});

let test: TestDb;
/** A settable clock so a window's ORDER is asserted on stamps this test chose, never on wall time. */
let nowMs: number;
const clock = { now: () => nowMs };

beforeEach(() => {
  test = makeTestDb();
  nowMs = 1_700_000_000_000;
});

afterEach(() => test.close());

/** Record one shadow decision through the real pipeline and return its row id. */
async function recordShadow(
  answer: ModelAnswer = ANSWER(),
  state: Record<string, unknown> = { nitText: "prefer const" },
): Promise<string> {
  const result = await decide({ point: POINT, state, mode: "shadow", ask: async () => answer });
  const id = await recordDecision(test.db, clock, {
    result,
    point: POINT,
    state,
    projectId: "proj-a",
  });
  if (!id) throw new Error("expected the log write to land");
  return id;
}

describe("write", () => {
  it("records every field of a shadow decision, with no operator half yet", async () => {
    const id = await recordShadow();

    const [row] = await listDecisions(test.db, POINT.id);
    expect(row).toMatchObject({
      id,
      point: "review-nit",
      mode: "shadow",
      decidedBy: "model",
      answer: "fix",
      confidence: 0.91,
      distribution: { fix: 0.91, decline: 0.07, human: 0.02 },
      backend: "claude-local",
      modelVersion: "claude-opus-5",
      // Shadow computes the answer auto would have acted on and acts on nothing — the whole reason
      // this log exists.
      acted: false,
    });
    expect(row.operatorAnswer).toBeUndefined();
    expect(row.settledAtMs).toBeUndefined();
    expect(row.inputHash).toBe(decisionInputHash(POINT, { nitText: "prefer const" }));
  });

  it("records an answerless fallback with the reason it fell back", async () => {
    const result = await decide({
      point: POINT,
      state: { nitText: "x" },
      mode: "shadow",
      ask: async () => {
        throw new Error("timeout");
      },
    });
    await recordDecision(test.db, clock, { result, point: POINT, state: { nitText: "x" } });

    const [row] = await listDecisions(test.db, POINT.id);
    expect(row.decidedBy).toBe("fallback");
    expect(row.answer).toBeUndefined();
    expect(row.reason).toBe("model call failed");
  });

  it("never throws — a log that cannot be written must not fail the decision", async () => {
    test.close();
    const result = await decide({
      point: POINT,
      state: {},
      mode: "shadow",
      ask: async () => ANSWER(),
    });

    await expect(
      recordDecision(test.db, clock, { result, point: POINT, state: {} }),
    ).resolves.toBeUndefined();
  });

  it("appends a re-decision rather than revising the first row", async () => {
    const first = await recordShadow(ANSWER({ confidence: 0.5 }));
    nowMs += 60_000;
    const second = await recordShadow(ANSWER({ confidence: 0.99 }));

    const rows = await listDecisions(test.db, POINT.id);
    expect(rows.map((r) => r.id)).toEqual([second, first]);
    expect(rows.map((r) => r.confidence)).toEqual([0.99, 0.5]);
  });
});

describe("the input digest", () => {
  it("covers only the fields the point declared", () => {
    const declared = decisionInputHash(POINT, { nitText: "prefer const" });
    const withUndeclaredField = decisionInputHash(POINT, {
      nitText: "prefer const",
      undeclaredField: "must never move the digest",
    });

    // The narrowing is the untrusted-text boundary: state the backend never saw must not move the
    // digest, or the log would claim a decision over inputs nothing was asked about.
    expect(withUndeclaredField).toBe(declared);
  });

  it("is stable across key order and moves when a declared field changes", () => {
    const point: DecisionPoint = { ...POINT, stateFields: ["a", "b"] };

    expect(decisionInputHash(point, { a: 1, b: 2 })).toBe(decisionInputHash(point, { b: 2, a: 1 }));
    expect(decisionInputHash(point, { a: 1, b: 2 })).not.toBe(
      decisionInputHash(point, { a: 1, b: 3 }),
    );
  });

  it("distinguishes a number from its own string form", () => {
    const point: DecisionPoint = { ...POINT, stateFields: ["score"] };
    expect(decisionInputHash(point, { score: 1 })).not.toBe(
      decisionInputHash(point, { score: "1" }),
    );
  });

  it("digests an unencodable value rather than throwing", () => {
    const point: DecisionPoint = { ...POINT, stateFields: ["cycle"] };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(() => decisionInputHash(point, { cycle })).not.toThrow();
    // Still distinguishable from an absent field — an input nobody can serialize is an input.
    expect(decisionInputHash(point, { cycle })).not.toBe(decisionInputHash(point, {}));
  });
});

describe("settle", () => {
  it("records the operator's answer, the act behind it, and the stamp", async () => {
    const id = await recordShadow();
    nowMs += 3_600_000;

    expect(
      await settleDecision(test.db, clock, id, {
        operatorAnswer: "decline",
        operatorAction: "decline",
      }),
    ).toBe(true);

    const [row] = await listDecisions(test.db, POINT.id);
    expect(row.operatorAnswer).toBe("decline");
    expect(row.operatorAction).toBe("decline");
    expect(row.settledAtMs).toBe(nowMs);
    // The decision half is untouched — a settle records what the operator did, never rewrites what
    // anton decided.
    expect(row.answer).toBe("fix");
  });

  it("refuses a second settle — a row carries ONE operator answer", async () => {
    const id = await recordShadow();
    await settleDecision(test.db, clock, id, { operatorAnswer: "fix" });

    expect(await settleDecision(test.db, clock, id, { operatorAnswer: "decline" })).toBe(false);

    const [row] = await listDecisions(test.db, POINT.id);
    expect(row.operatorAnswer).toBe("fix");
  });

  it("reports false for a decision it has never seen", async () => {
    expect(await settleDecision(test.db, clock, "nope", { operatorAnswer: "fix" })).toBe(false);
  });

  it("records the outcome later, and refuses one on an unsettled row", async () => {
    const id = await recordShadow();

    // An outcome with no operator answer beside it explains nothing.
    expect(await recordDecisionOutcome(test.db, id, "merged")).toBe(false);

    await settleDecision(test.db, clock, id, { operatorAnswer: "fix" });
    expect(await recordDecisionOutcome(test.db, id, "merged")).toBe(true);
    expect((await listDecisions(test.db, POINT.id))[0].outcome).toBe("merged");
  });
});

describe("replay — agreement(point)", () => {
  /** Settle `n` decisions, each either matching anton's answer or not, one minute apart. */
  async function settleMany(verdicts: boolean[]): Promise<void> {
    for (const agreed of verdicts) {
      const id = await recordShadow();
      nowMs += 60_000;
      await settleDecision(test.db, clock, id, { operatorAnswer: agreed ? "fix" : "decline" });
      nowMs += 60_000;
    }
  }

  it("reports zero samples over an empty log — not measured, never disagreement", async () => {
    expect(await agreement(test.db, POINT.id)).toEqual({
      point: "review-nit",
      settled: 0,
      agreed: 0,
    });
  });

  it("counts the pairs the operator matched", async () => {
    await settleMany([true, true, false, true]);

    expect(await agreement(test.db, POINT.id)).toEqual({
      point: "review-nit",
      settled: 4,
      agreed: 3,
    });
  });

  it("excludes UNSETTLED rows — nobody has answered them yet", async () => {
    await settleMany([true, true]);
    await recordShadow();
    await recordShadow();

    // Four rows, two answers. Counting the open ones would drive a point's agreement toward zero
    // simply by using it.
    expect(await listDecisions(test.db, POINT.id)).toHaveLength(4);
    expect(await agreement(test.db, POINT.id)).toMatchObject({ settled: 2, agreed: 2 });
  });

  it("excludes ANSWERLESS rows even once settled — a broken backend is not a disagreement", async () => {
    const result = await decide({
      point: POINT,
      state: {},
      mode: "shadow",
      ask: async () => {
        throw new Error("timeout");
      },
    });
    const id = await recordDecision(test.db, clock, { result, point: POINT, state: {} });
    await settleDecision(test.db, clock, id!, { operatorAnswer: "human" });

    expect(await agreement(test.db, POINT.id)).toMatchObject({ settled: 0, agreed: 0 });
  });

  it("counts a match on the answer, not on the act that produced it", async () => {
    const id = await recordShadow();
    await settleDecision(test.db, clock, id, {
      operatorAnswer: "fix",
      // A different affordance, the same answer — the answer is the evidence.
      operatorAction: "fix-and-reply",
    });

    expect(await agreement(test.db, POINT.id)).toMatchObject({ settled: 1, agreed: 1 });
  });

  it("does not read a number as its own string form", async () => {
    const scorePoint: DecisionPoint = {
      ...POINT,
      id: "review-score",
      question: { kind: "score", min: 0, max: 10 },
      instruction: "How confident is this fix, from 0 to 10?",
      stateFields: [],
      escapeValue: undefined,
    };
    const result = await decide({
      point: scorePoint,
      state: {},
      mode: "shadow",
      ask: async () => ANSWER({ value: 8, distribution: undefined }),
    });
    const id = await recordDecision(test.db, clock, { result, point: scorePoint, state: {} });
    await settleDecision(test.db, clock, id!, { operatorAnswer: "8" });

    expect(await agreement(test.db, scorePoint.id)).toMatchObject({ settled: 1, agreed: 0 });
  });

  it("is measured per point — one point's record says nothing about another's", async () => {
    await settleMany([true, true]);
    const other: DecisionPoint = { ...POINT, id: "stall-retry" };
    const result = await decide({
      point: other,
      state: {},
      mode: "shadow",
      ask: async () => ANSWER(),
    });
    const id = await recordDecision(test.db, clock, { result, point: other, state: {} });
    await settleDecision(test.db, clock, id!, { operatorAnswer: "decline" });

    expect(await agreement(test.db, POINT.id)).toMatchObject({ settled: 2, agreed: 2 });
    expect(await agreement(test.db, other.id)).toMatchObject({ settled: 1, agreed: 0 });
  });

  it("is measured per project — one project's record does not bleed into another's", async () => {
    // `recordShadow` logs under "proj-a"; settle two agreements there.
    await settleMany([true, true]);

    // The same point, decided the same way, but for a different project — and disagreeing.
    const result = await decide({ point: POINT, state: {}, mode: "shadow", ask: async () => ANSWER() });
    const id = await recordDecision(test.db, clock, {
      result,
      point: POINT,
      state: {},
      projectId: "proj-b",
    });
    await settleDecision(test.db, clock, id!, { operatorAnswer: "decline" });

    expect(await agreement(test.db, POINT.id, DECISION_AGREEMENT_WINDOW, "proj-a")).toMatchObject({
      settled: 2,
      agreed: 2,
    });
    expect(await agreement(test.db, POINT.id, DECISION_AGREEMENT_WINDOW, "proj-b")).toMatchObject({
      settled: 1,
      agreed: 0,
    });
    // Unscoped still folds every project together, for a caller that genuinely wants the global figure.
    expect(await agreement(test.db, POINT.id)).toMatchObject({ settled: 3, agreed: 2 });
  });

  it("rolls the window — a point fixed lately is not judged by the record it replaced", async () => {
    // Older disagreements first, then a full window of agreement on top of them.
    await settleMany([false, false, false]);
    await settleMany(Array.from({ length: DECISION_AGREEMENT_WINDOW }, () => true));

    expect(await agreement(test.db, POINT.id)).toEqual({
      point: "review-nit",
      settled: DECISION_AGREEMENT_WINDOW,
      agreed: DECISION_AGREEMENT_WINDOW,
    });
    // The narrower window still sees only the newest settles.
    expect(await agreement(test.db, POINT.id, 2)).toMatchObject({ settled: 2, agreed: 2 });
  });

  it("orders the window by SETTLE time, not decision time", async () => {
    // Two decisions made in order, answered in the reverse order. A window of one must hold the
    // answer that came in LAST, because that is the newest thing the operator said.
    const first = await recordShadow();
    nowMs += 60_000;
    const second = await recordShadow();

    nowMs += 60_000;
    await settleDecision(test.db, clock, second, { operatorAnswer: "fix" });
    nowMs += 60_000;
    await settleDecision(test.db, clock, first, { operatorAnswer: "decline" });

    expect(await agreement(test.db, POINT.id, 1)).toMatchObject({ settled: 1, agreed: 0 });
  });
});
