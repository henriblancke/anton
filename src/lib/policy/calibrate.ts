/**
 * FIRST ARM IS NEVER A BLANK FORM (anton-c7iv, R2.7).
 *
 * A generated policy editor showing twenty discovered namespaces is worse than no editor at all if
 * the operator has to guess where to start. So before anything is armed, this reads the approvals
 * the operator has ALREADY granted on this board and proposes the policy that would have admitted
 * every one of them. The proposal is a draft: {@link calibratePolicy} writes nothing, and the panel
 * that renders it applies nothing until the operator accepts.
 *
 * Reading THIS repo's history is also where repo-agnosticism comes from for free (R2.8): a payments
 * board that labels `severity:` and `team:` gets criteria in those words, because those are the
 * words its own approvals are written in. Nothing here knows a single label.
 *
 * The derivation's contract is that the draft MATCHES its evidence — every criterion is widened
 * until all sampled approvals satisfy it, and a criterion that cannot be stated without excluding
 * one is not stated at all. That is what makes the proposal defensible when the operator asks why:
 * each entry in {@link PolicyDraft.rationale} names the approvals behind it.
 *
 * Under {@link MIN_CALIBRATION_APPROVALS} the derivation is abandoned rather than fitted, because a
 * policy fitted to three data points is noise dressed as a recommendation. The fallback is the one
 * place anton does ship an opinion — deliberately universal (bd-native fields only) and narrow.
 *
 * Pure and spawn-free: it takes a board snapshot a caller already holds.
 */
import { LABELS } from "../beads/bd";
import type { Bead } from "../beads/types";
import {
  POLICY_CONTROL_NAMESPACES,
  POLICY_CRITERION_VALUES_MAX,
  POLICY_LABEL_CRITERIA_MAX,
  POLICY_PRIORITY_MAX,
  POLICY_TEXT_MAX,
  POLICY_TYPES_MAX,
  namespaceOf,
  valueOf,
  type Policy,
  type PolicyCriterionKey,
  type PolicyLabelCriterion,
} from "./types";

/**
 * Below this many prior approvals the history is evidence of nothing and the fallback is proposed
 * instead. Five is the design's "~5" (R2.7): enough that a repeated shape is a habit rather than a
 * coincidence, low enough that a board a fortnight old still teaches anton something.
 */
export const MIN_CALIBRATION_APPROVALS = 5;

/**
 * The conservative universal default (R2.7), stated in bd-NATIVE fields only — the sole vocabulary
 * guaranteed to exist on a board anton has never seen. Small, reversible work at or above P2, and
 * nothing with an unmet blocker.
 */
export const FALLBACK_POLICY: Policy = {
  types: ["bug", "chore"],
  maxPriority: 2,
  requireUnblocked: true,
};

/** How many approvals one rationale names. Enough to make the claim checkable, short enough to read. */
const MAX_CITED = 4;

/**
 * The ceilings `pickerPolicySchema` enforces at the API boundary — counts AND string lengths, every
 * one of them read from the shared constants the schema itself is built from, since a limit copied
 * here as a literal would drift the day the schema's moved. A draft that crosses one is worse than
 * no draft: the operator clicks accept and gets a 400 they cannot resolve from the panel. So a
 * criterion that would cross a ceiling is OMITTED rather than clamped — clamping would narrow the
 * proposal until it refused the very approvals it was read from, which is the one thing this
 * derivation promises never to do.
 */
const SCHEMA_LIMITS = {
  types: POLICY_TYPES_MAX,
  priority: POLICY_PRIORITY_MAX,
  criterionValues: POLICY_CRITERION_VALUES_MAX,
  labelCriteria: POLICY_LABEL_CRITERIA_MAX,
  text: POLICY_TEXT_MAX,
} as const;

/**
 * Whether the store would keep this string as written. Lengths are measured TRIMMED because the
 * schema trims before it bounds, so that is the string the API actually judges.
 */
function storable(text: string, max: number): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 1 && trimmed.length <= max;
}

export type { PolicyCriterionKey };

/** One criterion and the evidence behind it, so a draft is never an unexplained suggestion. */
export interface PolicyRationale {
  criterion: PolicyCriterionKey;
  /** The sentence shown beside the control, naming what in the history motivated the criterion. */
  summary: string;
  /** The approvals it was read off, most recent first, capped at {@link MAX_CITED}. */
  citedBeadIds: string[];
}

