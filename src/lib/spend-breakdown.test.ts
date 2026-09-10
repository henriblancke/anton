/**
 * The spend fold (anton-1kdm), tested at the boundary where it can lie.
 *
 * The claims under test are all honesty claims, not arithmetic ones: an unknown price yields tokens
 * and no dollars rather than a zero, an empty window is empty rather than free, a partly-priced group
 * says so, and the two dimensions agree because they are folds of the same rows. Arithmetic is
 * `model-pricing`'s own suite; what this one guards is what a number MEANS.
 */
import { describe, expect, it } from "vitest";

import {
  breakdownBy,
  DEFAULT_SPEND_WINDOW,
  formatTokens,
  formatUsd,
  hasMeasuredTokens,
  isCompletelyPriced,
  normalizeWindow,
  UNATTRIBUTED_LABEL,
  UNKNOWN_MODEL_LABEL,
  windowSince,
  type SpendRow,
} from "./spend-breakdown";
import { parse9RouterPricing } from "./model-pricing";

const AT = new Date("2026-09-09T12:00:00Z");

function row(overrides: Partial<SpendRow> = {}): SpendRow {
  return {
    modelReported: "claude-opus-5",
    jobType: "execute-epic",
    step: "implement",
    inputTokens: 1_000,
    outputTokens: 2_000,
    cacheReadInputTokens: 10_000,
    cacheCreationInputTokens: 500,
    ...overrides,
  };
}

