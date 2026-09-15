/**
 * Mark-done — the one close route `agent:human` work has (anton-fgqr). Anton closes a bead when a
 * run finishes it, and a human target is poisoned before dispatch (execute-epic-human-gate.ts), so
 * without this the only way to settle one was the `bd close` CLI (PR #214). Distinct from
 * {@link abandonTicket}: this records a delivery — the work happened — not a won't-do.
 */
import { beads, isBlockedByOpenIssues, LABELS, type Bead } from "./beads/bd";
import { isPipelineArtifact } from "./beads/contract";
import { loadAllIssues } from "./beads/issues";
import { withBeadWriteLock } from "./beads/claim-lock";
import { openDescendants, runTargetOf } from "./abandon";
import { openBlockersOf } from "./jobs/execute-epic-human-gate";
import { cancelRunForTarget } from "./jobs/service";
import { nudgeSync } from "./beads/sync-nudge";
import { freshDetail } from "./ticket-detail";
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
 * The run target still holding `bead`, when that target is open, not deferred, and not itself
 * `agent:human` — i.e. a run that could still reach this ticket and arm a gate on it. `undefined`
 * for a run target itself (nothing holds it — it IS the work) and for a ticket whose target has
 * already settled or gone human (execute-epic poisons a human target before dispatching a single
 * child, so no gate is ever armed under it — no run is coming for this ticket either way).
 *
 * Mirrors `holdsRunOf` (ticket-detail.ts) / `operatorQueue`'s inline check (operator-queue.ts): the
 * same read that already withholds the UI's own Mark done control, applied here so a direct or
 * stale request can't reach a click the UI itself refuses to offer.
 */
function stillHeldByLiveRun(bead: Bead, board: Bead[]): Bead | undefined {
  if (beads.isRunTarget(bead, board)) return undefined;
  const target = board.find((b) => b.id === runTargetOf(bead, board));
  if (!target || target.status === "closed" || beads.isDeferred(target) || beads.isHumanWork(target)) {
    return undefined;
  }
  return target;
}

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
 * that has simply not reached this ticket yet ({@link stillHeldByLiveRun} — the same `holdsRun`
 * predicate operator-queue.ts and ticket-detail.ts derive, which is what keeps the UI's own Mark
 * done control from ever offering this click). Before a run's human-ticket preflight arms this
 * ticket's gate, it carries no `blocks` dependency at all, so `openBlockersOf` reads it as clear —
 * a direct or stale request in exactly that window would sail past the check above, cancel a
 * healthy run mid-flight, and close a ticket that run was going to settle itself.
 *
 * A run still executing this bead's OWN target is killed FIRST, before the close is written — the
 * same order abandon uses and for the same reason: if the bead was relabelled `agent:human` after
 * its agent had already started, closing it out from under that agent must not leave it free to
 * keep committing toward a PR the board just called done. Machine-local, like every job cancel
 * here: a run on another machine stops at its next lease/ticket boundary, where a closed ticket is
 * skipped the same way an abandoned one is.
 *
 * Throws on an unknown id (bd's own error → 404), a bead that isn't `agent:human` (→ 409 — an agent
 * run is expected to close it), an already-settled bead (→ 409), open work still under it (→ 409),
 * an open blocker already holding it (→ 409), or the close itself refusing on one that appeared in
 * the gap since (→ 409). Any OTHER failure from `bd close` — the executable missing, a timeout,
 * Dolt unhealthy — is not a verdict on the bead and is left to propagate as-is, so the caller's
 * infrastructure failure stays a retryable error rather than reading as permanently unclosable.
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
    // Pipeline plumbing (a poured `molecule` root, its `gate` children) is never user work — every
    // other work surface holds it out through isPipelineArtifact, and this guard must too: a molecule
    // hung under the feature stays open for as long as its run does, so counting it here would 409
    // this route for the run's own lifetime, before cancelRunForTarget below ever gets to stop it.
    const open = openDescendants(board, id).filter((b) => !isPipelineArtifact(b));
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
    const liveTarget = stillHeldByLiveRun(bead, board);
    if (liveTarget) {
      throw new NotCloseableError(
        `${id} still rides on ${liveTarget.id}'s run, which is open and could still reach it — ` +
          `closing it now would mean cancelling that run first. Wait for it to arm a human gate on ` +
          `${id} and resolve that (\`bd gate resolve\`) instead, or abandon ${liveTarget.id} first ` +
          `if the run itself should stop`,
      );
    }

    await cancelRunForTarget(project.id, runTargetOf(bead, board));

    try {
      await beads.close(repo, id);
    } catch (e) {
      if (!isBlockedByOpenIssues(e)) throw e;
      throw new NotCloseableError(`${id} could not be closed (${messageOf(e)})`);
    }
    return beads.show(repo, id);
  });
  // Read-after-write, like setTicketDeferred: the `bd show` bead is authoritative for the closed
  // state it just wrote, so the response never reflects the board's stale snapshot.
  const detail = await freshDetail(project, written);
  nudgeSync(project, "close-human");
  return detail;
}

/** A bead that is already closed has a settled outcome — closing it again would rewrite history. */
function assertOpen(bead: Bead, id: string): void {
  if (bead.status === "closed") {
    throw new NotCloseableError(
      beads.isAbandoned(bead) ? `${id} is already abandoned` : `${id} is already closed`,
    );
  }
}
