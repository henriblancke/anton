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
import {
  computeEpicGraph,
  epicStandaloneBlockers,
  isUnit,
  standaloneBlockers,
  type EpicGraphNode,
} from "./epic-graph";
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
  const unitNodes = new Map(graph.epics.map((node) => [node.id, node]));

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
      ...blockedGap(target, board, unitNodes),
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
  const why = notRunnableWhy(target, board);
  if (!why) return [];
  return [
    {
      rule: "runnable",
      message: `${target.id} → no longer a run target: ${why}`,
    },
  ];
}

/**
 * Why nothing can run this target, as the clause a refusal quotes — undefined when it IS one.
 *
 * Exported because the board-picker refuses on the same rule (jobs/picker-targets.ts) and has to
 * tell the operator the same thing: a second wording of "this is a container epic, approve one of
 * its features" would be a second answer to a question the board only has one answer to.
 */
export function notRunnableWhy(target: Bead, board: Bead[]): string | undefined {
  if (beads.isRunTarget(target, board)) return undefined;
  const parent = beads.parentOf(target);
  const type = target.issue_type ?? "unknown";
  if (beads.isContainer(target, board)) {
    return "it has feature children and is now a container epic — approve one of its features instead; each is its own run and its own PR";
  }
  if ((type === "task" || type === "bug") && parent) {
    return `it now sits under ${parent} and runs as one of that target's tickets, not on its own`;
  }
  return `type "${type}" is not runnable — only a feature, a parentless task/bug, or an epic with no feature children can be approved to run`;
}

/**
 * Whether a worker could still start this target, asked exactly as the approve route asks it
 * (route.ts). For a graph unit (epic/feature) that is the rollup's PER-CHILD verdict, not its
 * target-level blocker list: one cross-run-gated tail child leaves the rest of the run dispatchable,
 * so a `partially-blocked` target is approvable and running (issue #58). Judging it on the coarse
 * rollup here would file a `degraded-approval` on every such target each product-master pass, and
 * approving that proposal would strip the `approved` label off a run that was starting fine. Only
 * `blocked` — zero dispatchable tickets — is a gap. A standalone task/bug carries no node in the
 * graph and has no children to be partial about, so it stays gated on its own `blocks` edges.
 *
 * The blockers are still derived for the MESSAGE — the rollup plus the parentless prerequisites it
 * drops (`epicStandaloneBlockers`) — so a refusal names what the operator is waiting on.
 *
 * One gap, not one per blocker: "this cannot start yet" is a single fact about the target, and
 * splitting it would file the same ask once per edge.
 */
function blockedGap(
  target: Bead,
  board: Bead[],
  unitNodes: Map<string, EpicGraphNode>,
): ApprovalGap[] {
  const unit = isUnit(target) ? unitNodes.get(target.id) : undefined;
  const open = isUnit(target)
    ? [...(unit?.blockedBy ?? []), ...epicStandaloneBlockers(board, target.id)]
    : standaloneBlockers(board, target.id);
  // A unit absent from the graph (a board read that doesn't carry it) has no per-child verdict to
  // read, so it falls back to the coarse list rather than silently reading as runnable.
  const runnable = unit ? unit.childReadiness !== "blocked" : open.length === 0;
  if (runnable) return [];
  const why =
    open.length > 0
      ? `blocked by ${open.join(", ")} — approval is the run trigger, and a worker cannot start it until those land`
      : "blocked: every ticket it would run is held by an open blocker — approval is the run trigger, and there is nothing here a worker could pick up";
  return [{ rule: "blocked", message: `${target.id} → ${why}` }];
}
