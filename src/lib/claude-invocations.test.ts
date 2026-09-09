/**
 * The per-invocation spend ledger (anton-77l9) — what actually lands in the fact table.
 *
 * Table-driven over the shapes a real result event arrives in, because the rule that matters is
 * the same for all of them: EVERY invocation gets a row. Unknown usage is recorded as unknown, and
 * nothing about the field's condition may drop the row or fail the run that produced it.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeResult } from "./claude/driver";
import { createStreamState } from "./claude/driver-events";
import { toClaudeResult } from "./claude/driver-exit";
import {
  hostOf,
  invocationRows,
  invocationSpend,
  listInvocations,
  metered,
  recordInvocation,
} from "./claude-invocations";
import { makeProjectDb, type TestProjectDb } from "./testing/project";
import type { Clock } from "./jobs/queue";

const clock: Clock = { now: () => 1_700_000_000_000 };

const DIMENSIONS = {
  jobType: "execute-epic",
  jobId: "job-1",
  step: "implement",
  runId: "run-1",
  beadId: "anton-77l9",
  modelRequested: "cc/claude-opus-5[1m]",
};

function result(overrides: Partial<ClaudeResult> = {}): ClaudeResult {
  return { ok: true, modelUsage: [], sessionId: "sess-1", numTurns: 4, costUsd: 1.5, ...overrides };
}

const USAGE = [
  { model: "claude-opus-5[1m]", inputTokens: 438, outputTokens: 29177, thinkingTokens: 10732 },
  { model: "claude-haiku-4-5-20251001", inputTokens: 1820, outputTokens: 28 },
];

describe("hostOf", () => {
  it("keeps the host and nothing else, so no path or credential is stored beside it", () => {
    expect(hostOf("https://gateway.example.com/v1/messages?key=secret")).toBe("gateway.example.com");
    expect(hostOf("https://gw.internal:8443/v1")).toBe("gw.internal:8443");
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
    ["unparseable", "not a url"],
  ])("has no host for a %s base url", (_label, raw) => {
    expect(hostOf(raw)).toBeUndefined();
  });
});

describe("invocationRows", () => {
  it("writes one row per model, each carrying the whole set of dimensions", () => {
    const rows = invocationRows(
      { ...DIMENSIONS, projectId: "proj-1", baseUrl: "https://gw.example.com/v1" },
      result({ modelUsage: USAGE, durationMs: 90_000, durationApiMs: 41_000 }),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      projectId: "proj-1",
      jobType: "execute-epic",
      jobId: "job-1",
      step: "implement",
      runId: "run-1",
      beadId: "anton-77l9",
      claudeSessionId: "sess-1",
      // Requested and reported are stored SEPARATELY: a gateway spells ids its own way and may serve
      // a different model than was asked for, and the divergence is only askable if both are kept.
      modelRequested: "cc/claude-opus-5[1m]",
      modelReported: "claude-opus-5[1m]",
      endpointHost: "gw.example.com",
      inputTokens: 438,
      outputTokens: 29177,
      thinkingTokens: 10732,
      numTurns: 4,
      costUsd: 1.5,
      durationMs: 90_000,
      durationApiMs: 41_000,
      outcome: "ok",
    });
    expect(rows[1]).toMatchObject({ modelReported: "claude-haiku-4-5-20251001", inputTokens: 1820 });
  });

  /**
   * The acceptance criterion this table exists to satisfy, driven from RECORDED RESULT EVENTS
   * through the driver's own parse rather than from a hand-built `modelUsage` array — the shapes
   * below are what claude actually emits, and the row they produce is the thing under test.
   *
   * An unreadable usage field costs the figures, never the invocation: a dropped row understates a
   * project's spend in silence, which is the one failure the ledger cannot report.
   */
  it.each([
    ["absent", { type: "result", is_error: true, num_turns: 2 }],
    ["an empty object", { type: "result", is_error: true, num_turns: 2, modelUsage: {} }],
    ["garbage", { type: "result", is_error: true, num_turns: 2, modelUsage: "lots of tokens" }],
    ["null", { type: "result", is_error: true, num_turns: 2, modelUsage: null }],
  ])("records one unknown-usage row when modelUsage is %s", (_label, resultRaw) => {
    const parsed = toClaudeResult({ ...createStreamState(), resultRaw });
    const rows = invocationRows(DIMENSIONS, parsed);

    expect(rows).toHaveLength(1);
    expect(rows[0].modelReported).toBeNull();
    // Null, not zero: an invocation whose usage is UNKNOWN is not one that spent nothing.
    expect(rows[0].inputTokens).toBeUndefined();
    // The dimensions still land, and so does the outcome — the invocation happened and it failed.
    expect(rows[0]).toMatchObject({
      beadId: "anton-77l9",
      step: "implement",
      numTurns: 2,
      outcome: "error",
    });
  });

  it("writes a row per model from a populated recorded result event", () => {
    // The whole event, as claude emits it — the parse and the row are exercised together.
    const parsed = toClaudeResult({
      ...createStreamState(),
      resultRaw: {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-9",
        num_turns: 37,
        duration_ms: 4_368_913,
        duration_api_ms: 444_789,
        total_cost_usd: 6.724998,
        result: "ANTON-RESULT: delivered",
        modelUsage: {
          "claude-haiku-4-5-20251001": { inputTokens: 1820, outputTokens: 28 },
          "claude-opus-5[1m]": { inputTokens: 438, outputTokens: 29177, thinkingTokens: 10732 },
        },
      },
    });

    expect(invocationRows(DIMENSIONS, parsed)).toMatchObject([
      { modelReported: "claude-haiku-4-5-20251001", inputTokens: 1820, numTurns: 37, outcome: "ok" },
      { modelReported: "claude-opus-5[1m]", thinkingTokens: 10732, costUsd: 6.724998, durationMs: 4_368_913 },
    ]);
  });

  it("prefers no endpoint host over a wrong one when the base url does not parse", () => {
    const [row] = invocationRows({ ...DIMENSIONS, baseUrl: "gateway" }, result());
    expect(row.endpointHost).toBeNull();
  });
});

