/**
 * Derived cost (anton-j9lf) — and the four ways a price table lies.
 *
 * The load-bearing cases are the ones where a wrong answer still looks like a number: an unknown
 * model priced as free, a cached read priced as fresh input, thinking tokens charged on top of the
 * output they are already part of, and a project total that quietly omits what it could not price.
 */
import { describe, expect, it } from "vitest";
import {
  costOf,
  isPriced,
  MODEL_PRICES,
  parse9RouterPricing,
  PRICES_AS_OF,
  PRICES_SOURCE,
  priceOf,
  totalCost,
  WEB_SEARCH_USD_PER_REQUEST,
  type PriceableRow,
} from "./model-pricing";

/** A real opus 5 result: 438 fresh input, 29,177 output of which 10,732 was thinking. */
const OPUS_RUN = { inputTokens: 438, outputTokens: 29177, thinkingTokens: 10732 };

describe("priceOf", () => {
  it("prices a known model through every spelling the serving side uses", () => {
    // The ledger stores the gateway's or the CLI's own id, never anton's tidy one — a table keyed on
    // exact strings would miss every real row.
    for (const id of [
      "claude-opus-5",
      "cc/claude-opus-5[1m]",
      "claude-opus-5-20260401",
      "anthropic/claude-opus-5",
      "us.anthropic.claude-opus-5-v1:0",
    ]) {
      expect(priceOf(id), id).toEqual(MODEL_PRICES["opus-5"]);
    }
  });

  it("knows the models the ledger actually records, at their published rates", () => {
    expect(priceOf("claude-opus-5")).toMatchObject({ input: 5, output: 25, cacheRead: 0.5 });
    expect(priceOf("claude-opus-4-8")).toMatchObject({ input: 5, output: 25, cacheRead: 0.5 });
    // $2/$10 is the standard price — the increase to $3/$15 scheduled for 2026-09-01 was cancelled.
    expect(priceOf("claude-sonnet-5")).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 });
    expect(priceOf("claude-haiku-4-5-20251001")).toMatchObject({ input: 1, output: 5 });
    // The 5.1 pair is the exception to the 0.1x cache-read multiplier: 0.025x base.
    expect(priceOf("claude-fable-5-1")).toMatchObject({ input: 10, cacheRead: 0.25 });
    expect(priceOf("claude-fable-5")).toMatchObject({ input: 10, cacheRead: 1 });
  });

  it("holds cache rates at the published multipliers of base input", () => {
    // Guards a hand-edited rate: a cache read is 0.1x base (0.025x on 5.1), a 5m write 1.25x, a 1h
    // write 2x. A typo here understates or overstates every long agentic run.
    for (const [id, price] of Object.entries(MODEL_PRICES)) {
      const readMultiplier = id.endsWith("-5-1") ? 0.025 : 0.1;
      expect(price.cacheRead, `${id} cache read`).toBeCloseTo(price.input * readMultiplier, 10);
      expect(price.cacheWrite5m, `${id} 5m write`).toBeCloseTo(price.input * 1.25, 10);
      expect(price.cacheWrite1h, `${id} 1h write`).toBeCloseTo(price.input * 2, 10);
      expect(price.output, `${id} output`).toBeGreaterThan(price.input);
    }
  });

  it("does not know a gateway's own provider, an unnamed model, or one released since", () => {
    for (const id of ["glm-4.6", "deepseek-chat", "gpt-5", "claude-opus-9", "", null, undefined]) {
      expect(priceOf(id), String(id)).toBeUndefined();
      expect(isPriced(id), String(id)).toBe(false);
    }
    expect(isPriced("claude-opus-5")).toBe(true);
  });

  it("states where its numbers came from and when", () => {
    // The provenance criterion: a table that cannot say this is indistinguishable from a stale one.
    expect(PRICES_SOURCE).toContain("pricing");
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(PRICES_AS_OF))).toBe(false);
  });
});

