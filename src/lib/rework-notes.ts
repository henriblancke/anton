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
import { ACCEPTANCE_HEADING } from "./beads/contract";
import { parseTicketNotes } from "./beads/notes";
import type { PullRequestState } from "./git/ops";
import type { ReviewFinding } from "./jobs/review-context";
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
          ...args.findings.map((f) => `- [${f.severity}] ${f.location} — ${f.note}`),
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

/**
 * The follow-up bead's contract. Every section the bead contract judges is written, because an
 * unshaped bead is refused by the approve route and poison-parks the runner — a rework that produced
 * one would hand the founder a follow-up they cannot run.
 *
 * The instructions themselves are NOT repeated here: they are the human note on the same bead, which
 * the dispatch prompt inlines, and duplicating them would leave two copies to drift apart the first
 * time the founder edits one.
 */
export function followUpDescription(args: {
  summary: string;
  ticket: Bead;
  targetId: string;
  parentId?: string;
  pipeline?: ReworkPipeline;
}): string {
  const { summary, ticket, targetId, parentId, pipeline } = args;
  return [
    `## Goal`,
    summary,
    ``,
    `## ${ACCEPTANCE_HEADING}`,
    `- [ ] ${summary}`,
    `- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply`,
    ``,
    `## Context`,
    followUpProvenance(ticket, targetId, pipeline),
    parentId
      ? `It runs as a ticket of ${parentId}, in that target's next run.`
      : `It is its own run target — approve it to run.`,
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

/** Why this bead exists — and, for a REDIRECTED send-back, why it exists here rather than on the original. */
function followUpProvenance(ticket: Bead, targetId: string, pipeline?: ReworkPipeline): string {
  if (pipeline?.redirected) {
    return (
      `Discovered from ${ticket.id} — ${ticket.title}. The founder judged its acceptance unmet, but ` +
      `${targetId}'s pull request (${pipeline.pr}) had already merged, so this bead carries the fix ` +
      `instead of reopening work that has shipped. The founder's instructions and the findings they ` +
      `selected are the human note on this bead.`
    );
  }
  return (
    `Discovered from ${ticket.id} — ${ticket.title}. That ticket's acceptance was met and it keeps ` +
    `its review score; this bead carries the next iteration ${targetId}'s self-review prompted. ` +
    `The founder's instructions and the findings they selected are the human note on this bead.`
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
