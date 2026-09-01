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
 * Canonical rather than `JSON.stringify`: two reads of one policy must digest identically however
 * the settings blob happened to be keyed, so every field is named here and the unordered ones are
 * sorted. Hand-ranked label values are NOT sorted — their order IS the operator's declared scale
 * (`PolicyLabelCriterion.ranked`), and reordering it changes what the criterion admits.
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
 * Every criterion the policy asserts, in a fixed order. An absent bound is written as the empty
 * string rather than skipped, so "not asserted" and "asserted as 0" stay distinguishable — they are
 * different policies (R2.5).
 */
function policyLine(policy: Policy): string {
  return [
    `types=${[...(policy.types ?? [])].sort().join(",")}`,
    `priority=${policy.minPriority ?? ""}..${policy.maxPriority ?? ""}`,
    `parentage=${policy.minParentDepth ?? ""}..${policy.maxParentDepth ?? ""}`,
    `age=${policy.minAgeDays ?? ""}..${policy.maxAgeDays ?? ""}`,
    `unblocked=${policy.requireUnblocked ? "1" : ""}`,
    ...(policy.labels ?? []).map(labelLine).sort(),
  ].join("|");
}

function labelLine(criterion: PolicyLabelCriterion): string {
  const values = criterion.ranked ? criterion.values : [...criterion.values].sort();
  const compare = criterion.compare ? `${criterion.compare.op}:${criterion.compare.value}` : "";
  return `labels:${criterion.namespace}=${values.join(",")}/${criterion.ranked ? "ranked" : ""}/${compare}`;
}
