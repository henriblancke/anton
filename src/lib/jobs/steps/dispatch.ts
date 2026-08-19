/**
 * The one claude dispatch every agent-running step goes through.
 *
 * Shared rather than duplicated per step so a run's session record, its live handle and its
 * `ANTON-RESULT` parsing are the SAME wherever an agent runs — a step that grew its own dispatch
 * would quietly drop one of the three.
 */
import { formatAntonResult, parseAntonResult } from "../../claude/anton-result";
import { runClaude } from "../../claude/driver";
import { appendSessionLog, endSession, setSessionClaudeId } from "../../sessions";
import { stepSession, type StepContext } from "./context";
import type { StepResult } from "./result";

/**
 * One claude dispatch, with everything a step inherits from the run: the session row + log (opened
 * here unless the caller handed one in), the live-session handle, the `ANTON-RESULT` self-report,
 * and the driver's own quota/transient classification passed through untouched — a `UsageLimitError`
 * must reach the runner as itself so the job reschedules instead of burning an attempt.
 */
export async function dispatchClaude(
  ctx: StepContext,
  args: {
    beadId: string;
    prompt: string;
    appendSystemPrompt: string;
    /** The message for a run claude itself reported as failed. */
    failure: (text: string | undefined) => string;
  },
): Promise<StepResult> {
  const claude = ctx.deps?.runClaude ?? runClaude;
  const { session, owned } = await stepSession(ctx, args.beadId);
  ctx.ctx.report({ sessionId: session.sessionId, cwd: ctx.worktreePath });

  try {
    const result = await claude({
      cwd: ctx.worktreePath,
      prompt: args.prompt,
      appendSystemPrompt: args.appendSystemPrompt,
      model: ctx.settings.model,
      permissionMode: ctx.settings.permissionMode ?? "bypassPermissions",
      signal: ctx.ctx.signal,
      onEvent: session.onEvent,
    });
    if (result.sessionId) {
      await setSessionClaudeId(ctx.db, session.sessionId, result.sessionId).catch(() => {});
    }
    // The agent's own verdict. It CORROBORATES the delivery evidence a later step reports, never
    // replaces it — a `delivered` claim on an unchanged tree is exactly the false success the commit
    // step's zero-diff report exists to catch.
    const selfReport = parseAntonResult(result.text);
    await appendSessionLog(session.logPath, `[anton-result] ${formatAntonResult(selfReport)}\n`).catch(
      () => {},
    );
    if (owned) await endSession(ctx.db, ctx.clock, session.sessionId, result.ok ? "done" : "failed");
    return {
      ok: result.ok,
      detail: result.ok ? formatAntonResult(selfReport) : args.failure(result.text),
      facts: { selfReport, sessionIds: [session.sessionId] },
    };
  } catch (e) {
    if (owned) await endSession(ctx.db, ctx.clock, session.sessionId, "failed");
    throw e;
  }
}