describe("costOf", () => {
  it("prices input, output and cached reads separately, at their own rates", () => {
    // 1M of each on opus 5: $5 input + $25 output + $0.50 cache read + $6.25 cache write.
    expect(
      costOf("claude-opus-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      }),
    ).toBeCloseTo(36.75, 10);

    expect(costOf("claude-opus-5", { inputTokens: 1_000_000 })).toBeCloseTo(5, 10);
    expect(costOf("claude-opus-5", { outputTokens: 1_000_000 })).toBeCloseTo(25, 10);
    expect(costOf("claude-opus-5", { cacheReadInputTokens: 1_000_000 })).toBeCloseTo(0.5, 10);
  });

  it("prices a cached read an order of magnitude below fresh input, never as input", () => {
    // The case that decides whether a long agentic run's figure means anything: nearly all of its
    // input is re-read context, so folding cache reads into input overstates it by most of the bill.
    const cached = costOf("claude-opus-5", { cacheReadInputTokens: 2_000_000 })!;
    const fresh = costOf("claude-opus-5", { inputTokens: 2_000_000 })!;
    expect(cached).toBeCloseTo(fresh / 10, 10);
    expect(cached).toBeLessThan(fresh);

    // A realistic run: 1.9M cached, 100k fresh. Priced as all-fresh it would be $10 — it is $1.45.
    expect(
      costOf("claude-opus-5", { inputTokens: 100_000, cacheReadInputTokens: 1_900_000 }),
    ).toBeCloseTo(1.45, 10);
  });

  it("does not charge thinking tokens on top of the output they are already part of", () => {
    // `thinking_tokens` reports how many of the BILLED OUTPUT tokens were internal reasoning — a
    // subset, not a surcharge. Adding it would overstate this real opus run by ~37%.
    const withThinking = costOf("claude-opus-5", OPUS_RUN);
    const withoutThinking = costOf("claude-opus-5", {
      inputTokens: OPUS_RUN.inputTokens,
      outputTokens: OPUS_RUN.outputTokens,
    });
    expect(withThinking).toBe(withoutThinking);
    // 438 * $5/M + 29,177 * $25/M = (2,190 + 729,425) / 1e6.
    expect(withThinking).toBeCloseTo(0.731615, 10);
    // Priced with thinking added to output it would be $1.0000, a ~37% overstatement.
    expect(withThinking!).toBeLessThan(
      costOf("claude-opus-5", {
        inputTokens: OPUS_RUN.inputTokens,
        outputTokens: OPUS_RUN.outputTokens + OPUS_RUN.thinkingTokens,
      })!,
    );
  });

  it("yields NO cost for a model the table does not know, rather than a zero", () => {
    // The criterion in one line: an unknown price is unknown, not free. A zero would sum into a
    // project total that understates real spend with nothing to show anything is missing.
    const spent = { inputTokens: 900_000, outputTokens: 200_000, cacheReadInputTokens: 4_000_000 };
    expect(costOf("glm-4.6", spent)).toBeUndefined();
    expect(costOf("glm-4.6", spent)).not.toBe(0);
    expect(costOf(null, spent)).toBeUndefined();
  });

  it("leaves a gateway-routed call unpriced even when its model has a direct API rate", () => {
    expect(costOf("cc/claude-opus-5[1m]", { inputTokens: 1_000_000 }, "router.example.com")).toBeUndefined();
  });

  it("uses the matching gateway's published rate for routed calls", () => {
    const gatewayPricing = {
      endpointHost: "router.example.com",
      prices: parse9RouterPricing({
        cc: {
          "claude-opus-5[1m]": { input: 1, output: 2, cached: 0.1, cache_creation: 1.25 },
        },
      }),
    };

    expect(
      costOf(
        "cc/claude-opus-5[1m]",
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        "router.example.com",
        gatewayPricing,
      ),
    ).toBeCloseTo(3, 10);
    expect(
      costOf(
        "cc/claude-opus-5[1m]",
        { inputTokens: 1_000_000 },
        "another-router.example.com",
        gatewayPricing,
      ),
    ).toBeUndefined();
  });

  it("yields no cost for a row that measured nothing, and zero for one that measured zero", () => {
    // The unknown-usage row a crashed result writes: nothing was measured, so nothing is derivable.
    expect(costOf("claude-opus-5", {})).toBeUndefined();
    expect(costOf("claude-opus-5", { inputTokens: null, outputTokens: null })).toBeUndefined();
    // A reported zero IS a measurement — an invocation that truly spent nothing cost nothing.
    expect(costOf("claude-opus-5", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("prices the components a row did report, treating the absent ones as zero", () => {
    // An invocation that reported input but no cache reads did not read cache — a measurement, not
    // a gap, so it prices rather than going unknown.
    expect(costOf("claude-haiku-4-5-20251001", { inputTokens: 1820, outputTokens: 28 })).toBeCloseTo(
      1820 / 1e6 + (28 * 5) / 1e6,
      10,
    );
  });

  it("refuses a negative or unreadable count instead of pricing it as a credit", () => {
    // A garbled count must never subtract from a total; the parse layer drops these, and pricing
    // does not trust that it did.
    expect(costOf("claude-opus-5", { inputTokens: -1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(
      25,
      10,
    );
    expect(
      costOf("claude-opus-5", { inputTokens: Number.NaN, outputTokens: 1_000_000 }),
    ).toBeCloseTo(25, 10);
  });

  it("prices web search per search rather than per token", () => {
    expect(costOf("claude-opus-5", { webSearchRequests: 1000 })).toBeCloseTo(10, 10);
    expect(WEB_SEARCH_USD_PER_REQUEST).toBeCloseTo(0.01, 10);
    // It is the only charge a row can carry with no tokens at all — still a cost, not unknown.
    expect(costOf("claude-opus-5", { webSearchRequests: 3 })).toBeCloseTo(0.03, 10);
  });

  it("never reads the result event's own costUSD", () => {
    // The whole point: two invocations with identical counts cost the same no matter what the CLI
    // reported, because a gateway makes that figure a claim about a model name and nothing more.
    const counts = { ...OPUS_RUN, costUsd: 999 } as never;
    expect(costOf("claude-opus-5", counts)).toBe(costOf("claude-opus-5", OPUS_RUN));
  });
});

describe("9Router pricing", () => {
  it("accepts provider/model rates and keeps missing models unpriced", () => {
    const prices = parse9RouterPricing({
      cc: {
        "claude-opus-5[1m]": { input: 1, output: 2, cached: 0.1, cache_creation: 1.25 },
      },
      malformed: { model: { input: "not a number", output: 2 } },
    });

    expect(prices["cc/claude-opus-5[1m]"]).toMatchObject({
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite5m: 1.25,
    });
    expect(prices["opus-5"]).toMatchObject({ input: 1, output: 2 });
    expect(Object.keys(prices)).toEqual([
      "cc/claude-opus-5[1m]",
      "claude-opus-5[1m]",
      "opus-5",
    ]);
  });
});

describe("totalCost", () => {
  /** A ledger row as the fact table stores it — one (invocation, model) pair. */
  function row(model: string | null, counts: Partial<PriceableRow> = {}): PriceableRow {
    return { modelReported: model, ...counts };
  }

  it("sums what it could price and keeps what it could not beside the total", () => {
    const spend = totalCost([
      row("claude-opus-5[1m]", { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      row("claude-haiku-4-5-20251001", { inputTokens: 1_000_000 }),
      row("glm-4.6", { inputTokens: 5_000_000, outputTokens: 1_000_000 }),
    ]);

    expect(spend.usd).toBeCloseTo(31, 10);
    expect(spend.priced).toBe(2);
    // The unpriced row is NOT folded in as zero — a total that hides it reads as complete.
    expect(spend.unpriced).toBe(1);
    expect(spend.unpricedModels).toEqual(["glm-4.6"]);
  });

  it("names the unpriced models most-seen first, so there is something to act on", () => {
    const spend = totalCost([
      row("glm-4.6", { inputTokens: 1 }),
      row("deepseek-chat", { inputTokens: 1 }),
      row("glm-4.6", { inputTokens: 1 }),
      // The unknown-usage row names nothing to add to the table, so it is counted but not named.
      row(null),
    ]);

    expect(spend.usd).toBe(0);
    expect(spend.priced).toBe(0);
    expect(spend.unpriced).toBe(4);
    expect(spend.unpricedModels).toEqual(["glm-4.6", "deepseek-chat"]);
  });

  it("does not apply direct API rates to a gateway-served known model", () => {
    const spend = totalCost([row("cc/claude-opus-5[1m]", {
      inputTokens: 1_000_000,
      endpointHost: "router.example.com",
    })]);
    expect(spend).toMatchObject({ usd: 0, priced: 0, unpriced: 1, unpricedModels: ["cc/claude-opus-5[1m]"] });
  });

  it("reads an unrouted project as fully priced, and an empty window as zero", () => {
    const spend = totalCost([
      row("claude-opus-5[1m]", { ...OPUS_RUN, cacheReadInputTokens: 1_900_000 }),
      row("claude-haiku-4-5-20251001", { inputTokens: 1820, outputTokens: 28 }),
    ]);
    expect(spend.unpriced).toBe(0);
    expect(spend.unpricedModels).toEqual([]);
    expect(spend.usd).toBeGreaterThan(0);

    expect(totalCost([])).toEqual({ usd: 0, priced: 0, unpriced: 0, unpricedModels: [] });
  });
});
