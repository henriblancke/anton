/**
 * The two GATES a run passes through: `step:verify` (the project's pinned commands) and
 * `step:review` (the pre-PR self-review). Both answer the same question — is this work fit to
 * become a PR — and both report rather than act, leaving the park/halt call to the caller.
 */
import { resolveVerifyGates } from "../../projects";
import { endSession } from "../../sessions";
import { runReviewGate } from "../review-gate";
import { runVerifyGates } from "../shell";
import { stepSession, stepSubject, type StepContext } from "./context";
import type { StepResult, StepResultWith } from "./result";

/**
 * `step:verify` — the project's operator-pinned gates (tests, lint, typecheck, build) in the
 * worktree. No gates configured ⇒ nothing runs, which is the unchanged behavior for a project that
 * pinned none. A non-zero exit throws, exactly as it does today, so the caller never commits behind
 * a red gate.
 */
export async function verifyStep(ctx: StepContext): Promise<StepResult> {
  const gates = resolveVerifyGates(ctx.settings);
  // No gates ⇒ nothing to run and nothing to record: return before a session is opened for an
  // empty log.
  if (gates.length === 0) return { ok: true, detail: "no verify gates configured" };

  const subject = stepSubject(ctx).id;
  const { session, owned } = await stepSession(ctx, subject);
  // The live handle has to name the session the gates are actually writing into. A run-phase verify
  // (a formula that moved `step:verify` after the commit) opens its OWN session, so without this
  // observe/investigate would attach to the last ticket's already-ended one for the whole of a
  // potentially long run-wide gate. Reported unconditionally, like every dispatching step: when the
  // caller handed its session in, this re-reports the one already on the handle.
  ctx.ctx.report({ sessionId: session.sessionId, cwd: ctx.worktreePath });
  try {
    await runVerifyGates(
      gates,
      ctx.worktreePath,
      ctx.ctx.signal,
      session.logPath,
      (gate, code) => `${gate.label} gate failed for ${subject} (exit ${code})`,
    );
  } catch (e) {
    if (owned) await endSession(ctx.db, ctx.clock, session.sessionId, "failed");
    throw e;
  }
  if (owned) await endSession(ctx.db, ctx.clock, session.sessionId, "done");
  return { ok: true, detail: `${gates.length} gate(s) passed`, facts: { sessionIds: [session.sessionId] } };
}

/**
 * `step:review` — the pre-PR self-review gate (anton-cbak): a fresh-context reviewer reads the run's
 * diff and its blocking findings are fixed on the branch before a PR exists.
 *
 * Reports the verdict rather than acting on it: whether an unresolved verdict parks the run, and
 * where the advisories are recorded, is the caller's call.
 *
 * A formula may name this step more than once. Each one is its own gate, so the advisories the
 * previous one left open ({@link StepContext.advisories}) are seeded as this gate's carry — the
 * reviewer is shown them and settles them, which is what makes the caller replacing its open set
 * (rather than accumulating) honest.
 */
export async function reviewStep(ctx: StepContext): Promise<StepResultWith<"review">> {
  // Asserted here AND handed in: the gate's review → fix → re-review sequence can outlive the lease
  // TTL, so it re-asserts at every dispatch rather than only on the way in.
  ctx.assertLeaseHeld?.();
  const review = await runReviewGate({
    db: ctx.db,
    clock: ctx.clock,
    ctx: ctx.ctx,
    projectId: ctx.projectId,
    runId: ctx.runId,
    target: ctx.target,
    tickets: ctx.tickets,
    settings: ctx.settings,
    worktreePath: ctx.worktreePath,
    baseBranch: ctx.baseRef,
    assertLeaseHeld: ctx.assertLeaseHeld,
    rounds: ctx.rounds,
    carried: ctx.advisories,
  });
  return {
    ok: review.outcome === "clean",
    detail: `self-review ${review.outcome} after ${review.rounds.length} round(s)`,
    facts: { review },
  };
}