describe("recordInvocation", () => {
  let tdb: TestProjectDb;

  it("persists the rows and reads them back for the project", async () => {
    tdb = makeProjectDb();
    await recordInvocation(
      tdb.db,
      clock,
      { ...DIMENSIONS, projectId: tdb.projectId },
      result({ modelUsage: USAGE }),
    );

    const rows = await listInvocations(tdb.db, tdb.projectId);
    expect(rows.map((r) => r.modelReported).sort()).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-5[1m]",
    ]);
    expect(rows[0].recordedAt?.getTime()).toBe(1_700_000_000_000);
    tdb.close();
  });

  // The ledger is a meter, not a gate. A run that did the work must not fail because the row could
  // not be written — every caller sits on the success path of a dispatch that already spent quota.
  it("never throws when the write fails", async () => {
    tdb = makeProjectDb();
    tdb.close(); // the connection is gone: every insert from here throws

    await expect(
      recordInvocation(tdb.db, clock, { ...DIMENSIONS, projectId: tdb.projectId }, result()),
    ).resolves.toBeUndefined();
  });
});

describe("metered", () => {
  it("records the invocation and returns the driver's result untouched", async () => {
    const tdb = makeProjectDb();
    const reply = result({ modelUsage: USAGE, text: "done" });
    const driver = metered(
      tdb.db,
      clock,
      { ...DIMENSIONS, projectId: tdb.projectId },
      async () => reply,
    );

    await expect(driver({ cwd: "/tmp/wt", prompt: "work" })).resolves.toBe(reply);
    expect(await listInvocations(tdb.db, tdb.projectId)).toHaveLength(2);
    tdb.close();
  });

  it("records the model as SPAWNED, which is what the result's usage answers for", async () => {
    const tdb = makeProjectDb();
    const driver = metered(
      tdb.db,
      clock,
      { ...DIMENSIONS, projectId: tdb.projectId, modelRequested: "settings-default" },
      async () => result({ modelUsage: USAGE.slice(0, 1) }),
    );

    await driver({ cwd: "/tmp/wt", prompt: "work", model: "cc/claude-sonnet-5" });

    const [row] = await listInvocations(tdb.db, tdb.projectId);
    expect(row.modelRequested).toBe("cc/claude-sonnet-5");
    tdb.close();
  });

  /**
   * The CUMULATIVE rule, end to end. `modelUsage` is a session total, so two results in one session
   * record the LATEST figures — never their sum, which would double-count every token the first
   * result already reported.
   */
  it("takes the latest result's usage, never the sum across a session's results", async () => {
    const tdb = makeProjectDb();
    const results = [
      result({ sessionId: "sess-A", modelUsage: [{ model: "opus", inputTokens: 100, outputTokens: 10 }] }),
      result({ sessionId: "sess-A", modelUsage: [{ model: "opus", inputTokens: 340, outputTokens: 55 }] }),
    ];
    let next = 0;
    const driver = metered(
      tdb.db,
      clock,
      { ...DIMENSIONS, projectId: tdb.projectId },
      async () => results[next++],
    );

    await driver({ cwd: "/tmp/wt", prompt: "first" });
    await driver({ cwd: "/tmp/wt", prompt: "second" });

    const rows = await listInvocations(tdb.db, tdb.projectId);
    // Two invocations, each holding the total its own result reported — 340, not 100 + 340 = 440.
    expect(rows.map((r) => r.inputTokens).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([100, 340]);
    expect(rows.map((r) => r.outputTokens).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([10, 55]);
    tdb.close();
  });

  it("records nothing when the driver throws — the ledger holds spend, not failures", async () => {
    const tdb = makeProjectDb();
    const driver = metered(tdb.db, clock, { ...DIMENSIONS, projectId: tdb.projectId }, async () => {
      throw new Error("mid-stream death");
    });

    await expect(driver({ cwd: "/tmp/wt", prompt: "work" })).rejects.toThrow("mid-stream death");
    expect(await listInvocations(tdb.db, tdb.projectId)).toHaveLength(0);
    tdb.close();
  });
});

/**
 * The spend read (anton-r0y6): the verdict rides WITH the numbers, so nobody has to think to ask
 * whether the per-model figures belong to the model they chose.
 */
describe("invocationSpend", () => {
  it("reports no divergence for an unrouted project, whose models always agree", async () => {
    const tdb = makeProjectDb();
    // The ordinary shape: one opus invocation that also reported its haiku sidecar. Judged per ROW
    // this reads as a substitution in every run ever recorded — which is the noise being avoided.
    await recordInvocation(
      tdb.db,
      clock,
      { ...DIMENSIONS, projectId: tdb.projectId, modelRequested: "claude-opus-5" },
      result({ modelUsage: USAGE }),
    );

    const spend = await invocationSpend(tdb.db, tdb.projectId);
    expect(spend.invocations).toHaveLength(1);
    expect(spend.invocations[0].rows).toHaveLength(2);
    expect(spend.divergence).toEqual({
      invocations: 1,
      diverged: 0,
      unknown: 0,
      substitutions: [],
    });
    tdb.close();
  });

  it("flags the invocation a gateway served with something else", async () => {
    const tdb = makeProjectDb();
    const dimensions = {
      ...DIMENSIONS,
      projectId: tdb.projectId,
      modelRequested: "claude-opus-5",
      baseUrl: "https://gw.example.com/v1",
    };
    await recordInvocation(
      tdb.db,
      clock,
      dimensions,
      result({ sessionId: "sess-1", modelUsage: [{ model: "glm-4.6", inputTokens: 900 }] }),
    );

    const spend = await invocationSpend(tdb.db, tdb.projectId);
    expect(spend.divergence).toEqual({
      invocations: 1,
      diverged: 1,
      unknown: 0,
      substitutions: [{ requested: "claude-opus-5", served: ["glm-4.6"], count: 1 }],
    });
    // The endpoint that substituted is on the fact, so the finding points somewhere.
    expect(spend.invocations[0]).toMatchObject({
      divergence: "diverged",
      endpointHost: "gw.example.com",
      beadId: "anton-77l9",
    });
    tdb.close();
  });

  it("reads an invocation that reported no model as unknown, never as diverged", async () => {
    const tdb = makeProjectDb();
    await recordInvocation(
      tdb.db,
      clock,
      { ...DIMENSIONS, projectId: tdb.projectId },
      result({ ok: false, modelUsage: [] }),
    );

    const spend = await invocationSpend(tdb.db, tdb.projectId);
    expect(spend.invocations[0].divergence).toBe("unknown");
    expect(spend.divergence).toMatchObject({ diverged: 0, unknown: 1, substitutions: [] });
    tdb.close();
  });

  it("derives the window's cost from the stored counts, not from the reported costUsd", async () => {
    // anton-j9lf: the result claimed $1.50 for this session. What it actually spent, priced from the
    // counts, is ~$0.73 — and the CLI's claim is priced against a model name a gateway can make
    // meaningless, so the read must not echo it.
    const tdb = makeProjectDb();
    await recordInvocation(
      tdb.db,
      clock,
      { ...DIMENSIONS, projectId: tdb.projectId },
      result({ costUsd: 1.5, modelUsage: USAGE }),
    );

    const spend = await invocationSpend(tdb.db, tdb.projectId);
    // opus: 438 in + 29,177 out (thinking is inside output). haiku: 1,820 in + 28 out.
    expect(spend.cost.usd).toBeCloseTo(0.731615 + (1820 + 28 * 5) / 1e6, 10);
    expect(spend.cost.usd).not.toBeCloseTo(1.5, 2);
    expect(spend.cost).toMatchObject({ priced: 2, unpriced: 0, unpricedModels: [] });
    tdb.close();
  });

  it("leaves a gateway-served model unpriced rather than counting it as free", async () => {
    const tdb = makeProjectDb();
    await recordInvocation(
      tdb.db,
      clock,
      { ...DIMENSIONS, projectId: tdb.projectId, modelRequested: "claude-opus-5" },
      result({ modelUsage: [{ model: "glm-4.6", inputTokens: 900_000, outputTokens: 200_000 }] }),
    );

    const spend = await invocationSpend(tdb.db, tdb.projectId);
    expect(spend.cost).toEqual({
      usd: 0,
      priced: 0,
      unpriced: 1,
      unpricedModels: ["glm-4.6"],
    });
    tdb.close();
  });

  it("reads a project with no recorded calls as empty, not as clean routing", async () => {
    const tdb = makeProjectDb();
    expect(await invocationSpend(tdb.db, tdb.projectId)).toEqual({
      invocations: [],
      divergence: { invocations: 0, diverged: 0, unknown: 0, substitutions: [] },
      cost: { usd: 0, priced: 0, unpriced: 0, unpricedModels: [] },
    });
    tdb.close();
  });
});
