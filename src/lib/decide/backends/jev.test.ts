/**
 * The jev backend's own contract, independent of decide()'s pipeline (index.test.ts covers that
 * side): a fake `fetch` stands in for a live call to `api.typesafe.ai`, so these prove the
 * request-shaping/parse/retry plumbing without a network dependency. Response fixtures are modeled on
 * the systemone example in docs.typesafe.ai/introduction/quickstart (a support ticket evaluated for
 * department/frustration/urgency — the choice/score/noul trio).
 */
import { describe, expect, it, vi } from "vitest";
import { ModelCallError } from "../index";
import type { DecisionPoint } from "../points";
import { DEFAULT_JEV_TIMEOUT_MS, jevBackend } from "./jev";

const PINNED_MODEL = "jev-1.13.0";

function choicePoint(overrides: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    id: "department",
    question: { kind: "choice", options: ["billing", "technical", "other"] },
    instruction: "Which team should handle this support ticket?",
    consequence: "low",
    threshold: 0.6,
    defaultMode: "shadow",
    stateFields: ["ticketText"],
    hardRules: [],
    escapeValue: "other",
    ...overrides,
  };
}

function scorePoint(overrides: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    id: "frustration",
    question: { kind: "score", min: 0, max: 10 },
    instruction: "How frustrated does the customer sound, from 0 (calm) to 10 (furious)?",
    consequence: "med",
    threshold: 0.7,
    defaultMode: "shadow",
    stateFields: ["ticketText"],
    hardRules: [],
    ...overrides,
  };
}

function yesNoPoint(overrides: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    id: "is_urgent",
    question: { kind: "yes-no" },
    instruction: "Is this ticket urgent?",
    consequence: "med",
    threshold: 0.6,
    defaultMode: "shadow",
    stateFields: ["ticketText"],
    hardRules: [],
    ...overrides,
  };
}

