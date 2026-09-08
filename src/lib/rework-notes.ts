/**
 * Everything a rework WRITES IN WORDS: the instruction note both modes land, the follow-up bead's
 * contract sections, the phrase every rollback record opens with, and the note predicates the
 * double-submit guards read back.
 *
 * One module, because these are the strings a founder actually reads on the board later — and
 * because the dedupe compares a note against the very blob that produced it ({@link hasHumanNote}),
 * so the rendering and the comparison must not drift apart.
 */
import type { Bead } from "./beads/bd";
import {
  ACCEPTANCE_HEADING,
  ACCEPTANCE_KEYS,
  CONTEXT_KEYS,
  isTicketContractHeading,
  sectionBody,
} from "./beads/contract";
import { type ScannedLine, scanMarkdown } from "./beads/markdown";
import { parseTicketNotes } from "./beads/notes";
import type { PullRequestState } from "./git/ops";
import type { ReviewFinding } from "./jobs/review-context";
import { instructionCriteria } from "./rework-contract";
import type { ReworkMode, ReworkPipeline } from "./types";

/**
 * The instruction note both modes write. One rendering, so a founder reading the bead later sees the
 * same thing the implementer was handed: what was decided, what to do, and the reviewer's own words
 * for the problems it is meant to fix.
 */
export function reworkNoteBody(args: {
  mode: ReworkMode;
  targetId: string;
  summary: string;
  instructions: string;
  findings: ReviewFinding[];
  /** For a follow-up: the ticket this bead was discovered from. */
  originId?: string;
  /** A reopen the merged target redirected into a follow-up ({@link ReworkPipeline}). */
  redirected?: boolean;
}): string {
  return [
    reworkNoteHead(args),
    ``,
    args.instructions,
    ...(args.findings.length > 0
      ? [
          ``,
          `Findings to fix (from the self-review):`,
          ...args.findings.map((f) => `- [${f.severity}] ${findingLine(f)}`),
        ]
      : []),
  ].join("\n");
}

/**
 * The opening line, which is the whole point of the note: it says what the founder judged. A
 * REDIRECTED send-back says something the other two don't — the acceptance was not met, and the fix
 * runs here only because the work already merged — so it is rendered apart from an ordinary
 * follow-up, whose head asserts the opposite.
 */
function reworkNoteHead(args: {
  mode: ReworkMode;
  targetId: string;
  summary: string;
  originId?: string;
  redirected?: boolean;
}): string {
  if (args.redirected) {
    return (
      `Rework — acceptance not met on ${args.originId}, but ${args.targetId} has already merged, so ` +
      `the fix runs here rather than reopening shipped work: ${args.summary}`
    );
  }
  return args.mode === "reopen"
    ? `Rework — acceptance not met. Sent back from ${args.targetId}'s self-review: ${args.summary}`
    : `Follow-up on ${args.originId} — its acceptance stands; ${args.targetId}'s self-review ` +
        `prompted another pass: ${args.summary}`;
}

/** What a follow-up's contract is written from — the request, its origin, and where the bead runs. */
export interface FollowUpContractArgs {
  summary: string;
  instructions: string;
  findings: ReviewFinding[];
  ticket: Bead;
  targetId: string;
  parentId?: string;
  pipeline?: ReworkPipeline;
}

/**
 * The follow-up bead's contract. Every section the bead contract judges is written, because an
 * unshaped bead is refused by the approve route and poison-parks the runner — a rework that produced
 * one would hand the founder a follow-up they cannot run.
 *
 * The acceptance is the founder's request itemised ({@link followUpAcceptance}), not the summary
 * echoed back: the summary is the bead's title and Goal already, and a rubric that restates the
 * headline gives the self-review nothing to score against. The note on the same bead keeps the
 * request in the founder's own words and order; this section is what "done" means, box by box.
 */
export function followUpDescription(args: FollowUpContractArgs): string {
  const { summary, instructions, findings, ticket, targetId, parentId, pipeline } = args;
  return [
    `## Goal`,
    markdownSafe(oneLine(summary)),
    ``,
    `## ${ACCEPTANCE_HEADING}`,
    ...followUpAcceptance(instructions, findings),
    ``,
    `## Context`,
    followUpProvenance(ticket, targetId, pipeline),
    followUpRunsUnder(parentId),
    ``,
    `## Out of scope`,
    `Anything beyond the instructions in the note. ${ticket.id} already shipped its own acceptance; ` +
      `re-litigating it belongs on that ticket, not here.`,
    ``,
    `## Verify`,
    `The project's own checks stay green, and the run's self-review scores this bead against the ` +
      `acceptance above.`,
  ].join("\n");
}

