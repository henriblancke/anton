/**
 * DECIDE: one board-picker pass, as a pure function (anton-albm, R1.2).
 *
 * The seam this module sits on is the whole design: everything that could change WHICH target is
 * next is a function of a board snapshot, a policy and the pass's runtime state — no clock read, no
 * `bd` spawn, no Claude session (D3, "an LLM cannot be a hash function"). Two machines holding the
 * same snapshot therefore compute the same queue, which is what lets `.beads/PRIME.md` promise that
 * a human at a terminal and this pass name the same target.
 *
 * It composes rather than re-derives, in the order the answer narrows:
 *
 *   1. {@link eligibleTargets} — the structural claimable set, plus a stated reason per refusal.
 *   2. the {@link PickerPolicy} — the standing approval, narrowing that set. A refusal here is a
 *      `policy` exclusion, so "why not this one?" stays answerable for a bead the board would have
 *      allowed but the operator's rule does not.
 *   3. {@link rankTargets} — the PRIME order over what survived.
 *
 * The result is the plan `saveBoardPickerPlan` records verbatim: the pass decides once and the
 * surfaces read it, rather than three of them re-ranking a board that moves between them.
 */
import { rankTargets } from "../beads/rank";
import type { Bead } from "../beads/types";
import {
  sortExclusions,
  stampBoard,
  type BoardStamp,
  type PickerExclusion,
  type PickerPlanEntry,
} from "../board-picker-plan";
import { eligibleTargets } from "./picker-targets";

/**
 * A policy's answer for one structurally-eligible target: the rule that admits it, or the reason it
 * does not. Admission carries the rule NAME rather than a boolean because the plan records it (`◈
 * policy` links to it, and a `Never` veto opens the editor at it) — a policy that could not say
 * which of its rules matched would make every start unauditable.
 */
export type PolicyVerdict = { admitted: true; rule: string } | { admitted: false; detail?: string };

/**
 * The standing approval, as a pure predicate over a bead (R2.1). An interface rather than a data
 * shape because the criteria themselves — the editor, the namespaces, the calibration read — are
 * their own feature; what this pass needs is the verdict and the rule that produced it.
 */
export interface PickerPolicy {
  admits(target: Bead): PolicyVerdict;
}

/** The rule {@link ADMIT_ALL_POLICY} records: no criteria configured, so eligibility is the rule. */
export const STRUCTURAL_RULE = "any claimable run target";

/**
 * The policy in force on a project that has armed none: everything structurally claimable is
 * admitted, and the plan says so by name. An armed project narrows this with the operator's own
 * policy instead ({@link ./picker-policy}).
 *
 * Safe only because this pass STARTS NOTHING — it ranks and records, and the record is read by a
 * human. The arming feature (R1.5) must not inherit this default: a pass that writes `approved` off
 * an admit-everything policy is autopilot without the approval, which is the one thing the design
 * refuses. It resolves an operator-authored policy, or does not run.
 */
export const ADMIT_ALL_POLICY: PickerPolicy = {
  admits: () => ({ admitted: true, rule: STRUCTURAL_RULE }),
};

/**
 * The pass's runtime state — the facts about anton itself, as opposed to the board or the policy.
 *
 * Only the observation instant today, and deliberately passed in rather than read here: a decision
 * that called the clock would not be a function of its inputs, and the stamp is what makes a
 * recorded plan's staleness detectable. WIP, quota and breaker state join it in the brakes feature,
 * which is what needs them — this pass starts nothing, so nothing here can be over budget.
 */
export interface PickerRuntime {
  /** When the board snapshot was read (epoch ms), in the gardener's `observedAtMs` sense. */
  observedAtMs: number;
}

/** What one pass decided — exactly the plan {@link saveBoardPickerPlan} persists. */
export interface BoardPickerDecision {
  stamp: BoardStamp;
  /** The ranked queue, best first, each carrying the rule that admitted it. */
  entries: PickerPlanEntry[];
  /** Every candidate left out, in a deterministic order, each with a machine-readable reason. */
  exclusions: PickerExclusion[];
}

export function decideBoardPickerPlan(input: {
  board: Bead[];
  policy: PickerPolicy;
  runtime: PickerRuntime;
}): BoardPickerDecision {
  const { eligible, exclusions } = eligibleTargets(input.board);

  const admitted: Bead[] = [];
  const ruleFor = new Map<string, string>();
  const refused: PickerExclusion[] = [...exclusions];
  for (const target of eligible) {
    const verdict = input.policy.admits(target);
    if (!verdict.admitted) {
      refused.push({ beadId: target.id, reason: "policy", detail: verdict.detail });
      continue;
    }
    admitted.push(target);
    ruleFor.set(target.id, verdict.rule);
  }

  // Ranked against the FULL board, not the admitted set: a target's unblocking value comes from the
  // work it releases, which is mostly work no policy would ever admit on its own.
  const entries = rankTargets(admitted, input.board).map((ranked, i) => {
    const rule = ruleFor.get(ranked.bead.id);
    // Total by construction — every bead ranked here was put in `admitted` beside its rule. A miss
    // would persist an entry that no rule admits, which is a start nobody can audit; fail the pass
    // rather than record one.
    if (!rule) throw new Error(`board-picker: no admitting rule for ${ranked.bead.id}`);
    return { beadId: ranked.bead.id, rank: i + 1, rule };
  });

  return {
    stamp: stampBoard(input.board, input.runtime.observedAtMs),
    entries,
    exclusions: sortExclusions(refused),
  };
}
