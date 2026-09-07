/**
 * Everything a step SAYS — the task text an agent is dispatched with and the PR body a run leaves
 * behind.
 *
 * Prompt construction lives here rather than beside the handlers because it is the concern that
 * changes for reasons of its own: wording, what the spec inlines, how an operator's steer reads. A
 * handler should be a dozen lines of orchestration, not a paragraph of prose.
 */
import type { Bead } from "../../beads/bd";
import { acceptanceBody } from "../../beads/contract";
import { humanNotesPromptBlock } from "../../beads/notes";
import { shortSha, type SatisfiedBy } from "../../beads/satisfied-note";
import { ANTON_REPO_URL } from "../../repo";
import { findingLines, type ReviewFinding } from "../review-context";
import type { StepContext } from "./context";

/**
 * What the `step:claude` agent is working ON: the run target, the tickets in scope, and the worktree
 * it is already in. The operating contract (git/beads ownership, scope, fail-loud, the
 * `ANTON-RESULT` line) lives in the system prompt, so it isn't repeated here.
 */
export function stepTaskBlock(
  ctx: Pick<StepContext, "target" | "tickets" | "branch" | "baseBranch">,
  stepId: string,
): string {
  const lines = [
    `You are running the \`${stepId}\` step of anton's run pipeline for **${ctx.target.id}** — ` +
      `${ctx.target.title}.`,
    ``,
    `Work in the current worktree (${ctx.branch}, forked from ${ctx.baseBranch}). Follow the ` +
      `instructions above; the operating contract in your system prompt still binds.`,
  ];
  if (ctx.tickets.length > 0) {
    lines.push(
      ``,
      `Tickets in this run:`,
      ...ctx.tickets.map((t) => `- ${t.id} — ${t.title}`),
    );
  }
  return lines.join("\n");
}

/**
 * Cap on each inlined ticket field. anton worktrees carry a frozen embedded Dolt with no remote,
 * so `bd show` inside the worktree can fail (issue #46 root cause #3) — the prompt must therefore
 * carry the spec itself and not be load-bearing on in-worktree DB access. A generous per-field
 * budget keeps a pathologically large body from bloating the prompt while still delivering the
 * whole spec for the common case.
 */
const MAX_TICKET_FIELD_CHARS = 4000;

export function truncateField(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TICKET_FIELD_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TICKET_FIELD_CHARS)}\n… [truncated — run \`bd show\` for the full text]`;
}

/**
 * The concrete task (`-p`) for one ticket. The operating contract (git/beads ownership, scope,
 * learnings, fail-loud) lives in the locked base system prompt (composeSystemPrompt), so it isn't
 * duplicated here.
 *
 * The ticket's full spec — Goal / Out of scope / Verify (the `description` markdown), Acceptance,
 * and Context — is inlined so the agent can implement even when the worktree's beads DB is
 * unreadable (issue #46 root cause #3). `bd show` is offered as a convenience, never as the sole
 * source: a bead whose spec is genuinely empty AND whose `bd show` fails is a fail-loud/blocked
 * condition, not a cue to silently produce nothing.
 */
export function ticketPrompt(ticket: Bead): string {
  return [
    `Implement this beads ticket in the current worktree:`,
    ``,
    `Ticket: ${ticket.id} — ${ticket.title}`,
    ...ticketSpecSections(ticket),
    ``,
    ticketPromptClosing(ticket.id),
  ].join("\n");
}

/**
 * The spec blocks, each omitted when the bead carries nothing for it.
 *
 * Human notes on the bead (anton-bfy4) are appended last — the operator's steer is the freshest
 * intent, so it reads as a refinement of the contract above it.
 */
function ticketSpecSections(ticket: Bead): string[] {
  const description = ticket.description?.trim();
  const lines: string[] = [];
  if (description) {
    lines.push(``, `## Goal / Out of scope / Verify`, truncateField(description));
  }
  lines.push(``, `## Acceptance criteria`, acceptanceSection(ticket));
  const context = standaloneContext(ticket, description);
  if (context) {
    lines.push(``, `## Context`, truncateField(context));
  }
  const humanNotes = humanNotesPromptBlock(ticket.notes);
  if (humanNotes) {
    lines.push(``, truncateField(humanNotes));
  }
  return lines;
}

