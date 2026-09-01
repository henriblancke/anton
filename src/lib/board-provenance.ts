/**
 * WHO touched a bead, and why — assembled once for the whole board (anton-cqxd / R3.7).
 *
 * The board's writers are unattended by design: the picker admits targets under a standing policy,
 * and the product master proposes moves on them in a session nobody watches. An operator looking at
 * a card must never have to guess which of them acted, so every card carries the answer as data and
 * the badge only renders it (`components/board/provenance-badge.tsx`).
 *
 * Derived, never stored. Both answers already exist — the picker RECORDS its plan (a rule per
 * entry), and a proposal IS a bead naming the beads it concerns — so a provenance table would be a
 * third copy of facts the other two could contradict. This module is the join, and the join only.
 *
 * Pure: it reads a board snapshot, a recorded plan and the stored policy, and spawns nothing.
 */
import { beads, type Bead } from "./beads/bd";
import type { BoardPickerPlan } from "./board-picker-plan";
import {
  fingerprintLabelOf,
  kindOfFingerprint,
  namespaceOf,
  proposalPlanOf,
  type GardenerPlan,
} from "./gardener/detections";
import { admittingCriterion } from "./policy/admitting";
import { policyCandidates } from "./policy/candidates";
import { policyDigest } from "./policy/digest";
import type { Policy } from "./policy/types";
import type { BeadProvenance } from "./types";

export interface BoardProvenanceInput {
  /** The full board read, unfiltered — what the policy projection and the proposals are read from. */
  board: Bead[];
  /**
   * The picker's latest recorded plan, or undefined on a project whose picker has never run — and
   * on one whose pass the operator has switched off, which the caller resolves: the badge is what
   * `[Release]` is derived from (isPickerPick), so a plan left behind by a disabled schedule must
   * not go on offering starts against a pass that no longer runs.
   */
  plan?: BoardPickerPlan;
  /** The policy armed on this machine, or undefined when the project has armed none. */
  policy?: Policy;
  /**
   * The recorded plan no longer describes the decision anton would make now — the board or the armed
   * policy has moved since the pass ran ({@link isPlanStale}). The mark is still emitted, because it
   * is history and history does not expire; it is flagged {@link BeadProvenance.stale} so the LIVE
   * predicate beside it can tell the two apart (`isPickerPick` → `[Release]`).
   *
   * Defaults to "current": the only producer is the board build, which always answers explicitly.
   */
  planIsStale?: boolean;
}

/**
 * Every writer's mark on every bead it touched, bead id → badges in a stable order (policy before
 * pm), so two renders of one board never reorder a card's badges.
 */
export function boardProvenance(input: BoardProvenanceInput): Map<string, BeadProvenance[]> {
  const policyMarks = pickerProvenance(input);
  const pmMarks = proposalProvenance(input.board);

  const out = new Map<string, BeadProvenance[]>();
  for (const [beadId, mark] of policyMarks) out.set(beadId, [mark]);
  for (const [beadId, mark] of pmMarks) {
    const existing = out.get(beadId);
    if (existing) existing.push(mark);
    else out.set(beadId, [mark]);
  }
  return out;
}

/**
 * A freshness token over the provenance a board would serve, so a polling surface sees new badges
 * instead of 304ing on a version that never moved.
 *
 * The pm half needs no part: it rides on the proposal beads themselves, so the bead snapshot version
 * already covers it. The plan and the POLICY both do — the policy because it is half of the plan's
 * freshness fence (`stampBoard`), so saving a narrower one turns every live pick into history
 * without touching a bead or a plan row. A poll that 304'd on that would leave `[Release]` on offer
 * against a rule the operator has already replaced.
 */
export function provenanceVersion(plan?: BoardPickerPlan, policy?: Policy): string {
  return `${plan ? `${plan.generatedAt}:${plan.stamp.digest}` : "none"}:${policyDigest(policy)}`;
}

