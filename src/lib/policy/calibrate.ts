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

/**
 * anton's own bookkeeping namespaces, excluded from the discovered tier. `stage:` and `run-lease:`
 * describe where anton has already put a bead, not what an operator judged worth starting, and a
 * criterion over them would be the machine quoting itself back.
 */
const CONTROL_NAMESPACES = new Set(["stage", "run-lease", "review-score", "source"]);

/** How many approvals one rationale names. Enough to make the claim checkable, short enough to read. */
const MAX_CITED = 4;

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
    policy.types = [...new Set(approvedTypes)].sort();
    rationale.push({
      criterion: "types",
      summary: `${share(total, total)} were ${listing(policy.types)} — no other type has been approved here.`,
      citedBeadIds: cite(approvals),
    });
  }

  // Priority: the LEAST urgent priority ever approved, so the floor admits the whole sample. Omitted
  // when any approval carries no priority, for the same fail-closed reason as type.
  const priorities = approvals.map((b) => b.priority);
  if (priorities.every((p): p is number => typeof p === "number")) {
    const floor = Math.max(...priorities);
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
      if (ns && !CONTROL_NAMESPACES.has(ns) && valueOf(label)) namespaces.add(ns);
    }
  }

  const criteria: PolicyLabelCriterion[] = [];
  for (const namespace of [...namespaces].sort()) {
    if (!approvals.every((b) => hasNamespace(b, namespace))) continue;
    const approved = valuesUnder(approvals, namespace);
    const onBoard = valuesUnder(board, namespace);
    if (approved.size >= onBoard.size) continue; // admits everything the board has — no signal
    criteria.push({ namespace, values: [...approved].sort() });
  }
  return criteria;
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
