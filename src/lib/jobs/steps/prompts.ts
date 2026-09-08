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
import { shortSha } from "../../beads/satisfied-note";
import type { PreservedCommit } from "../../git/ops";
import { ANTON_REPO_URL } from "../../repo";
import { findingLines, type ReviewFinding } from "../review-context";
import type { SatisfiedSettlement, StepContext } from "./context";

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
 *
 * `preserved` is the state of the BRANCH rather than of the bead (anton-16pq): a timed-out
 * attempt's work already committed here. It reads after the spec because it only means anything
 * once the agent knows what the ticket asks for.
 */
export function ticketPrompt(ticket: Bead, preserved?: PreservedCommit): string {
  return [
    `Implement this beads ticket in the current worktree:`,
    ``,
    `Ticket: ${ticket.id} — ${ticket.title}`,
    ...ticketSpecSections(ticket),
    ...continuationSection(preserved),
    ``,
    ticketPromptClosing(ticket.id, preserved !== undefined),
  ].join("\n");
}

/**
 * What a RESUMED ticket is owed: the work its timed-out attempt left on this branch (anton-d967).
 *
 * Without it the resume is dispatched blind. The agent re-reads a ticket whose change is apparently
 * already made, finds nothing to do, and exits having written nothing — which the delivery-evidence
 * gate reads as a zero-diff stall and parks the run again, forever. So the block says three things:
 * what was preserved, that it is INCOMPLETE (nobody verified this ticket finished), and that the
 * move is to continue from it rather than restart or revert it.
 *
 * It also names the one case where `delivered` on an unchanged working tree is correct, because the
 * base contract otherwise forbids exactly that. This does not soften the gate: `step:commit` adopts
 * the preserved commit only when THIS run's agent affirms the ticket is finished, so an agent that
 * stays silent (or reports blocked) still cannot close a ticket on a zero diff.
 *
 * Omitted entirely when nothing is preserved — a fresh ticket's prompt is unchanged.
 */
function continuationSection(preserved: PreservedCommit | undefined): string[] {
  if (!preserved) return [];
  return [``, continuationPromptBlock(preserved)];
}

function continuationPromptBlock(preserved: PreservedCommit): string {
  const multiple = preserved.earlier.length > 0;
  // Newest first, so the agent reads the freshest attempt at the top; every one is on the branch.
  const commitLines = [preserved, ...preserved.earlier].map((c) => `    ${c.sha} ${c.subject}`);
  return [
    `## CONTINUATION — a previous attempt's work is already on this branch`,
    ``,
    multiple
      ? `Earlier attempts at this ticket each ran out of their time budget and were stopped. anton ` +
        `kept what they had built rather than deleting it, and that work is already committed here ` +
        `(newest first):`
      : `An earlier attempt at this ticket ran out of its time budget and was stopped. anton kept ` +
        `what it had built rather than deleting it, and that work is already committed here:`,
    ``,
    ...commitLines,
    ...preservedFilesLines(preserved),
    ``,
    multiple
      ? `Those commits are INCOMPLETE by construction: the attempts were stopped mid-ticket, nobody ` +
        `has confirmed the ticket is finished, and none is in any pull request's delivered list.`
      : `That commit is INCOMPLETE by construction: the attempt was stopped mid-ticket, nobody has ` +
        `confirmed the ticket is finished, and it is in no pull request's delivered list.`,
    ``,
    `Read ${preservedInspectClause(preserved)} first and CONTINUE from it — finish the acceptance ` +
      `criteria it has not met yet. Do not restart the ticket from scratch, and do not revert or ` +
      `re-do what is already there.`,
    ``,
    `If, after reading it, everything the ticket asks for is genuinely already done, do not ` +
      `manufacture a change to prove it: say what you found and end with \`ANTON-RESULT: ` +
      `delivered\`. The preserved work is then this ticket's delivery — this is the one case ` +
      `where reporting \`delivered\` on an unchanged working tree is correct, because the work is ` +
      `on the branch. Without that line the run parks and the work never reaches a pull request.`,
  ].join("\n");
}

/**
 * The revision to `git show`: the fork point range when the ticket's baseline is known (anton-16pq),
 * which spans a first attempt's self-committed work beneath an empty marker as well as the markers
 * themselves; otherwise the whole marker range when the ticket timed out more than once, or the
 * single commit when it timed out once. The newest commit alone omits the earlier attempts' deltas.
 */
function preservedShowRange(preserved: PreservedCommit): string {
  if (preserved.baseline) return `${preserved.baseline}..${preserved.sha}`;
  const oldest = preserved.earlier.at(-1);
  return oldest ? `${oldest.sha}^..${preserved.sha}` : preserved.sha;
}

function preservedInspectClause(preserved: PreservedCommit): string {
  const range = preservedShowRange(preserved);
  return range.includes("..")
    ? `all of it (\`git show ${range}\`)`
    : `it (\`git show ${range}\`)`;
}

/**
 * The preserved diff, the marker's explanation, or — when git could not be read — nothing but a
 * pointer to inspect it directly. An EMPTY (`[]`) preserved commit is the marker form: the agent
 * committed the work under its own subjects and this commit only records whose it is, so pointing at
 * its (empty) diff would tell the agent nothing was kept. `undefined` is an unreadable diff (a git
 * failure), NOT an empty one — presenting it as a marker would falsely claim the work lives beneath
 * a commit anton never actually read (PR #255 review).
 */
