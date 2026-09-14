/**
 * What a send-back is allowed to touch: the run target named in the URL, the ticket of its run the
 * founder picked, and the refusal for each way that pair can be wrong — read off a board fresh enough
 * to decide against.
 */
import { beads, type Bead } from "./beads/bd";
import { refreshAllIssues } from "./beads/issues";
import { runIsLiveForTarget } from "./jobs/service";
import { ReworkConflictError, ReworkNotAllowedError, ReworkNotFoundError } from "./rework-contract";
import { runTickets } from "./ticket-view";
import type { Project } from "./types";

/** The board this send-back is decided against, and the two beads it is about. */
export interface ReworkScope {
  /** The full fresh board — the pipeline and the follow-up dedupe both ask it further questions. */
  all: Bead[];
  target: Bead;
  ticket: Bead;
}

/**
 * Resolve and vet the pair, before anything is written.
 *
 * The board is re-read rather than taken warm, like approve/claim: a mutating decision about what a
 * run CONTAINS must not be made from a snapshot that could still show a ticket the last run closed.
 * The live-run check comes last, once the pair is known to be a real one, so a founder acting on a
 * stale report is told what is wrong with their request before being told to wait for a run.
 */
export async function resolveReworkScope(
  project: Project,
  targetId: string,
  ticketId: string,
): Promise<ReworkScope> {
  const all = await refreshAllIssues(project.repoPath);
  const target = all.find((b) => b.id === targetId);
  if (!target) throw new ReworkNotFoundError(`Ticket ${targetId} not found on the board`);
  if (!beads.isRunTarget(target, all)) {
    throw new ReworkNotAllowedError(
      `${targetId} is not a run target — rework is decided against a run's review report, so send ` +
        `back a ticket of the feature (or standalone item) that actually ran`,
    );
  }
  const ticket = runMembers(target, all).find((b) => b.id === ticketId);
  if (!ticket) {
    throw new ReworkNotAllowedError(
      `${ticketId} is not part of ${targetId}'s run — only the work that run reviewed can be ` +
        `sent back from its report`,
    );
  }
  assertNoLiveRun(project.id, target);
  return { all, target, ticket };
}

/**
 * The beads a run target's review actually covers: its tickets, or the target itself when it is one
 * unit of work. The same pair epic-detail renders and execute-epic dispatches, so the founder can
 * send back exactly what the reviewer was shown — no more.
 */
export function runMembers(target: Bead, all: Bead[]): Bead[] {
  const children = runTickets(all, target.id);
  return beads.groupsChildren(target, children) ? children : [target];
}

/**
 * Refuse while a run holds this target — on this machine or, via the lease label, on any other.
 *
 * A boundary, not a lock, for the same reason `abandonTicket`'s is: a run STARTING in the window
 * between this read and the writes below is absorbed one layer down, where execute-epic re-reads the
 * board at every ticket boundary. What this catches is the case a re-read cannot — a founder acting
 * on a review report while the run that produced it is still writing the beads it names.
 *
 * Both machines are checked: the local job (what a cancel would reach) and the cross-machine
 * run-lease on the target (the only evidence another host is on it).
 */
export function assertNoLiveRun(projectId: string, target: Bead): void {
  if (runIsLiveForTarget(projectId, target.id)) {
    throw new ReworkConflictError(
      `${target.id} has a run in flight — sending its work back now would race the run that is ` +
        `writing it; wait for the run to finish or park it first`,
    );
  }
  if (beads.isRunLive(target, Date.now())) {
    throw new ReworkConflictError(
      `${target.id} is being run on another machine (it holds a live run-lease) — wait for that run ` +
        `to settle before sending its work back`,
    );
  }
}
