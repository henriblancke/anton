/**
 * Abandon — the won't-do outcome for a ticket or an epic (anton-6xj0). Distinct from delete (which
 * destroys the history the decision is made of) and from done (which means shipped): the bead is
 * closed with a reason and tagged `abandoned`, any run still executing it is killed, and nothing
 * about the exit reads as a delivery. See DESIGN.md §3 — beads owns status, anton.db gains no column.
 */
import { beads } from "./beads/bd";
import { withBeadWriteLock } from "./beads/claim-lock";
import { nudgeSync } from "./beads/sync-nudge";
import { declineNote } from "./gardener/apply";
import { cancelRunForTarget, runIsLiveForTarget } from "./jobs/service";
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

/**
 * Thrown when an abandon that was decided against STOPPED work (`requireStopped`) finds a live run at
 * the instant it would have killed it. A `NotAbandonableError` so every route already mapping that to
 * 409 keeps working, and its own class so the escalation path can tell this apart from a bead that
 * was merely already closed.
 */
export class RunRestartedError extends NotAbandonableError {
  constructor(targetId: string) {
    super(`${targetId} is executing again — this abandon applies to work that had stopped`);
    this.name = "RunRestartedError";
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
 * Stop the run executing `targetId` — or, when the abandon was decided against work that had already
 * STOPPED, refuse at the instant the kill would land. The liveness read and the destructive act share
 * one boundary here, which is the only precondition that can tie the cancel to the stopped work it was
 * decided against: a caller's earlier snapshot goes stale across every await between it and this line
 * (a bd pull, an escalation settle), and by then the cancel has no way to tell a run that never
 * stopped from one an operator restarted in the meantime.
 *
 * Refusing before any write, rather than skipping the cancel, is deliberate: closing the bead while
 * its agent keeps running is the same wrong answer one step later.
 *
 * The check is a boundary, not a lock, and deliberately so: a resume landing between it and the last
 * bd write is caught one layer down instead. execute-epic re-reads the board when it dispatches and
 * returns cleanly on an abandoned target, and filters abandoned tickets out of every run — the same
 * defense that already absorbs the identical window for a run on ANOTHER machine, which no local
 * reservation could ever close (jobs are machine-local). A lock here would narrow one half of that
 * window at the cost of a global mutable reservation on the resume path, whose own failure mode —
 * a leaked entry that blocks every future resume of the target — is worse than what it prevents.
 */
async function stopRun(projectId: string, targetId: string, requireStopped: boolean): Promise<void> {
  if (!requireStopped) {
    await cancelRunForTarget(projectId, targetId);
    return;
  }
  if (runIsLiveForTarget(projectId, targetId)) throw new RunRestartedError(targetId);
}

/**
 * The still-open descendants an abandon of `target` must take with it, with the run of each
 * descendant that owns one already killed. Shared by the ticket and epic paths: a bead that groups
 * other work must take that work with it however the abandon was reached, or the descendants sit in
 * `bd ready` as claimable tickets whose run target is already settled — no run path left to reach
 * them. Settled descendants are left out entirely; their history is not rewritten.
 *
 * Every run is stopped before the caller's first bd write, so a `requireStopped` refusal on ANY
 * descendant leaves the whole cascade untouched.
 */
async function stopDescendantRuns(
  project: Project,
  target: Bead,
  board: Bead[],
  requireStopped: boolean,
): Promise<Bead[]> {
  const descendants = openDescendants(board, target.id);
  for (const descendant of descendants) {
    if (beads.isRunTarget(descendant, board)) {
      await stopRun(project.id, descendant.id, requireStopped);
    }
  }
  return descendants;
}

/**
 * The abandon entries for a cascade: every open descendant (in cascade order) followed by the
 * target itself. The target comes LAST for the same reason it always did — the batch applies in
 * order, and the label pass that precedes it must reach the descendants before the target, so a
 * crash can only ever leave a still-open target whose re-run finishes the job.
 */
function cascadeEntries(target: Bead, descendants: Bead[], why: string): Array<{ id: string; reason: string }> {
  const inherited = `${why} (parent ${target.issue_type ?? "ticket"} ${target.id} abandoned)`;
  return [...descendants.map((d) => ({ id: d.id, reason: inherited })), { id: target.id, reason: why }];
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
 * `requireStopped` inverts the kill for a caller that decided against work it had observed STOPPED —
 * an escalation's abandon: a live run then means the decision is stale, so nothing is cancelled or
 * closed and `RunRestartedError` is thrown (see {@link stopRun}).
 *
 * Throws on an unknown id (bd's own error → 404), an empty/oversized reason (→ 400), or an
 * already-closed ticket (NotAbandonableError → 409).
 */
export async function abandonTicket(
  project: Project,
  id: string,
  reason: string,
  opts?: { requireStopped?: boolean },
): Promise<TicketDetail> {
  const why = requireReason(reason);
  const bead = await beads.show(project.repoPath, id); // 404 guard — bd throws on an unknown id
  assertOpen(bead, "Ticket");

  const board = await beads.list(project.repoPath, ["--status", "all"]);
  const requireStopped = opts?.requireStopped === true;
  await stopRun(project.id, runTargetOf(bead, board), requireStopped);
  const descendants = await stopDescendantRuns(project, bead, board, requireStopped);

  // Abandoning a gardener PROPOSAL is a DECLINE (anton-1t3n): the `abandoned` label it just gained
  // is what stops the patrol re-filing the same claim, so say that on the bead — the suppression is
  // a consequence of the label that nothing else spells out. The note comes after the settle and is
  // best-effort: the decision has landed either way, and a failed note must not fail the abandon.
  const declined = declineNote(bead);
  // The ticket and its cascade settle as one unit — every close in a single bd transaction, the
  // ticket last (see beads.abandonAll).
  const settle = () => beads.abandonAll(project.repoPath, cascadeEntries(bead, descendants, why));

  if (!declined) {
    await settle();
  } else {
    // A proposal is settled by EITHER half of the gardener loop — declined here, or applied by
    // applyProposal — so the decline takes the same per-bead lock the apply holds for its whole
    // run. Unserialized, an approval that has passed its own re-read can still be writing the
    // subject moves while this decline closes the proposal underneath it: the board ends up mutated
    // by a decision it records as declined. Re-read inside the lock for the same reason the apply
    // does — the `assertOpen` above judged a snapshot taken before whoever held the lock ran.
    //
    // A read that FAILS is not permission to proceed — the same fail-closed rule `applyApproved`
    // holds itself to. Declining is the one outcome that is permanent: the `abandoned` label
    // suppresses the fingerprint for good, so a decline written over a proposal that a concurrent
    // approve had already APPLIED would record an approved move as a no and stop the patrol ever
    // asking again. Nothing has been written yet, so refusing costs only a retry.
    await withBeadWriteLock(project.repoPath, id, async () => {
      const live = await beads.show(project.repoPath, id).catch((e: unknown) => {
        throw new NotAbandonableError(
          `${id} could not be re-read under its write lock (${e instanceof Error ? e.message : String(e)}) — decline it by hand`,
        );
      });
      assertOpen(live, "Ticket");
      await settle();
      await beads
        .note(project.repoPath, id, declined)
        .catch((e) => console.error(`[abandon] could not record the decline on ${id}`, e));
    });
  }
  // Read-after-write, like setTicketDeferred: the `bd show` bead is authoritative for the abandoned
  // state it just wrote, so the response never reflects the board's stale snapshot.
  const detail = await freshDetail(project, await beads.show(project.repoPath, id));
  nudgeSync(project, "abandon");
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

  // --skip-labels (bd 1.1.0): the cascade only inspects parent, status and type — openDescendants
  // walks the subtree, isRunTarget classifies it — so skipping label hydration keeps this
  // full-board read lean.
  const all = await beads.list(repo, ["--status", "all", "--skip-labels"]);

  // Kill every live run this abandon settles, BEFORE recording it. A container epic never runs
  // itself — the active job is keyed by the FEATURE below it, which stopDescendantRuns cancels —
  // so cancelling only `epicId` would mark the feature and its tickets abandoned while its agent
  // kept running from the bead snapshot it loaded at start, and still committed and opened a PR for
  // work the board now calls won't-do. The epic's own id is cancelled too: a legacy (non-container)
  // epic is its own run target.
  await cancelRunForTarget(project.id, epicId);
  const descendants = await stopDescendantRuns(project, epic, all, false);

  // The epic and its whole cascade settle as one unit — every close in a single bd transaction,
  // the epic last (see beads.abandonAll), so no state exists in which the epic reads as settled
  // above still-open orphaned children.
  await beads.abandonAll(repo, cascadeEntries(epic, descendants, why));
  nudgeSync(project, "abandon");
  return { epicId, children: descendants.map((d) => d.id) };
}
