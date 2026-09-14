/**
 * The operator's stored policy, as the predicate the board-picker narrows its plan with (R2.1/R2.4).
 *
 * The adapter exists because the two halves speak different shapes on purpose: the pass hands the
 * policy a `Bead`, while the policy is evaluated over the flat {@link PolicyCandidate} the editor
 * also evaluates — the same projection, the same predicate, so the count the panel showed when the
 * operator accepted a policy is the rule the pass then applies. A second evaluator over `Bead` would
 * be a second answer to "does this match?", and the panel would be advertising a boundary the plan
 * does not keep.
 *
 * FAILS CLOSED (R2.5). A target the projection does not carry is refused rather than admitted: the
 * projection is the startable set, so a miss means this target is not startable — and a policy that
 * guessed in the admitting direction would start work nobody's rule covered.
 */
import { policyCandidates } from "../policy/candidates";
import { explainPolicyMatch } from "../policy/match";
import type { Policy } from "../policy/types";
import type { Bead } from "../beads/types";
import type { PickerPolicy, PolicyVerdict } from "./picker-decision";

/**
 * What the plan records as the admitting rule. Names the policy rather than quoting its criteria: the
 * criteria are the settings panel's to print, and a rule string that restated them would go stale the
 * moment the operator edited one.
 */
export const ARMED_RULE = "the work policy armed on this machine";

/** Refused because the startable projection does not carry this target — see the module note. */
const NOT_STARTABLE = "not in the startable set the policy was evaluated over";

/**
 * Bind a stored policy to one board snapshot. `now` is the pass's observation instant, so the age
 * criterion is judged against the moment the board was read rather than the moment each bead is.
 */
export function armedPickerPolicy(policy: Policy, board: Bead[], now?: Date): PickerPolicy {
  const byId = new Map(policyCandidates(board, now).candidates.map((c) => [c.id, c]));

  return {
    admits(target: Bead): PolicyVerdict {
      const candidate = byId.get(target.id);
      if (!candidate) return { admitted: false, detail: NOT_STARTABLE };
      const failed = explainPolicyMatch(candidate, policy);
      if (!failed.length) return { admitted: true, rule: ARMED_RULE };
      // Every criterion that refused it, in the editor's own words — "why not this one?" is asked of
      // the plan as often as of the panel, and the two must answer it the same way.
      return { admitted: false, detail: failed.map((f) => `${f.label}: ${f.reason}`).join("; ") };
    },
  };
}
