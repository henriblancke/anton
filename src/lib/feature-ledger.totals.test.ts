/**
 * The totals fold (anton-8h3g2), tested against the three places it could lie.
 *
 * Arithmetic is checked against a hand-summed fixture rather than against a re-implementation of the
 * fold, so a bug in the fold cannot also be the expectation. The honesty claims get their own cases:
 * an unpriced bucket reports tokens with no dollars, a partly-priced one reports BOTH counts beside a
 * figure that is a floor, an empty scope is `recorded: false` rather than a wall of zeroes, and
 * unattributable spend sits in its own bucket at full value instead of being spread over the phases
 * around it.
 */
import { describe, expect, it } from "vitest";

import { ledgerTotals, type LedgerTotalsRow } from "./feature-ledger";
import type { GatewayPricing } from "./model-pricing";

const MINUTE = 60_000;

/** An opus row: 1M input + 1M output = $5 + $25 at opus-5's list rates. Exact by construction. */
function row(overrides: Partial<LedgerTotalsRow> = {}): LedgerTotalsRow {
  return {
    invocationId: "inv-1",
    projectId: "p1",
    jobType: "execute-epic",
    jobId: "j1",
    step: "implement",
    stepHandler: "implement",
    runId: "r1",
    beadId: "anton-aaa",
    claudeSessionId: "s1",
    modelRequested: "claude-opus-5",
    modelReported: "claude-opus-5",
    // `undefined` asks for the API-rate equivalent; a persisted row carries null or a host, and the
    // routed cases below pass one explicitly.
    endpointHost: "api.anthropic.com",
    outcome: "ok",
    recordedAt: new Date("2026-09-20T09:00:00Z"),
    durationMs: 10 * MINUTE,
    durationApiMs: 4 * MINUTE,
    numTurns: 12,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    thinkingTokens: 250_000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    ...overrides,
  };
}

describe("per-phase totals", () => {
  it("matches a hand-summed fixture, phase by phase", () => {
    const rows = [
      row({ invocationId: "i1", stepHandler: "implement", numTurns: 12, durationMs: 10 * MINUTE }),
      row({ invocationId: "i2", stepHandler: "implement", numTurns: 8, durationMs: 5 * MINUTE }),
      row({ invocationId: "i3", stepHandler: "review", step: "review", numTurns: 3, durationMs: 2 * MINUTE }),
      row({ invocationId: "i4", stepHandler: "describe", step: "describe", numTurns: 2, durationMs: MINUTE }),
    ];

    const { phases, totals, recorded } = ledgerTotals(rows);

    expect(recorded).toBe(true);
    // Two opus invocations at $30 each; 2M in, 2M out; 20 turns; 15 minutes active.
    expect(phases.get("implement")).toMatchObject({
      runs: 2,
      rows: 2,
      pricedRows: 2,
      unpricedRows: 0,
      usd: 60,
      turns: 20,
      activeMs: 15 * MINUTE,
      apiMs: 8 * MINUTE,
      errors: 0,
      tokens: { input: 2_000_000, output: 2_000_000, thinking: 500_000, cacheRead: 0, cacheWrite: 0 },
    });
    expect(phases.get("self-review")).toMatchObject({ runs: 1, usd: 30, turns: 3, activeMs: 2 * MINUTE });
    expect(phases.get("describe")).toMatchObject({ runs: 1, usd: 30, turns: 2, activeMs: MINUTE });
    expect(phases.get("pr-fix")).toBeUndefined();

    // The scope's own bill is the sum of its phases — and only ever that sum.
    expect(totals).toMatchObject({ runs: 4, rows: 4, usd: 120, turns: 25, activeMs: 18 * MINUTE });
  });

  it("carries every field the design names", () => {
    const totals = ledgerTotals([row()]).totals;
    expect(Object.keys(totals).sort()).toEqual(
      [
        "activeMs",
        "apiMs",
        "errors",
        "pricedRows",
        "rows",
        "runs",
        "tokens",
        "turns",
        "unpricedRows",
        "usd",
      ].sort(),
    );
    expect(Object.keys(totals.tokens).sort()).toEqual(
      ["cacheRead", "cacheWrite", "input", "output", "thinking"].sort(),
    );
  });

  it("counts an invocation ONCE however many models it reported usage under", () => {
    // The grain trap: `duration_ms`, `duration_api_ms` and `num_turns` are invocation-level measures
    // copied onto each per-model row, so a per-ROW sum would multiply all three by the model count —
    // and essentially every real opus invocation writes a haiku sidecar row.
    const sidecar = [
      row({ invocationId: "i1", modelReported: "claude-opus-5" }),
      row({
        invocationId: "i1",
        modelReported: "claude-haiku-4-5",
        inputTokens: 100_000,
        outputTokens: 100_000,
        thinkingTokens: 0,
      }),
    ];

    const implement = ledgerTotals(sidecar).phases.get("implement");
    // One invocation, two rows: the measures count once, the tokens and dollars count both rows.
    expect(implement).toMatchObject({
      runs: 1,
      rows: 2,
      pricedRows: 2,
      turns: 12,
      activeMs: 10 * MINUTE,
      apiMs: 4 * MINUTE,
      tokens: { input: 1_100_000, output: 1_100_000, thinking: 250_000 },
    });
    // $30 opus + haiku's own rates on its own row — each row billed at the model that served it.
    expect(implement?.usd).toBeCloseTo(30 + (100_000 * 1 + 100_000 * 5) / 1_000_000, 10);
  });

  it("counts an invocation claude reported as failed, without discarding its spend", () => {
    const rows = [
      row({ invocationId: "i1", outcome: "error" }),
      row({ invocationId: "i2", outcome: "ok" }),
    ];
    // Money spent without a result is still money spent — the count is beside the spend, not
    // instead of it.
    expect(ledgerTotals(rows).phases.get("implement")).toMatchObject({ runs: 2, errors: 1, usd: 60 });
  });

  it("treats a missing measure as a floor rather than refusing the total", () => {
    const rows = [
      row({ invocationId: "i1", durationMs: 10 * MINUTE, durationApiMs: null, numTurns: null }),
      row({ invocationId: "i2", durationMs: null, durationApiMs: 2 * MINUTE, numTurns: 5 }),
    ];
    expect(ledgerTotals(rows).phases.get("implement")).toMatchObject({
      runs: 2,
      activeMs: 10 * MINUTE,
      apiMs: 2 * MINUTE,
      turns: 5,
    });
  });
});

