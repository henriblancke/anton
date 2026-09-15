/**
 * Mark-done — the one close route `agent:human` work has (anton-fgqr). Anton closes a bead when a
 * run finishes it, and a human target is poisoned before dispatch (execute-epic-human-gate.ts), so
 * without this the only way to settle one was the `bd close` CLI (PR #214). Distinct from
 * {@link abandonTicket}: this records a delivery — the work happened — not a won't-do.
 */
import { beads, LABELS, type Bead } from "./beads/bd";
import { withBeadWriteLock } from "./beads/claim-lock";
import { openDescendants } from "./abandon";
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
 * Close a human bead as done. No cascade: an `agent:human` run target with open work still under it
 * is refused rather than closed out from under that work (the open question PR review left standing
 * — closing what is still open would either orphan it or silently claim it as done, and neither is
 * honest). Close the descendants first, or abandon them.
 *
 * Throws on an unknown id (bd's own error → 404), a bead that isn't `agent:human` (→ 409 — an agent
 * run is expected to close it), an already-settled bead (→ 409), open work still under it (→ 409),
 * or a bead `bd close` itself refuses — e.g. one an open human gate still blocks (→ 409).
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

    const board = await beads.list(repo, ["--status", "all"]);
    const open = openDescendants(board, id);
    if (open.length > 0) {
      throw new NotCloseableError(
        `${id} still has open work under it (${open.map((b) => b.id).join(", ")}) — close or ` +
          `abandon those first`,
      );
    }

    try {
      await beads.close(repo, id);
    } catch (e) {
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
