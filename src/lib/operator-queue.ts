/**
 * The operator's own queue: approved work anton will never dispatch (anton-qfso.1).
 *
 * `agent:human` names the one specialist anton does not have, so a bead carrying it is excluded from
 * the claimable set (beads.isClaimable) and refused at every point a bead turns into a dispatch
 * (anton-mv70). That exclusion is correct and it is also a hole: the work stops being agent work
 * without becoming anyone's work — it just stops appearing in the queue anton reads. This is where
 * it lands instead.
 *
 * Pure over a board snapshot the caller already holds, so it costs no bd spawn of its own: board.ts
 * hands it the same `workBeads` list the cards are built from.
 */
import { beads, type Bead } from "./beads/bd";
import { isPipelineArtifact } from "./beads/contract";
import { boardCards, deriveStage, isRunTicket, labelValue, parseGoal } from "./ticket-view";
import type { OperatorQueueItem } from "./types";

/**
 * Still someone's to do. Broader than the claimable set's `status === "open"`, and deliberately: a
 * human bead moves to `in_progress` the moment the person doing it claims it, and dropping it from
 * their queue exactly then would hide the work while it is being done. Only two answers take a bead
 * off this list — closed (it happened) and deferred (a person snoozed it themselves).
 */
function isOpenWork(bead: Bead): boolean {
  return bead.status !== "closed" && !beads.isDeferred(bead);
}

/**
 * Newest ask first. `createdAt` is when the bead — the ask — was filed, so the newest is the one the
 * operator is least likely to have already seen; the older asks keep their place below it rather
 * than being reshuffled by anything else. Id breaks the tie so two renders of an unchanged board are
 * identical, and a bead whose read carried no timestamp sorts last instead of pretending to be new.
 */
function byNewestAsk(a: OperatorQueueItem, b: OperatorQueueItem): number {
  if (a.createdAt !== b.createdAt) {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return a.createdAt > b.createdAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * The approved, open, human beads on this board, newest ask first.
 *
 * Two shapes qualify, and the row says which because they cost the operator different things:
 *   • a RUN TARGET labelled `agent:human` — anton refuses to run it at all, so nothing happens until
 *     a person does it;
 *   • a TICKET inside an ordinary run — the run reaches it, arms a human gate, and holds that ticket
 *     (and whatever depends on it) until the person answers.
 *
 * Approval is read off whichever bead carries the human gate for this work: a ticket has no
 * `approved` label of its own — its run target's approval is what puts it in front of an agent — so
 * a ticket under an unapproved (or closed, or abandoned) target is not queued for anyone yet. Every
 * other bead answers for itself.
 *
 * Container epics and pipeline plumbing are not work and never appear: a container's features each
 * run on their own, and a molecule/gate coordinates work without being any.
 */
export function operatorQueue(all: Bead[]): OperatorQueueItem[] {
  const work = all.filter((bead) => !isPipelineArtifact(bead));
  const cards = boardCards(work);
  const byId = new Map(work.map((bead) => [bead.id, bead]));

  const items: OperatorQueueItem[] = [];
  for (const bead of work) {
    if (!beads.isHumanWork(bead) || !isOpenWork(bead)) continue;

    // A run target answers for its own approval; anything else is a ticket riding on one.
    const isTarget = beads.isRunTarget(bead, work);
    if (!isTarget && !isRunTicket(bead, cards)) continue;
    const target = isTarget ? undefined : byId.get(cards.cardOf(bead) ?? "");
    const gate = target ?? bead;
    if (!beads.isApproved(gate) || !isOpenWork(gate)) continue;

    const goal = parseGoal(bead);
    const risk = labelValue(bead.labels, "risk");
    const size = labelValue(bead.labels, "size");
    items.push({
      id: bead.id,
      title: bead.title,
      stage: deriveStage(bead),
      createdAt: bead.created_at ?? "",
      ...(goal ? { goal } : {}),
      ...(risk ? { risk } : {}),
      ...(size ? { size } : {}),
      ...(target ? { runTarget: { id: target.id, title: target.title } } : {}),
    });
  }

  return items.sort(byNewestAsk);
}
