/**
 * The standing policy an operator arms anton with (R2.1) — the value shape, kept dependency-free so
 * the calibration below it, the predicate beside it and the settings panel above it can all import
 * it without importing each other.
 *
 * Two criterion tiers, and the split is the whole design (R2.3). The bd-NATIVE tier is guaranteed on
 * every board, and where a native field is genuinely ordered — priority, parentage depth, age — it
 * carries BOTH bounds, a `≤` and a `≥`. `types` is the exception inside its own tier: bd's issue
 * types are an enum with no order (a `bug` is not "less than" a `feature`), so it is membership, for
 * the same reason a discovered namespace is. anton infers an order for nothing.
 *
 * `labels` is the DISCOVERED tier: a namespace a repo invented has no inherent order, so a criterion
 * over it is membership — UNLESS the operator hand-ranked that namespace and stated a bound against
 * their own ranking ({@link PolicyLabelCriterion.compare}). The ordering is always the operator's
 * act, never a reading of the board. anton ships no vocabulary, which is why nothing here names a
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
   * On its own, ranking never changes what the criterion ADMITS: membership is still membership, and
   * this is the only ordering a discovered namespace ever has, because a set a repo invented has none
   * of its own and anton refuses to infer one. Absent means the values are an unordered set.
   */
  ranked?: boolean;
  /**
   * A `≤` / `≥` over that hand-ranking rather than a membership test (R2.3) — the ONE way a
   * discovered namespace gains an order, and only because the operator declared it.
   *
   * Requires {@link ranked}: without a declared scale there is nothing to compare against, and
   * reading one off the board is precisely what anton refuses to do. `value` names a position in
   * {@link values}; `lte` admits everything at or before it, `gte` everything at or after it. On a
   * ranking of `["S", "M", "L"]`, `{ op: "lte", value: "M" }` is `size ≤ M` and admits S and M.
   *
   * When set, {@link values} is read as the SCALE rather than as the admitted set — the comparison
   * decides admission, so the ranking may (and usually should) name values the policy excludes. A
   * comparison anton cannot evaluate — no ranking, or a bound the ranking does not carry — fails
   * closed for every bead (R2.5) rather than quietly degrading to membership over the whole scale.
   */
  compare?: PolicyRankComparison;
}

/** A bound within a hand-ranked namespace: `lte` = at or before it, `gte` = at or after it. */
export interface PolicyRankComparison {
  op: "lte" | "gte";
  /** The boundary value, BARE, and necessarily one of the criterion's ranked values. */
  value: string;
}

/**
 * Which criterion a rationale explains or a verdict refuses — the key every surface anchors to its
 * control, so a "why this?" and a "why not?" about the same criterion agree on its name.
 */
export type PolicyCriterionKey =
  | "types"
  | "priority"
  | "parentage"
  | "age"
  | "blockers"
  | `labels:${string}`;

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
  /**
   * The other end of the same ordered field ({@link maxPriority} is the floor, this is the ceiling):
   * bd's number must be at or above it, so `minPriority: 1` withholds P0 from autopilot. An operator
   * who wants the most urgent work triaged by a human rather than started by a policy states it here.
   */
  minPriority?: number;
  /**
   * Parentage, as an ordered field: how many parent hops sit above the bead, so 0 is top-level.
   * `maxParentDepth: 0` admits only parentless work; a bead whose parent chain leaves the board
   * cannot answer the question and fails closed.
   */
  maxParentDepth?: number;
  /** The shallow end of the same field — the bead must sit at least this deep under a parent. */
  minParentDepth?: number;
  /**
   * A SOAK: the bead must have existed at least this many days, so a policy never starts something
   * filed minutes ago that a human was still about to edit or veto.
   */
  minAgeDays?: number;
  /**
   * The stale end of the same field — nothing older than this many days is started, so a policy
   * widened once does not immediately pull in work the board has already ignored for a year.
   */
  maxAgeDays?: number;
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