/**
 * The picker's mark: this target is in the plan, admitted under the standing policy.
 *
 * The badge opens the CRITERION that admitted it — resolved here, exactly as the `Never` veto
 * resolves it server-side ({@link admittingCriterion}), because the recorded `rule` names the policy
 * as a whole ("the work policy armed on this machine") and an operator cannot check a whole policy.
 * The rule string is kept as the tooltip's own words, so an unarmed project's structural rule still
 * says what admitted the bead even though there is no control to open.
 *
 * The plan is read as HISTORY, not as a live verdict: a stale plan still records the rule this
 * target was picked under, so the badge survives the board moving past it. But `[Release]` is
 * derived from this same mark (`isPickerPick`), and offering a start against a decision the board
 * or the policy has since invalidated would be a live claim dressed as a record — so the caller's
 * freshness verdict rides along as {@link BeadProvenance.stale}, which the badge ignores and the
 * button obeys.
 */
function pickerProvenance({
  board,
  plan,
  policy,
  planIsStale,
}: BoardProvenanceInput): Map<string, BeadProvenance> {
  const out = new Map<string, BeadProvenance>();
  if (!plan?.entries.length) return out;

  // Projected once for the whole plan rather than per entry: the projection walks the board.
  const candidates = policy
    ? new Map(policyCandidates(board).candidates.map((c) => [c.id, c]))
    : undefined;

  for (const entry of plan.entries) {
    const candidate = candidates?.get(entry.beadId);
    const criterion = candidate && policy ? admittingCriterion(candidate, policy) : undefined;
    out.set(entry.beadId, {
      kind: "policy",
      ...(criterion ? { ref: criterion } : {}),
      ...(entry.rule ? { detail: entry.rule } : {}),
      ...(planIsStale ? { stale: true } : {}),
    });
  }
  return out;
}

/**
 * The product master's mark: an unattended judgment pass asked for a move on this bead.
 *
 * Only the `pm` namespace earns a badge. The gardener files through the same machinery, but it
 * detects board SHAPE mechanically — a different writer, with no place in this grammar — and badging
 * it would put a mark on half the board.
 *
 * A DECLINED proposal (abandoned) is skipped: the operator said no, so nothing touched the bead and
 * a badge would keep advertising a claim the board already settled. An applied one is kept — that is
 * precisely the case where "who moved this?" needs an answer.
 */
function proposalProvenance(board: Bead[]): Map<string, BeadProvenance> {
  const newest = new Map<string, { bead: Bead; plan: GardenerPlan }>();

  for (const bead of board) {
    const label = fingerprintLabelOf(bead);
    if (!label) continue;
    const kind = kindOfFingerprint(label);
    if (!kind || namespaceOf(kind) !== "pm") continue;
    if (beads.isAbandoned(bead)) continue;
    const plan = proposalPlanOf(bead);
    if (!plan) continue;

    for (const subject of concerned(plan)) {
      if (subject === bead.id) continue;
      const held = newest.get(subject);
      if (!held || isNewer(bead, held.bead)) newest.set(subject, { bead, plan });
    }
  }

  const out = new Map<string, BeadProvenance>();
  for (const [subject, { bead, plan }] of newest) {
    out.set(subject, { kind: "pm", ref: bead.id, detail: plan.kind });
  }
  return out;
}

/** Every bead a proposal's move concerns — its subjects plus whatever it points at. */
function concerned(plan: GardenerPlan): string[] {
  return plan.target ? [...plan.subjects, plan.target] : plan.subjects;
}

/**
 * Which of two proposals about one bead is the current word. Newest first, and a missing stamp loses
 * rather than wins; the id breaks a tie so two proposals filed in the same second still order the
 * same way on every machine.
 */
function isNewer(candidate: Bead, held: Bead): boolean {
  const a = candidate.created_at ?? "";
  const b = held.created_at ?? "";
  return a === b ? candidate.id > held.id : a > b;
}
