/**
 * The two steps that dispatch an AGENT — `step:implement` (the ticket's own) and `step:claude` (the
 * generic extension point). They differ only in what they hand the agent to reason from, so they
 * share this module and the one dispatch beneath it.
 */
import { beads, labelValueOf, type Bead } from "../../beads/bd";
import { loadAgentPrompt } from "../../claude/agent-prompt";
import { buildExecutionSystemPrompt } from "../../claude/system-prompt";
import type { StepContext } from "./context";
import { dispatchClaude } from "./dispatch";
import { stepTaskBlock, ticketPrompt } from "./prompts";
import { loadStepReasoning } from "./resolve";
import type { StepResult, StepResultWith } from "./result";

/**
 * `step:implement` — dispatch the ticket's agent in the worktree (execute-epic's per-ticket claude
 * call). One session per ticket, the ticket's `agent:` prompt in the system prompt, the full spec on
 * stdin, and the agent's `ANTON-RESULT` self-report parsed out of its final message.
 *
 * The bead's notes are re-read at dispatch, not taken from the run's opening snapshot: an operator's
 * steer (anton-bfy4) can land while an earlier ticket is still running.
 */
export async function implementStep(ctx: StepContext): Promise<StepResultWith<"sessionIds">> {
  const sessionIds: string[] = [];
  let last: StepResult = { ok: true };
  for (const ticket of ctx.tickets) {
    ctx.assertLeaseHeld?.();
    const agentTag = labelValueOf(ticket.labels, "agent");
    // The base contract is mandatory (buildExecutionSystemPrompt throws without it); the agent tag
    // and the operator's seed layer on top.
    const appendSystemPrompt = await buildExecutionSystemPrompt({
      agentPrompt: await loadAgentPrompt(agentTag, { projectDir: ctx.worktreePath }),
      seedPrompt: ctx.settings.seedPrompt,
    });
    const dispatched = await withDispatchNotes(ctx.repoPath, ticket);
    last = await dispatchClaude(ctx, {
      beadId: ticket.id,
      prompt: ticketPrompt(dispatched),
      appendSystemPrompt,
      failure: (text) => `claude reported an error for ${ticket.id}: ${text ?? "unknown"}`,
    });
    sessionIds.push(...(last.facts?.sessionIds ?? []));
    // The LAST dispatch's self-report is the one that speaks for the step: a caller running a step
    // per ticket (as execute-epic does) sees one either way, and a run-wide dispatch is judged on
    // where it ended up.
    if (!last.ok) return { ...last, facts: { ...last.facts, sessionIds } };
  }
  return { ok: true, detail: last.detail, facts: { ...last.facts, sessionIds } };
}

/**
 * `step:claude` — the generic extension point. A project adds a pipeline step by naming a prompt or
 * skill of its own on the formula step (`prompt:<id>` → an agent-style prompt file, `skill:<id>` →
 * the project's `.claude/skills/<id>/SKILL.md`, falling back to anton's own) with NO anton code
 * change.
 *
 * It is cheap because it adds no failure mode: it dispatches through the same driver every other
 * step uses, so session recording, the lease assertion, quota backoff/parking and `ANTON-RESULT`
 * parsing all come along unchanged. A step that names no prompt, or names one that resolves nowhere,
 * parks the run rather than running an agent with no instruction.
 */
export async function claudeStep(ctx: StepContext): Promise<StepResult> {
  const stepId = ctx.step?.id ?? "claude";
  const reasoning = await loadStepReasoning(ctx, stepId);
  ctx.assertLeaseHeld?.();
  return dispatchClaude(ctx, {
    beadId: ctx.target.id,
    prompt: [reasoning, "", "---", "", stepTaskBlock(ctx, stepId)].join("\n"),
    appendSystemPrompt: await buildExecutionSystemPrompt({ seedPrompt: ctx.settings.seedPrompt }),
    failure: (text) => `claude reported an error for step ${stepId}: ${text ?? "unknown"}`,
  });
}

/**
 * The ticket as it should be dispatched: the board-snapshot bead plus its CURRENT notes blob, read
 * fresh so an operator's steer written after the run started still reaches this ticket's prompt.
 * `bd show` failing (e.g. a locked DB) must never block the run — the snapshot bead is returned.
 */
export async function withDispatchNotes(repo: string, ticket: Bead): Promise<Bead> {
  const fresh = await beads.show(repo, ticket.id).catch(() => null);
  return fresh?.notes ? { ...ticket, notes: fresh.notes } : ticket;
}