/**
 * The ceilings the API boundary enforces on the whole-unit ordered bounds, held here so the editor
 * constrains what it accepts to exactly what the schema will store: a control that lets an operator
 * type a depth of 40 spends their click on a 400 they cannot resolve from the panel.
 *
 * A board nests epic → feature → ticket, so a depth beyond a few hops is a typo rather than a
 * policy; a year is the outer edge of a soak, and a decade the outer edge of "stale".
 */
export const POLICY_BOUND_MAX = {
  parentDepth: 8,
  minAgeDays: 365,
  maxAgeDays: 3650,
} as const;

/**
 * How many issue types one policy may admit, held beside the bounds above for the same reason: the
 * calibrator must not propose — and the editor must not offer — a `types` criterion the schema would
 * reject, spending the operator's accept on a 400 the panel cannot explain.
 */
export const POLICY_TYPES_MAX = 16;

/**
 * The least urgent priority a policy may name as its floor — 4 is the bottom of bd's own 0-4 scale,
 * so a floor above it is a priority no bead can carry.
 */
export const POLICY_PRIORITY_MAX = 4;

/**
 * How many values one discovered-namespace criterion may carry, held beside the bounds above for the
 * same reason: the editor must refuse the 33rd chip rather than spend an operator's accept on a 400
 * the panel cannot explain. A namespace with more observed values than this is stated by selecting
 * the ones that matter, not by admitting all of them.
 */
export const POLICY_CRITERION_VALUES_MAX = 32;

/**
 * How many discovered namespaces one policy may constrain at once, for the same reason as the
 * ceiling above: a board can expose more `ns:` groups than the store will hold, and an editor that
 * keeps offering criteria past this point spends the operator's accept on a 400 no control on the
 * panel can undo. A policy naming this many namespaces is already narrower than anything a board
 * routinely needs.
 */
export const POLICY_LABEL_CRITERIA_MAX = 16;

/**
 * How long each authored string may be, for the same reason as the counts above: the schema bounds
 * a type, a namespace and a value, and a draft or an editor that offers a longer one spends the
 * operator's accept on a 400 the panel cannot explain. A board label past these lengths is a
 * sentence, not a vocabulary.
 */
export const POLICY_TEXT_MAX = {
  type: 40,
  namespace: 60,
  value: 120,
} as const;

/**
 * Whether the store would keep this string as written — the one place the length question is
 * answered, so the calibrated draft and the editor's chips agree on which of a board's own words are
 * authorable. Lengths are measured TRIMMED because the schema trims before it bounds, so that is the
 * string the API actually judges.
 */
export function isStorableText(text: string, max: number): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 1 && trimmed.length <= max;
}

/**
 * anton's OWN bookkeeping namespaces — where anton has already put a bead, not what an operator
 * judged worth starting. Excluded everywhere a criterion is authored (the calibrated draft and the
 * editor alike): a policy over `stage:` or `review-score:` is the machine quoting itself back, and
 * one over a namespace anton rewrites mid-run admits a set that moves under it.
 */
export const POLICY_CONTROL_NAMESPACES: ReadonlySet<string> = new Set([
  "stage",
  "run-lease",
  "review-score",
  "source",
]);

/**
 * How far the board-picker may go with the plan it just decided (R3.5), ordered by how much of the
 * start it is trusted to make — the same ladder, and the same word order, the gardener's per-kind
 * autonomy uses (`gardener/autonomy.ts`), because an operator reading both should not have to learn
 * two vocabularies for one idea.
 *
 *   • `propose` — the pass ranks and records, and the lane is empty. Nothing is offered.
 *   • `shadow`  — the ranking is offered as picks the operator releases or vetoes by hand. Every
 *                 release and veto is evidence, which is what `apply` is later earned on.
 *   • `apply`   — the pass writes `approved`, claims the target and starts the run itself.
 *
 * Machine-local like the policy it accompanies, and never a default: `apply` is only ever reachable
 * on a project that has armed a policy, because the structural default admits everything and a pass
 * that started work off THAT is autopilot without the approval.
 */
export const PICKER_AUTONOMY_LEVELS = ["propose", "shadow", "apply"] as const;

export type PickerAutonomy = (typeof PICKER_AUTONOMY_LEVELS)[number];
