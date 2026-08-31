/**
 * Proposal autonomy (anton-nbyy): the levels a pass may act at, the detection kinds grouped by how
 * a wrong move is undone, and the two floors that keep the control from ever offering a level the
 * pass would silently ignore.
 */

/**
 * How far a pass may go with a proposal it files, mirrored from PROPOSAL_AUTONOMY_LEVELS
 * (src/lib/gardener/autonomy.ts) — least autonomous first, which is the order the control offers
 * them in, so "further right is more autonomous" reads the same in the type and on screen.
 */
export const AUTONOMY_LEVELS = ["propose", "shadow", "apply"] as const;

export type ProposalAutonomy = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_LEVEL_HINT: Record<ProposalAutonomy, string> = {
  propose: "files it on the board and stops · you approve it",
  shadow: "also records what applying it would have done — and still writes nothing",
  apply: "writes the move to the board unattended · nobody is asked",
};

/**
 * One kind's settled-proposal record as the form receives it (anton-m29g) — plain counts and a
 * reason, computed on the server (gardener/autonomy.ts `earnedAutonomyOfKind`) because this module
 * never imports server code and the verdict is a fact about the board.
 *
 * The counts travel WITH the verdict on purpose. A control that is merely disabled is the failure
 * this floor exists to stop repeating: the evidence for the nine bad re-parents was printed every
 * time and read by nobody, so a locked `apply` has to say what it is locked on and what would
 * unlock it, in the row, at the moment the founder is deciding.
 */
export interface EarnedKind {
  applied: number;
  settled: number;
  eligible: boolean;
  /** Why apply is unavailable, with the counts and the bar. Absent exactly when eligible. */
  reason?: string;
}

/** A kind with no record at all — what an unreadable board, or a board with no proposals, yields. */
export const NO_RECORD: EarnedKind = { applied: 0, settled: 0, eligible: false };

/**
 * Why `apply` is locked, always sayable.
 *
 * `eligible` is the gate and `reason` only ever the label for it — the two are separate fields, so a
 * verdict that is ineligible with no reason ({@link NO_RECORD}, what an unreadable board yields) must
 * still read as locked. Deriving the lock from `reason` instead would leave that case naming no
 * reason AND offering the level: the one direction this floor may never fail in.
 */
export function lockedReason(earned: EarnedKind): string {
  return earned.reason ?? "no record could be read for this kind — apply stays locked";
}

/** One detection kind as the founder meets it: what its move does, and whether it can be armed. */
export interface AutonomyKindSpec {
  /** A GardenerDetectionKind (src/lib/gardener/detections.ts). */
  id: string;
  /** What approving it WRITES — the move in the founder's terms, not the detector's. */
  does: string;
  /**
   * Why this kind can never be armed at all. Set only where the move has no mechanical answer, and
   * it mirrors autonomyFor's hard floor: the control is pinned at `propose` rather than offering a
   * level the pass would silently ignore.
   */
  blocked?: string;
}

/**
 * Every detection kind grouped by REVERSIBILITY — the whole design of the control (anton-nbyy).
 *
 * A flat list makes arming `implied-order` and arming `shipped-orphan` look like the same decision,
 * and they are nothing alike: one adds an edge a single write removes, the other writes "this
 * shipped" into the board's history. Each group therefore states both halves — what the move does
 * and how a wrong one is taken back — so the founder who arms this never has to read the source to
 * know what a mistake costs. Ordered cheapest-mistake first.
 */
