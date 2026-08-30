/**
 * ELIGIBILITY: may anton take this? (anton-o76r)
 *
 * The board-side half of the board-picker pass, split out exactly as gate-targets.ts is split out of
 * gate-check: the decision is a pure function over ONE board snapshot, so it can be read and tested
 * without a runner, a clock, or a `bd` spawn around it.
 *
 * This is the STRUCTURAL half of `.beads/PRIME.md` §1 — a run target, `open`, unclaimed, unblocked,
 * and clearing the approve gate. The policy predicate (R2) narrows this set afterwards and the PRIME
 * ranking (`beads/rank.ts`) orders what survives; neither belongs here. Nothing in this module calls
 * `bd ready`, whose answer is "what is unblocked", not "what may I take".
 *
 * Every refusal is a REASON, not a silent drop. The policy editor answers "why not this one?" per
 * bead (R2.6) and the Up Next lane groups the rest, so a bead that never appears has to be able to
 * say why — which is why {@link ineligibility} is total over the board and {@link eligibleTargets}
 * returns the refusals beside the set.
 *
 * It re-derives NONE of the rules it applies. Run-target identity is `beads.isRunTarget` — the same
 * predicate the approve route and execute-epic gate on — and approval's four promises come from
 * `makeApprovalGate`, bound once per board. A second definition of either would let the picker start
 * work the runner then refuses, or refuse work a human could approve by hand.
 *
 * Deliberately NOT tested here: the `approved` label. The picker is the second WRITER of it (R1.5),
 * so it asks whether approval's promises would hold, never whether someone already granted them.
 * That is the one place this set is wider than `beads.claimableTargets`, which serves workers that
 * only ever consume the label.
 */
import { beads, ownerOf } from "../beads/bd";
import type { Bead } from "../beads/types";
import {
  formatApprovalGaps,
  makeApprovalGate,
  notRunnableWhy,
  type ApprovalGate,
  type ApprovalRule,
} from "../approval-gate";
import type { PickerExclusion, PickerExclusionReason } from "../board-picker-plan";

/**
 * Which exclusion an approve-gate gap reports as. `contract` and `structure` collapse into one
 * reason on purpose: to an operator they are the same fact — the bead is not shaped well enough to
 * run — and the gap's own message says which, in the detail.
 */
const REASON_BY_RULE: Record<ApprovalRule, PickerExclusionReason> = {
  runnable: "not-a-run-target",
  contract: "approval-gap",
  structure: "approval-gap",
  blocked: "blocked",
};

/** The eligible set and, beside it, the stated reason for everything the pass left out. */
export interface EligibleSet {
  /** Structurally claimable targets, in board order — {@link rankTargets} owns the sequence. */
  eligible: Bead[];
  /** One per candidate refused, each carrying a machine-readable reason. */
  exclusions: PickerExclusion[];
}

/**
 * Why this bead is not eligible, or undefined when it is. Total over any bead on the board — a
 * chore, a gate, a child ticket and a closed epic all get an answer, because "why not this one?" is
 * asked of whatever card the operator is looking at.
 *
 * The order of the clauses is the order of the facts' permanence, cheapest first: what a bead IS
 * before what state it is in, and both before the approve gate, whose contract and structure checks
 * walk the board per target and must not be paid for a board's worth of chores.
 *
 * `gate` is optional so a single-bead surface can call this without holding a snapshot; a caller
 * judging many beads must pass one, or each call rebuilds the card attribution and the epic rollup.
 */
export function ineligibility(
  target: Bead,
  board: Bead[],
  gate: ApprovalGate = makeApprovalGate(board),
): PickerExclusion | undefined {
  const beadId = target.id;

  const notRunnable = notRunnableWhy(target, board);
  if (notRunnable) return { beadId, reason: "not-a-run-target", detail: notRunnable };

  // Before the status test: `bd abandon` closes as it labels, but a crashed cascade can leave the
  // label on an OPEN bead, and reporting that as "not-open" would name a state the board denies.
  if (beads.isAbandoned(target)) return { beadId, reason: "abandoned", detail: "won't-do" };

  // `open` and nothing else. in_progress is a run somebody already started, deferred is a target a
  // human pushed away (the lane's `✕ not now` veto), closed is finished work.
  if (target.status !== "open") return { beadId, reason: "not-open", detail: target.status };

  // A claim already held is not up for grabs — and a claim a HUMAN holds is never taken back (R1.5).
  // The holder is the detail: "who has it" is the whole of what the operator needs.
  const holder = ownerOf(target);
  if (holder) return { beadId, reason: "claimed", detail: `held by ${holder}` };

  // Approval's four promises, through the gate rather than re-derived — including the blocker
  // rollup, which is where the per-child readiness verdict lives (a partially-gated target is
  // startable, issue #58). Gaps arrive worst-scoped first, so the first one names the reason while
  // the detail carries all of them: a bead with a broken contract AND an open blocker has two
  // problems, and reporting one would send the operator back for the other.
  const gaps = gate.gapsFor(target);
  const worst = gaps[0];
  if (worst) {
    return { beadId, reason: REASON_BY_RULE[worst.rule], detail: formatApprovalGaps(gaps) };
  }

  return undefined;
}

/**
 * The claimable set over a board snapshot, plus why every candidate that missed it did. Pure: the
 * same board yields the same answer on any machine, which is what lets two antons reading one board
 * agree about what is startable before bd's claim protocol arbitrates who gets it.
 *
 * CLOSED beads are refused (they are not `open`) but not REPORTED: on a mature board they are most
 * of the rows, and "why isn't this finished work up next?" is a question nobody asks. Every other
 * bead earns an exclusion, so a deferred target, a held one and a container epic each stay
 * answerable in the lane.
 */
export function eligibleTargets(board: Bead[]): EligibleSet {
  const gate = makeApprovalGate(board);
  const eligible: Bead[] = [];
  const exclusions: PickerExclusion[] = [];

  for (const bead of board) {
    const excluded = ineligibility(bead, board, gate);
    if (!excluded) eligible.push(bead);
    else if (bead.status !== "closed") exclusions.push(excluded);
  }

  return { eligible, exclusions };
}