/**
 * The gate's own reader: covers every home the contract accepts — bd's acceptance fields AND a
 * description-only `## Acceptance` section. Reading the fields alone said "(none stated)" for a
 * rubric the gate had just accepted, whenever the truncated description block cut it.
 */
function acceptanceSection(ticket: Bead): string {
  const acceptance = acceptanceBody(ticket)?.trim();
  return acceptance ? truncateField(acceptance) : "(none stated)";
}

/**
 * In some boards Context is a separate column; in others it's folded into `description` as a
 * `## Context` heading. Only inline the standalone field when it isn't already in `description`.
 */
function standaloneContext(ticket: Bead, description: string | undefined): string | undefined {
  const context = ticket.context?.trim();
  return context && context !== description ? context : undefined;
}

/**
 * Why the inlined spec is authoritative, what to do when it is empty anyway, and when the step's
 * honest outcome is `satisfied` rather than `blocked` (anton-6l0q): a ticket is one step of a run
 * whose earlier steps committed to this same branch, so its acceptance can already be met before the
 * agent starts. The contract defines the line; this names the moment it applies to THIS ticket.
 */
function ticketPromptClosing(ticketId: string): string {
  return [
    `The full ticket spec is inlined above so you can implement it even if the worktree's beads ` +
      `DB is unreadable. \`bd show ${ticketId}\` gives the same content when bd is healthy. If ` +
      `the spec above is empty AND \`bd show\` fails, stop and report the ticket as blocked — do ` +
      `not guess or silently bail. Follow the operating contract in your system prompt.`,
    ``,
    `Before you implement, check the branch: earlier steps of this run committed here, and one of ` +
      `them may already meet every acceptance criterion above. If it does, do not redo or ` +
      `restate that work and do not report \`blocked\` — end with ` +
      `\`ANTON-RESULT: satisfied — <commit sha> — <how that commit covers ${ticketId}>\`, naming ` +
      `the commit that did it. That is the honest answer only when every criterion is met by work ` +
      `already committed on this branch; if any is still open, do the remaining work and report ` +
      `\`delivered\`.`,
  ].join("\n");
}

/**
 * `advisory` — findings the self-review reported and did NOT fix (anton-omum). They never hold the PR
 * back, so the merge gate is the only place the founder would ever see them; putting them in the body
 * is what makes "self-reviewed" mean something they can act on rather than trust blindly.
 *
 * `satisfied` — the tickets that settled on an EARLIER commit of this run (anton-8h4b). They are
 * closed and their acceptance is in this diff, but no commit here carries their name, so the body
 * attributes each to the commit that did the work rather than listing it among the deliveries: a
 * reader matching tickets to commits would otherwise go looking for one that does not exist.
 */
export function prBody(
  target: Bead,
  tickets: Bead[],
  advisory: ReviewFinding[] = [],
  satisfied: ReadonlyMap<string, SatisfiedBy> = new Map(),
): string {
  // Standalone run (epic-of-one): the single ticket IS the target, so listing it again is noise.
  const standalone = tickets.length === 1 && tickets[0]?.id === target.id;
  const committed = tickets.filter((t) => !satisfied.has(t.id));
  const settled = tickets.filter((t) => satisfied.has(t.id));
  const lines = [
    `Autonomous run for **${target.id}** — ${target.title}.`,
    ``,
    ...(standalone || committed.length === 0
      ? []
      : [`Tickets:`, ...committed.map((t) => `- ${t.id} — ${t.title}`), ``]),
    ...(settled.length > 0
      ? [
          `Satisfied by earlier commits of this run (closed on that work; no commit of their own):`,
          ...settled.map((t) => `- ${t.id} — ${t.title} — by ${satisfiedByLine(satisfied.get(t.id)!)}`),
          ``,
        ]
      : []),
    ...(advisory.length > 0
      ? [
          `### Unresolved review findings (${advisory.length}, advisory)`,
          ``,
          `anton's pre-PR self-review reported these and left them for you — they don't block the merge.`,
          ``,
          ...findingLines(advisory),
          ``,
        ]
      : []),
    `🤖 Generated with [anton](${ANTON_REPO_URL}) autonomous execution`,
  ];
  return lines.join("\n");
}

/** `<short sha> "<subject>"` — the subject is the attribution, since anton's commits are named for their ticket. */
function satisfiedByLine(by: SatisfiedBy): string {
  return by.subject ? `${shortSha(by.commit)} "${by.subject}"` : shortSha(by.commit);
}
