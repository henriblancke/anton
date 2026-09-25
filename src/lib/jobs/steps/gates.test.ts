/**
 * Direct tests for the two gate steps. Both answer "is this work fit to become a PR" and both
 * REPORT rather than act — the park/halt call stays with the caller, and that translation is what
 * these pin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { eq } from "drizzle-orm";

import { schema } from "../../db";
import { findRunGateFailureForBranch } from "../../runs";
import { isVerifyGateFailedError } from "../errors";
import type { ReviewGateResult } from "../review-gate";
import { BRANCH, closeSandbox, openSandbox, target } from "./step.fixture";

const runReviewGate = vi.hoisted(() => vi.fn());
vi.mock("../review-gate", () => ({ runReviewGate }));

const { reviewStep, verifyStep } = await import("./gates");

let sandbox: Awaited<ReturnType<typeof openSandbox>>;

beforeEach(async () => {
  sandbox = await openSandbox("steps-gates");
  runReviewGate.mockReset();
});

afterEach(() => closeSandbox(sandbox));

describe("step:verify", () => {
  // No gates ⇒ nothing runs and no session is opened, so there is nothing to point the handle at.
  it("runs nothing and opens no session when the project pinned no gates", async () => {
    const reported: unknown[] = [];
    const ctx = sandbox.context();

    const result = await verifyStep({ ...ctx, ctx: { ...ctx.ctx, report: (i) => reported.push(i) } });

    expect(result.ok).toBe(true);
    expect(result.detail).toBe("no verify gates configured");
    expect(reported).toEqual([]);
    expect(await sandbox.tdb.db.select().from(schema.sessions)).toHaveLength(0);
  });

  // A run-phase verify opens its OWN session; without the report the live handle keeps naming the
  // last ticket's already-ended one for the whole of a potentially long gate.
  it("runs the pinned gates and points the live handle at their own session", async () => {
    const reported: Array<{ sessionId?: string }> = [];
    const ctx = sandbox.context({ settings: { testCommand: "exit 0", lintCommand: "exit 0" } });

    const result = await verifyStep({ ...ctx, ctx: { ...ctx.ctx, report: (i) => reported.push(i) } });

    expect(result.ok).toBe(true);
    expect(result.detail).toBe("2 gate(s) passed");
    expect(reported[0]?.sessionId).toBe(result.facts?.sessionIds?.[0]);
    const rows = await sandbox.tdb.db.select().from(schema.sessions);
    expect(rows[0].status).toBe("done");
  });

  // A red gate must never let the caller commit behind it — and must not leave a running session.
  it("throws on a failing gate and closes the session it opened as failed", async () => {
    await expect(verifyStep(sandbox.context({ settings: { testCommand: "exit 1" } }))).rejects.toThrow(
      /tests gate failed/,
    );

    const rows = await sandbox.tdb.db.select().from(schema.sessions);
    expect(rows[0].status).toBe("failed");
  });

  /** What the run row currently remembers about a red gate. */
  const recordOf = async (): Promise<string | null> => {
    const [row] = await sandbox.tdb.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, sandbox.runId));
    return row.lastGateFailure;
  };

  const RECORD = JSON.stringify({
    label: "tests",
    command: "bun run test",
    code: 1,
    output: "FAIL",
    beadId: "anton-8d0f",
  });

  const remember = async () =>
    sandbox.tdb.db
      .update(schema.runs)
      .set({ lastGateFailure: RECORD })
      .where(eq(schema.runs.id, sandbox.runId));

  // The gate is green, so a failure the row still remembers describes a tree that no longer exists
  // — and the next attempt would be sent after a bug that is already fixed (anton-vynb8).
  it("forgets a recorded gate failure once the gates pass", async () => {
    await remember();

    await verifyStep(sandbox.context({ settings: { testCommand: "exit 0" } }));

    expect(await recordOf()).toBeNull();
  });

  // The reviewer's 3-attempt repro: attempt 1 records a red gate and settles `failed`; attempt 2 (a
  // fresh row) passes the gate, then stops for some other reason. Attempt 3 must not be sent after
  // the failure attempt 2 already fixed, and the stale record sits on attempt 1's row, not attempt 2's.
  it("forgets a failure an EARLIER attempt on the branch recorded once the gates pass", async () => {
    await sandbox.tdb.db.insert(schema.runs).values({
      id: "attempt-1",
      projectId: sandbox.projectId,
      epicBeadId: target.id,
      branch: BRANCH,
      status: "failed",
      lastGateFailure: RECORD,
    });
    const read = () => findRunGateFailureForBranch(sandbox.tdb.db, sandbox.projectId, target.id, BRANCH);
    expect((await read())?.label).toBe("tests");

    await verifyStep(sandbox.context({ settings: { testCommand: "exit 0" } }));

    expect(await read()).toBeUndefined();
  });

  it("never forgets a failure recorded on a different branch", async () => {
    await sandbox.tdb.db.insert(schema.runs).values({
      id: "other-branch",
      projectId: sandbox.projectId,
      epicBeadId: target.id,
      branch: "anton/elsewhere",
      status: "failed",
      lastGateFailure: RECORD,
    });

    await verifyStep(sandbox.context({ settings: { testCommand: "exit 0" } }));

    expect(
      await findRunGateFailureForBranch(sandbox.tdb.db, sandbox.projectId, target.id, "anton/elsewhere"),
    ).toBeDefined();
  });

  // Nothing proved anything green here, so the record is left for the settle/resume to carry.
  it("leaves the record alone when the gate goes red", async () => {
    await remember();

    await expect(
      verifyStep(sandbox.context({ settings: { testCommand: "exit 1" } })),
    ).rejects.toSatisfy(isVerifyGateFailedError);

    expect(await recordOf()).toBe(RECORD);
  });

  // A project that pins no gates proves nothing green either — the step returns before it could.
  it("leaves the record alone when the project pins no gates", async () => {
    await remember();

    await verifyStep(sandbox.context());

    expect(await recordOf()).toBe(RECORD);
  });

  // The record has to say WHERE it went red, or a re-attempt cannot act on it.
  it("names the bead and the formula step the red gate ran under", async () => {
    const e = await verifyStep(
      sandbox.context({
        settings: { testCommand: "exit 1" },
        step: { id: "verify", labels: ["step:verify"] },
      }),
    ).catch((err: unknown) => err);

    expect(isVerifyGateFailedError(e) && e.site).toEqual({ beadId: "anton-8d0f", stepId: "verify" });
  });
});