describe("grouping by model", () => {
  it("splits spend across the models that were actually served", () => {
    const { groups } = breakdownBy(
      [
        row({ modelReported: "claude-opus-5" }),
        row({ modelReported: "claude-opus-5" }),
        row({ modelReported: "claude-haiku-4-5" }),
      ],
      "model",
    );

    expect(groups.map((g) => g.label)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
    expect(groups[0].rows).toBe(2);
    expect(groups[0].tokens.input).toBe(2_000);
    // Opus is the pricier model AND the bigger consumer here, so it leads on both orderings.
    expect(groups[0].usd!).toBeGreaterThan(groups[1].usd!);
  });

  it("prices an invocation's sidecar model at its own rates, not the invocation's", () => {
    // One opus invocation reports a haiku row for Claude Code's own small tasks. Folding it into
    // opus would overstate it fivefold; it belongs to haiku's row.
    const { groups } = breakdownBy(
      [
        row({ modelReported: "claude-opus-5", modelRequested: "opus" } as Partial<SpendRow>),
        row({ modelReported: "claude-haiku-4-5", modelRequested: "opus" } as Partial<SpendRow>),
      ],
      "model",
    );

    const haiku = groups.find((g) => g.label === "claude-haiku-4-5")!;
    const opus = groups.find((g) => g.label === "claude-opus-5")!;
    expect(haiku.usd).toBeLessThan(opus.usd!);
    expect(haiku.rows).toBe(1);
  });

  it("names the rows that reported no model rather than dropping them", () => {
    const { groups } = breakdownBy(
      [row({ modelReported: null, inputTokens: null, outputTokens: null,
             cacheReadInputTokens: null, cacheCreationInputTokens: null })],
      "model",
    );

    expect(groups[0].label).toBe(UNKNOWN_MODEL_LABEL);
    expect(groups[0].rows).toBe(1);
  });
});

describe("grouping by task", () => {
  it("splits by pipeline step, which is the finer and more actionable answer", () => {
    const { groups } = breakdownBy(
      [
        row({ step: "implement", outputTokens: 9_000 }),
        row({ step: "review", outputTokens: 1_000 }),
      ],
      "task",
    );

    expect(groups.map((g) => g.label)).toEqual(["implement", "review"]);
  });

  it("falls back to the job type for passes that run outside the ticket pipeline", () => {
    const { groups } = breakdownBy([row({ step: null, jobType: "gardener" })], "task");
    expect(groups[0].label).toBe("gardener");
  });

  it("names a row with neither rather than leaving a blank label", () => {
    const { groups } = breakdownBy([row({ step: null, jobType: null })], "task");
    expect(groups[0].label).toBe(UNATTRIBUTED_LABEL);
  });

  it("totals the same dollars as the model fold, being the same rows", () => {
    const rows = [
      row({ modelReported: "claude-opus-5", step: "implement" }),
      row({ modelReported: "claude-haiku-4-5", step: "implement" }),
      row({ modelReported: "claude-sonnet-5", step: "review" }),
    ];

    expect(breakdownBy(rows, "task").usd).toBe(breakdownBy(rows, "model").usd);
    expect(breakdownBy(rows, "task").tokens.total).toBe(breakdownBy(rows, "model").tokens.total);
  });

  it("uses endpoint pricing for a routed known model in both folds", () => {
    const rows = [
      row({
        modelReported: "cc/claude-opus-5[1m]",
        endpointHost: "router.example.com",
      }),
    ];
    const gatewayPricing = {
      endpointHost: "router.example.com",
      prices: parse9RouterPricing({
        cc: {
          "claude-opus-5[1m]": { input: 1, output: 2, cached: 0.1, cache_creation: 1.25 },
        },
      }),
    };

    const model = breakdownBy(rows, "model", gatewayPricing);
    const task = breakdownBy(rows, "task", gatewayPricing);
    expect(model.usd).toBeCloseTo(0.006625, 10);
    expect(task.usd).toBe(model.usd);
    expect(model.unpriced).toBe(0);
  });
});

describe("a model anton has no price for", () => {
  const UNKNOWN = "some-gateway/mistral-large";

  it("reports its tokens and NO cost — never a zero", () => {
    const { groups } = breakdownBy([row({ modelReported: UNKNOWN })], "model");

    expect(groups[0].usd).toBeUndefined();
    expect(groups[0].tokens.total).toBeGreaterThan(0);
    expect(hasMeasuredTokens(groups[0])).toBe(true);
    // The distinction the whole module exists for: no price is not free.
    expect(formatUsd(groups[0].usd)).toBe("—");
    expect(formatUsd(groups[0].usd)).not.toBe("$0.00");
  });

  it("keeps its tokens in the window total while leaving the dollar total a floor", () => {
    const breakdown = breakdownBy(
      [row({ modelReported: "claude-opus-5" }), row({ modelReported: UNKNOWN })],
      "model",
    );

    expect(breakdown.tokens.total).toBe(27_000);
    expect(breakdown.unpriced).toBe(1);
    expect(breakdown.priced).toBe(1);
    expect(breakdown.unpricedModels).toEqual([UNKNOWN]);
    // The total covers only the priced half, and says as much through `unpriced`.
    expect(breakdown.usd).toBeGreaterThan(0);
  });

  it("marks a partly-priced group as incomplete rather than reporting a bare total", () => {
    const { groups } = breakdownBy(
      [
        row({ step: "review", modelReported: "claude-opus-5" }),
        row({ step: "review", modelReported: UNKNOWN }),
      ],
      "task",
    );

    expect(groups[0].priced).toBe(1);
    expect(groups[0].unpriced).toBe(1);
    expect(isCompletelyPriced(groups[0])).toBe(false);
  });

  it("distinguishes an unpriceable model from an invocation that measured nothing", () => {
    const { groups } = breakdownBy(
      [
        row({ modelReported: UNKNOWN }),
        row({
          modelReported: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          cacheCreationInputTokens: null,
        }),
      ],
      "model",
    );

    const unpriceable = groups.find((g) => g.label === UNKNOWN)!;
    const unmeasured = groups.find((g) => g.label === UNKNOWN_MODEL_LABEL)!;
    expect(hasMeasuredTokens(unpriceable)).toBe(true);
    expect(hasMeasuredTokens(unmeasured)).toBe(false);
    expect(unpriceable.usd).toBeUndefined();
    expect(unmeasured.usd).toBeUndefined();
  });

  it("sorts unpriced groups below priced ones rather than interleaving on a missing number", () => {
    const { groups } = breakdownBy(
      [
        row({ modelReported: UNKNOWN, inputTokens: 9_000_000 }),
        row({ modelReported: "claude-haiku-4-5", inputTokens: 10 }),
      ],
      "model",
    );

    expect(groups.map((g) => g.label)).toEqual(["claude-haiku-4-5", UNKNOWN]);
  });
});

describe("a window with nothing recorded", () => {
  it("reads as empty, not as zero spend", () => {
    const breakdown = breakdownBy([], "model");

    expect(breakdown.recorded).toBe(false);
    expect(breakdown.groups).toEqual([]);
    expect(breakdown.rows).toBe(0);
    // The load-bearing one: no rows means no dollar figure at all, never $0.00.
    expect(breakdown.usd).toBeUndefined();
    expect(formatUsd(breakdown.usd)).toBe("—");
  });

  it("is distinguishable from a window whose rows genuinely measured zero", () => {
    const measuredZero = breakdownBy(
      [row({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })],
      "model",
    );

    expect(measuredZero.recorded).toBe(true);
    expect(measuredZero.usd).toBe(0);
    expect(formatUsd(measuredZero.usd)).toBe("$0.00");
  });
});

describe("token totals", () => {
  it("never adds thinking tokens, which are a subset of output", () => {
    const { tokens } = breakdownBy(
      [row({ inputTokens: 100, outputTokens: 900, thinkingTokens: 400,
             cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })],
      "model",
    );

    expect(tokens.thinking).toBe(400);
    expect(tokens.total).toBe(1_000);
  });

  it("treats an absent count as nothing rather than as an error", () => {
    const { tokens } = breakdownBy(
      [row({ inputTokens: null, outputTokens: 5, cacheReadInputTokens: null,
             cacheCreationInputTokens: null })],
      "model",
    );

    expect(tokens.total).toBe(5);
  });
});

describe("the chosen window", () => {
  it("falls back to the default rather than rejecting an unknown value", () => {
    expect(normalizeWindow("nonsense")).toBe(DEFAULT_SPEND_WINDOW);
    expect(normalizeWindow(undefined)).toBe(DEFAULT_SPEND_WINDOW);
    expect(normalizeWindow("24h")).toBe("24h");
  });

  it("resolves to a cutoff, and to none for all-time", () => {
    expect(windowSince("24h", AT.getTime())).toEqual(new Date("2026-09-08T12:00:00Z"));
    expect(windowSince("7d", AT.getTime())).toEqual(new Date("2026-09-02T12:00:00Z"));
    expect(windowSince("all", AT.getTime())).toBeUndefined();
  });
});

describe("formatting", () => {
  it("compacts token counts without claiming they are approximate", () => {
    expect(formatTokens(912)).toBe("912");
    expect(formatTokens(84_300)).toBe("84.3K");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    // The `≈` belongs to quota-share's sampled figures. These are measured, so it must not appear.
    expect(formatTokens(1_200_000)).not.toContain("≈");
  });

  it("shows a sub-cent amount rather than rounding it away to free", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(4.128)).toBe("$4.13");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(undefined)).toBe("—");
  });

  it("never marks a dollar figure approximate", () => {
    expect(formatUsd(4.128)).not.toContain("≈");
  });
});
