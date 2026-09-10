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
} from "./beads/contract";
import {
  type Heading,
  closingFence,
  htmlBlockLines,
  isHeading,
  openingFence,
  type ScannedLine,
  scanMarkdown,
  unterminatedCloser,
} from "./beads/markdown";
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
    goalBody(summary),
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
 *
 * With no section to swap, one is appended — after closing a fence or HTML comment the description
 * ends inside ({@link unterminatedCloser}). Appended verbatim, the heading would land in that
 * construct, where the judge reads no section at all; the pass would then note the bead finished,
 * and no retry reconciles a finished bead, leaving one that can never be approved.
 *
 * A heading inside a persistent HTML block ({@link htmlBlockLines}) is no section to swap either,
 * for the mirror reason: `<script>` and its kind run past the blank line to their own closing tag,
 * so the description RENDERS no Acceptance while the scanner — which models no HTML block — reports
 * one. Swapping the hidden boxes skipped the closer and filed a bead whose acceptance nobody can
 * see; ignoring them appends a real section after the block is closed.
 */
function replaceAcceptance(description: string, boxes: string[]): string {
  // `scanMarkdown` deliberately does not model raw HTML blocks, while this writer must not let a
  // heading hidden in one become part of the contract it later reads. Neutralize only those
  // headings before sectioning: their surrounding raw HTML stays founder-authored, but the
  // description-first contract reader cannot concatenate its stale boxes with the real section.
  const inHtml = htmlBlockLines(description);
  const containerFences = containerFenceLines(description);
  const inContainerFence = containerFences.fenced;
  const initiallyScanned = scanMarkdown(description);
  const neutralized = initiallyScanned
    .map((line, at) =>
      inHtml[at] && line.heading && ACCEPTANCE_KEYS.includes(line.heading.key)
        ? line.text.replace(/^([ \t]*)(.*)$/, "$1<!-- $2 -->")
        : line.text,
    )
    .join("\n");
  // The flat scanner cannot see that dedenting out of a list closes a fence held by that item. Hide
  // just those nested openers from this *section-finding* pass: the untouched `neutralized` lines
  // below are still what we return, and the real renderer already closes the fence at the dedent.
  const sectionScan = neutralized
    .split("\n")
    .map((line, at) =>
      containerFences.openers[at] ? line.replace(/([`~])/, "\\\\$1") : line,
    )
    .join("\n");
  const lines = scanMarkdown(sectionScan);
  const authoredLines = scanMarkdown(neutralized);
  const sections = sectionsNamed(lines, ACCEPTANCE_KEYS).filter(
    ({ start }) => !inHtml[start] && !inContainerFence[start],
  );
  if (sections.length === 0) {
    const kept = neutralized.trimEnd();
    const closer = unterminatedCloser(kept);
    return [kept, ...(closer ? [closer] : []), ``, `## ${ACCEPTANCE_HEADING}`, ...boxes].join("\n");
  }
  const texts = (from: number, to: number) => authoredLines.slice(from, to).map((l) => l.text);
  const [first, ...duplicates] = sections;
  const pieces = [[...texts(0, first!.start + 1), ...boxes]];
  // Text between a dropped copy and the next: verbatim, minus the blank lines that led into the copy.
  let cursor = first!.end;
  // The heading that governs what follows, as the judge scopes sections — the surviving Acceptance
  // until a kept heading supersedes it.
  let governing = authoredLines[first!.start]!.heading!;
  for (const { start, end } of duplicates) {
    pieces.push(withoutTrailingBlank(texts(cursor, start)));
    governing = lastHeadingIn(authoredLines, cursor, start) ?? governing;
    // A dropped copy can be load-bearing: it TERMINATED the section after it. `## Acceptance`, a
    // nested `### Acceptance Criteria`, then a peer `### Success` — the judge reads Success as its
    // own section only because the duplicate closed the shallower Acceptance. Dropping the heading
    // outright re-parents Success under the survivor, folding founder-authored or stale boxes back
    // into the very acceptance this reconcile exists to replace. So the heading stays as an empty
    // boundary, its stale body gone: the judge concatenates repeated headings, and an empty body
    // adds nothing to the boxes above while still closing the section.
    const next = authoredLines[end]?.heading;
    if (next && next.depth > governing.depth && !isTicketContractHeading(next)) {
      pieces.push([authoredLines[start]!.text]);
      governing = authoredLines[start]!.heading!;
    }
    cursor = end;
  }
  pieces.push(texts(cursor, authoredLines.length));
  return pieces
    .filter((piece) => piece.length > 0)
    .map((piece) => piece.join("\n"))
    .join("\n\n");
}

/**
 * Fences opened on a list item's marker line are invisible to the flat markdown scanner. Mark
 * their lines here so an apparent contract heading in the literal sample cannot be reconciled.
 */
function containerFenceLines(description: string): { fenced: boolean[]; openers: boolean[] } {
  const lines = description.split(/\r?\n/);
  const fenced = Array.from({ length: lines.length }, () => false);
  const openers = Array.from({ length: lines.length }, () => false);
  let open: { prefix: string; fence: ReturnType<typeof openingFence> } | undefined;
  let itemPrefix: string | undefined;
  for (let at = 0; at < lines.length; at += 1) {
    const text = lines[at]!;
    if (open) {
      const inner = text.startsWith(open.prefix) ? text.slice(open.prefix.length) : undefined;
      if (inner === undefined) {
        open = undefined;
      } else {
        fenced[at] = true;
        if (closingFence(inner, open.fence!)) open = undefined;
        continue;
      }
    }
    const item = /^(?: {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)(.*)$/.exec(text);
    if (item) {
      // Continuations begin at the content column. Keep this even when the marker's own line is
      // prose: a fence can open on its following line (`- example` then `  ```md`).
      itemPrefix = text.slice(0, text.length - item[1]!.length).replace(/[^\t]/g, " ");
    // A blank alone does not leave a list item; its following continuation may still be at the
    // item's content column. Only actual dedented content closes this remembered container.
    } else if (itemPrefix && text.trim() !== "" && !text.startsWith(itemPrefix)) {
      itemPrefix = undefined;
    }
    const inner = itemPrefix && text.startsWith(itemPrefix) ? text.slice(itemPrefix.length) : text;
    const nestedFence = openingFence(inner);
    if (nestedFence && itemPrefix) {
      fenced[at] = true;
      openers[at] = true;
      open = { prefix: itemPrefix, fence: nestedFence };
      continue;
    }
    const fence = item && openingFence(item[1]!);
    if (item && fence) {
      fenced[at] = true;
      openers[at] = true;
      // Continuation lines sit at the list item's content column; repeating `- ` would start a
      // sibling item instead of remaining inside the fence.
      open = {
        prefix: text.slice(0, text.length - item[1]!.length).replace(/[^\t]/g, " "),
        fence,
      };
    }
  }
  return { fenced, openers };
}

/** Every section under one of `keys` as the judge sees it: `start` is its heading's line, `end` the line opening the next section. */
function sectionsNamed(lines: ScannedLine[], keys: string[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  lines.forEach((line, start) => {
    if (!line.heading || !keys.includes(line.heading.key)) return;
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

/** The last heading in `lines` over [from, to), or undefined when the range opens no section. */
function lastHeadingIn(lines: ScannedLine[], from: number, to: number): Heading | undefined {
  for (let at = to - 1; at >= from; at -= 1) {
    const heading = lines[at]?.heading;
    if (heading) return heading;
  }
  return undefined;
}

function withoutTrailingBlank(texts: string[]): string[] {
  let end = texts.length;
  while (end > 0 && texts[end - 1]!.trim() === "") end -= 1;
  return texts.slice(0, end);
}

/**
 * The run-location line ({@link followUpRunsUnder}) re-said for the parentage the bead holds now.
 * Only the two shapes a create can write are recognised — under the target, or standing alone; a
 * founder who rewrote that line has taken the Context into their own hands, and it is left as they
 * put it.
 *
 * Only the Context section is searched, the one place the formula writes the line. The same
 * sentence elsewhere — a Goal that happens to say it, a founder's instruction quoting it into an
 * Acceptance box — is authored text a reconcile promises to keep, and rewriting it there changed a
 * section it had no business in.
 */
function replaceRunsUnder(description: string, targetId: string, parentId?: string): string {
  const generated = new Set([followUpRunsUnder(targetId), followUpRunsUnder()]);
  const wanted = followUpRunsUnder(parentId);
  const lines = scanMarkdown(description);
  const inContext = new Set<number>();
  for (const { start, end } of sectionsNamed(lines, CONTEXT_KEYS)) {
    for (let at = start + 1; at < end; at += 1) inContext.add(at);
  }
  return lines
    .map((line, at) => (inContext.has(at) && generated.has(line.text) ? wanted : line.text))
    .join("\n");
}

/**
 * The Context line that says WHERE the follow-up runs. Rendered on its own because the reconcile
 * re-says it ({@link replaceRunsUnder}): it is frozen at `bd create`, so it still names the parent
 * after a `bd reparent` has moved the bead. It is a description line, not a record — a founder may
 * rewrite it — so nothing reads it back to decide what the bead is owed; the detachment that moves
 * a bead leaves its own note ({@link detachmentNoteBody}).
 */
export function followUpRunsUnder(parentId?: string): string {
  return parentId
    ? `It runs as a ticket of ${parentId}, in that target's next run.`
    : `It is its own run target — approve it to run.`;
}

/**
 * The definition of done, derived from what the founder asked for: one box per instruction line, one
 * per finding they selected, then the standing rule that every finding in the note is either fixed
 * or answered. The generic box stays even when the specifics are listed — it is the one that admits
 * "this finding does not apply" as a legitimate close, which no per-finding box says.
 *
 * Instruction lines become boxes through {@link instructionCriteria} — the derivation the dialog's
 * refusal is judged against, so what it says will file is exactly what files. A fenced block among
 * them is filed as it was typed, in its place and unboxed: it is the example the box beside it
 * refers to, the judge (lib/beads/contract.ts) reads fenced content as authored, and neither a
 * `- [ ]` on each of its lines nor the comment escape belongs in literal text.
 */
function followUpAcceptance(instructions: string, findings: ReviewFinding[]): string[] {
  return [
    ...instructionCriteria(instructions).map((c) => (c.fenced ? c.text : `- [ ] ${markdownSafe(c.text)}`)),
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

/** A fence delimiter at a line's head — the only place one opens a block ({@link goalBody}). */
const FENCE_HEAD = /^(?:`{3,}|~{3,})/;

/**
 * An HTML block opener that runs PAST the blank line under it — CommonMark's start conditions 1
 * through 5, which end only at their own closing tag (`</script>`, `-->`, `?>`, `>`, `]]>`) or the
 * document's end, not at a blank line. A summary that is one of them swallows every section written
 * below the Goal in anything that renders the description ({@link goalBody}).
 *
 * The other openers are deliberately absent. Condition 6's `<div>` and condition 7's `<span x="y">`
 * end at the blank line the Goal is followed by, so the sections below survive; a `<!--` is already
 * neutralised as text by {@link markdownSafe} before this is tested.
 */
const HTML_BLOCK_HEAD = /^(?:<(?:pre|script|style|textarea)(?:[ \t>]|$)|<\?|<![A-Za-z]|<!\[CDATA\[)/i;

/**
 * A thematic break — 3+ `-`/`*`/`_` of one kind, spaces between allowed — as CommonMark and the
 * contract judge (lib/beads/contract.ts) both read it. It renders as a rule, not text, so a Goal
 * holding only one states nothing ({@link goalBody}).
 */
const THEMATIC_BREAK = /^([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/**
 * The summary as the Goal section's body: {@link markdownSafe}, on one line, and with a leading
 * BLOCK construct neutralised.
 *
 * The summary is the bead's title, and a founder sending back a request ABOUT markdown types its
 * scaffolding ("```md swallows the section", "## Backend"). Written bare under `## Goal` each opens
 * a block rather than the paragraph the Goal is: a fence runs to the end of the description, so
 * every heading below it is literal content to the scanner (lib/beads/markdown.ts) and the bead
 * files with no Acceptance, Context, Out of scope or Verify — the approve route then refuses the
 * follow-up the rework just created. A heading opens a spurious section of its own and leaves the
 * Goal empty; a thematic break renders as a rule, which is not text either. A `<script>`, `<pre>`,
 * `<style>`, `<textarea>`, `<?`, `<!DOCTYPE` or `<![CDATA[` head opens an HTML block that runs to
 * its own closing tag rather than ending at the blank line under the Goal
 * ({@link HTML_BLOCK_HEAD}), so every section below it is swallowed wherever the description is
 * rendered — while the scanner, which models no HTML block, reads the sections and reports a
 * contract the founder cannot see. All are neutralised the same way: a backslash on the line's
 * head, the trick {@link markdownSafe} plays on
 * `<!--` — CommonMark renders the identical characters, and no scanner reads the line as a block.
 * Only the head is escaped, since only a construct at the line's start opens a block; the
 * {@link oneLine} collapse already means there is no second line to open one.
 *
 * A summary that is only a bare list marker or the formula's `TODO —` prompt is deliberately left
 * as typed. Escaping those would make the contract judge report a written Goal where the founder
 * wrote nothing — the false green the gate exists to prevent — and unlike a fence or a heading
 * neither breaks the sections around it.
 */
function goalBody(summary: string): string {
  const text = markdownSafe(oneLine(summary));
  const block =
    FENCE_HEAD.test(text) ||
    HTML_BLOCK_HEAD.test(text) ||
    isHeading(text) ||
    THEMATIC_BREAK.test(text);
  return block ? `\\${text}` : text;
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
 * The record that a follow-up created UNDER a target is being detached because the target's PR
 * merged under it. Written BEFORE the `bd reparent` that detaches it (lib/rework-modes.ts) — it is
 * the record a retry finds the owed detachment by, and neither the reparent nor a founder editing
 * the Context can erase it — so it states the decision being carried out, not a move already made:
 * true on the bead whether the reparent that follows lands or is left for the retry.
 *
 * Split into a head and a Context clause because the retry matches on the HEAD alone
 * ({@link hasDetachmentNote}) — what the clause says depends on which pass wrote it. A finished
 * bead keeps its Context, which a founder may have edited, so the note flags that it still names
 * the old parent. A half-created bead's run-location line is re-said by the pass finishing it
 * ({@link reconcileFollowUpDescription}), so the note claims nothing about it either way.
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
    `under it, so anton is detaching it to stand as its own run target — approve it to run.`
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