describe("step:review", () => {
  const verdict = (outcome: ReviewGateResult["outcome"]): ReviewGateResult => ({
    outcome,
    baseRev: "base-sha",
    rounds: [],
    unresolved: [],
    reviewer: { kind: "default" },
  });

  it("reports the verdict rather than acting on it", async () => {
    runReviewGate.mockResolvedValue(verdict("clean"));
    const clean = await reviewStep(sandbox.context());
    expect(clean.ok).toBe(true);
    expect(clean.facts.review.outcome).toBe("clean");

    runReviewGate.mockResolvedValue(verdict("unresolved"));
    const unresolved = await reviewStep(sandbox.context());
    // Not a throw and not a park: the caller owns what an unresolved verdict does to the run.
    expect(unresolved.ok).toBe(false);
    expect(unresolved.facts.review.outcome).toBe("unresolved");
  });

  // The gate diffs against the ref the run actually FORKED from, not the local base, which may have
  // drifted since. Seeding the earlier gate's open findings is what makes a second `step:review`
  // speak for the whole open set.
  it("hands the gate the fork point and the advisories an earlier review left open", async () => {
    runReviewGate.mockResolvedValue(verdict("clean"));
    const carried = [{ severity: "advisory" as const, location: "src/a.ts:3", note: "tidy this" }];

    await reviewStep(sandbox.context({ advisories: carried }));

    expect(runReviewGate).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "origin/main", carried }),
    );
  });
});
