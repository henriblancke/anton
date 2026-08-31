/**
 * One bead as the product-master pass reads it (anton-d2sx): the facts a ranking, sizing or value
 * judgment rests on, rendered as one line plus the bead's own goal.
 *
 * Kept apart from the sections that arrange them (`board-context.ts`) because this is where the
 * pass's EVIDENCE is decided — which facts a claim may rest on, and which are deliberately withheld
 * — and every one of those calls is argued at its own site.
 */
import { beads, labelValueOf, type Bead } from "../beads/bd";
import { goalBody, isAuthoredBody, preambleOf } from "../beads/contract";
import {
  ageInDays,
  isClaimed,
  isInFlight,
  runClaimOf,
  ticketOwnerOf,
  type BoardIndex,
} from "../gardener/board-index";
import { oneLine } from "./text";

/**
 * How much of one bead's stated goal rides along. Enough to weigh two contracts against each other,
 * far short of quoting them: the cap is per bead and the board is capped at hundreds, so the whole
 * contract of every bead is a prompt nothing could read.
 */
export const MAX_GOAL_CHARS = 240;
/** How many score rounds one bead's series shows, newest last. */
export const MAX_SCORE_ROUNDS = 6;

/**
 * The slice of the board input a bead's own facts read — declared here rather than imported from
 * `board-context.ts` so the evidence layer depends on nothing that arranges it.
 */
export interface BeadFacts {
  /**
   * Per-bead review-score series, oldest first — the anton-3apm round comments, replayed by the job.
   * Absent for a bead nobody reviewed, which is not the same as a bead that scored zero.
   */
  scores?: Map<string, number[]>;
  /** ms epoch, so a fixture board dates deterministically. */
  now: number;
}

/**
 * One bead as the pass reads it: the facts a ranking, sizing or value judgment rests on, and — on
 * its own second line — what the bead says it is FOR ({@link goalOf}).
 */
export function beadLines(
  bead: Bead,
  index: BoardIndex,
  input: BeadFacts,
  indent: string,
  extras: (string | undefined)[] = [],
): string[] {
  const facts = [
    `[${bead.issue_type ?? "task"}]`,
    `P${bead.priority ?? "?"}`,
    sizeOf(bead),
    ageOf(bead, input.now),
    homeOf(bead, index),
    shippedBy(bead, index),
    blockedByOf(bead, index),
    ...extras,
    scoresOf(bead, input.scores),
    ownedBy(bead, input.now),
    approvalOf(bead),
    beads.isDeferred(bead) ? "deferred" : undefined,
  ].filter((f): f is string => f !== undefined);
  const lines = [`${indent}- ${bead.id} ${facts.join(" · ")} — ${oneLine(bead.title ?? "")}`];
  const goal = goalOf(bead);
  if (goal) lines.push(`${indent}  goal: ${goal}`);
  return lines;
}

/**
 * What the bead states it is FOR, in its own words — the one contract field a home judgment cannot
 * be made without.
 *
 * The pass is required to match two beads' CONTRACTS and forbidden to judge a home from their names
 * (skills/product-master/SKILL.md: "naming is not evidence"), so a context carrying only titles left
 * it two answers and both were wrong — omit every home claim, or guess from the shape of the words.
 *
 * Its `## Goal` where the bead states one, else the description's opening prose: an unshaped bead
 * still says something about itself, and a reader that knew only the heading rendered nothing at all
 * for it. Excerpted rather than quoted whole — see {@link MAX_GOAL_CHARS}.
 *
 * AUTHORED text only ({@link isAuthoredBody}). `goalBody` returns the formula's `TODO — …` prompt
 * when nothing is written, because a view must show the operator the placeholder its "no goal yet"
 * marker is about — but this line is quoted to the pass as the bead's own contract text and as the
 * only evidence a home claim may rest on, so rendering the scaffold would let a home be proposed on
 * words the approval gate itself treats as missing. Omitted instead, which reads correctly: a bead
 * with no `goal:` line has stated nothing to match.
 */
const goalOf = (bead: Bead): string | undefined => {
  const description = typeof bead.description === "string" ? bead.description : "";
  const authored = [goalBody(bead), preambleOf(description)].find(isAuthoredBody);
  const text = oneLine(authored ?? "");
  if (!text) return undefined;
  return text.length > MAX_GOAL_CHARS ? `${text.slice(0, MAX_GOAL_CHARS)}…` : text;
};

