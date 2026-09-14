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
 * direction inverts: a bead that cannot answer the question — no type, no priority, no creation
 * date, a parent chain that leaves the board, no label under the namespace — fails it.
 *
 * What each criterion may SAY is the R2.3 split, and it is a rule about ordering rather than about
 * where a field came from. The ordered bd-native fields — priority, parentage depth, age — take both
 * a `≤` and a `≥`, because every board carries them on the same scale. `type` does not, despite
 * being native: bd's issue types are an enum nobody ordered. A discovered namespace is membership
 * for the same reason, until the operator ranks it themselves and states a bound against THEIR
 * ranking — the one ordering in this module, and it arrives from the policy, never from the board.
 */
import { ageBoundBreached } from "./age";
import {
  namespaceOf,
  valueOf,
  type Policy,
  type PolicyCriterionKey,
  type PolicyLabelCriterion,
} from "./types";

/**
 * The slice of a bead the editor evaluates and lists. Deliberately flat and small: this is the whole
 * payload the panel ships to the browser, one entry per startable target on the board.
 */
export interface PolicyCandidate {
  id: string;
  title: string;
  /** bd's `issue_type`. Absent is a real state, and an asserted `types` criterion excludes it. */
  type?: string;
  /** bd's priority NUMBER — P0 is 0 and larger is less urgent. */
  priority?: number;
  /**
   * Parent hops above this bead — 0 is top-level. Absent means the chain leaves the board (a parent
   * this snapshot does not carry, or a cycle), which an asserted parentage criterion fails closed on
   * rather than guessing a depth for.
   */
  depth?: number;
  /** Whole days since the bead was filed. Absent when it carries no creation date. */
  ageDays?: number;
  labels: string[];
  /**
   * Carries at least one unmet blocker on the `blocks` graph. Never set by the startable projection
   * ({@link ./candidates}) — a held target is refused structurally, before any policy is consulted —
   * so a policy stating the rule restates a guarantee it already has.
   */
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

/** `is top-level` / `sits 2 levels under a parent` — parentage read as the depth it is. */
function depthPhrase(depth: number): string {
  return depth === 0 ? "is top-level" : `sits ${depthBound(depth)}`;
}

/** The same depth as a bound the policy states — `top-level`, `2 levels under a parent`. */
function depthBound(depth: number): string {
  return depth === 0 ? "top-level" : `${depth} level${depth === 1 ? "" : "s"} under a parent`;
}

/** `1 day` / `9 days`. */
function days(count: number): string {
  return `${count} day${count === 1 ? "" : "s"}`;
}

/**
 * What a discovered-namespace criterion admits: its values outright, or — where the operator ranked
 * the namespace and stated a bound — the slice of that ranking the bound names.
 *
 * `undefined` is the criterion anton CANNOT evaluate: a comparison with no ranking behind it, or one
 * bounded on a value the ranking does not carry. Neither may be softened into membership, because
 * the softening would admit beads the operator never wrote a rule for.
 */
export function admittedValues(criterion: PolicyLabelCriterion): string[] | undefined {
  const { compare, values } = criterion;
  if (!compare) return values;
  if (!criterion.ranked) return undefined;
  const at = values.indexOf(compare.value);
  if (at === -1) return undefined;
  return compare.op === "lte" ? values.slice(0, at + 1) : values.slice(at);
}

/** Why a comparison cannot be judged — the policy's defect, named on the bead it is refusing. */
function unusableComparison(criterion: PolicyLabelCriterion): string {
  const bound = criterion.compare?.value ?? "";
  return criterion.ranked
    ? `cannot be judged: the policy compares \`${criterion.namespace}:\` against \`${bound}\`, which is not in its ranking`
    : `cannot be judged: the policy compares \`${criterion.namespace}:\` against a ranking it does not carry`;
}

/**
 * The admitted set as the operator stated it. A comparison quotes its bound as well as the values it
 * resolves to — "at or before `major`" is the rule; the listing is only what the rule currently means.
 */
function requirement(criterion: PolicyLabelCriterion, admitted: readonly string[]): string {
  const compare = criterion.compare;
  if (!compare) return listing(admitted);
  const side = compare.op === "lte" ? "at or before" : "at or after";
  return `${side} \`${compare.value}\` in your \`${criterion.namespace}:\` ranking (${listing(admitted)})`;
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

  const priorityBounded = typeof policy.maxPriority === "number" || typeof policy.minPriority === "number";
  if (priorityBounded) {
    if (typeof candidate.priority !== "number") {
      failed.push({ criterion: "priority", label: "priority", reason: "carries no priority" });
    } else if (typeof policy.maxPriority === "number" && candidate.priority > policy.maxPriority) {
      failed.push({
        criterion: "priority",
        label: "priority",
        reason: `is P${candidate.priority}, below the P${policy.maxPriority} floor`,
      });
    } else if (typeof policy.minPriority === "number" && candidate.priority < policy.minPriority) {
      // The urgent end is withheld on purpose: a P0 an operator has excluded is work they want
      // triaged by hand, not started by a rule.
      failed.push({
        criterion: "priority",
        label: "priority",
        reason: `is P${candidate.priority}, above the P${policy.minPriority} ceiling`,
      });
    }
  }

  const depthBounded =
    typeof policy.maxParentDepth === "number" || typeof policy.minParentDepth === "number";
  if (depthBounded) {
    if (typeof candidate.depth !== "number") {
      failed.push({
        criterion: "parentage",
        label: "parentage",
        reason: "sits under a parent this board does not carry",
      });
    } else if (typeof policy.maxParentDepth === "number" && candidate.depth > policy.maxParentDepth) {
      failed.push({
        criterion: "parentage",
        label: "parentage",
        reason: `${depthPhrase(candidate.depth)}, and the policy admits nothing deeper than ${depthBound(policy.maxParentDepth)}`,
      });
    } else if (typeof policy.minParentDepth === "number" && candidate.depth < policy.minParentDepth) {
      failed.push({
        criterion: "parentage",
        label: "parentage",
        reason: `${depthPhrase(candidate.depth)}, and the policy admits nothing shallower than ${depthBound(policy.minParentDepth)}`,
      });
    }
  }

  // Through the shared bound, never a second comparison: the recorded plan's fence re-judges this
  // same criterion off the clock (`board-picker-plan.ts`), and a card may not be explained by one
  // rounding of "a day" and released under another.
  const aged = ageBoundBreached(candidate.ageDays, policy);
  if (aged?.bound === "unknown") {
    failed.push({ criterion: "age", label: "age", reason: "carries no creation date" });
  } else if (aged?.bound === "min") {
    failed.push({
      criterion: "age",
      label: "age",
      reason: `was filed ${days(aged.ageDays)} ago, inside the ${days(aged.limit)} the policy waits before starting anything`,
    });
  } else if (aged?.bound === "max") {
    failed.push({
      criterion: "age",
      label: "age",
      reason: `was filed ${days(aged.ageDays)} ago, past the ${days(aged.limit)} the policy admits`,
    });
  }

  for (const criterion of policy.labels ?? []) {
    if (!criterion.values.length) continue; // never emitted, and it would exclude the whole board
    const key: PolicyCriterionKey = `labels:${criterion.namespace}`;
    const label = `${criterion.namespace}:`;

    const admitted = admittedValues(criterion);
    if (!admitted) {
      // An unevaluable comparison refuses everything and names the policy's own defect, rather than
      // widening to the whole ranking — silently admitting more than the operator wrote is the one
      // failure direction this module never takes (R2.5).
      failed.push({ criterion: key, label, reason: unusableComparison(criterion) });
      continue;
    }

    const carried = valuesUnder(candidate, criterion.namespace);
    if (carried.length === 0) {
      failed.push({
        criterion: key,
        label,
        // The fail-closed case, stated as the policy talking rather than as the bead being broken.
        reason: `carries no \`${criterion.namespace}:\` label, and the policy requires ${requirement(criterion, admitted)}`,
      });
    } else if (!carried.some((value) => admitted.includes(value))) {
      failed.push({
        criterion: key,
        label,
        reason: `is ${listing(carried.map((v) => `${criterion.namespace}:${v}`))}, and the policy admits only ${requirement(criterion, admitted)}`,
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

/**
 * The policy as the yes/no the picker needs. Every no is explainable — that is {@link
 * explainPolicyMatch} — so nothing evaluates the policy twice to also learn why.
 */
export function matchesPolicy(candidate: PolicyCandidate, policy: Policy): boolean {
  return explainPolicyMatch(candidate, policy).length === 0;
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
