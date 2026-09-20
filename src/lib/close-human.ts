/**
 * Mark-done — the one close route `agent:human` work has (anton-fgqr). Anton closes a bead when a
 * run finishes it, and a human target is poisoned before dispatch (execute-epic-human-gate.ts), so
 * without this the only way to settle one was the `bd close` CLI (PR #214). Distinct from
 * {@link abandonTicket}: this records a delivery — the work happened — not a won't-do.
 */
import { beads, isBlockedByOpenIssues, LABELS, type Bead } from "./beads/bd";
import { loadAllIssues } from "./beads/issues";
import { withBeadWriteLock } from "./beads/claim-lock";
import { runTargetOf } from "./abandon";
import { openBlockersOf } from "./jobs/execute-epic-human-gate";
import { cancelRunForTarget, runIsLiveForTarget } from "./jobs/service";
import { nudgeSync } from "./beads/sync-nudge";
import { runMembers } from "./rework-target";
import { bareDetail, freshDetail } from "./ticket-detail";
import { liveRunTargetOf, openWorkUnder } from "./ticket-view";
import type { Project, TicketDetail } from "./types";

/** Thrown when the target exists but isn't in a state this action can settle (route → 409). */
export class NotCloseableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotCloseableError";
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Close a human bead as done. No cascade: an `agent:human` run target with open work still under it
 * is refused rather than closed out from under that work (the open question PR review left standing
 * — closing what is still open would either orphan it or silently claim it as done, and neither is
 * honest). Close the descendants first, or abandon them.
 *
 * Refused up front, before anything is killed, when an open blocker already holds the bead ({@link
 * openBlockersOf} — the same read `bd close` itself would answer with "blocked by open issues"):
 * a direct or stale request can target an `agent:human` CHILD ticket that is being held by a gate
 * an active, otherwise-ordinary run armed on it (execute-epic-human-gate.ts's
 * `armHumanTicketGates`). `runTargetOf` for that child resolves to the PARENT the run is actually
 * executing, so without this check the call below would cancel that run — killing healthy,
 * unrelated work — and only then discover `bd close` was always going to refuse. Resolve the gate
 * (`bd gate resolve`) instead; the run's own preflight closes the ticket once it does.
 *
 * Refused for the same reason, one step EARLIER, when the child's run target still HOLDS a run
 * that has simply not reached this ticket yet ({@link liveRunTargetOf} in ticket-view.ts — the one
 * `holdsRun` predicate this route, operator-queue.ts, and ticket-detail.ts all derive from, which is
 * what keeps the UI's own Mark done control from ever offering this click). Before a run's
 * human-ticket preflight arms this ticket's gate, it carries no `blocks` dependency at all, so
 * `openBlockersOf` reads it as clear — a direct or stale request in exactly that window would sail
 * past the check above, cancel a healthy run mid-flight, and close a ticket that run was going to
 * settle itself.
 *
 * A run still executing this bead's OWN target is killed FIRST, before the close is written — the
 * same order abandon uses and for the same reason: if the bead was relabelled `agent:human` after
 * its agent had already started, closing it out from under that agent must not leave it free to
 * keep committing toward a PR the board just called done. Machine-local, like every job cancel
 * here: a run on another machine stops at its next lease/ticket boundary, where a closed ticket is
 * skipped the same way an abandoned one is.
 *
 * Only when the resolved target actually OWNS the bead's run is it cancelled. `runTargetOf` walks
 * the WHOLE parent chain to the nearest run-target ancestor with no stop at pipeline plumbing and
 * no notion of which children a run actually dispatches, so an `agent:human` bead poured under a
 * molecule resolves to the enclosing feature even though that feature's ordinary run never
 * dispatches a gated step, and a child under a standalone task/bug resolves to that parent even
 * though its run executes only the parent itself. {@link runMembers} (rework-target.ts) is the set
 * a run actually contains — `runTickets`/`cardOf`, which stops at pipeline plumbing, collapsed to
 * the target alone on a standalone run — so membership in it is what gates the cancel; cancelling
 * on a bare `runTargetOf` read would kill a healthy, unrelated run for a ticket it was never going
 * to touch. Exempted: `runTargetOf`'s OWN fallback for "no run target anywhere in the ancestry" (a
 * task on a container epic) resolves to a non-run-target parent that owns no run either way — a
 * harmless no-op cancel, left unconditional rather than run through a membership check that assumes
 * a real target.
 *
 * Throws on an unknown id (bd's own error → 404), a bead that isn't `agent:human` (→ 409 — an agent
 * run is expected to close it), an already-settled bead (→ 409), open work still under it (→ 409),
 * an open blocker already holding it (→ 409), or the close itself refusing on one that appeared in
 * the gap since (→ 409). Any OTHER failure from `bd close` — the executable missing, a timeout,
 * Dolt unhealthy — is not a verdict on the bead and is left to propagate as-is, so the caller's
 * infrastructure failure stays a retryable error rather than reading as permanently unclosable.
 *
 * Once `bd close` itself has succeeded, nothing after it may turn the outcome into a failure: sync
 * is nudged immediately off the write, and a failure hydrating the response detail (a cold board
 * snapshot hitting a transient bd/Dolt error) degrades to {@link bareDetail} rather than reporting
 * an already-committed close as a 500 — which would also skip the nudge above and leave a retry
 * facing 409 on a bead the close already settled (PR #288 review).
 */
export async function closeHumanTicket(project: Project, id: string): Promise<TicketDetail> {
  const repo = project.repoPath;
  const written = await withBeadWriteLock(repo, id, async () => {
    const bead = await beads.show(repo, id); // 404 guard — bd throws on an unknown id
    if (!beads.isHumanWork(bead)) {
      throw new NotCloseableError(
        `${id} isn't labelled ${LABELS.agentHuman} — a run is expected to close it, not this action`,
      );
    }
    assertOpen(bead, id);

    // Through loadAllIssues, never a bare `bd list --status all` (PR #238 review pattern, also
    // execute-epic-persist.ts / execute-epic-human-gate.ts): bd omits gate beads from an ordinary
    // listing while still carrying the `blocks` edge they put on the bead they gate, so a raw list
    // makes openBlockersOf read a RESOLVED gate as an open blocker forever — 409ing this route
    // permanently even after `bd gate resolve`. strictGates: a stale gate read must fail this write
    // rather than silently degrade to that same false-open reading.
    const board = await loadAllIssues(repo, { strictGates: true });
    // Pipeline plumbing (a poured `molecule` root, its `gate` children, and every step poured under
    // them) is never user work — {@link openWorkUnder} prunes those whole subtrees, and this guard
    // must too: a molecule hung under the feature stays open for as long as its run does, so counting
    // it (or its steps) here would 409 this route for the run's own lifetime, before cancelRunForTarget
    // below ever gets to stop it.
    const open = openWorkUnder(bead, board);
    if (open.length > 0) {
      throw new NotCloseableError(
        `${id} still has open work under it (${open.map((b) => b.id).join(", ")}) — close or ` +
          `abandon those first`,
      );
    }

    // Reject BEFORE cancelling anything: an open blocker is exactly what makes `bd close` refuse
    // below, so cancelling this bead's run target first would kill it for a close that was never
    // going to land — and for a child ticket that target is an ordinary run's, not this bead's own.
    const blockers = openBlockersOf(board, id);
    if (blockers.length > 0) {
      throw new NotCloseableError(
        `${id} is still held by an open blocker (${blockers.join(", ")}) — \`bd close\` would ` +
          `refuse it; resolve the blocker (\`bd gate resolve\` for a human gate) instead, which ` +
          `closes the ticket through its run rather than out from under it`,
      );
    }

    // Reject BEFORE cancelling anything, same as the blockers check above: a target that could
    // still reach this ticket has no `blocks` dependency to catch here until its own preflight
    // arms one, and cancelling it now would kill a healthy, unrelated run for a ticket it was
    // going to settle itself.
    const liveTarget = liveRunTargetOf(bead, board);
    if (liveTarget) {
      throw new NotCloseableError(
        `${id} still rides on ${liveTarget.id}'s run, which is open and could still reach it — ` +
          `closing it now would mean cancelling that run first. Wait for it to arm a human gate on ` +
          `${id} and resolve that (\`bd gate resolve\`) instead, or abandon ${liveTarget.id} first ` +
          `if the run itself should stop`,
      );
    }

    const targetId = runTargetOf(bead, board);
    const target = board.find((b) => b.id === targetId);

    // liveRunTargetOf excludes a DEFERRED target from the guard above on the premise a human
    // already snoozed it out of the way — but setTicketDeferred (ticket-detail.ts) only calls
    // `beads.defer`; it never touches a job that had already started. A target deferred mid-run is
    // still executing here, so without this check the route would fall through the guard above and
    // treat that live job's cancel below as a routine side effect of closing an unrelated child,
    // instead of refusing the way it does for every other still-reachable run (PR #288 review).
    if (target && beads.isDeferred(target) && runIsLiveForTarget(project.id, targetId)) {
      throw new NotCloseableError(
        `${id} still rides on ${targetId}'s run, which is deferred but still executing — deferring ` +
          `a target doesn't stop a job already in flight. Wait for it to finish or abandon ${targetId} ` +
          `first`,
      );
    }

    const isRealTarget = !!target && beads.isRunTarget(target, board);
    const ownedByTarget =
      bead.id === targetId || !isRealTarget || runMembers(target!, board).some((b) => b.id === bead.id);
    if (ownedByTarget) {
      await cancelRunForTarget(project.id, targetId);
    }

    try {
      await beads.close(repo, id);
    } catch (e) {
      if (!isBlockedByOpenIssues(e)) throw e;
      throw new NotCloseableError(`${id} could not be closed (${messageOf(e)})`);
    }
    // Best-effort, like the detail hydration below: `bd close` has already committed, so a
    // transient failure reading it back must not turn a landed close into a thrown error — that
    // would skip nudgeSync and the fallback detail entirely, and a retry would then find the bead
    // already closed and 409 forever (PR #288 review).
    try {
      return await beads.show(repo, id);
    } catch (e) {
      console.error(`[close-human] ${id} closed, but failed to re-read it`, e);
      return { ...bead, status: "closed" };
    }
  });
  // The close already landed inside the lock; schedule sync propagation now, before anything below
  // (which reads the board, not bd) gets a chance to fail and swallow it.
  nudgeSync(project, "close-human");
  // Read-after-write, like setTicketDeferred: the `bd show` bead is authoritative for the closed
  // state it just wrote, so the response never reflects the board's stale snapshot. Best-effort: the
  // close has already committed above, so a failure here degrades to bareDetail instead of failing
  // the whole response.
  try {
    return await freshDetail(project, written);
  } catch (e) {
    console.error(`[close-human] ${id} closed, but failed to hydrate its fresh detail`, e);
    return bareDetail(project, written);
  }
}

/** A bead that is already closed has a settled outcome — closing it again would rewrite history. */
function assertOpen(bead: Bead, id: string): void {
  if (bead.status === "closed") {
    throw new NotCloseableError(
      beads.isAbandoned(bead) ? `${id} is already abandoned` : `${id} is already closed`,
    );
  }
}
