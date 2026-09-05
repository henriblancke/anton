/**
 * The resilient claude driver every dispatching step of one ticket inherits (anton-juar — extracted
 * from execute-epic-ticket.ts).
 *
 * Split the way the retry itself is: {@link claudeResumeDecision} answers whether to resume and
 * nothing else, while everything with a side effect — persisting the captured session id, writing
 * the resume log, escalating to a fresh restart — lives in {@link resumeAfter} around it.
 */
import type { Bead } from "../beads/bd";
import { runClaude, type ClaudeResult, type RunClaudeOptions } from "../claude/driver";
import { appendSessionLog, setSessionClaudeId } from "../sessions";
import { isRecoverableClaudeError, type RecoverableClaudeError } from "./errors";
import type { AntonDb } from "./queue";
import type { JobContext } from "./runner";
import { truncateField } from "./step-registry";

/** Cap on in-session `claude --resume` retries before escalating to a fresh restart (anton-juar). */
const MAX_RESUME_ATTEMPTS = 2;

export function claudeResumeDecision(
  error: { sessionId?: string; signature: string },
  attempt: number,
  priorSignature?: string,
): { resume: true } | { resume: false; reason: string } {
  if (!error.sessionId) return { resume: false, reason: "no session id" };
  if (error.signature === priorSignature) {
    return { resume: false, reason: `repeated ${error.signature}` };
  }
  if (attempt >= MAX_RESUME_ATTEMPTS) {
    return { resume: false, reason: "resume budget spent" };
  }
  return { resume: true };
}

/**
 * A claude driver with resilient in-session recovery (anton-juar), shaped exactly like `runClaude`
 * so it drops into the step registry's driver seam and every step inherits the recovery. A transient
 * mid-stream
 * death (network drop, truncated stream, exit-without-result) that captured a Claude session id is
 * retried with `claude --resume <id>` — continuing the same conversation instead of re-running the
 * whole ticket from scratch — bounded by MAX_RESUME_ATTEMPTS so a flapping connection can't burn the
 * job's retry budget. A resume that dies the SAME way escalates immediately to a fresh restart. When
 * no session id was captured, the failure is deterministic (non-recoverable), or the resume budget
 * is spent, the error propagates so the job-level runner does today's fresh spawn (then parks after
 * maxAttempts) — resume is best-effort and never a new failure mode.
 */
export function resilientClaude(args: {
  db: AntonDb;
  ctx: Pick<JobContext, "signal">;
  /** anton's session row for this ticket — where the captured claude id and the resume log land. */
  sessionId: string;
  logPath: string;
  /** The ticket in scope, for the continuation prompt a resumed session gets. */
  ticket: Bead;
  /**
   * The formula step being dispatched. Every dispatching step in the ticket phase inherits this
   * driver — `implement`, and any `step:claude` the project added — so the continuation prompt names
   * the step rather than implying the resumed session was implementing the ticket.
   */
  stepId?: string;
}): (options: RunClaudeOptions) => Promise<ClaudeResult> {
  const { db, ctx, sessionId, logPath, ticket, stepId } = args;
  return async function dispatch(options: RunClaudeOptions): Promise<ClaudeResult> {
    let resumeId: string | undefined;
    let priorError: string | undefined;
    let priorSignature: string | undefined;

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await runClaude(
          resumeId
            ? {
                ...options,
                // The interrupted step's own context already lives in the resumed conversation, so
                // the prompt is a brief continuation rather than the whole instruction again.
                prompt: continuationPrompt(ticket, priorError, stepId),
                resumeSessionId: resumeId,
              }
            : options,
        );
        // Persist the real Claude session id once the run reports it (diagnostics + future resume).
        if (result.sessionId) await setSessionClaudeId(db, sessionId, result.sessionId).catch(() => {});
        return result;
      } catch (e) {
        const resumable = await resumeAfter({ db, ctx, sessionId, logPath, e, attempt, priorSignature });
        resumeId = resumable.sessionId;
        priorError = resumable.message;
        priorSignature = resumable.signature;
      }
    }
  };
}

