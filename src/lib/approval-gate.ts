/**
 * WHAT APPROVAL PROMISES, as one pure predicate (anton-xg5y).
 *
 * The approve route gates a target on four questions before it labels anything `approved`: is it a
 * run target at all, does the bead contract hold over the set the run will dispatch (anton-6u6y /
 * anton-j9zs), does the tier structure hold under it, and is anything still blocking it. Approval is
 * a MOMENT, though, and the board keeps moving after it: an Acceptance section can be edited away, a
 * feature can land under a legacy epic, a `blocks` edge can be drawn — all while the target sits
 * approved in the queue waiting for a worker.
 *
 * So the same four questions are asked again on the product-master cadence (pm/revalidate.ts), and
 * a third time when the resulting proposal is approved (gardener/apply.ts). This module is what they
 * share. It does NOT re-implement any of them: `beads.isRunTarget`, `contractGaps` over
 * `contractGatedBeads`, `structureGaps`, and the epic-graph blocker rollup are the very functions the
 * route calls, composed here in one place so a re-check can never hold a target to a different bar
 * than the gate did.
 *
 * PURE over a board snapshot — no bd spawn, no clock. That is what lets the re-check run over the
 * board read the pass already made rather than costing one `bd` per approved bead.
 *
 * The route deliberately keeps its own call sites: it answers each question with a different status
 * and body (422 not runnable, 422 contract, 422 structure, 409 blocked) and needs the advisory half
 * besides, which a merged list cannot express.
 */
import { beads } from "./beads/bd";
import { contractGaps, formatContractGaps } from "./beads/contract";
import { formatStructureViolations, structureGaps } from "./beads/structure";
import type { Bead } from "./beads/types";
import { computeEpicGraph, epicStandaloneBlockers, isUnit, standaloneBlockers } from "./epic-graph";
import { boardCards, contractGatedBeads, isRunTicket, type BoardCards } from "./ticket-view";

/** Which of approval's four promises a target has stopped keeping. */
export type ApprovalRule = "runnable" | "contract" | "structure" | "blocked";

export interface ApprovalGap {
  rule: ApprovalRule;
  /** One line, `<id> → what is wrong`, ready to stand as evidence on a proposal or in a refusal. */
  message: string;
}

/** The gate, bound to one board snapshot — see {@link makeApprovalGate}. */
export interface ApprovalGate {
  /** Every way this target no longer clears the approve gate, worst-scoped first. Empty ⇒ it does. */
  gapsFor(target: Bead): ApprovalGap[];
}

/**
 * Bind the gate to a board read. The card attribution and the epic dependency rollup are derived
 * ONCE here rather than per target: a pass re-checking every approved bead on the board would
 * otherwise rebuild both for each one, and the whole point of running this off the pass's existing
 * snapshot is that re-validation costs no reads at all.
 */
export function makeApprovalGate(board: Bead[]): ApprovalGate {
  const cards = boardCards(board);
  const tickets = ticketIndex(board, cards);
  const graph = computeEpicGraph(board);
  const unitBlockers = new Map(graph.epics.map((node) => [node.id, node.blockedBy]));

  return {
    gapsFor: (target) => [
      // Runnability first: it is the only gap that makes the other three moot — a bead nothing can
      // dispatch cannot fail its run's contract, because there is no run.
      ...runnableGap(target, board),
      // The contract, over the SAME set execute-epic and the approve route judge — the target plus
      // every ticket the run would actually dispatch, never the target alone. One gap per bead, each
      // naming its own id: across a ticket set, bare messages leave a reader no way to tell which
      // bead is the one missing its rubric.
      ...contractGaps(contractGatedBeads(target, tickets.get(target.id) ?? []), "blocking").map(
        (gap): ApprovalGap => ({ rule: "contract", message: formatContractGaps([gap]) }),
      ),
      // The tier taxonomy, scoped to this target's subtree exactly as the route scopes it: a stray
      // chore three branches away is not this target's fault and must not withdraw its approval.
      ...structureGaps(target.id, board).blocking.map(
        (violation): ApprovalGap => ({
          rule: "structure",
          message: formatStructureViolations([violation]),
        }),
      ),
      ...blockedGap(target, board, unitBlockers),
    ],
  };
}

