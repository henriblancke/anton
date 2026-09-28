/**
 * The decision log end to end over a REAL file-backed anton.db (anton-q5ixf `## Verify`): write,
 * settle, replay — driven through the shared `getDb()` singleton and the committed migrations, not an
 * in-memory fixture.
 *
 * `log.test.ts` already covers the fold's own rules against an injected connection. What this suite
 * adds is the part an in-memory test cannot reach: that the migration's real columns round-trip the
 * values the writer encodes, that the settle survives being a SEPARATE request against a persisted
 * row (the whole point of recording the operator's answer "later"), and that the UI read paths
 * (`latestAgreement`/`latestDecisions`, which take no `db`) see the same rows the writer wrote.
 *
 * A plain `*.test.ts` on purpose, per vitest.config.ts: it drives temp sqlite and no bd/Dolt, so it
 * belongs in the blocking gate rather than the report-only integration job.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFileDb, type FileDb } from "@/lib/testing/integration";
import { decide } from "./index";
import type { DecisionPoint } from "./points";

const POINT: DecisionPoint = {
  id: "review-nit",
  question: { kind: "choice", options: ["fix", "decline", "human"] },
  consequence: "low",
  threshold: 0.8,
  defaultMode: "shadow",
  stateFields: ["nitText"],
  hardRules: [],
  escapeValue: "human",
};

let fileDb: FileDb;
let log: typeof import("./log");
let getDb: typeof import("@/lib/db").getDb;

beforeAll(async () => {
  // MUST precede the getDb-touching imports: the db path is resolved at import time.
  fileDb = makeFileDb();
  log = await import("./log");
  ({ getDb } = await import("@/lib/db"));
});

afterAll(() => fileDb.cleanup());

/** Wall-clock is fine here — this suite asserts persistence, never window composition. */
const clock = { now: () => Date.now() };

/** Decide one nit in shadow and log it, exactly as a caller in shadow mode would. */
async function decideAndLog(nitText: string, answer: string, confidence = 0.9): Promise<string> {
  const state = { nitText };
  const result = await decide({
    point: POINT,
    state,
    mode: "shadow",
    ask: async () => ({
      value: answer,
      confidence,
      distribution: { [answer]: confidence },
      backend: "claude-local",
      modelVersion: "claude-opus-5",
    }),
  });
  const id = await log.recordDecision(getDb(), clock, {
    result,
    point: POINT,
    state,
    projectId: "proj-a",
  });
  if (!id) throw new Error("expected the log write to land on the real db");
  return id;
}

describe("the decision log over a real anton.db", () => {
  it("writes, settles later, and replays the agreement the operator earned it", async () => {
    // ── write: three shadow decisions, nothing acted on ──
    const agreedA = await decideAndLog("prefer const", "fix");
    const agreedB = await decideAndLog("stray import", "fix");
    const disagreed = await decideAndLog("rename this", "fix");

    // Before any operator answer, the log has rows and the record has no samples. An unsettled row
    // is not a disagreement — this is the distinction that keeps a point's figure honest while it is
    // being used.
    expect(await log.latestDecisions(POINT.id)).toHaveLength(3);
    expect(await log.latestAgreement(POINT.id)).toEqual({
      point: "review-nit",
      settled: 0,
      agreed: 0,
    });

    // ── settle: a separate pass over persisted rows, which is the "later" in the contract ──
    expect(
      await log.settleDecision(getDb(), clock, agreedA, {
        operatorAnswer: "fix",
        operatorAction: "fix",
      }),
    ).toBe(true);
    expect(
      await log.settleDecision(getDb(), clock, agreedB, {
        operatorAnswer: "fix",
        operatorAction: "fix",
      }),
    ).toBe(true);
    expect(
      await log.settleDecision(getDb(), clock, disagreed, {
        operatorAnswer: "decline",
        operatorAction: "decline",
      }),
    ).toBe(true);

    // ── replay ──
    expect(await log.latestAgreement(POINT.id)).toEqual({
      point: "review-nit",
      settled: 3,
      agreed: 2,
    });
  });

  it("round-trips every logged field through the migration's real columns", async () => {
    const id = await decideAndLog("check this", "decline", 0.77);
    await log.settleDecision(getDb(), clock, id, {
      operatorAnswer: "decline",
      operatorAction: "decline-with-reply",
      outcome: "merged",
    });

    const row = (await log.latestDecisions(POINT.id)).find((r) => r.id === id);
    expect(row).toMatchObject({
      point: "review-nit",
      mode: "shadow",
      decidedBy: "model",
      answer: "decline",
      confidence: 0.77,
      distribution: { decline: 0.77 },
      backend: "claude-local",
      modelVersion: "claude-opus-5",
      acted: false,
      operatorAnswer: "decline",
      operatorAction: "decline-with-reply",
      outcome: "merged",
    });
    expect(row!.inputHash).toBe(log.decisionInputHash(POINT, { nitText: "check this" }));
    expect(row!.settledAtMs).toBeGreaterThan(0);
  });

  it("records an outcome after the settle, as a third observation", async () => {
    const id = await decideAndLog("later outcome", "fix");
    await log.settleDecision(getDb(), clock, id, { operatorAnswer: "fix" });

    // The outcome is knowable after the choice — sometimes days later — so it lands on its own.
    expect(await log.recordDecisionOutcome(getDb(), id, "reverted")).toBe(true);

    const row = (await log.latestDecisions(POINT.id)).find((r) => r.id === id);
    expect(row!.outcome).toBe("reverted");
    // …and does not disturb the pair it explains.
    expect(row!.answer).toBe("fix");
    expect(row!.operatorAnswer).toBe("fix");
  });

  it("keeps each point's record to itself on a db that holds several", async () => {
    const other: DecisionPoint = { ...POINT, id: "stall-retry" };
    const state = { nitText: "n/a" };
    const result = await decide({
      point: other,
      state,
      mode: "shadow",
      ask: async () => ({
        value: "human",
        confidence: 0.4,
        backend: "claude-local",
        modelVersion: "claude-opus-5",
      }),
    });
    const id = await log.recordDecision(getDb(), clock, { result, point: other, state });
    await log.settleDecision(getDb(), clock, id!, { operatorAnswer: "fix" });

    expect(await log.latestAgreement(other.id)).toEqual({
      point: "stall-retry",
      settled: 1,
      agreed: 0,
    });
    // The other point's rows are untouched by it — agreement is measured per point.
    expect((await log.latestAgreement(POINT.id)).settled).toBeGreaterThan(1);
  });
});
