/**
 * The armed policy's REVISION, as one short deterministic string.
 *
 * The board-picker's recorded plan is fenced against the board it was computed over (`stampBoard`),
 * but the board is only half of that decision — the standing policy is the other half. An operator
 * who narrows `pickerPolicy` without touching a bead changes which targets are admissible while
 * every bead digest stays byte-identical, so a fence over the beads alone would go on calling the
 * old plan current until the next pass overwrote it: the Up Next lane would keep ranking, and
 * `[Release]` keep offering, targets the newly saved policy excludes.
 *
 * Canonical rather than a `JSON.stringify` of the stored blob: two reads of one policy must digest
 * identically however the settings object happened to be keyed, so every field is named here and the
 * unordered ones are sorted. Hand-ranked label values are NOT sorted — their order IS the operator's
 * declared scale (`PolicyLabelCriterion.ranked`), and reordering it changes what the criterion
 * admits.
 *
 * The canonical form is then JSON-encoded rather than joined with delimiters (PR #212 review). Every
 * variable part of a policy is a string off the operator's own board — a namespace, a type, a label
 * value — and any separator this file picked could appear inside one, so `{ values: ["a,b"] }` and
 * `{ values: ["a", "b"] }` would digest alike while admitting different labels. Two policies that
 * differ must move the digest, or the plan the replaced one produced goes on reading as current.
 */
import { createHash } from "node:crypto";
import type { Policy, PolicyLabelCriterion } from "./types";

/** What a project that has armed no policy digests to — its own state, not an empty policy. */
export const UNARMED_POLICY_DIGEST = "unarmed";

/** Long enough that a collision is not a practical concern, short enough to sit in a version token. */
const DIGEST_LENGTH = 16;

export function policyDigest(policy?: Policy): string {
  if (!policy) return UNARMED_POLICY_DIGEST;
  return createHash("sha256").update(policyLine(policy)).digest("hex").slice(0, DIGEST_LENGTH);
}

/**
 * Every criterion the policy asserts, in a fixed order. An absent bound is written as `null` rather
 * than skipped, so "not asserted" and "asserted as 0" stay distinguishable — they are different
 * policies (R2.5).
 */
function policyLine(policy: Policy): string {
  return JSON.stringify([
    [...(policy.types ?? [])].sort(),
    [policy.minPriority ?? null, policy.maxPriority ?? null],
    [policy.minParentDepth ?? null, policy.maxParentDepth ?? null],
    [policy.minAgeDays ?? null, policy.maxAgeDays ?? null],
    policy.requireUnblocked === true,
    // Sorted by their own encodings, so one policy's criteria digest in one order however the
    // settings blob listed them.
    (policy.labels ?? []).map(labelLine).sort(),
  ]);
}

function labelLine(criterion: PolicyLabelCriterion): string {
  const values = criterion.ranked ? criterion.values : [...criterion.values].sort();
  return JSON.stringify([
    criterion.namespace,
    values,
    criterion.ranked === true,
    criterion.compare ? [criterion.compare.op, criterion.compare.value] : null,
  ]);
}