/** One target's gaps against a board read, for a caller with no snapshot to reuse (apply.ts). */
export function approvalGaps(target: Bead, board: Bead[]): ApprovalGap[] {
  return makeApprovalGate(board).gapsFor(target);
}

/** Gaps as one line — a proposal's summary, or the note a withdrawn approval leaves on the bead. */
export function formatApprovalGaps(gaps: ApprovalGap[]): string {
  return gaps.map((gap) => gap.message).join("; ");
}

/**
 * The tickets each board card carries, in board order — `runTickets` for every target at once. It
 * re-derives `boardCards` on every call, so asking it per approved target would walk the board twice
 * per bead; this is the same filter (`isRunTicket` + nearest-card attribution) hoisted to one pass.
 */
function ticketIndex(board: Bead[], cards: BoardCards): Map<string, Bead[]> {
  const byCard = new Map<string, Bead[]>();
  for (const bead of board) {
    if (!isRunTicket(bead, cards)) continue;
    const card = cards.cardOf(bead);
    if (!card) continue;
    const carried = byCard.get(card);
    if (carried) carried.push(bead);
    else byCard.set(card, [bead]);
  }
  return byCard;
}

/**
 * Why nothing can RUN this target any more — the approve route's first question (route.ts), asked
 * again because it is the degradation that hides best: the other three leave a claimable bead with a
 * broken spec, while this one leaves a bead the claimable set silently skips (`isClaimable`) and a
 * dispatch poison-parks (execute-epic). Approval is the run trigger, so an approval on a bead nothing
 * can dispatch is a promise the board has quietly stopped being able to keep.
 *
 * The usual way in is a legacy epic that gained a feature child and became a container — approved as
 * one unit of work, now a home for several. A re-parented task/bug is the other: it runs as one of
 * its new parent's tickets, so its own approval stops meaning anything.
 */
function runnableGap(target: Bead, board: Bead[]): ApprovalGap[] {
  if (beads.isRunTarget(target, board)) return [];
  const parent = beads.parentOf(target);
  const type = target.issue_type ?? "unknown";
  let why: string;
  if (beads.isContainer(target, board)) {
    why =
      "it has feature children and is now a container epic — approve one of its features instead; each is its own run and its own PR";
  } else if ((type === "task" || type === "bug") && parent) {
    why = `it now sits under ${parent} and runs as one of that target's tickets, not on its own`;
  } else {
    why = `type "${type}" is not runnable — only a feature, a parentless task/bug, or an epic with no feature children can be approved to run`;
  }
  return [
    {
      rule: "runnable",
      message: `${target.id} → no longer a run target: ${why}`,
    },
  ];
}

/**
 * The target's open blockers, derived the way the approve route derives them: for a graph unit
 * (epic/feature) the epic-graph rollup PLUS the parentless prerequisites that rollup drops
 * (`epicStandaloneBlockers`); for a standalone task/bug — which carries no node in the graph at all —
 * its own `blocks` edges.
 *
 * One gap, not one per blocker: "this cannot start yet" is a single fact about the target, and
 * splitting it would file the same ask once per edge.
 */
function blockedGap(
  target: Bead,
  board: Bead[],
  unitBlockers: Map<string, string[]>,
): ApprovalGap[] {
  const open = isUnit(target)
    ? [...(unitBlockers.get(target.id) ?? []), ...epicStandaloneBlockers(board, target.id)]
    : standaloneBlockers(board, target.id);
  if (open.length === 0) return [];
  return [
    {
      rule: "blocked",
      message: `${target.id} → blocked by ${open.join(", ")} — approval is the run trigger, and a worker cannot start it until those land`,
    },
  ];
}
