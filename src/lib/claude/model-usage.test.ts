/**
 * The result event's `modelUsage`, read the two ways that matter (anton-77l9): as the session's
 * CUMULATIVE total, and defensively.
 *
 * Table-driven over the shapes the field actually arrives in — Claude Code omits it entirely on a
 * crash/startup-error result, emits `{}` when the model never ran, and a gateway keys it by its own
 * spelling — because the rule is that NONE of them may throw or lose the invocation.
 */
import { describe, expect, it } from "vitest";
import { parseModelUsage } from "./model-usage";

/** The real shape, taken from a recorded result event (two models, one session). */
const RECORDED = {
  "claude-haiku-4-5-20251001": {
    inputTokens: 1820,
    outputTokens: 28,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.00196,
  },
  "claude-opus-5[1m]": {
    inputTokens: 438,
    outputTokens: 29177,
    thinkingTokens: 10732,
    cacheReadInputTokens: 8471906,
    cacheCreationInputTokens: 175547,
    webSearchRequests: 0,
    costUSD: 6.723038,
  },
};

describe("parseModelUsage", () => {
  it("reads every model the result reported, keeping the id it reported it under", () => {
    expect(parseModelUsage(RECORDED)).toEqual([
      {
        model: "claude-haiku-4-5-20251001",
        inputTokens: 1820,
        outputTokens: 28,
        thinkingTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
      },
      {
        model: "claude-opus-5[1m]",
        inputTokens: 438,
        outputTokens: 29177,
        thinkingTokens: 10732,
        cacheReadInputTokens: 8471906,
        cacheCreationInputTokens: 175547,
        webSearchRequests: 0,
      },
    ]);
  });

  // Every way the field fails to say anything. None may throw, and none may be confused with a
  // reported zero: an invocation whose usage is UNKNOWN is not one that spent nothing.
  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", {}],
    ["a string", "lots"],
    ["an array", [{ inputTokens: 5 }]],
    ["a number", 12],
  ])("yields no entries for %s modelUsage", (_label, raw) => {
    expect(parseModelUsage(raw)).toEqual([]);
  });

  it("drops an entry whose value is not an object, keeping its readable siblings", () => {
    expect(parseModelUsage({ "model-a": "garbage", "model-b": { inputTokens: 7 } })).toEqual([
      { model: "model-b", inputTokens: 7 },
    ]);
  });

  it("keeps a model whose counts are all unreadable, since the result still named it", () => {
    // The model ran — the figures are what is missing. A dropped entry would say it never ran.
    expect(parseModelUsage({ "model-a": { inputTokens: "8", outputTokens: null } })).toEqual([
      { model: "model-a" },
    ]);
  });

  it("refuses a count that is not a finite, non-negative number", () => {
    // A negative or NaN count would price as a credit or poison every sum it lands in.
    expect(
      parseModelUsage({
        m: { inputTokens: -5, outputTokens: Number.NaN, thinkingTokens: Infinity, webSearchRequests: 0 },
      }),
    ).toEqual([{ model: "m", webSearchRequests: 0 }]);
  });

  it("ignores an empty model key, which names nothing anyone can attribute spend to", () => {
    expect(parseModelUsage({ "": { inputTokens: 5 }, m: { inputTokens: 1 } })).toEqual([
      { model: "m", inputTokens: 1 },
    ]);
  });
});
