/**
 * DEFERRED WORK THAT HAS AGED PAST RE-JUDGEMENT (anton-c009): parked beads nothing has looked at
 * since they were parked.
 *
 * `defer` is the gardener's reversible kill — the retirement verb every judgment tier is allowed to
 * ask for, precisely because a permanent won't-do is a human's act (detections.ts `KINDS`). That
 * reversibility is only real if something ever comes back to it: without this, "not now, but not
 * dead" is a one-way valve, and the board accumulates work whose last recorded decision was made a
 * quarter ago by a pass nobody re-read.
 *
 * What this module produces is the QUESTION, not the answer. A {@link DeferredRejudgement} is a
 * {@link DetectionClaim} — evidence and a summary with no move attached — because whether parked
 * work comes back to the board or is written off is a judgment nothing mechanical is entitled to
 * make; the pass that owns the verb (anton-rozm) spreads the claim into `makeDetection`.
 *
 * Pure over its input, like every detector here: no bd spawn, no db, no repo read, no clock of its
 * own. A fixture board plus a `nowMs` is a complete test of what a pass would find.
 */
import { beads, type Bead } from "../beads/bd";
import { isPipelineArtifact } from "../beads/contract";
import { ageInDays, isInFlight, stampOf, type BoardIndex } from "./board-index";
import { makeDetection, type DetectionClaim, type GardenerDetection } from "./detections";

/**
 * How long a bead may sit deferred before its parking is worth re-asking — a quarter of silence.
 *
 * Deliberately as long as the retirement window that files most of these in the first place
 * (retire.ts `RETIRE_STALE_OPEN_DAYS`): a bead deferred last month is a decision that was just made,
 * and re-asking inside the window would hand the founder back the question they already answered.
 * A quarter is the shortest silence that says nobody is coming back to it on their own.
 */
export const REJUDGE_DEFERRED_DAYS = 90;

/** How long parked work may stay unexamined before {@link detectDeferredRejudgement} asks about it. */
export interface RejudgeOptions {
  /**
   * Override for {@link REJUDGE_DEFERRED_DAYS}, in whole days. Ignored when it is not a finite
   * non-negative number: this is a knob an operator or a settings blob can hand over, and a
   * threshold of `NaN` compares false against every age — silencing the detector entirely, which is
   * the one failure a re-judgement pass must not have.
   */
  afterDays?: number;
}

/** One parked bead the pass is asking about, with the single subject named for the caller's verb. */
export interface DeferredRejudgement extends DetectionClaim {
  /** The deferred bead — also the sole entry in {@link DetectionClaim.subjects}. */
  subject: string;
  /** Whole days of silence, as measured against the threshold. */
  ageDays: number;
}

/**
 * Every deferred bead whose parking has aged past re-judgement, oldest silence first.
 *
 * Ordered rather than left in board order because the age IS the ranking: a pass with a write budget
 * (anton-30vo) should spend it on the work that has been forgotten longest, and a stable order lets
 * two passes over an unchanged board agree on which that is.
 */
export function detectDeferredRejudgement(
  index: BoardIndex,
  nowMs: number,
  options: RejudgeOptions = {},
): DeferredRejudgement[] {
  const threshold = resolveThreshold(options.afterDays);

  const found: DeferredRejudgement[] = [];
  for (const bead of index.all) {
    if (!isRejudgeable(index, bead, nowMs)) continue;

    // No readable stamp ⇒ no measurable silence ⇒ no ask. An undated bead is the one row this
    // detector cannot honestly describe, and its whole claim is a duration.
    const ageDays = ageInDays(bead, nowMs);
    if (ageDays === undefined || ageDays < threshold) continue;

    found.push({
      subject: bead.id,
      ageDays,
      subjects: [bead.id],
      summary: `${bead.id} has sat deferred and untouched for ${ageDays} days — re-judge whether it is still wanted`,
      evidence: evidenceFor(index, bead, ageDays, threshold),
    });
  }

  return found.sort(byOldestSilence);
}

/**
 * The same claims with the VERB attached — what a pass files (anton-rozm).
 *
 * The verb is `undefer`, and choosing it is the whole judgment this module was split around. A
 * re-judgement has two honest conclusions and only one of them is a move anton may make: approving
 * returns the parked bead to the board, and DECLINING is how "it really is dead" is recorded —
 * followed by the founder's own `bd close --reason abandoned` if they want the won't-do on the
 * record. Proposing the retirement as the move instead would put a permanent close behind an
 * approval a pass can be armed for, which is exactly the human act every retirement here defers to.
 *
 * Pure, like the detector: the pass supplies the clock, and emission (emit.ts) does the writing.
 */
