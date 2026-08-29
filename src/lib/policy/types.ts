/**
 * The standing policy an operator arms anton with (R2.1) — the value shape, kept dependency-free so
 * the calibration below it, the predicate beside it and the settings panel above it can all import
 * it without importing each other.
 *
 * Two criterion tiers, and the split is the whole design (R2.3). `types` and `maxPriority` are
 * bd-NATIVE: guaranteed on every board and inherently ordered, so they carry a threshold. `labels`
 * is the DISCOVERED tier: a namespace a repo invented has no inherent order, so a criterion over it
 * is membership and nothing more. anton ships no vocabulary, which is why nothing here names a
 * label — every value in {@link PolicyLabelCriterion} comes from the operator's own board.
 *
 * Absent means NOT ASSERTED, never "match nothing": a policy with no `types` places no constraint on
 * type. Within an asserted criterion the direction inverts and it fails CLOSED (R2.5) — a bead with
 * no `domain:` label does not satisfy `domain ∈ {eng}`.
 *
 * Machine-local by construction: this is stored per project in `settingsJson`, so two machines on
 * one repo may hold different policies and bd's claim protocol resolves the race.
 */

/** One discovered-namespace criterion: the bead must carry `<namespace>:<value>` for some value. */
export interface PolicyLabelCriterion {
  /** The `ns` of a `ns:value` label, as the board writes it — `"domain"`, not `"domain:"`. */
  namespace: string;
  /** Admitted values, BARE (`"eng"`, not `"domain:eng"`). Empty is meaningless and never emitted. */
  values: string[];
  /**
   * The operator ranked these values by hand, so {@link values} is ORDERED — most preferred first —
   * and the order must survive a round trip through settings (R2.3).
   *
   * Ranking never changes what the criterion ADMITS: membership is still membership, and this is the
   * only ordering a discovered namespace ever has, because a set a repo invented has none of its own
   * and anton refuses to infer one. Absent means the values are an unordered set.
   */
  ranked?: boolean;
}

/**
 * Which criterion a rationale explains or a verdict refuses — the key every surface anchors to its
 * control, so a "why this?" and a "why not?" about the same criterion agree on its name.
 */
export type PolicyCriterionKey = "types" | "priority" | "blockers" | `labels:${string}`;

export interface Policy {
  /**
   * Admitted bd issue types (`bug`, `chore`, `feature`, …). Membership, not a threshold: bd's types
   * are a set, unlike its priorities.
   */
  types?: string[];
  /**
   * Priority floor, held as bd's NUMBER because that is what a bead carries: P0 is 0 and larger is
   * less urgent, so "priority ≥ P2" is `priority <= 2`. Named for the comparison the code performs
   * rather than the one the UI prints, so nothing has to remember the inversion twice.
   */
  maxPriority?: number;
  /** Discovered-namespace membership criteria, one entry per namespace the operator named. */
  labels?: PolicyLabelCriterion[];
  /** Refuse a target with an unmet blocker on the `blocks` graph. */
  requireUnblocked?: boolean;
}

/** The `ns` of a `ns:value` label, or `""` for a bare label like `approved`. */
export function namespaceOf(label: string): string {
  const sep = label.indexOf(":");
  return sep === -1 ? "" : label.slice(0, sep);
}

/** The `value` of a `ns:value` label, or `undefined` when the label is bare. */
export function valueOf(label: string): string | undefined {
  const sep = label.indexOf(":");
  return sep === -1 ? undefined : label.slice(sep + 1);
}