/**
 * A half-created follow-up's description, brought in line with the request finishing it
 * (lib/rework-modes.ts). Only what the request DECIDES is touched: the Acceptance section, derived
 * from its instructions and findings, and the Context line saying where the bead runs. Everything
 * else stays as written. The bead matched on title and edge alone, so it may be one a founder made
 * by hand, or a remnant whose Context, Out of scope or Verify they have edited since — and
 * regenerating the whole contract to refresh the boxes would silently discard that authorship.
 *
 * A description with no Acceptance section gets the request's appended, since a bead without one is
 * refused at approval; a blank one gets the whole contract, there being nothing to keep.
 */
export function reconcileFollowUpDescription(
  current: string | undefined,
  args: FollowUpContractArgs,
): string {
  if (!current?.trim()) return followUpDescription(args);
  const withAcceptance = replaceAcceptance(
    current,
    followUpAcceptance(args.instructions, args.findings),
  );
  return replaceRunsUnder(withAcceptance, args.targetId, args.parentId);
}

/**
 * The Acceptance section's body swapped for `boxes`, bounded exactly as the contract judge bounds it
 * for a ticket (`sectionOccurrences` with the ticket-tier keys, lib/beads/contract.ts): a
 * sub-heading grouping criteria is part of the section and goes with it, a ticket contract heading
 * or a peer ends it. Text either side is kept verbatim. The tier matters: a follow-up is a ticket,
 * so a `### Success` grouping criteria is Acceptance's own content to the judge — ending on every
 * tier's headings left those grouped boxes in the bead's effective acceptance beside the new ones.
 *
 * Every occurrence is reconciled, not just the first. The judge concatenates repeated headings
 * (`sectionsOf`), so a description carrying `## Acceptance Criteria` and a later `## Acceptance`
 * is governed by both — swapping one body and leaving the other would file a follow-up whose "done"
 * still includes the stale criteria. The first heading keeps its place and takes the new boxes; the
 * later copies go entirely, heading included, since one section is what the formula writes.
 */
function replaceAcceptance(description: string, boxes: string[]): string {
  const lines = scanMarkdown(description);
  const sections = acceptanceSections(lines);
  if (sections.length === 0) {
    return [description.trimEnd(), ``, `## ${ACCEPTANCE_HEADING}`, ...boxes].join("\n");
  }
  const texts = (from: number, to: number) => lines.slice(from, to).map((l) => l.text);
  const [first, ...duplicates] = sections;
  const pieces = [[...texts(0, first!.start + 1), ...boxes]];
  // Text between a dropped copy and the next: verbatim, minus the blank lines that led into the copy.
  let cursor = first!.end;
  for (const { start, end } of duplicates) {
    pieces.push(withoutTrailingBlank(texts(cursor, start)));
    cursor = end;
  }
  pieces.push(texts(cursor, lines.length));
  return pieces
    .filter((piece) => piece.length > 0)
    .map((piece) => piece.join("\n"))
    .join("\n\n");
}