describe("rule 1 — unpriced is tokens-only, never free", () => {
  it("reports tokens with usd undefined when nothing in the bucket could be priced", () => {
    const rows = [
      row({ invocationId: "i1", modelReported: "glm-4.6", endpointHost: "gateway.example.com" }),
    ];
    const implement = ledgerTotals(rows).phases.get("implement");
    expect(implement?.usd).toBeUndefined();
    expect(implement?.usd).not.toBe(0);
    expect(implement).toMatchObject({
      runs: 1,
      rows: 1,
      pricedRows: 0,
      unpricedRows: 1,
      tokens: { input: 1_000_000, output: 1_000_000 },
    });
  });

  it("reports BOTH counts for a partly-priced bucket, so its figure reads as a floor", () => {
    const rows = [
      row({ invocationId: "i1" }),
      row({ invocationId: "i2", modelReported: "glm-4.6", endpointHost: "gateway.example.com" }),
    ];
    // $30 is real and incomplete at once: the unpriced row's tokens are in the total, its dollars
    // cannot be. The two counts beside the figure are what let a UI say so.
    expect(ledgerTotals(rows).phases.get("implement")).toMatchObject({
      usd: 30,
      pricedRows: 1,
      unpricedRows: 1,
      rows: 2,
      tokens: { input: 2_000_000, output: 2_000_000 },
    });
  });

  it("keeps an unpriced bucket from zeroing the scope total, and from inflating it", () => {
    const rows = [
      row({ invocationId: "i1", stepHandler: "implement" }),
      row({
        invocationId: "i2",
        stepHandler: "describe",
        step: "describe",
        modelReported: "glm-4.6",
        endpointHost: "gateway.example.com",
      }),
    ];
    const { phases, totals } = ledgerTotals(rows);
    expect(phases.get("describe")?.usd).toBeUndefined();
    expect(totals.usd).toBe(30);
    expect(totals).toMatchObject({ pricedRows: 1, unpricedRows: 1 });
  });

  it("leaves the scope total undefined when it could price nothing at all", () => {
    const rows = [row({ modelReported: "glm-4.6", endpointHost: "gateway.example.com" })];
    expect(ledgerTotals(rows).totals.usd).toBeUndefined();
  });

  it("names the models it has no price for, most-seen first", () => {
    const rows = [
      row({ invocationId: "i1", modelReported: "glm-4.6", endpointHost: "gw.example.com" }),
      row({ invocationId: "i2", modelReported: "glm-4.6", endpointHost: "gw.example.com" }),
      row({ invocationId: "i3", modelReported: "kimi-k2", endpointHost: "gw.example.com" }),
      // The unknown-usage row a crashed result writes names nothing to add to the table.
      row({ invocationId: "i4", modelReported: null, inputTokens: null, outputTokens: null }),
    ];
    expect(ledgerTotals(rows).unpricedModels).toEqual(["glm-4.6", "kimi-k2"]);
  });

  it("does not name a PRICED model whose row simply measured no counts", () => {
    // A crashed invocation: opus is a model anton prices just fine, but this row reported no counts
    // at all, so `costOf` is undefined for a reason that has nothing to do with the price table —
    // naming opus here would wrongly tell the UI to add a model it already knows how to price.
    const rows = [
      row({
        invocationId: "i1",
        modelReported: "claude-opus-5",
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        durationMs: null,
        durationApiMs: null,
        numTurns: null,
      }),
      row({ invocationId: "i2", modelReported: "glm-4.6", endpointHost: "gw.example.com" }),
    ];
    expect(ledgerTotals(rows).unpricedModels).toEqual(["glm-4.6"]);
  });

  it("leaves an UNROUTED row unpriced — its billing mode is unknown, not free", () => {
    // `model-pricing`'s rule, and worth pinning here because it is the ordinary case: a null host
    // means the CLI used its default transport, which may be a subscription rather than API billing.
    // The tokens are real either way; inventing a list-rate charge for them would not be.
    const totals = ledgerTotals([row({ endpointHost: null })]);
    const implement = totals.phases.get("implement");
    expect(implement?.usd).toBeUndefined();
    expect(implement).toMatchObject({ unpricedRows: 1, tokens: { input: 1_000_000 } });
    // The default row's model (claude-opus-5) is one anton already prices — the unknown fact here is
    // the billing mode, not the model's rate, so it must not be reported as a price-table gap
    // (PR #320 review).
    expect(totals.unpricedModels).toEqual([]);
  });

  it("names a model with NO price table entry at all, even over an unrouted transport", () => {
    // Unlike the case above, a model anton genuinely has no price for is still worth reporting —
    // the null host does not excuse a real price-table gap (PR #320 review).
    const totals = ledgerTotals([row({ modelReported: "glm-4.6", endpointHost: null })]);
    expect(totals.unpricedModels).toEqual(["glm-4.6"]);
  });

  it("prices a routed row once the caller supplies that endpoint's rates", () => {
    const gateway: GatewayPricing = {
      endpointHost: "gw.example.com",
      prices: { "glm-4.6": { input: 1, output: 2 } },
    };
    const rows = [row({ modelReported: "glm-4.6", endpointHost: "gw.example.com" })];
    expect(ledgerTotals(rows, gateway).phases.get("implement")).toMatchObject({
      usd: 3,
      pricedRows: 1,
      unpricedRows: 0,
    });
    expect(ledgerTotals(rows, gateway).unpricedModels).toEqual([]);
  });

  it("names a model whose gateway rate is missing the cache component a row actually used", () => {
    // The gateway prices input/output for this model but never reported a cache rate — `costOf`
    // correctly refuses to guess and leaves the row unpriced, but a check that only asks "does a
    // price entry exist" would call it priced and never say why the total is incomplete
    // (PR #320 review).
    const gateway: GatewayPricing = {
      endpointHost: "gw.example.com",
      prices: { "glm-4.6": { input: 1, output: 2 } },
    };
    const rows = [
      row({
        modelReported: "glm-4.6",
        endpointHost: "gw.example.com",
        cacheReadInputTokens: 1_000_000,
      }),
    ];
    const implement = ledgerTotals(rows, gateway).phases.get("implement");
    expect(implement?.usd).toBeUndefined();
    expect(implement).toMatchObject({ pricedRows: 0, unpricedRows: 1 });
    expect(ledgerTotals(rows, gateway).unpricedModels).toEqual(["glm-4.6"]);
  });
});

