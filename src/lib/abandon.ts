/**
 * Abandon — the won't-do outcome for a ticket or an epic (anton-6xj0). Distinct from delete (which
 * destroys the history the decision is made of) and from done (which means shipped): the bead is
 * closed with a reason and tagged `abandoned`, any run still executing it is killed, and nothing
 * about the exit reads as a delivery. See DESIGN.md §3 — beads owns status, anton.db gains no column.
 */
import { beads } from "./beads/bd";
import { withBeadWriteLocks } from "./beads/claim-lock";
import { descendantsOf } from "./beads/subtree";
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
 * was merely already closed. `held` names WHERE the run is, because the two cases are answered
 * differently by the operator: work restarted here is theirs to stop, work on another machine is not.
 */
export class RunRestartedError extends NotAbandonableError {
  constructor(targetId: string, held = "is executing again") {
    super(`${targetId} ${held} — this abandon applies to work that had stopped`);
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
 * The precondition of an abandon decided against work the caller had observed STOPPED. `ownRunId` is
 * that stopped run: its own leftover lease is not a foreign holder (see `beads.foreignRunLeaseLive`),
 * so an abandon of a PARKED run — whose lease can still be unexpired — isn't refused by its own
 * evidence. Absent when the stall named no run of its own (a wait on a person), where every live
 * lease is another machine's.
 */
interface StoppedWork {
  ownRunId?: string;
}

/**
 * Stop the run executing `targetId` — or, when the abandon was decided against work that had already
 * STOPPED, refuse at the instant the kill would land. The liveness read and the destructive act share
 * one boundary here, which is the only precondition that can tie the cancel to the stopped work it was
 * decided against: a caller's earlier snapshot goes stale across every await between it and this line
 * (a bd pull, an escalation settle), and by then the cancel has no way to tell a run that never
 * stopped from one an operator restarted in the meantime.
 *
 * BOTH machines' answers, because `targetId` is derived HERE (see {@link runTargetOf}) and the caller
 * could not have judged it: reparenting is a supported move, so the run target above a ticket now is
 * not always the ancestor the caller's own lease check froze, and a run holding the new one is
 * invisible to the machine-local job table. So the shared board's run-lease is re-read on whatever
 * this abandon actually kills — the target and every cascaded descendant — off the same board read
 * the cascade is planned from, which {@link refreshSharedBoard} pulls first so both the parentage
 * and the lease are the remote's current answer rather than the local mirror's.
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
async function stopRun(
  projectId: string,
  targetId: string,
  board: Bead[],
  stopped: StoppedWork | undefined,
): Promise<void> {
  if (!stopped) {
    await cancelRunForTarget(projectId, targetId);
    return;
  }
  if (runIsLiveForTarget(projectId, targetId)) throw new RunRestartedError(targetId);
  // A target this board doesn't carry carries no lease either — a run publishes its lease on the
  // bead, so a bead the read answered for by omission is evidence of no holder, not a failed read
  // (the same rule readTargetState applies to a missing lease-holder). Only reachable at all through
  // runTargetOf's dangling-parent fallback.
  const target = board.find((b) => b.id === targetId);
  if (!target) return;
  const nowMs = Date.now();
  const foreign = stopped.ownRunId
    ? beads.foreignRunLeaseLive(target, nowMs, stopped.ownRunId)
    : beads.isRunLive(target, nowMs);
  if (foreign) throw new RunRestartedError(targetId, "is being executed on another machine");
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
  stopped: StoppedWork | undefined,
): Promise<Bead[]> {
  const descendants = openDescendants(board, target.id);
  for (const descendant of descendants) {
    if (beads.isRunTarget(descendant, board)) {
      await stopRun(project.id, descendant.id, board, stopped);
    }
  }
  return descendants;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Refresh shared state before an abandon that judges another machine's run-lease (anton-mivh).
 *
 * `requireStopped` is a statement about CURRENT shared state, and the board read it rests on is
 * local: bd answers `list`/`show` from the Dolt working set, which trails the remote by a sync
 * heartbeat. The caller's own pull ({@link readTargetState in escalation-actions}) is several awaits
 * back — a gate close, the escalation settle — so a reparent-plus-run that landed elsewhere inside
 * that window is invisible to the read below. {@link runTargetOf} would then derive the FORMER
 * target, find no lease on it, and let the abandon close the ticket underneath the new target's live
 * foreign run. Pulling HERE is what makes the boundary check answer for the board as it is, the same
 * pull `gateDispatch` makes before its own last-look liveness read.
 *
 * FAILS CLOSED, exactly as both of those reads do: a pull that didn't land leaves shared state
 * unread, which is not evidence of a clear board. Nothing has been written at this point, so refusing
 * costs a retry — the escalation route maps it to 409 with its message. A workspace with no remote
 * resolves the pull rather than rejecting, so a single-machine board never reaches this.
 */
async function refreshSharedBoard(repo: string, id: string): Promise<void> {
  try {
    await beads.pull(repo);
  } catch (e) {
    throw new NotAbandonableError(
      `the shared board could not be re-read before abandoning ${id} (${messageOf(e)}) — so a run ` +
        `on another machine can't be ruled out; nothing was written, try again`,
    );
  }
}

/**
 * The write locks an abandon settles under: the target plus every bead its cascade closes. The
 * gardener takes both ends of a move (gardener/apply.ts `applyStep` locks the subject AND the home),
 * so holding the whole cascade is what puts this abandon in an order with an approval attaching work
 * anywhere beneath it — not just when the abandoned bead is itself a proposal.
 */
const cascadeLocks = (target: Bead, descendants: Bead[]): string[] => [
  target.id,
  ...descendants.map((d) => d.id),
];

/**
 * The target, re-read from inside its own write lock. The `assertOpen` before the lock judged a
 * snapshot taken before whoever held the lock ran — an apply that has passed its own re-read can
 * still be writing when this abandon is planned. A read that FAILS is never permission to write:
 * nothing has been written yet, so refusing costs only a retry, while an abandon written blind is
 * permanent (for a proposal the `abandoned` label suppresses its fingerprint for good).
 */
async function rereadLocked(repo: string, id: string): Promise<Bead> {
  try {
    return await beads.show(repo, id);
  } catch (e) {
    throw new NotAbandonableError(
      `${id} could not be re-read under its write lock (${messageOf(e)}) — nothing was written; try again`,
    );
  }
}

/**
 * Refuse an abandon whose cascade moved between the snapshot it was planned from and the locks it
 * now holds (anton-e42l).
 *
 * The race is a gardener re-parent, which takes the write lock of the bead it moves AND of the card
 * it moves it under, and yields between passing its home check (`homeUnusable`) and writing. An
 * abandon that settled outside those locks could land in exactly that gap: its descendant snapshot
 * predates the newcomer, so the cascade misses it, and the approval then attaches an open bead
 * beneath a card this abandon has just closed — while closing its proposal as applied. Re-deriving
 * here is what makes the ordering mean something: either the re-parent landed first and shows up in
 * this read, or it queues behind the settle and its own locked home re-check refuses.
 *
 * Refuse rather than adopt the fresh set: a bead that arrived (or left) after the locks were chosen
 * is one this abandon holds no lock on, so closing it would race the very writes this serializes
 * against. Nothing has been written yet, so a retry re-plans against the board it just saw.
 */
async function assertCascadeUnchanged(
  repo: string,
  target: Bead,
  descendants: Bead[],
  listArgs: string[],
): Promise<void> {
  let board: Bead[];
  try {
    board = await beads.list(repo, listArgs);
  } catch (e) {
    throw new NotAbandonableError(
      `the board under ${target.id} could not be re-read under its write lock (${messageOf(e)}) — nothing was written; try again`,
    );
  }
  const before = new Set(descendants.map((d) => d.id));
  const after = openDescendants(board, target.id);
  const afterIds = new Set(after.map((b) => b.id));
  const attached = [...afterIds].filter((id) => !before.has(id));
  const detached = [...before].filter((id) => !afterIds.has(id));
  if (attached.length === 0 && detached.length === 0) return;
  const moved = [
    attached.length > 0 ? `attached ${attached.join(", ")}` : "",
    detached.length > 0 ? `detached ${detached.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  throw new NotAbandonableError(
    `the open work under ${target.id} changed while this abandon was landing (${moved}) — nothing ` +
      `was written; try again so the cascade settles the work the board actually holds`,
  );
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
 * an escalation's abandon: a run live on EITHER machine then means the decision is stale, so nothing
 * is cancelled or closed and `RunRestartedError` is thrown (see {@link stopRun}). `ownRunId` exempts
 * the stopped run's own leftover lease from that (see {@link StoppedWork}).
 *
 * Throws on an unknown id (bd's own error → 404), an empty/oversized reason (→ 400), or an
 * already-closed ticket (NotAbandonableError → 409).
 */
export async function abandonTicket(
  project: Project,
  id: string,
  reason: string,
  opts?: { requireStopped?: boolean; ownRunId?: string },
): Promise<TicketDetail> {
  const why = requireReason(reason);
  const repo = project.repoPath;
  const stopped = opts?.requireStopped === true ? { ownRunId: opts.ownRunId } : undefined;
  // Before the reads, not after: parentage and the run-lease are both read off the board below, and
  // `stopped` needs BOTH as the remote has them now (see {@link refreshSharedBoard}). The plain
  // abandon reads no lease and kills what it finds, so it pays no pull.
  if (stopped) await refreshSharedBoard(repo, id);
  const bead = await beads.show(repo, id); // 404 guard — bd throws on an unknown id
  assertOpen(bead, "Ticket");

  // Labels hydrated (no --skip-labels): the run-lease `requireStopped` reads lives on them.
  const listArgs = ["--status", "all"];
  const board = await beads.list(repo, listArgs);
  await stopRun(project.id, runTargetOf(bead, board), board, stopped);
  const descendants = await stopDescendantRuns(project, bead, board, stopped);

  // Abandoning a gardener PROPOSAL is a DECLINE (anton-1t3n): the `abandoned` label it just gained
  // is what stops the patrol re-filing the same claim, so say that on the bead — the suppression is
  // a consequence of the label that nothing else spells out. The note comes after the settle and is
  // best-effort: the decision has landed either way, and a failed note must not fail the abandon.
  const declined = declineNote(bead);

  // EVERY abandon settles under the cascade's write locks, not only a proposal's decline. A proposal
  // is settled by either half of the gardener loop — declined here, or applied by applyProposal — so
  // the decline has to hold the lock that apply holds for its whole run. An ordinary ticket needs the
  // same serialization for the other direction (see assertCascadeUnchanged): the gardener's own
  // subject and home checks rest on these locks, and an abandon outside them can close a card the
  // approval is still attaching work under. Re-read the target and re-derive the cascade inside, for
  // the same reason the apply re-reads: the checks above judged a snapshot taken before whoever held
  // the lock ran.
  await withBeadWriteLocks(repo, cascadeLocks(bead, descendants), async () => {
    assertOpen(await rereadLocked(repo, id), "Ticket");
    await assertCascadeUnchanged(repo, bead, descendants, listArgs);
    // The ticket and its cascade settle as one unit — every close in a single bd transaction, the
    // ticket last (see beads.abandonAll).
    await beads.abandonAll(repo, cascadeEntries(bead, descendants, why));
    if (declined) {
      await beads
        .note(repo, id, declined)
        .catch((e) => console.error(`[abandon] could not record the decline on ${id}`, e));
    }
  });
  // Read-after-write, like setTicketDeferred: the `bd show` bead is authoritative for the abandoned
  // state it just wrote, so the response never reflects the board's stale snapshot.
  const detail = await freshDetail(project, await beads.show(repo, id));
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
  return descendantsOf(board, epicId, (bead) => bead.status !== "closed");
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
  // full-board read lean. Safe only because this path never passes `stopped`, whose lease check
  // reads exactly those labels (see stopRun).
  const listArgs = ["--status", "all", "--skip-labels"];
  const all = await beads.list(repo, listArgs);

  // Kill every live run this abandon settles, BEFORE recording it. A container epic never runs
  // itself — the active job is keyed by the FEATURE below it, which stopDescendantRuns cancels —
  // so cancelling only `epicId` would mark the feature and its tickets abandoned while its agent
  // kept running from the bead snapshot it loaded at start, and still committed and opened a PR for
  // work the board now calls won't-do. The epic's own id is cancelled too: a legacy (non-container)
  // epic is its own run target.
  await cancelRunForTarget(project.id, epicId);
  const descendants = await stopDescendantRuns(project, epic, all, undefined);

  // Under the cascade's write locks, re-read and re-derived inside them, exactly as abandonTicket
  // settles: a gardener re-parent attaching work anywhere beneath this epic takes those same locks,
  // so either it lands first and this read refuses (the retry then cascades over the newcomer too),
  // or it queues behind this settle and its own home re-check refuses.
  await withBeadWriteLocks(repo, cascadeLocks(epic, descendants), async () => {
    assertOpen(await rereadLocked(repo, epicId), "Epic");
    await assertCascadeUnchanged(repo, epic, descendants, listArgs);
    // The epic and its whole cascade settle as one unit — every close in a single bd transaction,
    // the epic last (see beads.abandonAll), so no state exists in which the epic reads as settled
    // above still-open orphaned children.
    await beads.abandonAll(repo, cascadeEntries(epic, descendants, why));
  });
  nudgeSync(project, "abandon");
  return { epicId, children: descendants.map((d) => d.id) };
}