export function detectDeferredRejudgements(
  index: BoardIndex,
  nowMs: number,
  options: RejudgeOptions = {},
): GardenerDetection[] {
  return detectDeferredRejudgement(index, nowMs, options).map((claim) =>
    makeDetection({
      kind: "aged-defer",
      move: "undefer",
      subjects: claim.subjects,
      summary: claim.summary,
      evidence: claim.evidence,
    }),
  );
}

/** The stated window, or an operator's override once it is a number an age can be compared against. */
function resolveThreshold(afterDays: number | undefined): number {
  if (afterDays === undefined) return REJUDGE_DEFERRED_DAYS;
  return Number.isFinite(afterDays) && afterDays >= 0 ? afterDays : REJUDGE_DEFERRED_DAYS;
}

/**
 * Which parked beads this tier may re-ask about at all.
 *
 * `abandoned` is the recorded won't-do — the answer this question is asking FOR — so a bead carrying
 * it has already been re-judged by the only party entitled to. Plumbing is held out for the reason
 * every work surface holds it out ({@link isPipelineArtifact}): a poured `gate` waiting on a human is
 * not parked work anybody chose, and asking a founder whether they still want one is asking about
 * anton's own wiring. And a bead a run is somehow mid-flight over is nobody's to re-decide while the
 * run holds it, the same bar the retirement detectors keep.
 */
function isRejudgeable(index: BoardIndex, bead: Bead, nowMs: number): boolean {
  if (!beads.isDeferred(bead) || beads.isAbandoned(bead) || isPipelineArtifact(bead)) return false;
  if (isInFlight(bead, nowMs)) return false;
  // One ask per parked SUBTREE. Deferring a card parks everything beneath it, so a feature and its
  // six tickets are one decision with one answer — asking about each would put seven proposals on
  // the board for a founder to answer identically, and answering the child first decides nothing.
  return !hasDeferredAncestor(index, bead);
}

/** Is any bead on this one's parent chain also parked? Cycle-guarded, like every walk here. */
function hasDeferredAncestor(index: BoardIndex, bead: Bead): boolean {
  const seen = new Set<string>([bead.id]);
  let parentId = beads.parentOf(bead);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = index.byId.get(parentId);
    if (!parent) return false;
    if (beads.isDeferred(parent)) return true;
    parentId = beads.parentOf(parent);
  }
  return false;
}

/**
 * What a founder needs in front of them to answer "is this still wanted?" without re-reading the
 * board: how long it has been quiet, what the bead actually is, where it hangs, what returning it
 * would set in motion, and how much rides on the answer.
 *
 * The approval line is the one that changes the stakes rather than describing them. A deferred bead
 * keeps its labels, so one that still carries `approved` re-enters the CLAIMABLE pool the moment it
 * is undeferred (`bd ready --label approved --unassigned`) — the answer starts a run rather than
 * queuing a decision, and an approver who was not told that is being asked the wrong question.
 */
function evidenceFor(
  index: BoardIndex,
  bead: Bead,
  ageDays: number,
  threshold: number,
): string[] {
  const parked = index.openDescendants(bead.id);
  return [
    `${bead.id} is deferred, last written ${stampOf(bead)} — ${ageDays} days ago, past the ${threshold}-day re-judgement window`,
    `${describe(bead)} — ${homeOf(index, bead)}`,
    beads.isApproved(bead)
      ? "it still carries `approved`, so returning it to the board puts it straight into the claimable pool — the answer starts a run, it does not queue a decision"
      : "it carries no approval, so returning it to the board queues a decision rather than a run",
    parked.length > 0
      ? `${parked.length} open ${parked.length === 1 ? "bead is" : "beads are"} parked beneath it (${parked.map((b) => b.id).join(", ")}) — the answer decides the whole subtree`
      : "nothing open hangs beneath it — the answer decides this bead alone",
  ];
}

/** The bead in one clause: what it is, how it ranks, what it is called. */
function describe(bead: Bead): string {
  return `${bead.issue_type ?? "task"} P${bead.priority ?? "?"} "${bead.title ?? bead.id}"`;
}

/** Where it hangs, named so the reader can place the ask without a `bd show`. */
function homeOf(index: BoardIndex, bead: Bead): string {
  const parentId = beads.parentOf(bead);
  if (!parentId) return "parented to nothing";
  const parent = index.byId.get(parentId);
  return parent ? `parked under ${parent.id} ("${parent.title}")` : `parented to ${parentId}`;
}

/** Longest silence first, then by id so two passes over an unchanged board agree on the order. */
function byOldestSilence(a: DeferredRejudgement, b: DeferredRejudgement): number {
  if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays;
  return a.subject < b.subject ? -1 : 1;
}
