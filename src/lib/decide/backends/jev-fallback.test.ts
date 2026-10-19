/**
 * The fallback-with-health contract (anton-p32iy), independent of either backend's own plumbing: a
 * jev failure must still answer via claude-local, decide() must never see the failure, and repeated
 * failures must flip a health flag an operator can read — without ever skipping jev on the next call.
 */
import { describe, expect, it, vi } from "vitest";
import type { DecisionPoint, DecisionState } from "../points";
import type { ModelAnswer, ModelCaller } from "../index";
import { createJevFallbackCaller, JEV_UNHEALTHY_THRESHOLD } from "./jev-fallback";

const POINT: DecisionPoint = {
  id: "department",
  question: { kind: "choice", options: ["billing", "technical", "other"] },
  instruction: "Which team should handle this support ticket?",
  consequence: "low",
  threshold: 0.6,
  defaultMode: "shadow",
  stateFields: ["ticketText"],
  hardRules: [],
  escapeValue: "other",
};

const STATE: DecisionState = { ticketText: "my invoice is wrong" };

const jevAnswer: ModelAnswer = { backend: "jev", modelVersion: "jev-1.13.0", value: "billing", confidence: 0.9 };
const claudeLocalAnswer: ModelAnswer = { backend: "claude-local", value: "billing", confidence: 0.8 };

function callers(jevImpl: ModelCaller, claudeLocalImpl: ModelCaller = vi.fn(async () => claudeLocalAnswer)) {
  return { jev: vi.fn(jevImpl), claudeLocal: vi.fn(claudeLocalImpl) };
}

describe("createJevFallbackCaller — happy path", () => {
  it("returns jev's own answer when jev succeeds, and never calls claude-local", async () => {
    const { jev, claudeLocal } = callers(async () => jevAnswer);
    const { ask, health } = createJevFallbackCaller(jev, claudeLocal);

    const answer = await ask(POINT, STATE);

    expect(answer).toEqual(jevAnswer);
    expect(claudeLocal).not.toHaveBeenCalled();
    expect(health()).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
  });
});

describe("createJevFallbackCaller — fallback on failure", () => {
  it("falls back to claude-local's answer when jev throws, instead of propagating the error", async () => {
    const { jev, claudeLocal } = callers(async () => {
      throw new Error("decide/jev: systemone responded 503");
    });
    const { ask } = createJevFallbackCaller(jev, claudeLocal);

    const answer = await ask(POINT, STATE);

    expect(answer).toEqual(claudeLocalAnswer);
    expect(claudeLocal).toHaveBeenCalledWith(POINT, STATE);
  });

  it("propagates claude-local's own error when the fallback itself fails", async () => {
    const fallbackError = new Error("decide/claude-local: session errored");
    const { jev, claudeLocal } = callers(
      async () => {
        throw new Error("jev down");
      },
      async () => {
        throw fallbackError;
      },
    );
    const { ask } = createJevFallbackCaller(jev, claudeLocal);

    await expect(ask(POINT, STATE)).rejects.toBe(fallbackError);
  });
});

describe("createJevFallbackCaller — health", () => {
  it("stays healthy under the failure threshold", async () => {
    const { jev, claudeLocal } = callers(async () => {
      throw new Error("timeout");
    });
    const { ask, health } = createJevFallbackCaller(jev, claudeLocal);

    for (let i = 0; i < JEV_UNHEALTHY_THRESHOLD - 1; i++) await ask(POINT, STATE);

    expect(health()).toMatchObject({
      status: "healthy",
      consecutiveFailures: JEV_UNHEALTHY_THRESHOLD - 1,
    });
  });

  it("flips unhealthy once failures reach the threshold, and records the last error", async () => {
    const { jev, claudeLocal } = callers(async () => {
      throw new Error("decide/jev: systemone responded 503");
    });
    const { ask, health } = createJevFallbackCaller(jev, claudeLocal);

    for (let i = 0; i < JEV_UNHEALTHY_THRESHOLD; i++) await ask(POINT, STATE);

    expect(health()).toMatchObject({
      status: "unhealthy",
      consecutiveFailures: JEV_UNHEALTHY_THRESHOLD,
      lastError: "decide/jev: systemone responded 503",
    });
  });

  it("recovers to healthy the moment jev answers again — nothing keeps it pinned unhealthy", async () => {
    let fail = true;
    const { jev, claudeLocal } = callers(async () => {
      if (fail) throw new Error("timeout");
      return jevAnswer;
    });
    const { ask, health } = createJevFallbackCaller(jev, claudeLocal);

    for (let i = 0; i < JEV_UNHEALTHY_THRESHOLD; i++) await ask(POINT, STATE);
    expect(health().status).toBe("unhealthy");

    fail = false;
    await ask(POINT, STATE);

    expect(health()).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
  });

  it("still tries jev on every call, even while unhealthy — nothing short-circuits it", async () => {
    const { jev, claudeLocal } = callers(async () => {
      throw new Error("timeout");
    });
    const { ask } = createJevFallbackCaller(jev, claudeLocal);

    for (let i = 0; i < JEV_UNHEALTHY_THRESHOLD + 2; i++) await ask(POINT, STATE);

    expect(jev).toHaveBeenCalledTimes(JEV_UNHEALTHY_THRESHOLD + 2);
  });

  it("returns a snapshot — mutating the returned object never affects tracked state", async () => {
    const { jev, claudeLocal } = callers(async () => jevAnswer);
    const { ask, health } = createJevFallbackCaller(jev, claudeLocal);
    await ask(POINT, STATE);

    const snapshot = health();
    snapshot.status = "unhealthy";
    snapshot.consecutiveFailures = 99;

    expect(health()).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
  });
});
