/**
 * Does a bead satisfy the standing policy — and when it does not, WHICH criterion refused it (R2.6)?
 *
 * Fail-closed (R2.5) is the safe semantics and it is also the whole usability problem: a policy
 * written in a vocabulary this board does not use admits nothing, which on screen is indistinguishable
 * from a broken pass. So the interesting output here is not the boolean, it is the SENTENCE beside
 * the boolean. Every criterion an asserted policy states is evaluated, and every one a bead fails
 * comes back named and explained, so the editor can answer "why not this one?" per bead rather than
 * showing an unexplained zero.
 *
 * Evaluated in the BROWSER: the match count has to move with the control the operator is dragging,
 * and a round trip per edit would make the count lag the criterion it explains. That is why this
 * module imports nothing but {@link ./types} and reads a flat {@link PolicyCandidate} rather than a
 * `Bead` — the board projection lives in {@link ./candidates}, server-side, where the bd reader is.
 *
 * Absent criteria are NOT ASSERTED and place no constraint. Within an asserted criterion the
 * direction inverts: a bead that cannot answer the question — no type, no priority, no label under
 * the namespace — fails it.
 */
import { namespaceOf, valueOf, type Policy, type PolicyCriterionKey } from "./types";

/**
 * The slice of a bead the editor evaluates and lists. Deliberately flat and small: this is the whole
 * payload the panel ships to the browser, one entry per open bead on the board.
 */
export interface PolicyCandidate {
  id: string;
  title: string;
  /** bd's `issue_type`. Absent is a real state, and an asserted `types` criterion excludes it. */
  type?: string;
  /** bd's priority NUMBER — P0 is 0 and larger is less urgent. */
  priority?: number;
  labels: string[];
  /** Carries at least one unmet blocker on the `blocks` graph. */
  blocked?: boolean;
}

export type { PolicyCriterionKey };

/** One criterion a bead FAILED, in the words the editor prints beside that bead. */
export interface CriterionVerdict {
  criterion: PolicyCriterionKey;
  /** The criterion's name as the editor labels it — `type`, `priority`, `severity:`. */
  label: string;
  /** Why this bead does not satisfy it. */
  reason: string;
}

/** `a`, `a or b`, `a, b or c` — an admitted set read as prose, matching the draft's rationale. */
function listing(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "nothing";
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

/** The values a bead carries under one namespace, in the order its labels are written. */
function valuesUnder(candidate: PolicyCandidate, namespace: string): string[] {
  const found: string[] = [];
  for (const label of candidate.labels) {
    if (namespaceOf(label) !== namespace) continue;
    const value = valueOf(label);
    if (value) found.push(value);
  }
  return found;
}

/**
 * Every criterion this bead fails, in the order the editor lists its controls. Empty means the bead
 * matches — the count is `explainPolicyMatch(...).length === 0` over the candidates, and nothing has
 * to evaluate the policy twice to also know why.
 */
export function explainPolicyMatch(candidate: PolicyCandidate, policy: Policy): CriterionVerdict[] {
  const failed: CriterionVerdict[] = [];

  if (policy.types?.length) {
    if (!candidate.type) {
      failed.push({ criterion: "types", label: "type", reason: "carries no issue type" });
    } else if (!policy.types.includes(candidate.type)) {
      failed.push({
        criterion: "types",
        label: "type",
        reason: `is a ${candidate.type}, and the policy admits only ${listing(policy.types)}`,
      });
    }
  }

  if (typeof policy.maxPriority === "number") {
    if (typeof candidate.priority !== "number") {
      failed.push({ criterion: "priority", label: "priority", reason: "carries no priority" });
    } else if (candidate.priority > policy.maxPriority) {
      failed.push({
        criterion: "priority",
        label: "priority",
        reason: `is P${candidate.priority}, below the P${policy.maxPriority} floor`,
      });
    }
  }

  for (const criterion of policy.labels ?? []) {
    if (!criterion.values.length) continue; // never emitted, and it would exclude the whole board
    const carried = valuesUnder(candidate, criterion.namespace);
    const label = `${criterion.namespace}:`;
    if (carried.length === 0) {
      failed.push({
        criterion: `labels:${criterion.namespace}`,
        label,
        // The fail-closed case, stated as the policy talking rather than as the bead being broken.
        reason: `carries no \`${criterion.namespace}:\` label, and the policy requires ${listing(criterion.values)}`,
      });
    } else if (!carried.some((value) => criterion.values.includes(value))) {
      failed.push({
        criterion: `labels:${criterion.namespace}`,
        label,
        reason: `is ${listing(carried.map((v) => `${criterion.namespace}:${v}`))}, and the policy admits only ${listing(criterion.values)}`,
      });
    }
  }

  if (policy.requireUnblocked && candidate.blocked) {
    failed.push({
      criterion: "blockers",
      label: "blockers",
      reason: "has an unmet blocker on the `blocks` graph",
    });
  }

  return failed;
}

/** One bead the policy refused, with the criteria that refused it. */
export interface PolicyExclusion {
  candidate: PolicyCandidate;
  failed: CriterionVerdict[];
}

/**
 * The board split by the policy in ONE pass — what it admits, and what it refused with reasons.
 *
 * One pass rather than a count plus a filter plus a per-bead explain: the panel shows all three at
 * once, and three walks of the board per keystroke is the shape that makes an editor feel slow.
 */
export function partitionByPolicy(
  candidates: readonly PolicyCandidate[],
  policy: Policy,
): { matched: PolicyCandidate[]; excluded: PolicyExclusion[] } {
  const matched: PolicyCandidate[] = [];
  const excluded: PolicyExclusion[] = [];
  for (const candidate of candidates) {
    const failed = explainPolicyMatch(candidate, policy);
    if (failed.length === 0) matched.push(candidate);
    else excluded.push({ candidate, failed });
  }
  return { matched, excluded };
}
