/**
 * Abandon — the won't-do outcome for a ticket or an epic (anton-6xj0). Distinct from delete (which
 * destroys the history the decision is made of) and from done (which means shipped): the bead is
 * closed with a reason and tagged `abandoned`, any run still executing it is killed, and nothing
 * about the exit reads as a delivery. See DESIGN.md §3 — beads owns status, anton.db gains no column.
 */
import { beads } from "./beads/bd";
import { nudgeSync } from "./beads/sync-nudge";
import { cancelRunForTarget } from "./jobs/service";
import { freshDetail } from "./ticket-detail";
import type { Bead } from "./beads/bd";
import { MAX_ABANDON_REASON_CHARS } from "./types";
import type { Project, TicketDetail } from "./types";

// Re-exported so server callers keep importing the cap from the module that enforces it; the
// declaration lives in types.ts because the client abandon form needs it too.
export { MAX_ABANDON_REASON_CHARS };

/** Thrown when the target exists but isn't in a state that can be abandoned (route → 409). */
export class NotAbandonableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAbandonableError";
  }
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("Abandon reason is required");
  if (trimmed.length > MAX_ABANDON_REASON_CHARS) {
    throw new Error(
      `Abandon reason is too long (${trimmed.length} > ${MAX_ABANDON_REASON_CHARS} characters)`,
    );
  }
  return trimmed;
}

/** A bead that is already closed has a settled outcome — re-labelling it would rewrite history. */
function assertOpen(bead: Bead, what: string): void {
  if (bead.status === "closed") {
    throw new NotAbandonableError(
      beads.isAbandoned(bead)
        ? `${what} is already abandoned`
        : `${what} is already closed — abandon applies to work that hasn't settled`,
    );
  }
}

/**
 * Abandon one ticket. The live run is killed FIRST (see cancelRunForTarget): a ticket is executed
 * as part of its parent epic's run — or, parentless, as its own epic-of-one — so the run target to
 * kill is the parent when there is one. Only then is the outcome recorded, so the agent is already
 * stopped when the board says the work won't be done. Killing the parent's run stops the WHOLE epic,
 * not just this ticket — there is no finer-grained kill, and a run that kept going would have to be
 * told mid-flight that one of its tickets vanished. The remaining tickets are picked up by running
 * the epic again, which now skips the abandoned one.
 *
 * Throws on an unknown id (bd's own error → 404), an empty/oversized reason (→ 400), or an
 * already-closed ticket (NotAbandonableError → 409).
 */
export async function abandonTicket(
  project: Project,
  id: string,
  reason: string,
): Promise<TicketDetail> {
  const why = requireReason(reason);
  const bead = await beads.show(project.repoPath, id); // 404 guard — bd throws on an unknown id
  assertOpen(bead, "Ticket");

  const runTarget = ((bead.parent ?? bead.parent_id) as string | undefined) ?? id;
  await cancelRunForTarget(project.id, runTarget);

  await beads.abandon(project.repoPath, id, why);
  // Read-after-write, like setTicketDeferred: the `bd show` bead is authoritative for the abandoned
  // state it just wrote, so the response never reflects the board's stale snapshot.
  const detail = await freshDetail(project, await beads.show(project.repoPath, id));
  nudgeSync(project, "abandon");
  return detail;
}

/** What an epic-level abandon settled: the epic plus every open child it cascaded to. */
export interface EpicAbandonResult {
  epicId: string;
  /** Ids abandoned by the cascade — the epic's open children, in board order. */
  children: string[];
}

/**
 * Abandon an epic and cascade to its still-open children. Cascade (not delete's `--cascade`, which
 * would erase them) is what keeps the epic's outcome coherent: leaving children open would strand
 * them in the ready queue with no epic to run them under. Children that already settled — closed,
 * shipped, or abandoned earlier — are left exactly as they are; their history is not rewritten.
 *
 * Throws on an unknown id (→ 404), an empty/oversized reason (→ 400), or an already-closed epic
 * (NotAbandonableError → 409).
 */
export async function abandonEpic(
  project: Project,
  epicId: string,
  reason: string,
): Promise<EpicAbandonResult> {
  const why = requireReason(reason);
  const repo = project.repoPath;
  const epic = await beads.show(repo, epicId); // 404 guard — bd throws on an unknown id
  assertOpen(epic, "Epic");

  await cancelRunForTarget(project.id, epicId);

  const all = await beads.list(repo, ["--status", "all"]);
  const open = all.filter(
    (b) => ((b.parent ?? b.parent_id) as string | undefined) === epicId && b.status !== "closed",
  );

  const children: string[] = [];
  for (const child of open) {
    await beads.abandon(repo, child.id, `${why} (parent epic ${epicId} abandoned)`);
    children.push(child.id);
  }
  // The epic closes LAST: a crash mid-cascade leaves it open with a partially-abandoned child set,
  // which re-running abandon finishes — the reverse order would leave orphaned open children under
  // an epic that already reads as settled.
  await beads.abandon(repo, epicId, why);
  nudgeSync(project, "abandon");
  return { epicId, children };
}