function preservedFilesLines(preserved: PreservedCommit): string[] {
  if (preserved.files === undefined) {
    return [
      ``,
      `anton could not read the preserved diff (a git error), so no file list is shown — inspect it ` +
        `yourself with the command below before continuing.`,
    ];
  }
  if (preserved.files.length === 0) {
    return [
      ``,
      `That commit is empty — it is a marker. The previous attempt committed the work itself under ` +
        `subjects that name neither this ticket nor its incompleteness, so the changes are in the ` +
        `commits beneath it (\`git log -p\`).`,
    ];
  }
  const shown = preserved.files.slice(0, MAX_PRESERVED_FILES);
  const rest = preserved.files.length - shown.length;
  return [
    ``,
    `Files changed across the preserved work:`,
    ...shown.map((f) => `- ${f}`),
    ...(rest > 0 ? [`- … and ${rest} more (\`git show --stat ${preservedShowRange(preserved)}\`)`] : []),
  ];
}

/** Enough to see the shape of the change; past that the agent is better served by `git show`. */
const MAX_PRESERVED_FILES = 40;

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
 *
 * The `satisfied` guidance is omitted for a RESUMED ticket (`preserved`): its CONTINUATION block
 * already names the one correct unchanged-tree outcome — `delivered` — and a preserved-adoption
 * settle can only be `delivered` (PR #255 review). `assertDelivered` refuses every other outcome
 * once `preservedAdoption` is set, so leaving the generic `satisfied` line here after it would tell
 * the agent to report the one thing that re-parks the resume this prompt exists to unblock.
 */
function ticketPromptClosing(ticketId: string, preserved: boolean): string {
  return [
    `The full ticket spec is inlined above so you can implement it even if the worktree's beads ` +
      `DB is unreadable. \`bd show ${ticketId}\` gives the same content when bd is healthy. If ` +
      `the spec above is empty AND \`bd show\` fails, stop and report the ticket as blocked — do ` +
      `not guess or silently bail. Follow the operating contract in your system prompt.`,
    ...(preserved
      ? []
      : [
          ``,
          `Before you implement, check the branch: earlier steps of this run committed here, and one ` +
            `of them may already meet every acceptance criterion above. If it does, do not redo or ` +
            `restate that work and do not report \`blocked\` — end with ` +
            `\`ANTON-RESULT: satisfied — <commit sha> — <how that commit covers ${ticketId}>\`, naming ` +
            `the commit that did it. That is the honest answer only when every criterion is met by work ` +
            `already committed on this branch; if any is still open, do the remaining work and report ` +
            `\`delivered\`.`,
        ]),
  ].join("\n");
}

/**
 * `advisory` — findings the self-review reported and did NOT fix (anton-omum). They never hold the PR
 * back, so the merge gate is the only place the founder would ever see them; putting them in the body
 * is what makes "self-reviewed" mean something they can act on rather than trust blindly.
 *
 * `satisfied` — the tickets that settled on an EARLIER commit of this run (anton-8h4b). Their
 * acceptance is in this diff, but no commit here carries their name, so the body attributes each to
 * the commit that did the work rather than listing it among the deliveries: a reader matching
 * tickets to commits would otherwise go looking for one that does not exist.
 */
export function prBody(
  target: Bead,
  tickets: Bead[],
  advisory: ReviewFinding[] = [],
  satisfied: ReadonlyMap<string, SatisfiedSettlement> = new Map(),
): string {
  // Standalone run (epic-of-one): the single ticket IS the target, so listing it again is noise.
  const standalone = tickets.length === 1 && tickets[0]?.id === target.id;
  const committed = tickets.filter((t) => !satisfied.has(t.id));
  const lines = [
    `Autonomous run for **${target.id}** — ${target.title}.`,
    ``,
    ...(standalone || committed.length === 0
      ? []
      : [`Tickets:`, ...committed.map((t) => `- ${t.id} — ${t.title}`), ``]),
    ...satisfiedLines(standalone ? [] : tickets, satisfied),
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

/**
 * The satisfied attribution as the PR body and its stale-body fallback both render it (PR #253
 * review): one line per ticket naming the commit that did its work. Empty when nothing settled that
 * way. The header claims no close — a ticket whose close never landed (a budget that ran out on it,
 * or a bd write that failed) is still open or blocked, and its line says so, since the body is where
 * a reviewer learns it needs closing by hand.
 */
export function satisfiedLines(
  tickets: Bead[],
  satisfied: ReadonlyMap<string, SatisfiedSettlement>,
): string[] {
  const settled = tickets.filter((t) => satisfied.has(t.id));
  if (settled.length === 0) return [];
  return [
    `Satisfied by earlier commits of this run (no commit of their own):`,
    ...settled.map((t) => {
      const by = satisfied.get(t.id)!;
      const line = `- ${t.id} — ${t.title} — by ${satisfiedByLine(by)}`;
      return by.closed
        ? line
        : `${line} — NOT closed: the close never landed (its budget ran out on it, or bd refused ` +
            `the write), so it is not done on the board; review that commit and close it by hand`;
    }),
    ``,
  ];
}

/** `<short sha> "<subject>"` — the subject is the attribution, since anton's commits are named for their ticket. */
function satisfiedByLine(by: SatisfiedSettlement): string {
  return by.subject ? `${shortSha(by.commit)} "${by.subject}"` : shortSha(by.commit);
}