/** Every Acceptance section as the judge sees it: `start` is its heading's line, `end` the line opening the next section. */
function acceptanceSections(lines: ScannedLine[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  lines.forEach((line, start) => {
    if (!line.heading || !ACCEPTANCE_KEYS.includes(line.heading.key)) return;
    const depth = line.heading.depth;
    let end = start + 1;
    while (end < lines.length) {
      const heading = lines[end]!.heading;
      if (heading && (heading.depth <= depth || isTicketContractHeading(heading))) break;
      end += 1;
    }
    out.push({ start, end });
  });
  return out;
}

function withoutTrailingBlank(texts: string[]): string[] {
  let end = texts.length;
  while (end > 0 && texts[end - 1]!.trim() === "") end -= 1;
  return texts.slice(0, end);
}

/**
 * The run-location line ({@link followUpRunsUnder}) re-said for the parentage the bead holds now.
 * Only the two shapes a create can write are recognised — under the target, or standing alone; a
 * founder who rewrote that line has taken the Context into their own hands ({@link createdUnder}),
 * and it is left as they put it.
 */
function replaceRunsUnder(description: string, targetId: string, parentId?: string): string {
  const generated = new Set([followUpRunsUnder(targetId), followUpRunsUnder()]);
  const wanted = followUpRunsUnder(parentId);
  return description
    .split(/\r?\n/)
    .map((line) => (generated.has(line) ? wanted : line))
    .join("\n");
}

/**
 * The Context line that says WHERE the follow-up runs. Rendered on its own because the detachment
 * recovery reads it back ({@link createdUnder}): it is frozen at `bd create`, so it still names the
 * parent after a `bd reparent` has moved the bead — which is how a retry tells a follow-up whose
 * detachment went unrecorded from one that was created standing alone.
 */
export function followUpRunsUnder(parentId?: string): string {
  return parentId
    ? `It runs as a ticket of ${parentId}, in that target's next run.`
    : `It is its own run target — approve it to run.`;
}

/**
 * Was this follow-up created as a ticket of `parentId`? Read off the Context line
 * ({@link followUpRunsUnder}) rather than the parentage, which is exactly what a detachment
 * changes. A founder who has rewritten that line has taken the Context into their own hands, and
 * with it the record of where the bead came from.
 *
 * Only a whole line of the Context section counts. The same sentence can sit elsewhere in the
 * description without saying anything about parentage — a founder's instruction quoting it lands
 * verbatim in an Acceptance box ({@link followUpAcceptance}) — and a bead created standing alone
 * that carried it there would otherwise be read as detached, and given a note about a detachment
 * that never happened.
 */
export function createdUnder(bead: Bead, parentId: string): boolean {
  const context = sectionBody(bead.description, CONTEXT_KEYS);
  if (!context) return false;
  const generated = followUpRunsUnder(parentId);
  return context.split(/\r?\n/).some((line) => line.trim() === generated);
}

/**
 * The definition of done, derived from what the founder asked for: one box per instruction line, one
 * per finding they selected, then the standing rule that every finding in the note is either fixed
 * or answered. The generic box stays even when the specifics are listed — it is the one that admits
 * "this finding does not apply" as a legitimate close, which no per-finding box says.
 *
 * Instruction lines become boxes through {@link instructionCriteria} — the derivation the dialog's
 * refusal is judged against, so what it says will file is exactly what files.
 */
function followUpAcceptance(instructions: string, findings: ReviewFinding[]): string[] {
  return [
    ...instructionCriteria(instructions).map((line) => `- [ ] ${markdownSafe(line)}`),
    ...findings.map((f) => `- [ ] ${markdownSafe(findingLine(f))}`),
    `- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply`,
  ];
}

/**
 * A finding as one list item. The review model's location and note are accepted with internal
 * newlines ({@link toFinding}, lib/jobs/review-context.ts), and a line break inside a box is not
 * part of that box: a note that continues `\n## Context` would close the Acceptance section early
 * and carry the rest of itself — and the generic findings box — out of it. Collapsed to a single
 * line, so what the founder selected is exactly one criterion.
 */
function findingLine(f: ReviewFinding): string {
  return `${oneLine(f.location)} — ${oneLine(f.note)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Founder- and reviewer-typed text, made safe to sit in the description's markdown. An unmatched
 * `<!--` opens an HTML comment that runs to the end of the bead: the contract scanner
 * (lib/beads/markdown.ts) and every markdown renderer hide all that follows it, so a criterion
 * about comment parsing would file a bead with no Context, Out of scope or Verify — which the
 * approve route refuses. The `!` is backslash-escaped: CommonMark renders the same four characters,
 * and no scanner reads them as an opener. Text that must sit on ONE line — the Goal, the title in
 * Context — is collapsed with {@link oneLine} first, since a pasted `\n## Acceptance Criteria` would
 * otherwise open a section of its own. The note keeps the raw text; it is prose, not a contract.
 */
function markdownSafe(text: string): string {
  return text.replace(/<!--/g, "<\\!--");
}

/** Why this bead exists — and, for a REDIRECTED send-back, why it exists here rather than on the original. */
function followUpProvenance(ticket: Bead, targetId: string, pipeline?: ReworkPipeline): string {
  if (pipeline?.redirected) {
    return (
      `Discovered from ${ticket.id} — ${markdownSafe(oneLine(ticket.title))}. The founder judged its ` +
      `acceptance unmet, but ${targetId}'s pull request (${pipeline.pr}) had already merged, so ` +
      `this bead carries the fix instead of reopening work that has shipped. The founder's ` +
      `instructions and the findings they selected are the human note on this bead.`
    );
  }
  return (
    `Discovered from ${ticket.id} — ${markdownSafe(oneLine(ticket.title))}. That ticket's acceptance was ` +
    `met and it keeps its review score; this bead carries the next iteration ${targetId}'s ` +
    `self-review prompted. The founder's instructions and the findings they selected are the ` +
    `human note on this bead.`
  );
}

/**
 * Point the ORIGINAL ticket at what its review produced, in words. It keeps its score and its status;
 * all it gains is this pointer. A REDIRECTED send-back says something different on purpose — the
 * founder judged the acceptance unmet, and this bead is closed only because its work merged, so
 * claiming it stands would put words in their mouth.
 */
export function originNoteBody(followUpId: string, pipeline?: ReworkPipeline): string {
  return pipeline?.redirected
    ? `Follow-up ${followUpId} was opened from this ticket's review — the founder judged its ` +
        `acceptance unmet, but ${pipeline.pr} had already merged, so the fix runs there as its ` +
        `own target rather than reopening work that has shipped.`
    : `Follow-up ${followUpId} was opened from this ticket's review — its acceptance stands; the ` +
        `next iteration is tracked there.`;
}

/**
 * The record that a follow-up created UNDER a target was detached because the target's PR merged
 * under it. Split into a head and a Context clause because the retry that recovers a detachment
 * matches on the HEAD alone ({@link hasDetachmentNote}) — what the clause says depends on which
 * pass wrote it. A finished bead keeps its Context, which a founder may have edited, so the note
 * flags that it still names the old parent. A half-created bead's run-location line is re-said by
 * the pass finishing it ({@link reconcileFollowUpDescription}), so the note claims nothing about it
 * either way.
 */
export function detachmentNoteBody(args: {
  targetId: string;
  pr: string;
  /** The bead keeps the Context it was created with — the note warns that it is stale. */
  contextKept: boolean;
}): string {
  const head = detachmentNoteHead(args.targetId, args.pr);
  return args.contextKept
    ? `${head} Its Context section still names the parent it was created under.`
    : head;
}

function detachmentNoteHead(targetId: string, pr: string): string {
  return (
    `anton: rework — ${targetId}'s pull request (${pr}) merged after this follow-up was created ` +
    `under it, so it was detached and is its own run target now — approve it to run.`
  );
}

/** Has the detachment of this follow-up from `targetId` already been recorded, by any pass? */
export function hasDetachmentNote(bead: Bead, targetId: string, pr: string): boolean {
  const head = normalize(detachmentNoteHead(targetId, pr));
  return parseTicketNotes(bead.notes).some(
    (n) => n.source === "system" && normalize(n.text).startsWith(head),
  );
}

/**
 * How the verify read the PR, in words — the one phrase every rollback record opens with. Unreadable
 * is kept distinct from a state change everywhere it is reported: one says the PR moved, the other
 * says anton stopped being able to see it, and they are fixed differently.
 */
export function settledPhrase(pr: string, state: PullRequestState): string {
  return state === "unknown"
    ? `${pr}'s state could no longer be read as it was applying`
    : `${pr} reads as ${state} now`;
}

/** Is this exact instruction already on the bead as a human note? Half of the double-submit guard. */
export function hasHumanNote(bead: Bead, body: string): boolean {
  const wanted = normalize(body);
  return parseTicketNotes(bead.notes).some(
    (n) => n.source === "human" && normalize(n.text) === wanted,
  );
}

/**
 * Does the bead carry ANY human note? A follow-up with none speaks for no request — every path that
 * creates one writes the instructions as a human note — which is what marks it as an unfinished
 * creation rather than another send-back's work ({@link existingFollowUp}, lib/rework-modes.ts).
 */
export function hasAnyHumanNote(bead: Bead): boolean {
  return parseTicketNotes(bead.notes).some((n) => n.source === "human");
}

/** Whitespace-insensitive comparison, so a note round-tripped through the blob still matches itself. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
