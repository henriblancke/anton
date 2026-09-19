/**
 * Everything a step SAYS — the task text an agent is dispatched with and the PR body a run leaves
 * behind.
 *
 * Prompt construction lives here rather than beside the handlers because it is the concern that
 * changes for reasons of its own: wording, what the spec inlines, how an operator's steer reads. A
 * handler should be a dozen lines of orchestration, not a paragraph of prose.
 */
import type { Bead } from "../../beads/bd";
import { acceptanceBody, goalBody, outOfScopeBody, verifyBody } from "../../beads/contract";
import { humanNotesPromptBlock } from "../../beads/notes";
import { shortSha } from "../../beads/satisfied-note";
import type { BranchDiff, PreservedCommit } from "../../git/ops";
import { ANTON_REPO_URL } from "../../repo";
import { findingLines, type ReviewFinding } from "../review-context";
import type { SatisfiedSettlement, StepContext } from "./context";
import type { RunNarrative } from "./result";

/** A ticket in scope whose previous attempt left preserved work on the branch (anton-16pq). */
export interface TicketPreserved {
  ticketId: string;
  commit: PreservedCommit;
}

/**
 * What the `step:claude` agent is working ON: the run target, the tickets in scope, and the worktree
 * it is already in. The operating contract (git/beads ownership, scope, fail-loud, the
 * `ANTON-RESULT` line) lives in the system prompt, so it isn't repeated here.
 *
 * `preserved` is any preserved-work continuation for the tickets in scope. A formula may run a
 * generic step BEFORE `step:implement` (PR #255 review), so on resume this step — not the
 * implementer — is dispatched first onto a timed-out attempt's commits; it must be told they exist
 * or it can revert or re-do them before the implementer ever sees them.
 */
export function stepTaskBlock(
  ctx: Pick<StepContext, "target" | "tickets" | "branch" | "baseBranch">,
  stepId: string,
  preserved: TicketPreserved[] = [],
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
      ...ctx.tickets.flatMap(ticketContractBlock),
    );
  }
  lines.push(...stepContinuationSection(preserved));
  return lines.join("\n");
}

/** The immutable ticket contract a generic step receives beside the run overview. */
function ticketContractBlock(ticket: Bead): string[] {
  return [
    ``,
    `## Ticket contract — ${ticket.id}`,
    ...ticketSpecSections(ticket),
    ``,
    `The full ticket spec is inlined above so you can assess this ticket even if the worktree's beads ` +
      `DB is unreadable. \`bd show ${ticket.id}\` gives the same content when bd is healthy.`,
  ];
}

/**
 * Continuation awareness for a GENERIC step (`step:claude`), which a formula can place before
 * `step:implement` (PR #255 review). Unlike {@link continuationSection} it prescribes no outcome:
 * settling the ticket is the implementer's job and the delivery gate's, not this step's. It only
 * tells the agent that a previous attempt's incomplete-but-real work is already on the branch so it
 * builds on it rather than reverting, re-doing, or discarding it. Omitted when nothing is preserved.
 *
 * Each ticket's commits are shown with the SAME range/marker-aware inspection {@link
 * continuationPromptBlock} uses (PR #255 review): a timed-out attempt that self-committed its work
 * leaves an EMPTY `WIP` marker, so pointing the agent at `git show <marker-sha>` alone shows an
 * empty diff and hides the real commits beneath it — inviting the very revert or redo this block
 * exists to prevent. {@link preservedFilesLines} directs marker cases to `git log -p`, and {@link
 * preservedInspectClause} spans the whole preserved range (from the baseline when known).
 */
function stepContinuationSection(preserved: TicketPreserved[]): string[] {
  if (preserved.length === 0) return [];
  const multiple = preserved.length > 1;
  return [
    ``,
    `## CONTINUATION — a previous attempt's work is already on this branch`,
    ``,
    `A previous attempt at ${multiple ? "these tickets" : "this ticket"} ran out of its time budget ` +
      `and was stopped. anton kept what it had built rather than deleting it, and that work is ` +
      `already committed here:`,
    ...preserved.flatMap(({ ticketId, commit }) => stepPreservedTicketLines(ticketId, commit, multiple)),
    ``,
    `That work is INCOMPLETE — the attempts were stopped mid-ticket — but it is real and belongs on ` +
      `this branch. Build on it: do not revert, re-do, or discard it, and do not restart from scratch.`,
  ];
}

