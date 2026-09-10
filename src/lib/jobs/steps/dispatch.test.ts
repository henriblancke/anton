/**
 * Direct tests for the one claude dispatch every agent-running step goes through: what it records,
 * what it reports, and what it refuses to swallow.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { schema } from "../../db";
import { isUsageLimitError, UsageLimitError } from "../errors";
import { dispatchClaude } from "./dispatch";
import { clock, closeSandbox, fakeClaude, openSandbox, target } from "./step.fixture";

let sandbox: Awaited<ReturnType<typeof openSandbox>>;

beforeEach(async () => {
  sandbox = await openSandbox("steps-dispatch");
});

afterEach(() => closeSandbox(sandbox));

const args = (beadId = target.id, prompt = "do the thing") => ({
  beadId,
  prompt,
  appendSystemPrompt: "the operating contract",
  failure: (text: string | undefined) => `claude reported an error: ${text ?? "unknown"}`,
});

describe("dispatchClaude", () => {
  it("runs in the worktree, records a done session, and parses the self-report", async () => {
    const claude = fakeClaude("all set\n\nANTON-RESULT: delivered");
    const reported: Array<{ sessionId?: string; cwd?: string }> = [];
    const ctx = sandbox.context({ deps: { runClaude: claude.run } });

    const result = await dispatchClaude(
      { ...ctx, ctx: { ...ctx.ctx, report: (info) => reported.push(info) } },
      args(),
    );

    expect(result.ok).toBe(true);
    expect(result.facts?.selfReport?.outcome).toBe("delivered");
    expect(claude.calls[0].cwd).toBe(sandbox.dir);
    expect(claude.calls[0].appendSystemPrompt).toBe("the operating contract");
    const rows = await sandbox.tdb.db.select().from(schema.sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
    // The live handle names the session the agent is actually writing into.
    expect(reported).toEqual([{ sessionId: result.facts?.sessionIds?.[0], cwd: sandbox.dir }]);
  });

  it("routes an execute step by its step id and bead labels", async () => {
    const claude = fakeClaude("ANTON-RESULT: delivered");
    const ctx = sandbox.context({ deps: { runClaude: claude.run } });
    await dispatchClaude(
      {
        ...ctx,
        step: { id: "implementation", labels: ["step:implement"] },
        target: { ...ctx.target, labels: ["risk:high"] },
        // A run-phase implementation has no one ticket to route from.
        tickets: [],
        settings: {
          ...ctx.settings,
          model: "fallback",
          modelRoutes: [
            { jobType: "execute-epic", step: "review", model: "reviewer" },
            { label: "risk:high", model: "safe" },
          ],
        },
      },
      args(),
    );
    expect(claude.calls[0].model).toBe("safe");
  });

  it("routes a ticket-phase custom step by the ticket's labels", async () => {
    const claude = fakeClaude("ANTON-RESULT: delivered");
    const ctx = sandbox.context({ deps: { runClaude: claude.run } });
    const ticket = { ...ctx.target, id: "anton-8d0f.1", labels: ["risk:high"] };

    await dispatchClaude(
      {
        ...ctx,
        step: { id: "security-pass", labels: ["step:claude"] },
        target: { ...ctx.target, labels: ["risk:low"] },
        tickets: [ticket],
        settings: {
          ...ctx.settings,
          model: "fallback",
          modelRoutes: [{ label: "risk:high", model: "safe" }],
        },
      },
      args(ctx.target.id),
    );

    expect(claude.calls[0].model).toBe("safe");
  });

  it("does not let an unlabeled ticket inherit a target-only route", async () => {
    const claude = fakeClaude("ANTON-RESULT: delivered");
    const ctx = sandbox.context({ deps: { runClaude: claude.run } });

    await dispatchClaude(
      {
        ...ctx,
        step: { id: "security-pass", labels: ["step:claude"] },
        target: { ...ctx.target, labels: ["risk:high"] },
        tickets: [{ ...ctx.target, id: "anton-8d0f.1", labels: undefined }],
        settings: {
          ...ctx.settings,
          model: "fallback",
          modelRoutes: [{ label: "risk:high", model: "safe" }],
        },
      },
      args(ctx.target.id),
    );

    expect(claude.calls[0].model).toBe("fallback");
  });

  it("tells the runner Claude was reached before the spawn, so a crashed spawn still counts (PR #248)", async () => {
    // The runner prices the attempt on this signal alone — an attempt that never says so is refunded
    // from the project's spend meter and its burn window discarded. It has to fire BEFORE the
    // driver: a spawn that dies mid-stream burned quota all the same.
    const order: string[] = [];
    const claude = fakeClaude("ANTON-RESULT: delivered");
    const ctx = sandbox.context({
      deps: {
        runClaude: (options) => {
          order.push("spawn");
          return claude.run(options);
        },
      },
    });

    await dispatchClaude(
      {
        ...ctx,
        ctx: {
          ...ctx.ctx,
          claudeReached: async () => {
            order.push("claudeReached");
          },
        },
      },
      args(),
    );

    expect(order).toEqual(["claudeReached", "spawn"]);
  });

  // A run claude itself reported as failed is a step that RAN and did not achieve its work — the
  // caller decides what that means, so it comes back as `ok: false` rather than a throw.
  it("reports a failed run through the caller's own failure wording", async () => {
    const claude = fakeClaude({ ok: false, text: "the model gave up", modelUsage: [] });

    const result = await dispatchClaude(
      sandbox.context({ deps: { runClaude: claude.run } }),
      args(),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("claude reported an error: the model gave up");
    const rows = await sandbox.tdb.db.select().from(schema.sessions);
    expect(rows[0].status).toBe("failed");
  });

  // The runner keys its quota backoff off the error's TYPE, so wrapping it would burn an attempt.
  it("propagates a usage limit unchanged and closes the session it opened", async () => {
    const claude = fakeClaude(new UsageLimitError("Claude AI usage limit reached", 1_700_000_600));

    const raised = await dispatchClaude(
      sandbox.context({ deps: { runClaude: claude.run } }),
      args(),
    ).catch((e) => e);

    expect(isUsageLimitError(raised)).toBe(true);
    const rows = await sandbox.tdb.db.select().from(schema.sessions);
    expect(rows[0].status).toBe("failed");
  });

  it("records into the caller's session when one is handed in, and leaves it open", async () => {
    const claude = fakeClaude("ANTON-RESULT: delivered");
    const { startJobSession } = await import("../../sessions");
    const session = await startJobSession(sandbox.tdb.db, clock, {
      projectId: sandbox.projectId,
      runId: sandbox.runId,
      kind: "execute",
      beadId: target.id,
    });

    await dispatchClaude(
      sandbox.context({ session, deps: { runClaude: claude.run } }),
      args(),
    );

    const rows = await sandbox.tdb.db.select().from(schema.sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
  });

  /**
   * The spend ledger is wired HERE (anton-77l9) rather than in each step, for the same reason this
   * dispatch is shared: the ledger's whole value is holding every invocation, and a per-step
   * recording call is one a new step forgets.
   */
  it("records the invocation's per-model usage against the run's dimensions", async () => {
    const claude = fakeClaude({
      ok: true,
      text: "ANTON-RESULT: delivered",
      sessionId: "sess-9",
      numTurns: 12,
      costUsd: 2.5,
      durationMs: 90_000,
      modelUsage: [
        { model: "claude-opus-5[1m]", inputTokens: 438, outputTokens: 29177 },
        { model: "claude-haiku-4-5-20251001", inputTokens: 1820, outputTokens: 28 },
      ],
    });
    const ctx = sandbox.context({ deps: { runClaude: claude.run } });

    await dispatchClaude(ctx, args());

    const rows = await sandbox.tdb.db.select().from(schema.claudeInvocations);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.modelReported).sort()).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-5[1m]",
    ]);
    // The dimensions the run knows at dispatch, which nothing can reconstruct later.
    expect(rows[0]).toMatchObject({
      projectId: sandbox.projectId,
      jobType: "execute-epic",
      jobId: "job-test",
      runId: ctx.runId,
      beadId: target.id,
      claudeSessionId: "sess-9",
      numTurns: 12,
      outcome: "ok",
    });
  });

  it("still records an invocation whose result reported no readable usage", async () => {
    // The failure the ledger cannot report is a missing row: it would understate spend in silence.
    const claude = fakeClaude({ ok: false, text: "the model gave up", modelUsage: [] });

    await dispatchClaude(sandbox.context({ deps: { runClaude: claude.run } }), args());

    const rows = await sandbox.tdb.db.select().from(schema.claudeInvocations);
    expect(rows).toHaveLength(1);
    expect(rows[0].modelReported).toBeNull();
    expect(rows[0].inputTokens).toBeNull();
    expect(rows[0].outcome).toBe("error");
  });
});