export const AUTONOMY_GROUPS: {
  id: string;
  title: string;
  /** What the moves in this group do to the board. */
  does: string;
  /** How a wrong one is undone — the property the grouping is actually by. */
  undo: string;
  /**
   * What ARMING this group at `apply` costs (anton-hzce). Stated per group rather than once at the
   * top, because the whole reason these boxes exist is that the cost is not the same in each: the
   * decision an operator is making when they arm a link is not the decision they make when they arm
   * a close, and a single blanket warning would flatten exactly that difference. Absent where there
   * is nothing to arm.
   */
  armed?: string;
  /** A per-PROPOSAL floor inside this group that no setting can lift. */
  floor?: string;
  kinds: AutonomyKindSpec[];
}[] = [
  {
    id: "reversible",
    title: "Undone by one write",
    does: "Moves a bead in the graph, or rewrites one field: a parent, a blocks edge, a priority.",
    undo: "One bd write puts it back, and nothing is recorded as having happened.",
    armed:
      "Armed, a pass re-shapes the graph overnight without asking. A wrong one costs you the one " +
      "write that puts it back — the cheapest group to arm first.",
    floor:
      "A re-parent filed without a target names no home — the ask is “which feature?”, and only " +
      "you can answer it. Those are never applied, whatever this says.",
    kinds: [
      {
        id: "container-orphan",
        does: "re-parents a bead hanging off a container epic under the feature that carries it",
      },
      {
        id: "parentless-cluster",
        does: "re-parents loose beads under the one card that is obviously their home",
      },
      { id: "implied-order", does: "adds the blocks edge two beads' bodies already state" },
      { id: "missing-order", does: "adds the blocks edge one top-tier bead needs on another" },
      { id: "mispriority", does: "rewrites one bead's priority to the one the evidence supports" },
      {
        id: "misfiled",
        does: "re-parents a bead whose home is the wrong one under the epic or card its contract belongs to",
      },
    ],
  },
  {
    id: "dequeued",
    title: "Takes work out of the queue",
    does: "The bead and its contract survive untouched; what changes is that nothing picks it up next.",
    undo: "bd undefer puts a deferred bead straight back. A withdrawn approval returns only when you approve it again.",
    armed:
      "Armed, work stops being picked up while you sleep. Nothing is lost, but a wrong one is a " +
      "week the bead sat still — and you only find it by reading the record.",
    kinds: [
      { id: "stale", does: "defers a bead untouched far past the threshold for its status" },
      { id: "low-value", does: "defers work the evidence no longer supports — the kill" },
      {
        id: "degraded-approval",
        does: "withdraws approved from work that has stopped clearing the approve gate",
      },
    ],
  },
  {
    id: "history",
    title: "Writes history",
    does: "Closes the bead — a close is a claim about what happened: shipped-orphan writes “this shipped”, superseded writes “that one replaced it” — or grants the approve gate on one, which records the decision a run starts from in your name.",
    undo: "Reopening a close is one write. Undoing a grant is two, in that order — withdraw the label, then release the reservation it took, because nothing will release a target the board still shows as approved — and a failure between them leaves the bead reserved with the gate already off. Either way the close or the grant stays in the board's history and in every report already taken from it.",
    armed:
      "Armed, a pass closes beads and grants approvals with nobody watching, and what it writes " +
      "outlives the undo. Arm this last, on a project whose shadow record you have actually read.",
    kinds: [
      { id: "superseded", does: "closes a bead as superseded, pointing at the twin that landed" },
      { id: "shipped-orphan", does: "closes a bead a commit already shipped" },
      {
        id: "withheld-approval",
        // The gate and the reservation are the whole write — nothing here enqueues a run
        // (anton-qlci), and a tier that promised one would promise spend that never happens.
        does: "grants the approve gate to work the board ranks next that nothing has approved, and reserves it for anton — the state a run starts from, not the run itself",
      },
    ],
  },
  {
    id: "manual",
    title: "Nothing to arm",
    does: "No mechanical move exists. The ask is filed with its evidence and waits on a judgment only you can make.",
    undo: "Nothing to undo: approving one is refused, and declining is what records your answer.",
    kinds: [
      {
        id: "oversized",
        does: "asks for a decomposition, and sketches one",
        blocked: "a split writes new contracts — /shape's work, and your call",
      },
    ],
  },
];

/** Every kind the control renders, in the order the groups declare them. */
export const AUTONOMY_KINDS = AUTONOMY_GROUPS.flatMap((g) => g.kinds);

/**
 * The stored overrides as a full per-kind policy — the same "never partial" shape
 * resolveProposalAutonomyPolicy produces on the server, so the form and the passes agree on what an
 * absent entry means.
 *
 * Both of autonomyFor's floors are re-applied here, because the one lie this control cannot tell is
 * showing a level the pass would ignore. An unreadable entry falls back to `propose`; a kind the
 * manual floor pins there ({@link AutonomyKindSpec.blocked}) is pinned here too; and a stored
 * `apply` on a kind whose record has not earned it reads back as `propose`, exactly as the pass
 * resolves it.
 */
export function resolveProposalAutonomy(
  stored: Record<string, string> | undefined,
  earned: Record<string, EarnedKind>,
): Record<string, ProposalAutonomy> {
  return Object.fromEntries(
    AUTONOMY_KINDS.map((kind) => {
      const value = stored?.[kind.id];
      const armable =
        !kind.blocked && (AUTONOMY_LEVELS as readonly string[]).includes(value ?? "");
      const level = armable ? (value as ProposalAutonomy) : "propose";
      const locked = level === "apply" && !(earned[kind.id] ?? NO_RECORD).eligible;
      return [kind.id, locked ? "propose" : level];
    }),
  );
}
