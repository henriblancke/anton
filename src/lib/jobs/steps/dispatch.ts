/**
 * The one claude dispatch every agent-running step goes through.
 *
 * Shared rather than duplicated per step so a run's session record, its live handle and its
 * `ANTON-RESULT` parsing are the SAME wherever an agent runs — a step that grew its own dispatch
 * would quietly drop one of the three.
 */
import { metered, type InvocationDimensions } from "../../claude-invocations";
import { formatAntonResult, parseAntonResult } from "../../claude/anton-result";
import { claudeRouting, runClaude } from "../../claude/driver";
import { quotaMeterKey } from "../../quota-meter";
import { appendSessionLog, endSession, setSessionClaudeId, type SessionKind } from "../../sessions";
import { resolveModel } from "../model-routing";
import { stepName } from "./resolve";
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
    /**
     * The session kind to record this dispatch under. Defaults to `execute` — a delivering step's
     * kind, which `listDeliveriesByBead` (runs.ts) reads as delivery evidence. A step that dispatches
     * an agent but delivers nothing passes its own kind (see `step:describe`).
     */
    sessionKind?: SessionKind;
    /**
     * Route this dispatch against the run's WHOLE label context — the target's labels and every
     * ticket's — rather than the ticket-phase default below (PR #303 review).
     *
     * The default reads one ticket as "this dispatch is about that ticket", which is right for a
     * per-ticket step and wrong for a step describing the run: an epic with one child would route on
     * the CHILD's labels, so a route like `{ step: "describe", label: "risk:high" }` on the epic never
     * fires, and the same run grown a second ticket would suddenly route on the target instead. A
     * run-level step's model must follow the work it covers, not the run's ticket count — so it
     * resolves the way the analogous run-level review does (`review-gate.ts`), against the target and
     * all tickets at once.
     */
    runLevelLabels?: boolean;
    /**
     * Hard-deny these tools for this dispatch (`--disallowedTools`). Deny rules outrank the
     * permission mode, so this BINDS an unattended `bypassPermissions` session rather than asking it
     * — which is what makes it usable as a guard by a step that must not write (`step:describe`).
     */
    disallowedTools?: string[];
    /**
     * Which settings files this session loads (`--setting-sources`). Omitted → Claude Code's default
     * of `user,project,local`, which reads `.claude/settings.json` FROM THE WORKTREE — source-
     * controlled, and able to register hooks that run shell commands. A session that must not write
     * passes `["user"]`, leaving it configured only by the machine anton runs on (the reviewer does
     * the same, via `REVIEW_SETTING_SOURCES`).
     */
    settingSources?: Array<"user" | "project" | "local">;
    /**
     * What this dispatch resolved to run FROM — the ticket's `agent:<tag>`, or the `prompt:`/`skill:`
     * a `step:claude` named, with the skill's content digest. Passed from the caller that already
     * resolved it (`steps/agent.ts`) rather than re-resolved here: a second resolution could answer
     * differently from the one that actually ran, which is worse than not recording it at all.
     */
    attribution?: Pick<
      InvocationDimensions,
      "agentTag" | "promptId" | "skillId" | "skillDigest"
    >;
  },
): Promise<StepResult> {
  // Metered here rather than at each step (anton-77l9): this is the ONE dispatch every agent-running
  // step goes through, so the ledger holds every invocation without a new step having to remember.
  // A resume-aware ticket driver meters its own underlying attempts. Other drivers are metered
  // here, at this shared dispatch boundary.
  const dimensions = {
    projectId: ctx.projectId,
    jobType: ctx.ctx.type,
    jobId: ctx.ctx.jobId,
    step: ctx.step?.id ?? "claude",
    runId: ctx.runId,
    beadId: args.beadId,
    modelRequested: ctx.settings.model,
    ...args.attribution,
  };
  const claude = ctx.deps?.recordsEachAttempt
    ? (ctx.deps.runClaude ?? runClaude)
    : metered(ctx.db, ctx.clock, dimensions, ctx.deps?.runClaude ?? runClaude);
  const { session, owned } = await stepSession(ctx, args.beadId, args.sessionKind);
  ctx.ctx.report({ sessionId: session.sessionId, cwd: ctx.worktreePath });

  try {
    const routing = claudeRouting(ctx.settings);
    await ctx.ctx.claudeReached(quotaMeterKey(ctx.settings));
    const result = await claude({
      cwd: ctx.worktreePath,
      prompt: args.prompt,
      appendSystemPrompt: args.appendSystemPrompt,
      model: resolveModel(ctx.settings, {
        jobType: "execute-epic",
        step: ctx.step ? (stepName(ctx.step) as "implement" | "claude") : undefined,
        // A run-level step covers the whole run, so it routes on the whole run (see
        // `runLevelLabels`). Otherwise: ticket-phase steps receive exactly one ticket, and its labels
        // are the routing context even though this session is filed under the run target by callers
        // that share a session.
        labels: args.runLevelLabels
          ? [ctx.target, ...ctx.tickets].flatMap((bead) => bead.labels ?? [])
          : ctx.tickets.length === 1
            ? (ctx.tickets[0]?.labels ?? [])
            : ctx.target.labels,
      }),
      routing,
      permissionMode: ctx.settings.permissionMode ?? "bypassPermissions",
      ...(args.disallowedTools ? { disallowedTools: args.disallowedTools } : {}),
      ...(args.settingSources ? { settingSources: args.settingSources } : {}),
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
