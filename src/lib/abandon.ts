/**
 * Abandon — the won't-do outcome for a ticket or an epic (anton-6xj0). Distinct from delete (which
 * destroys the history the decision is made of) and from done (which means shipped): the bead is
 * closed with a reason and tagged `abandoned`, any run still executing it is killed, and nothing
 * about the exit reads as a delivery. See DESIGN.md §3 — beads owns status, anton.db gains no column.
 */
import { beads } from "./beads/bd";
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

/** Push the abandon to teammates without blocking the response — the heartbeat backstop retries. */
function nudgeSync(project: Project, id: string): void {
  void beads
    .sync(project.repoPath)
    .catch((e) => console.error(`[abandon] beads dolt sync failed after abandoning ${id}`, e));
}

/**
 * The run this bead's work executes under: the bead ITSELF when it is a run target (a feature, or a
 * parentless task/bug run as an epic-of-one), otherwise its nearest run-target ANCESTOR — a child
 * ticket runs as part of its target's run. Reading the parent for a bead that owns a run would kill
 * the wrong thing: abandoning a feature would cancel its product epic (which never runs) and leave
 * the feature's own agent executing on toward a PR the board already calls won't-do.
 *
 * The walk goes the whole way up, like openDescendants goes the whole way down: runs are keyed by
 * run target, so for a subtask (feature → task → subtask) a single hop cancelled the intermediate
 * task — an id no job is keyed by — and the feature's agent ran on through the abandoned ticket.
 * Guards against a malformed parent cycle; falls back to the immediate parent when the chain reaches
 * no run target at all (a cancel that matches no job, rather than a wrong one).
 */
function runTargetOf(bead: Bead, board: Bead[]): string {
  if (beads.isRunTarget(bead, board)) return bead.id;
  const byId = new Map(board.map((b) => [b.id, b]));
  const seen = new Set<string>([bead.id]);
  let parentId = beads.parentOf(bead);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (beads.isRunTarget(parent, board)) return parent.id;
    parentId = beads.parentOf(parent);
  }
  return beads.parentOf(bead) ?? bead.id;
}

/**
 * Abandon every still-open descendant of `target`, killing the run of each descendant that owns one
 * before recording anything. Shared by the ticket and epic paths: a bead that groups other work must
 * take that work with it however the abandon was reached, or the descendants sit in `bd ready` as
 * claimable tickets whose run target is already settled — no run path left to reach them. Settled
 * descendants are left exactly as they are; their history is not rewritten. Returns the ids it
 * abandoned, in cascade order.
 */
async function cascadeToDescendants(
  project: Project,
  target: Bead,
  board: Bead[],
  why: string,
): Promise<string[]> {
  const descendants = openDescendants(board, target.id);

  for (const descendant of descendants) {
    if (beads.isRunTarget(descendant, board)) {
      await cancelRunForTarget(project.id, descendant.id);
    }
  }

  const children: string[] = [];
  for (const descendant of descendants) {
    await beads.abandon(
      project.repoPath,
      descendant.id,
      `${why} (parent ${target.issue_type ?? "ticket"} ${target.id} abandoned)`,
    );
    children.push(descendant.id);
  }
  return children;
}

/**
 * Abandon one ticket, cascading to everything still open beneath it. The live runs are killed FIRST
 * (see cancelRunForTarget) — this bead's own, against the run target its work actually executes
 * under (runTargetOf), plus each descendant that owns one. Only then is the outcome recorded, so no
 * agent is still driving toward a PR for work the board now calls won't-do. For a child ticket that
 * kill stops the WHOLE run, not just this ticket — there is no finer-grained kill, and a run that
 * kept going would have to be told mid-flight that one of its tickets vanished. The remaining
 * tickets are picked up by running the target again, which now skips the abandoned one.
 *
 * The cascade matters most for a feature reached through this path (a direct API call — the UI
 * deep-links features to the epic route): abandoning it alone would strand its tasks open under a
 * settled run target. A leaf ticket has no descendants, so it costs one board read and nothing else.
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

  const board = await beads.list(project.repoPath, ["--status", "all"]);
  await cancelRunForTarget(project.id, runTargetOf(bead, board));
  await cascadeToDescendants(project, bead, board, why);

  // The ticket closes LAST, like the epic cascade: a crash mid-cascade leaves it open with a
  // partially-abandoned child set that re-running abandon finishes.
  await beads.abandon(project.repoPath, id, why);
  // Read-after-write, like setTicketDeferred: the `bd show` bead is authoritative for the abandoned
  // state it just wrote, so the response never reflects the board's stale snapshot.
  const detail = await freshDetail(project, await beads.show(project.repoPath, id));
  nudgeSync(project, id);
  return detail;
}

/** What an epic-level abandon settled: the epic plus every open descendant it cascaded to. */
export interface EpicAbandonResult {
  epicId: string;
  /** Ids abandoned by the cascade — the epic's open descendants, depth-first in board order. */
  children: string[];
}

/**
 * Every still-open descendant of the epic, depth-first in board order (like buildTicketRows). The
 * walk goes the WHOLE way down, not one level: under the three-tier shape (epic → feature → task) a
 * ticket's parent is its feature, so a direct-children cascade would abandon the feature and strand
 * its tickets open in the ready queue with no run path left to reach them. Settled beads are
 * descended THROUGH but never collected — their own history stays as it is, while an open ticket
 * beneath one is still orphaned by the epic's exit and belongs in the cascade.
 *
 * Pure over a bead list, so the cascade costs one bd read and is testable from a fixture board.
 */
export function openDescendants(board: Bead[], epicId: string): Bead[] {
  const childrenByParent = new Map<string, Bead[]>();
  for (const bead of board) {
    const parent = beads.parentOf(bead);
    if (!parent) continue;
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(bead);
    else childrenByParent.set(parent, [bead]);
  }

  const open: Bead[] = [];
  const seen = new Set<string>([epicId]); // also the cycle guard on a malformed parent chain
  const stack = [...(childrenByParent.get(epicId) ?? [])].reverse();
  while (stack.length > 0) {
    const bead = stack.pop()!;
    if (seen.has(bead.id)) continue;
    seen.add(bead.id);
    if (bead.status !== "closed") open.push(bead);
    const children = childrenByParent.get(bead.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return open;
}

/**
 * Abandon an epic and cascade to its still-open descendants (the whole subtree — see
 * openDescendants). Cascade (not delete's `--cascade`, which would erase them) is what keeps the
 * epic's outcome coherent: leaving them open would strand them in the ready queue with no epic to
 * run them under. Beads that already settled — closed, shipped, or abandoned earlier — are left
 * exactly as they are; their history is not rewritten.
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

  const all = await beads.list(repo, ["--status", "all"]);

  // Kill every live run this abandon settles, BEFORE recording it. A container epic never runs
  // itself — the active job is keyed by the FEATURE below it, which cascadeToDescendants cancels —
  // so cancelling only `epicId` would mark the feature and its tickets abandoned while its agent
  // kept running from the bead snapshot it loaded at start, and still committed and opened a PR for
  // work the board now calls won't-do. The epic's own id is cancelled too: a legacy (non-container)
  // epic is its own run target.
  await cancelRunForTarget(project.id, epicId);
  const children = await cascadeToDescendants(project, epic, all, why);

  // The epic closes LAST: a crash mid-cascade leaves it open with a partially-abandoned child set,
  // which re-running abandon finishes — the reverse order would leave orphaned open children under
  // an epic that already reads as settled.
  await beads.abandon(repo, epicId, why);
  nudgeSync(project, epicId);
  return { epicId, children };
}