/** A fake `fetch` returning one fixed JSON body, mirroring the docs' own systemone response shape. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("jevBackend — construction", () => {
  it("refuses jev-latest", () => {
    expect(() => jevBackend({ apiKey: "k", model: "jev-latest" })).toThrow(/pinned/);
  });

  it("refuses an unpinned model string", () => {
    expect(() => jevBackend({ apiKey: "k", model: "jev-1" })).toThrow(/pinned/);
    expect(() => jevBackend({ apiKey: "k", model: "latest" })).toThrow(/pinned/);
  });

  it("accepts an exact jev-X.Y.Z version", () => {
    expect(() => jevBackend({ apiKey: "k", model: PINNED_MODEL })).not.toThrow();
  });
});

describe("jevBackend — request shaping", () => {
  it("sends state, the pinned model, and a choice question keyed by the point id", async () => {
    let seenBody: Record<string, unknown> = {};
    let seenHeaders: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      seenHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          model: PINNED_MODEL,
          answers: {
            department: {
              type: "choice",
              choice: "technical",
              confidence: 0.91,
              probabilities: { billing: 0.05, technical: 0.91, other: 0.04 },
            },
          },
        }),
        { status: 200 },
      );
    });
    const ask = jevBackend({ apiKey: "sk-test-key", model: PINNED_MODEL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await ask(choicePoint(), { ticketText: "I'm getting a 500 error on checkout", secret: "never leaves" });

    expect(seenHeaders?.get("Authorization")).toBe("Bearer sk-test-key");
    expect(seenBody.model).toBe(PINNED_MODEL);
    expect(seenBody.state).toEqual({ ticketText: "I'm getting a 500 error on checkout" });
    expect(seenBody.questions).toEqual({
      department: {
        type: "choice",
        instructions: choicePoint().instruction,
        criteria: { billing: "billing", technical: "technical", other: "other" },
      },
    });
  });

  it("maps a score question to criteria spanning its min and max", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          model: PINNED_MODEL,
          answers: { frustration: { type: "score", score: 0.5, confidence: 0.8 } },
        }),
        { status: 200 },
      );
    });
    const ask = jevBackend({ apiKey: "k", model: PINNED_MODEL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await ask(scorePoint(), { ticketText: "x" });

    expect(seenBody.questions).toEqual({
      frustration: {
        type: "score",
        instructions: `${scorePoint().instruction} (answer on a scale from 0 to 10)`,
        criteria: ["0", "10"],
      },
    });
  });

  it("maps a yes-no question to Jev's noul type", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ model: PINNED_MODEL, answers: { is_urgent: { type: "noul", noul: 0.5 } } }),
        { status: 200 },
      );
    });
    const ask = jevBackend({ apiKey: "k", model: PINNED_MODEL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await ask(yesNoPoint(), { ticketText: "x" });

    expect(seenBody.questions).toEqual({
      is_urgent: { type: "noul", instructions: yesNoPoint().instruction },
    });
  });

  it("only sends the state fields the point declared", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ model: PINNED_MODEL, answers: { is_urgent: { type: "noul", noul: 0.1 } } }),
        { status: 200 },
      );
    });
    const ask = jevBackend({ apiKey: "k", model: PINNED_MODEL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await ask(yesNoPoint(), { ticketText: "x", secretField: "must never leave the process" });

    expect(JSON.stringify(seenBody.state)).not.toContain("secretField");
    expect(JSON.stringify(seenBody.state)).not.toContain("must never leave the process");
  });
});

describe("jevBackend — response parsing (fixtures from the docs example)", () => {
  it("picks a choice answer, carrying confidence and the full probability distribution", async () => {
    const ask = jevBackend({
      apiKey: "k",
      model: PINNED_MODEL,
      fetchImpl: fakeFetch({
        model: "jev-1.13.0",
        answers: {
          department: {
            type: "choice",
            choice: "technical",
            confidence: 1.0,
            probabilities: { billing: 0.0, technical: 1.0, other: 0.0 },
          },
        },
        usage: { input_tokens: 428, output_tokens: 12 },
      }) as unknown as typeof fetch,
    });

    const answer = await ask(choicePoint(), { ticketText: "I'm getting a 500 error on checkout" });

    expect(answer).toEqual({
      backend: "jev",
      modelVersion: "jev-1.13.0",
      value: "technical",
      confidence: 1.0,
      distribution: { billing: 0.0, technical: 1.0, other: 0.0 },
    });
  });

  it("rescales a score answer from Jev's 0..1 index position onto the point's own [min, max]", async () => {
    const ask = jevBackend({
      apiKey: "k",
      model: PINNED_MODEL,
      fetchImpl: fakeFetch({
        model: "jev-1.13.0",
        answers: {
          frustration: {
            type: "score",
            score: 0.67,
            confidence: 0.82,
            legend: { "0": "calm", "1": "annoyed" },
            probabilities: { "0": 0.2, "1": 0.8 },
          },
        },
      }) as unknown as typeof fetch,
    });

    const answer = await ask(scorePoint(), { ticketText: "x" });

    expect(answer.value).toBeCloseTo(6.7);
    expect(answer.confidence).toBe(0.82);
    expect(answer.backend).toBe("jev");
    expect(answer.modelVersion).toBe("jev-1.13.0");
  });

  it("derives a yes/no answer and its distribution from the noul probability", async () => {
    const ask = jevBackend({
      apiKey: "k",
      model: PINNED_MODEL,
      fetchImpl: fakeFetch({
        model: "jev-1.13.0",
        answers: { is_urgent: { type: "noul", noul: 0.99 } },
      }) as unknown as typeof fetch,
    });

    const answer = await ask(yesNoPoint(), { ticketText: "x" });

    expect(answer.value).toBe(true);
    expect(answer.confidence).toBe(0.99);
    expect(answer.distribution?.yes).toBe(0.99);
    expect(answer.distribution?.no).toBeCloseTo(0.01);
  });

  it("reads noul < 0.5 as false, confidence as the complement", async () => {
    const ask = jevBackend({
      apiKey: "k",
      model: PINNED_MODEL,
      fetchImpl: fakeFetch({
        model: "jev-1.13.0",
        answers: { is_urgent: { type: "noul", noul: 0.1 } },
      }) as unknown as typeof fetch,
    });

    const answer = await ask(yesNoPoint(), { ticketText: "x" });

    expect(answer.value).toBe(false);
    expect(answer.confidence).toBeCloseTo(0.9);
  });

  it("rejects a reply failing Zod validation (confidence out of [0, 1])", async () => {
    const ask = jevBackend({
      apiKey: "k",
      model: PINNED_MODEL,
      fetchImpl: fakeFetch({
        model: "jev-1.13.0",
        answers: {
          department: { type: "choice", choice: "technical", confidence: 1.5, probabilities: {} },
        },
      }) as unknown as typeof fetch,
    });

    await expect(ask(choicePoint(), { ticketText: "x" })).rejects.toThrow(ModelCallError);
  });

  it("throws when the reply carries no answer for the point's own id", async () => {
    const ask = jevBackend({
      apiKey: "k",
      model: PINNED_MODEL,
      fetchImpl: fakeFetch({ model: "jev-1.13.0", answers: {} }) as unknown as typeof fetch,
    });

    await expect(ask(choicePoint(), { ticketText: "x" })).rejects.toThrow(ModelCallError);
  });

  it("rejects a reply whose model doesn't match the configured pin, even if otherwise well-formed", async () => {
    const ask = jevBackend({
      apiKey: "k",
      model: PINNED_MODEL,
      fetchImpl: fakeFetch({
        model: "jev-latest",
        answers: { is_urgent: { type: "noul", noul: 0.9 } },
      }) as unknown as typeof fetch,
    });

    const error = await ask(yesNoPoint(), { ticketText: "x" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).modelVersion).toBe(PINNED_MODEL);
  });

  it("attributes backend and the pinned model on a thrown error", async () => {
    const ask = jevBackend({
      apiKey: "k",
      model: PINNED_MODEL,
      fetchImpl: fakeFetch({ model: "jev-1.13.0", answers: {} }) as unknown as typeof fetch,
    });

    const error = await ask(choicePoint(), { ticketText: "x" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).backend).toBe("jev");
    expect((error as ModelCallError).modelVersion).toBe(PINNED_MODEL);
  });
});

describe("jevBackend — retry and failure (one retry, no more)", () => {
  it("retries exactly once on a 5xx and succeeds on the second attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { is_urgent: { type: "noul", noul: 0.8 } },
          }),
          { status: 200 },
        ),
      );
    const ask = jevBackend({ apiKey: "k", model: PINNED_MODEL, fetchImpl: fetchImpl as unknown as typeof fetch });

    const answer = await ask(yesNoPoint(), { ticketText: "x" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(answer.value).toBe(true);
  });

  it("fails after exactly one retry when every attempt errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("server error", { status: 503 }));
    const ask = jevBackend({ apiKey: "k", model: PINNED_MODEL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(ask(yesNoPoint(), { ticketText: "x" })).rejects.toThrow(ModelCallError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts and falls back once the timeout elapses, never hanging on a stuck call", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const ask = jevBackend({
      apiKey: "k",
      model: PINNED_MODEL,
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(ask(yesNoPoint(), { ticketText: "x" })).rejects.toThrow(ModelCallError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("defaults to a short timeout suited to Jev's own ~70-500ms response figures", () => {
    expect(DEFAULT_JEV_TIMEOUT_MS).toBeLessThan(30_000);
  });
});