/** A proposed policy, its provenance, and its reasons. Never persisted by this module. */
export interface PolicyDraft {
  policy: Policy;
  /** `history` = fitted to this board's approvals; `fallback` = too little evidence to fit. */
  basis: "history" | "fallback";
  /** How many prior approvals the read found — the number the thin-evidence copy quotes. */
  approvals: number;
  rationale: PolicyRationale[];
}

/**
 * The approvals a policy may be fitted to, most recent first.
 *
 * The `approved` label IS the history: it is the human gate every worker reads, so a bead carrying
 * it is by definition work this operator blessed. ABANDONED approvals are dropped — a won't-do is an
 * approval the operator took back, and fitting to it would teach anton the one shape it got wrong.
 */
export function approvalHistory(board: readonly Bead[]): Bead[] {
  return board
    .filter((b) => b.labels?.includes(LABELS.approved) && !b.labels?.includes(LABELS.abandoned))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

/** The issue types this board actually uses — the type vocabulary a draft is edited against. */
export function boardIssueTypes(board: readonly Bead[]): string[] {
  const types = new Set<string>();
  for (const bead of board) if (bead.issue_type) types.add(bead.issue_type);
  return [...types].sort();
}

const cite = (approvals: readonly Bead[]): string[] =>
  approvals.slice(0, MAX_CITED).map((b) => b.id);

/** `2 of 9 approvals` / `every one of 9 approvals` — the phrasing every summary shares. */
function share(count: number, total: number): string {
  return count === total ? `all ${total} approvals` : `${count} of ${total} approvals`;
}

/**
 * Propose a policy from what this project has already approved.
 *
 * Every derived criterion is widened to cover the whole sample, so the draft provably admits its own
 * evidence. Where that is impossible — approvals with no `issue_type`, or no priority — the criterion
 * is OMITTED rather than stated at a value that would fail closed against the very history it was
 * read from.
 */
export function calibratePolicy(board: readonly Bead[]): PolicyDraft {
  const approvals = approvalHistory(board);
  if (approvals.length < MIN_CALIBRATION_APPROVALS) return fallbackDraft(approvals);

  const policy: Policy = { requireUnblocked: true };
  const rationale: PolicyRationale[] = [];
  const total = approvals.length;

  // Type: membership over every type the operator has approved. Omitted when any approval carries no
  // type at all, since `types` fails closed and would exclude that approval.
  const approvedTypes = approvals.map((b) => b.issue_type);
  if (approvedTypes.every((t): t is string => !!t)) {
    const types = [...new Set(approvedTypes)].sort();
    // A type the store would not keep cannot be dropped from the membership set without excluding
    // the approval that carried it, so the criterion goes instead (see SCHEMA_LIMITS).
    const storableTypes = types.every((t) => storable(t, SCHEMA_LIMITS.text.type));
    if (types.length <= SCHEMA_LIMITS.types && storableTypes) {
      policy.types = types;
      rationale.push({
        criterion: "types",
        summary: `${share(total, total)} were ${listing(types)} — no other type has been approved here.`,
        citedBeadIds: cite(approvals),
      });
    }
  }

  // Priority: the LEAST urgent priority ever approved, so the floor admits the whole sample. Omitted
  // when any approval carries no priority, for the same fail-closed reason as type.
  const priorities = approvals.map((b) => b.priority);
  if (priorities.every((p): p is number => typeof p === "number")) {
    const floor = Math.max(...priorities);
    // A floor off bd's own 0-4 scale is a priority no policy may state, so the criterion is dropped
    // rather than clamped down onto the approval that produced it.
    if (floor >= 0 && floor <= SCHEMA_LIMITS.priority) {
      policy.maxPriority = floor;
      const atFloor = priorities.filter((p) => p === floor).length;
      rationale.push({
        criterion: "priority",
        summary:
          `Nothing below P${floor} has ever been approved here` +
          ` (${share(atFloor, total)} sat at P${floor}).`,
        citedBeadIds: cite(approvals.filter((b) => b.priority === floor)),
      });
    }
  }

  // Discovered namespaces: a criterion is proposed only where the namespace is a real signal — every
  // approval carries it (so membership can't fail closed on the sample) AND the approved values are
  // a PROPER subset of what the board uses (so the criterion actually narrows something).
  const labels = labelCriteria(approvals, board);
  if (labels.length) policy.labels = labels;
  for (const { namespace, values } of labels) {
    rationale.push({
      criterion: `labels:${namespace}`,
      summary:
        `${share(total, total)} carry a \`${namespace}:\` label, and between them they used only` +
        ` ${listing(values)} — narrower than the values this board uses elsewhere.`,
      citedBeadIds: cite(approvals),
    });
  }

  rationale.push(blockerRationale());
  return { policy, basis: "history", approvals: total, rationale };
}

/** `a`, `a and b`, `a, b and c` — criteria are read as prose, not as a JSON array. */
function listing(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "nothing";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function hasNamespace(bead: Bead, namespace: string): boolean {
  return (bead.labels ?? []).some((l) => namespaceOf(l) === namespace && valueOf(l));
}

/** The values a set of beads uses under one namespace. */
function valuesUnder(beads: readonly Bead[], namespace: string): Set<string> {
  const values = new Set<string>();
  for (const bead of beads) {
    for (const label of bead.labels ?? []) {
      if (namespaceOf(label) !== namespace) continue;
      const value = valueOf(label);
      if (value) values.add(value);
    }
  }
  return values;
}

function labelCriteria(approvals: readonly Bead[], board: readonly Bead[]): PolicyLabelCriterion[] {
  const namespaces = new Set<string>();
  for (const bead of approvals) {
    for (const label of bead.labels ?? []) {
      const ns = namespaceOf(label);
      if (ns && !POLICY_CONTROL_NAMESPACES.has(ns) && valueOf(label)) namespaces.add(ns);
    }
  }

  const criteria: PolicyLabelCriterion[] = [];
  for (const namespace of [...namespaces].sort()) {
    if (!storable(namespace, SCHEMA_LIMITS.text.namespace)) continue;
    if (!approvals.every((b) => hasNamespace(b, namespace))) continue;
    const approved = valuesUnder(approvals, namespace);
    const onBoard = valuesUnder(board, namespace);
    if (approved.size >= onBoard.size) continue; // admits everything the board has — no signal
    // More approved values than one criterion may carry: the namespace cannot be stated without
    // excluding an approval, so it is not stated (see SCHEMA_LIMITS).
    if (approved.size > SCHEMA_LIMITS.criterionValues) continue;
    // Same for a value the store would not keep: dropping it would narrow the criterion past an
    // approval it was read from, so the whole namespace is omitted rather than stated short.
    const values = [...approved].sort();
    if (!values.every((v) => storable(v, SCHEMA_LIMITS.text.value))) continue;
    criteria.push({ namespace, values });
  }

  if (criteria.length <= SCHEMA_LIMITS.labelCriteria) return criteria;
  // Past the criterion ceiling, keep the most NARROWING namespaces — fewest admitted values. Dropping
  // a criterion only widens the draft, so the proposal still admits every approval behind it.
  const kept = new Set(
    [...criteria]
      .sort((a, b) => a.values.length - b.values.length || a.namespace.localeCompare(b.namespace))
      .slice(0, SCHEMA_LIMITS.labelCriteria)
      .map((c) => c.namespace),
  );
  return criteria.filter((c) => kept.has(c.namespace));
}

/**
 * The blocker criterion is asserted whatever the history says: every approval was startable when it
 * was granted, so the sample can only ever confirm it, and stating it keeps the draft a complete
 * description of what anton may take rather than a partial one an operator has to finish.
 */
function blockerRationale(): PolicyRationale {
  return {
    criterion: "blockers",
    summary: "A target with an unmet blocker is never started — this restates that guarantee.",
    citedBeadIds: [],
  };
}

/**
 * The thin-evidence draft. It still cites what little history there is: an operator seeing "we found
 * 2 approvals" understands why they are being handed anton's opinion instead of their own board's.
 */
function fallbackDraft(approvals: readonly Bead[]): PolicyDraft {
  const found = approvals.length;
  const because =
    `Only ${found} prior approval${found === 1 ? "" : "s"} on this board — too few to read a` +
    ` pattern from, so anton proposes its conservative default instead.`;
  return {
    policy: { ...FALLBACK_POLICY },
    basis: "fallback",
    approvals: found,
    rationale: [
      {
        criterion: "types",
        summary: `${because} Bugs and chores are the smallest, most reversible work on any board.`,
        citedBeadIds: cite(approvals),
      },
      {
        criterion: "priority",
        summary: "P2 and above — work nobody has marked as low priority.",
        citedBeadIds: [],
      },
      blockerRationale(),
    ],
  };
}