/**
 * "A run owns this", in both halves — a published lease, and the claim a lease has not caught up to
 * yet. Shown because a proposal against either is refused at filing time (`subjectChecked` in
 * `refusals.ts`, `rehomeRefusal` in `home-guards.ts`); a session that cannot see the claim spends
 * its judgment on asks the board will throw away.
 */
const ownedBy = (bead: Bead, nowMs: number): string | undefined => {
  if (isInFlight(bead, nowMs)) return "IN FLIGHT — a run owns it, do not propose against it";
  if (isClaimed(bead)) {
    return `CLAIMED by ${runClaimOf(bead)} — a run has picked it up, do not propose against it`;
  }
  return undefined;
};

/**
 * Whether the gate is already granted. The one fact a `start` claim rests on: the ask is that work
 * the board should run next carries no `approved` label, so a session that cannot see the label can
 * only guess — and every guess that lands on an approved bead is a claim `alreadyApproved` throws
 * away (`start-guards.ts`).
 *
 * Rendered only when the label IS there. Its absence is the claim's premise, and marking every
 * unapproved bead would read as an invitation to propose a start for each of them, which is the
 * opposite of a pass that proposes few, load-bearing things.
 */
const approvalOf = (bead: Bead): string | undefined =>
  beads.isApproved(bead) ? "approved — the gate is already granted" : undefined;

const sizeOf = (bead: Bead): string | undefined => {
  const size = labelValueOf(bead.labels, "size");
  return size ? `size:${size}` : undefined;
};

const ageOf = (bead: Bead, nowMs: number): string | undefined => {
  const days = ageInDays(bead, nowMs);
  return days === undefined ? undefined : `${days}d since last write`;
};

/**
 * Where the bead hangs today, named rather than implied by the nesting: a feature's epic, a ticket's
 * card. Rendered with the parent's TITLE because an id alone does not say what a home is for, and the
 * only judgment worth making about a home is whether the work belongs in it.
 *
 * A bead with NO parent says so in those words rather than rendering blank. `rehome` is a claim about
 * a home that is WRONG and anton refuses one about a bead that has none (`rehomeRefusal`) — first
 * homes are the gardener's ask. The loose section says that for the work IT covers, but a parentless
 * task/bug is a run target and renders as one, so silence there read as a home the pass had merely
 * not been told.
 */
const homeOf = (bead: Bead, index: BoardIndex): string => {
  const parentId = beads.parentOf(bead);
  // Parenthesised, not em-dashed: the em dash is what separates the facts from the title.
  if (!parentId) return `under nothing (no home to be the wrong one)`;
  const parent = index.byId.get(parentId);
  // A parent absent from a full-board read is a dangling pointer; naming the id is still the truth.
  if (!parent) return `under ${parentId} (not on the board)`;
  return `under ${parent.id} "${oneLine(parent.title ?? "")}"`;
};

/**
 * The run target that will actually SHIP this bead, whenever that is not its own parent — resolved
 * through {@link ticketOwnerOf}, the same attribution the runner and the board use.
 *
 * bd nesting runs to any depth: under `feature → task → subtask` the subtask rides the FEATURE's run
 * and its PR. Its parent is therefore a bead no `rehome` could ever name as a home (a ticket's home
 * must be a card, `homeWrongTier`) — so a line showing only the parent read as a ticket hanging off
 * a non-card, and the repair for that appearance is a proposal to flatten nesting somebody meant.
 */
const shippedBy = (bead: Bead, index: BoardIndex): string | undefined => {
  const owner = ticketOwnerOf(index, bead);
  if (!owner || owner.id === beads.parentOf(bead)) return undefined;
  return `shipped by ${owner.id} "${oneLine(owner.title ?? "")}"`;
};

const blockedByOf = (bead: Bead, index: BoardIndex): string | undefined => {
  const blockers = index.all
    .filter((other) => other.id !== bead.id && index.recordsBlocker(bead.id, other.id))
    .map((b) => b.id);
  return blockers.length > 0 ? `blocked by ${blockers.join(", ")}` : undefined;
};

/**
 * The bead's review-score series — the single strongest piece of evidence the pass has, and the one
 * thing a board read alone cannot produce (it lives in the round comments anton-3apm appends).
 */
const scoresOf = (bead: Bead, scores: BeadFacts["scores"]): string | undefined => {
  const series = scores?.get(bead.id);
  if (!series?.length) return undefined;
  const shown = series.slice(-MAX_SCORE_ROUNDS);
  const prefix = series.length > shown.length ? "…," : "";
  return `review scores ${prefix}${shown.join(",")}`;
};