describe("rule 2 — nothing recorded is empty, not zero", () => {
  it("returns recorded: false with no phases and no buckets", () => {
    const empty = ledgerTotals([]);
    expect(empty.recorded).toBe(false);
    expect(empty.phases.size).toBe(0);
    expect(empty.unattributed).toBeUndefined();
    expect(empty.overhead).toBeUndefined();
    expect(empty.rows).toBe(0);
    // The totals object exists so a caller need not null-check it, but `recorded: false` is what
    // says it means nothing — and its dollars are absent, not $0.00.
    expect(empty.totals.usd).toBeUndefined();
  });

  it("distinguishes nothing-recorded from a scope that recorded a zero", () => {
    // A crashed invocation reported no counts at all: it happened, it is recorded, and anton cannot
    // derive a cost for it. That is the opposite fact from an empty scope.
    const crashed = ledgerTotals([
      row({
        modelReported: null,
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        numTurns: null,
        durationMs: null,
        durationApiMs: null,
        outcome: "error",
      }),
    ]);
    expect(crashed.recorded).toBe(true);
    expect(crashed.phases.get("implement")).toMatchObject({
      runs: 1,
      rows: 1,
      unpricedRows: 1,
      errors: 1,
      usd: undefined,
      tokens: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("omits a phase that recorded nothing rather than publishing a zeroed one", () => {
    const { phases } = ledgerTotals([row({ stepHandler: "implement" })]);
    expect([...phases.keys()]).toEqual(["implement"]);
    expect(phases.get("pr-fix")).toBeUndefined();
  });
});

describe("rule 3 — cost is never split proportionally", () => {
  it("buckets unattributable spend whole, leaving every phase untouched", () => {
    const rows = [
      row({ invocationId: "i1", stepHandler: "implement" }),
      // A row written before `step_handler` existed: it classifies to nothing, and guessing from
      // `step` is exactly the author-id guess the phase mapping refuses.
      row({ invocationId: "i2", stepHandler: null, step: "implement" }),
    ];
    const { phases, unattributed, totals } = ledgerTotals(rows);

    expect(phases.get("implement")).toMatchObject({ runs: 1, usd: 30, rows: 1 });
    expect(unattributed).toMatchObject({ runs: 1, usd: 30, rows: 1, turns: 12 });
    // The unattributed dollars are in the scope's bill at full value — not spread across the phases,
    // and not dropped from the total either.
    expect(totals.usd).toBe(60);
    expect(totals.runs).toBe(2);
  });

  it("buckets a mechanical job's row rather than defaulting it into implement", () => {
    // `sync-push` declares it dispatches no claude, so a ledger row under one is an anomaly. The
    // bucket makes the anomaly visible; a default phase would hide it inside real spend.
    const { phases, unattributed } = ledgerTotals([row({ jobType: "sync-push" })]);
    expect(phases.size).toBe(0);
    expect(unattributed).toMatchObject({ runs: 1, usd: 30 });
  });

  it("keeps a scheduled pass's spend out of the feature's bill entirely (design D4)", () => {
    const rows = [
      row({ invocationId: "i1", stepHandler: "implement" }),
      row({ invocationId: "i2", jobType: "gardener", step: "gardener", stepHandler: "gardener" }),
    ];
    const { phases, overhead, totals } = ledgerTotals(rows);

    // Overhead serves the whole board, so it is reported on its own field and divided into nothing.
    expect(overhead).toMatchObject({ runs: 1, usd: 30, rows: 1 });
    expect([...phases.keys()]).toEqual(["implement"]);
    expect(totals).toMatchObject({ runs: 1, usd: 30, rows: 1 });
  });

  it("reports the rows it folded across every bucket, so nothing is silently dropped", () => {
    const rows = [
      row({ invocationId: "i1", stepHandler: "implement" }),
      row({ invocationId: "i2", stepHandler: null }),
      row({ invocationId: "i3", jobType: "board-picker", stepHandler: "board-picker" }),
    ];
    const ledger = ledgerTotals(rows);
    const bucketed =
      [...ledger.phases.values()].reduce((n, b) => n + b.rows, 0) +
      (ledger.unattributed?.rows ?? 0) +
      (ledger.overhead?.rows ?? 0);
    expect(bucketed).toBe(ledger.rows);
    expect(ledger.rows).toBe(3);
  });
});