/**
 * The side-effecting half of the retry: record what the dead attempt captured, then act on
 * {@link claudeResumeDecision}. Returns the transient error the next attempt resumes from — or
 * throws it, which is how a failure that must escalate to a fresh restart leaves the loop.
 */
async function resumeAfter(args: {
  db: AntonDb;
  ctx: Pick<JobContext, "signal">;
  sessionId: string;
  logPath: string;
  e: unknown;
  attempt: number;
  priorSignature?: string;
}): Promise<RecoverableClaudeError> {
  const { db, ctx, sessionId, logPath, e, attempt, priorSignature } = args;
  // Only a transient (RecoverableClaudeError) failure is resume-eligible. A deterministic/content
  // failure (verify-gate, agent error), poison, or quota is NOT — it propagates unchanged so the
  // runner applies today's fresh-restart/park policy (never a resume that would replay bad state).
  if (!isRecoverableClaudeError(e)) throw e;
  // A killed job (force-kill, or an abandon that cancelled the run — anton-6xj0) aborts the
  // child mid-stream, which looks exactly like a transient death. Never resume through it: the
  // operator asked for this agent to stop, and the retry would spawn against an already-aborted
  // signal anyway. Checked before the resume decision so the abort propagates immediately.
  if (ctx.signal.aborted) throw e;
  // Persist the captured id even on the failure path — a mid-stream death may carry it only via
  // the system-init event, and it's what a fresh-restart's operator or a future resume relies on.
  if (e.sessionId) await setSessionClaudeId(db, sessionId, e.sessionId).catch(() => {});

  const decision = claudeResumeDecision(e, attempt, priorSignature);
  if (!decision.resume) {
    await appendSessionLog(
      logPath,
      `[resume] not resuming (${decision.reason}) — escalating to a fresh restart: ${e.message}\n`,
    ).catch(() => {});
    throw e;
  }
  await appendSessionLog(
    logPath,
    `[resume] transient failure (${e.signature}); resuming claude session ${e.sessionId} — ` +
      `attempt ${attempt + 2}/${MAX_RESUME_ATTEMPTS + 1}: ${e.message}\n`,
  ).catch(() => {});
  return e;
}

/**
 * Brief continuation prompt for a resumed session (anton-juar). Whatever the interrupted session was
 * given — the ticket spec, or a `step:claude`'s own prompt — already lives in the resumed
 * conversation, so this only nudges the agent to pick up where it left off. It names the STEP when
 * there is one: the ticket phase can dispatch several agents, and telling a custom step's agent that
 * its session "for <ticket>" was interrupted misdescribes the work it was actually doing. The
 * captured error is injected ONLY when it may have been caused by the agent's own output (e.g. an
 * oversized tool result that tripped a limit) — never for pure infra noise the agent can't act on,
 * which would only distract it.
 */
export function continuationPrompt(ticket: Bead, priorError?: string, stepId?: string): string {
  const subject = stepId ? `the \`${stepId}\` step of ${ticket.id}` : ticket.id;
  const lines = [
    `Your previous session — ${subject} — was interrupted mid-stream by a transient failure and ` +
      `has been resumed with full conversation context. Continue from where you left off — do NOT ` +
      `restart from scratch. Inspect the working tree for partial edits before redoing anything, so ` +
      `you don't duplicate or conflict with work already in progress.`,
  ];
  if (priorError && mayBeAgentCaused(priorError)) {
    lines.push(
      ``,
      `Your previous session ended with: "${truncateField(priorError)}". If that was caused by your ` +
        `own output (an oversized tool result, too-long input), adjust your approach so it doesn't recur.`,
    );
  }
  lines.push(``, `Follow the operating contract in your system prompt.`);
  return lines.join("\n");
}

/**
 * Could this transient error have been triggered by the AGENT's own output rather than pure infra
 * noise (anton-juar)? Oversized-input / context-window / too-large-payload errors are the agent-caused
 * class worth surfacing back into the continuation; a bare network drop is not, so it's left out.
 */
function mayBeAgentCaused(message: string): boolean {
  return /prompt is too long|input (?:is )?too long|too many tokens|maximum context|context (?:length|window)|request (?:entity )?too large|payload too large|too large|\b413\b/i.test(
    message,
  );
}