/**
 * One ticket's preserved commits inside the generic step's CONTINUATION block: the commits, what
 * they changed (or, for an empty marker, that the work is in the commits beneath it — PR #255
 * review), and the range-aware inspect command. The ticket id heads the block only when more than
 * one is preserved, since each carries its own range.
 */
function stepPreservedTicketLines(
  ticketId: string,
  commit: PreservedCommit,
  multiple: boolean,
): string[] {
  const commitLines = [commit, ...commit.earlier].map((c) => `    ${c.sha} ${c.subject}`);
  return [
    ``,
    ...(multiple ? [`For ${ticketId}:`] : []),
    ...commitLines,
    ...preservedFilesLines(commit),
    ``,
    `Inspect ${preservedInspectClause(commit)} before you change anything.`,
  ];
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
 * pointer to inspect it directly. A `[]` file list is ambiguous, so {@link PreservedCommit.newestEmpty}
 * decides which it is (PR #255 review): an EMPTY newest commit is the marker form — the agent
 * committed the work under its own subjects and this commit only records whose it is, so pointing at
 * its (empty) diff would tell the agent nothing was kept. A NON-EMPTY newest commit whose range
 * still nets to `[]` is not a marker but a range that cancels out (earlier edits undone by later
 * ones); claiming the work is self-committed beneath it would be a lie. `undefined` files is an
 * unreadable diff (a git failure), NOT an empty one — presenting it as a marker would falsely claim
 * the work lives beneath a commit anton never actually read (PR #255 review).
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
    // A non-empty newest commit whose range nets to nothing is NOT a marker (PR #255 review); only a
    // genuinely empty newest commit sends the agent to the work beneath it. `undefined` (git could
    // not read the newest commit's own diff) keeps the marker wording as the safe default.
    if (preserved.newestEmpty === false) {
      return [
        ``,
        `The preserved attempts cancel out to no net change against the ticket baseline — an earlier ` +
          `attempt's edits were undone by a later one — so no file list is shown. Inspect the full ` +
          `history (\`git log -p\`) to see what each attempt did before continuing.`,
      ];
    }
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

/** An ATX heading, recognized the same way CommonMark does at block level: up to 3 leading spaces,
 * then 1-6 `#`, then whitespace or end of line. */
const HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** An opening or closing code fence: up to 3 leading spaces, then a run of 3+ backticks or tildes. */
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;
/** The leading run of spaces plus the single structural character a heading or fence line opens with. */
const STRUCTURAL_PREFIX = /^( {0,3})([#`~])/;

/**
 * Defuse a line of untrusted prose (a describer's narrative) that would itself parse as a markdown
 * heading or a fenced-code delimiter, so it can't forge one of anton's own `##`/`###` sections below
 * it, or open a fence that swallows the rest of the body as literal code (anton-7x273). A backslash
 * before the leading `#`/backtick/tilde keeps the character on the page while pulling the line out
 * of CommonMark's block-level grammar — the same trick `formatHumanNote` uses against a forged
 * `[human-note …]` header (beads/notes.ts).
 */
function defuseStructuralLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      HEADING_LINE.test(line) || FENCE_LINE.test(line) ? line.replace(STRUCTURAL_PREFIX, "$1\\$2") : line,
    )
    .join("\n");
}

/** Untrusted prose (describer narrative, a bead's free text) as it may safely reach a PR body: bounded
 * by the same field cap every inlined ticket field carries ({@link truncateField}), then defused. */
const renderUntrusted = (text: string): string => defuseStructuralLines(truncateField(text));

/**
 * `summary`, then "Review these first" (`spotlight`) and "Risks", each present only when the
 * describer reported one (anton-7x273). Exported so the stale-body salvage
 * (`stalePrBodyNote` in execute-epic-review.ts) can carry the same narrative when a `gh` refresh
 * fails and the PR body itself is stuck on an earlier attempt's text — the narrative would
 * otherwise be lost with nowhere else to land.
 */
export function narrativeFieldLines(narrative: RunNarrative | undefined): string[] {
  if (!narrative) return [];
  const spotlight = narrative.spotlight?.trim();
  const risks = narrative.risks?.trim();
  return [
    renderUntrusted(narrative.summary),
    ``,
    ...(spotlight ? [`### Review these first`, ``, renderUntrusted(spotlight), ``] : []),
    ...(risks ? [`### Risks`, ``, renderUntrusted(risks), ``] : []),
  ];
}

/**
 * What `prBody` opens with when a describer reported a narrative: what changed and why, what to
 * check first, what could break, then the run target's own `## Out of scope` — read off the BEAD
 * (`outOfScopeBody`), not the describer, so a swapped reasoning contract can never change what the
 * PR claims is deliberately left out.
 *
 * Absent entirely when there is no narrative: a project with no `step:describe` (or one whose
 * describer never reported) gets exactly today's body, Out of scope included — the two ride
 * together rather than Out of scope standing alone on a run that never opted into narration.
 */
function narrativeOpening(target: Bead, narrative: RunNarrative | undefined): string[] {
  if (!narrative) return [];
  const outOfScope = outOfScopeBody(target)?.trim();
  return [
    ...narrativeFieldLines(narrative),
    ...(outOfScope ? [`## Out of scope`, ``, renderUntrusted(outOfScope), ``] : []),
    `---`,
    ``,
  ];
}

/**
 * `narrative` — what the describer reported for this run (anton-7x273), opening the body when
 * present, the run target's `## Out of scope` alongside it. Absent entirely when there is no
 * narrative, so a project without `step:describe` sees exactly today's body ({@link narrativeOpening}).
 *
 * `advisory` — findings the self-review reported and did NOT fix (anton-omum). They never hold the PR
 * back, so the merge gate is the only place the founder would ever see them; putting them in the body
 * is what makes "self-reviewed" mean something they can act on rather than trust blindly.
 *
 * `satisfied` — the tickets that settled on ANOTHER commit rather than one of their own
 * (anton-8h4b). No commit here carries their name, so the body attributes each to the commit that
 * did the work rather than listing it among the deliveries: a reader matching tickets to commits
 * would otherwise go looking for one that does not exist. A settlement flagged `inherited` is
 * attributed to the BASE instead of to this run (PR #258 review) — same reason, one step further:
 * its commit is not in this diff at all.
 */
export function prBody(
  target: Bead,
  tickets: Bead[],
  advisory: ReviewFinding[] = [],
  satisfied: ReadonlyMap<string, SatisfiedSettlement> = new Map(),
  narrative?: RunNarrative,
): string {
  // Standalone run (epic-of-one): the single ticket IS the target, so listing it again is noise.
  const standalone = tickets.length === 1 && tickets[0]?.id === target.id;
  const committed = tickets.filter((t) => !satisfied.has(t.id));
  const lines = [
    ...narrativeOpening(target, narrative),
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
 *
 * Two headings, because the two claims send a reviewer to different places (PR #258 review). A
 * BRANCH-ADDED commit is in this diff, so "satisfied by earlier commits of this run" is an
 * instruction the reviewer can follow. An INHERITED one reached the base by an earlier merge — the
 * work is in the tree and nothing here re-does it, but no commit of this pull request carries it,
 * and saying otherwise sends the reviewer hunting a diff that cannot contain it.
 */
export function satisfiedLines(
  tickets: Bead[],
  satisfied: ReadonlyMap<string, SatisfiedSettlement>,
): string[] {
  const settled = tickets.filter((t) => satisfied.has(t.id));
  if (settled.length === 0) return [];
  const group = (inherited: boolean) =>
    settled.filter((t) => (satisfied.get(t.id)!.inherited ?? false) === inherited);
  return [
    ...satisfiedGroup(
      group(false),
      satisfied,
      `Satisfied by earlier commits of this run (no commit of their own):`,
    ),
    ...satisfiedGroup(
      group(true),
      satisfied,
      `Already satisfied by commits in the base, not by this run (not in this diff):`,
    ),
  ];
}

/** One heading and its ticket lines, or nothing when no ticket settled that way. */
function satisfiedGroup(
  settled: Bead[],
  satisfied: ReadonlyMap<string, SatisfiedSettlement>,
  heading: string,
): string[] {
  if (settled.length === 0) return [];
  return [
    heading,
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

/**
 * The context appended beneath the describer's reasoning contract (anton-aucch): the run target,
 * every ticket with its contract, and the diff under description — plus the reporting format the
 * narrative is parsed back out of (`parseNarrativeReport` in `steps/describe.ts`).
 *
 * A standalone run (epic-of-one) lists its bead once, the same rule {@link prBody} applies — repeating
 * it as "ticket 1" would read as two separate contracts to describe against.
 */
export function describeContext(args: { target: Bead; tickets: Bead[]; diff: BranchDiff }): string {
  const { target, tickets, diff } = args;
  const standalone = tickets.length === 1 && tickets[0]?.id === target.id;
  return [
    `## This run`,
    ``,
    `Run target: ${target.id} — ${target.title}`,
    `Tickets in this run: ${tickets.length}`,
    `Files changed: ${diff.files.length}`,
    ``,
    ...describeBeadBlock(target, "Run target"),
    ...(standalone ? [] : tickets.flatMap((t) => describeBeadBlock(t, "Ticket"))),
    ...describeDiffBlock(diff),
    ...narrativeReportFormat(),
  ].join("\n");
}

/** One bead's contract, in the same four sections a reviewer is shown ({@link acceptanceSection} and siblings). */
function describeBeadBlock(bead: Bead, label: string): string[] {
  const field = (heading: string, body: string | undefined): string[] => [
    `**${heading}**`,
    body?.trim() ? truncateField(body) : `(none stated)`,
    ``,
  ];
  return [
    `### ${label}: ${bead.id} — ${bead.title}`,
    ``,
    ...field("Goal", goalBody(bead)),
    ...field("Acceptance", acceptanceBody(bead)),
    ...field("Out of scope", outOfScopeBody(bead)),
    ...field("Verify", verifyBody(bead)),
  ];
}

/** The diff itself, mirroring review-context.ts's own rendering — same file list, same rescued deletions. */
function describeDiffBlock(diff: BranchDiff): string[] {
  if (diff.files.length === 0) {
    return [`## The diff`, ``, `This run produced NO changes against its base.`, ``];
  }
  return [
    `## The diff`,
    ``,
    `Changed files (${diff.files.length}):`,
    ...diff.files.map((f) => `- ${f}`),
    ``,
    ...(diff.truncated
      ? [`The patch below is truncated — read the files in the worktree for anything it cuts off.`, ``]
      : []),
    "```diff",
    diff.patch,
    "```",
    ``,
    ...describeDeletionsBlock(diff),
  ];
}

/**
 * The deletions a truncated patch may have cut off, repeated in full — a file this run DELETED is
 * not in the worktree to read, same reasoning as the reviewer's own rescue.
 */
function describeDeletionsBlock(diff: BranchDiff): string[] {
  if (!diff.deletions && !diff.deletionsIncomplete && !diff.deletionsUnshown) return [];
  return [
    `### Files this run DELETED`,
    ``,
    `Repeated here because the patch above is truncated and a deleted file is not in the worktree to read.`,
    ``,
    ...(diff.deletions ? ["```diff", diff.deletions, "```", ``] : []),
    ...(diff.deletionsIncomplete
      ? [`Some deletions could not be recovered — anton's own git read failed partway through.`, ``]
      : []),
    ...(diff.deletionsUnshown
      ? [`${diff.deletionsUnshown} deleted file(s) are named above but not shown — the budget ran out.`, ``]
      : []),
  ];
}

/**
 * The report format the describer is asked to end its final message with — DEFINED here and PARSED
 * in `steps/describe.ts`'s `parseNarrativeReport`, so a swapped reasoning contract (a `prompt:<id>`,
 * a `skill:<id>`, an operator's `describePrompt`) can never break the protocol anton relies on.
 *
 * Unlike the reviewer's report, nothing here is mandatory but `summary`: this step never blocks the
 * run, so there is nothing to be strict about — a short, an empty, or an absent report all cost the
 * narrative alone.
 */
function narrativeReportFormat(): string[] {
  return [
    `## Reporting format (required)`,
    ``,
    `End your final message with a fenced json block, in exactly this shape:`,
    ``,
    "```json",
    `{"narrative":{"summary":"what changed and why","spotlight":"what to look at first, and why (may be omitted)","risks":"what could break, and under what conditions — or that you found nothing (may be omitted)"}}`,
    "```",
    ``,
    `\`summary\` is the only required field. \`spotlight\` and \`risks\` may be omitted, or left brief,`,
    `when you are short on budget or certainty — write what you're sure of and stop, per the guidance`,
    `above; do not invent detail to fill either section.`,
    ``,
    `This step never blocks the run and cannot fail it: if you emit no report, or one anton cannot`,
    `parse, the pull request simply carries no narrative. Report what you have rather than nothing.`,
  ];
}
