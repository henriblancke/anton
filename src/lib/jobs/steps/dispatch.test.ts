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

const args = (prompt = "do the thing") => ({
  beadId: target.id,
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

  // A run claude itself reported as failed is a step that RAN and did not achieve its work — the
  // caller decides what that means, so it comes back as `ok: false` rather than a throw.
  it("reports a failed run through the caller's own failure wording", async () => {
    const claude = fakeClaude({ ok: false, text: "the model gave up" });

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
});
