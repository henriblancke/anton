/**
 * The two steps that dispatch an AGENT — `step:implement` (the ticket's own) and `step:claude` (the
 * generic extension point). They differ only in what they hand the agent to reason from, so they
 * share this module and the one dispatch beneath it.
 */
import { beads, labelValueOf, type Bead } from "../../beads/bd";
import { loadAgentPrompt } from "../../claude/agent-prompt";
import { buildExecutionSystemPrompt } from "../../claude/system-prompt";
import { readPreservedCommitFor } from "../../git/ops";
import type { StepContext } from "./context";
import { dispatchClaude } from "./dispatch";
import { stepTaskBlock, ticketPrompt, type TicketPreserved } from "./prompts";
import { loadStepReasoning } from "./resolve";
import type { StepResult, StepResultWith } from "./result";

/**
 * `step:implement` — dispatch the ticket's agent in the worktree (execute-epic's per-ticket claude
 * call). One session per ticket, the ticket's `agent:` prompt in the system prompt, the full spec on
 * stdin, and the agent's `ANTON-RESULT` self-report parsed out of its final message.
 *
 * The bead's notes are re-read at dispatch, not taken from the run's opening snapshot: an operator's
 * steer (anton-bfy4) can land while an earlier ticket is still running. The BRANCH is read here too
 * (anton-16pq) — a resume whose earlier attempt timed out is dispatched onto that attempt's
 * preserved work, and is told so rather than left to rediscover it.
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
    const dispatched = await readForDispatch(ctx.repoPath, ticket);
    // Asked per ticket, not once per run: the answer is about THIS bead's own preserved commit, and
    // a resume can carry one for some tickets and not others. The fork point lets the continuation
    // range span the whole preserved delta, self-committed work beneath an empty marker included.
    const preserved = await readPreservedCommitFor(ctx.worktreePath, ticket.id, ctx.baseRef);
    last = await dispatchClaude(ctx, {
      beadId: ticket.id,
      prompt: ticketPrompt(dispatched, preserved),
      appendSystemPrompt,
      failure: (text) => `claude reported an error for ${ticket.id}: ${text ?? "unknown"}`,
    });
    sessionIds.push(...(last.facts?.sessionIds ?? []));
    // The LAST dispatch's self-report is the one that speaks for the step: a caller running a step
    // per ticket (as execute-epic does) sees one either way, and a run-wide dispatch is judged on
    // where it ended up. The bead it was prompted with travels beside it, for the same caller.
    last = { ...last, facts: { ...last.facts, dispatched } };
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
  ctx.assertLeaseHeld?.();
  const reasoning = await loadStepReasoning(ctx, stepId);
  // A formula can run this generic step before `step:implement`, so a resume is dispatched here
  // first onto a timed-out attempt's preserved commits (PR #255 review). Read them per ticket — as
  // implementStep does — so the step is told the work exists rather than reverting or re-doing it.
  const preserved = await readTicketsPreserved(ctx);
  return dispatchClaude(ctx, {
    beadId: ctx.target.id,
    prompt: [reasoning, "", "---", "", stepTaskBlock(ctx, stepId, preserved)].join("\n"),
    appendSystemPrompt: await buildExecutionSystemPrompt({ seedPrompt: ctx.settings.seedPrompt }),
    failure: (text) => `claude reported an error for step ${stepId}: ${text ?? "unknown"}`,
  });
}

/** Preserved work on the branch for each ticket in scope, in ticket order; empty when none has any. */
async function readTicketsPreserved(ctx: StepContext): Promise<TicketPreserved[]> {
  const preserved: TicketPreserved[] = [];
  for (const ticket of ctx.tickets) {
    const commit = await readPreservedCommitFor(ctx.worktreePath, ticket.id, ctx.baseRef);
    if (commit) preserved.push({ ticketId: ticket.id, commit });
  }
  return preserved;
}

/**
 * The ticket as it should be dispatched: the board-snapshot bead plus what only a fresh `bd show`
 * can add to it. Its CURRENT notes blob, so an operator's steer written after the run started still
 * reaches this ticket's prompt; and its description when the listing dropped it (issues.ts
 * `ensureDescription` — the one field `bd list` omits on some bd versions), so the agent is never
 * prompted without the contract and the `already-shipped` fence has the contract it read to hold
 * the claim to (PR #238 review). A show that succeeds is the whole truth about the description: a
 * bead it carries none for is dispatched with an empty one, not an unknown one.
 *
 * `bd show` failing (e.g. a locked DB) must never block the run — the snapshot bead is returned,
 * attesting to nothing the listing did not carry.
 */
export async function readForDispatch(repo: string, ticket: Bead): Promise<Bead> {
  const fresh = await beads.show(repo, ticket.id).catch(() => null);
  if (!fresh) return ticket;
  const dispatched = fresh.notes ? { ...ticket, notes: fresh.notes } : ticket;
  return ticket.description === undefined ? { ...dispatched, description: fresh.description ?? "" } : dispatched;
}

