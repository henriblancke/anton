/**
 * WHICH CRITERION LET THIS BEAD IN (anton-jqvy) — the lever `Never` puts under the operator's hand.
 *
 * `Never` is the veto that changes the rule instead of re-arguing the pick, so it has to land on a
 * control, not on a panel. The policy admits by unanimity — a bead is in when NO asserted criterion
 * refuses it ({@link explainPolicyMatch}) — so "the criterion that admitted it" is not read off the
 * verdict; it is chosen, and the choice is the one an operator would reach for to keep work like
 * this out.
 *
 * The order below is that choice, from narrowest lever to bluntest:
 *
 *   1. a DISCOVERED namespace the bead satisfies — the repo's own vocabulary, and the only criterion
 *      written in words this board invented. Tightening `domain:` excludes a class of work; the
 *      operator authored that class themselves.
 *   2. `types`, then the ordered bd-native fields — priority, parentage, age. Native and coarse: a
 *      type bound moves whole tiers of the board at once.
 *   3. `blockers` last. It is a safety assertion rather than a selection, so tightening it to exclude
 *      one target is almost never what an operator means.
 *
 * `undefined` is a real answer and not a failure: an unarmed project, or one whose policy asserts
 * nothing this bead satisfies, has no rule to open at — the editor opens at the panel and the
 * operator authors the first criterion. Silently naming an unrelated control would be worse.
 *
 * Pure, client-safe and over the same {@link PolicyCandidate} the editor evaluates, for the reason
 * {@link ./match} is: the answer must be the same one the panel would give.
 */
import { admittedValues, explainPolicyMatch, type PolicyCandidate } from "./match";
import { namespaceOf, valueOf, type Policy, type PolicyCriterionKey } from "./types";

/** Does the bead carry a value this namespace criterion admits? */
function satisfiesNamespace(candidate: PolicyCandidate, policy: Policy, namespace: string): boolean {
  const criterion = policy.labels?.find((c) => c.namespace === namespace);
  if (!criterion?.values.length) return false;
  const admitted = admittedValues(criterion);
  if (!admitted) return false;
  return candidate.labels.some(
    (label) => namespaceOf(label) === namespace && admitted.includes(valueOf(label) ?? ""),
  );
}

/**
 * The criterion a `Never` on this bead should open the policy editor at, or `undefined` when the
 * policy has none to name.
 *
 * A bead the policy REFUSES has no admitting criterion either: nothing let it in, so there is
 * nothing to tighten. That is the same `undefined`, and the editor treats it the same way.
 */
export function admittingCriterion(
  candidate: PolicyCandidate,
  policy: Policy,
): PolicyCriterionKey | undefined {
  if (explainPolicyMatch(candidate, policy).length > 0) return undefined;

  for (const criterion of policy.labels ?? []) {
    if (satisfiesNamespace(candidate, policy, criterion.namespace)) {
      return `labels:${criterion.namespace}`;
    }
  }

  if (policy.types?.length && candidate.type && policy.types.includes(candidate.type)) {
    return "types";
  }
  if (typeof policy.maxPriority === "number" || typeof policy.minPriority === "number") {
    if (typeof candidate.priority === "number") return "priority";
  }
  if (typeof policy.maxParentDepth === "number" || typeof policy.minParentDepth === "number") {
    if (typeof candidate.depth === "number") return "parentage";
  }
  if (typeof policy.minAgeDays === "number" || typeof policy.maxAgeDays === "number") {
    if (typeof candidate.ageDays === "number") return "age";
  }
  if (policy.requireUnblocked) return "blockers";

  return undefined;
}
