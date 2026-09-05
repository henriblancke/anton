/**
 * What a run reads off the BOARD, with no worktree, no lease and no side effects (anton-1lix —
 * extracted from execute-epic.ts): what it may start, which tickets a blocker holds, what a timeout
 * takes down with it, and the order the rest run in.
 *
 * Pure except for the one write a stopping run owes its absorbed timeouts ({@link
 * reopenAbsorbedTimeouts}) — which is here because the verdict it acts on is this module's.
 */
import { beads, gateReason, HUMAN_AGENT, labelValueOf, type Bead } from "../beads/bd";
import { latestBlockNoteCommit } from "../beads/block-note";
import { ownerOf } from "../beads/claim";
import { withBeadWriteLock } from "../beads/claim-lock";
import { parseTicketNotes } from "../beads/notes";
import { computeEpicGraph, epicStandaloneBlockers, standaloneBlockers } from "../epic-graph";
import { blockedByPoison, PoisonEpic } from "./errors";
import { mustPersist } from "./execute-epic-persist";

/**
 * What a run may actually start, over one board snapshot (anton-1two). A run target is dispatched
 * PER TICKET, so "blocked" is not a property of the target: a ticket whose prerequisite ships in
 * ANOTHER run is held, while its independent siblings are ordinary work the run does now. The
 * rollup's per-child verdict (epic-graph `childReadiness`) is what tells those two apart — the
 * target-level `blockedBy` conflates them, and a run that gated on it stalled a whole feature over
 * one tail ticket (issue #58).
 */
export interface RunReadiness {
  /** Open prerequisites of the target or of its tickets — what the park reason names. */
  blockers: string[];
  /** Ticket ids a blocker OUTSIDE this run holds; never dispatched this pass. */
  gated: string[];
  /** At least one ticket is dispatchable now — the only condition under which the run proceeds. */
  runnable: boolean;
}

/**
 * Read {@link RunReadiness} off a board snapshot, for the run target `targetId`.
 *
 * A GRAPH UNIT — every feature and every epic (epic-graph's isUnit) — takes its verdict from the
 * epic-graph rollup, which is where cross-unit edges inferred from ticket-level `blocks` land;
 * keying on isEpic alone would send a feature down the standalone path and miss every inferred
 * blocker the approve route gates on. `targetIsUnit` is passed in rather than re-derived so a run
 * judges every board it re-reads by the shape it started with.
 *
 * The BLOCKER list stays the coarse roll-up — it names what the operator is waiting on, and a unit
 * also inherits any open standalone (parentless task/bug) prerequisite the rollup drops
 * (epicStandaloneBlockers), the same gap the approve route closes. Only the DECISION is per-child.
 *
 * A standalone task/bug (epic-of-one) never appears in the rollup and has nothing to be partial
 * about — it IS its own single ticket — so its own open `blocks` edges hold the whole run.
 */
export function runReadiness(
  board: Bead[],
  targetId: string,
  targetIsUnit: boolean,
): RunReadiness {
  if (!targetIsUnit) {
    const blockers = standaloneBlockers(board, targetId);
    return {
      blockers,
      gated: blockers.length > 0 ? [targetId] : [],
      runnable: blockers.length === 0,
    };
  }
  const node = computeEpicGraph(board).epics.find((n) => n.id === targetId);
  const blockers = [...(node?.blockedBy ?? []), ...epicStandaloneBlockers(board, targetId)];
  return {
    blockers,
    gated: node?.blockedChildren ?? [],
    // A unit always has a node; judging a missing one by its blockers is the fail-safe.
    runnable: node ? node.childReadiness !== "blocked" : blockers.length === 0,
  };
}

/**
 * The ask each open human gate among `blockers` carries, phrased as what a person does about it.
 *
 * A human gate blocks its target like any other prerequisite, but no work completes it — only
 * someone answering it — so listing it beside ordinary blockers describes a wait for something that
 * is never coming.
 */
export function openHumanGateAsks(board: Bead[], blockers: string[]): string[] {
  return blockers.flatMap((id) => {
    const bead = board.find((b) => b.id === id);
    if (!bead || bead.status === "closed" || !beads.isHumanGate(bead)) return [];
    const ask = gateReason(bead) ?? "no reason recorded on the gate";
    return [
      `${id} is a human gate, not work in flight — "${ask}" — answer it, then ` +
        `\`bd gate resolve ${id}\`.`,
    ];
  });
}

/** The park a run takes when NOTHING in it can start. */
export function blockedRunPoison(beadId: string, readiness: RunReadiness, board: Bead[]): PoisonEpic {
  if (readiness.blockers.length === 0) {
    return new PoisonEpic(
      `${beadId} has no ticket it can start — every ticket it would run is held by an open ` +
        `blocker outside this run; resume the run once they complete`,
    );
  }
  const blocked = blockedByPoison(beadId, readiness.blockers);
  // A human gate among the blockers is an ASK, not work in progress — and it can be the only record
  // of one: a needs-human park whose run row could not be settled leaves the gate standing alone
  // (anton-287p), and the next attempt lands here. Naming the ask is what keeps that recovery from
  // reading as an ordinary block. The blocked-by clause stays intact ahead of it — run-health
  // parses the ids back out of it to report this stall as the gate's own wait rather than twice.
  const asks = openHumanGateAsks(board, readiness.blockers);
  return asks.length > 0 ? new PoisonEpic(`${blocked.message}. ${asks.join(" ")}`) : blocked;
}

/**
 * The statuses `bd update --claim` refuses for a reason no retry and no agent can clear (anton-fude).
 * Verified against bd 1.1.2 by claiming a bead in each status: `open` is the only status
 * claimable by an actor that does not already hold the bead (`in_progress` re-claims by the
 * same actor succeed — that idempotency is what lets a resume re-claim its own ticket cleanly).
 *
 * `closed` is deliberately absent — a closed ticket is settled work the dispatch loop skips (or
 * reopens for a cross-machine resume) long before the claim — and so is `in_progress`, which is an
 * ownership question runTicket's own claim gate answers. What is left is the two states a PERSON
 * writes: `blocked` (anton's own human-review verdict on a ticket that delivered nothing) and
 * `deferred` (snoozed out of the queue).
 */
const HUMAN_HELD_STATUSES: ReadonlySet<string> = new Set(["blocked", "deferred"]);

/** A ticket no run may claim until a person moves it, and the account the board carries for it. */
export interface HumanHeldTicket {
  id: string;
  status: string;
  /** anton's newest note on the bead — why it blocked the ticket — when it left one. */
  note?: string;
  /**
   * The branch + short sha of the work this ticket's block left behind, when its note records a
   * commit. Both halves matter: the remedy this ticket is owed ({@link humanHeldClause}) turns on
   * whether that branch is the one THIS run ships. The sha is absent when the run that wrote the
   * note could not read it — a commit that cannot be located is still a commit.
   */
  committed?: { branch: string; head?: string };
}

/**
 * The run's tickets a person has to release before any run can dispatch them (anton-fude).
 *
 * A run that blocks a ticket for human review — the no-delivery gate's verdict — leaves the board in
 * a state its own resume cannot walk past: the ticket is neither closed nor abandoned, so the
 * dispatch loop hands it to runTicket, whose first act is the hard claim gate bd refuses outright.
 * Answering it HERE, off the board, is what turns that into a park naming the ticket instead of a
 * claim failure blamed on a foreign operator or a locked DB.
 *
 * Abandoned tickets are excluded for the same reason the dispatch loop drops them: a human already
 * settled them, and this run runs without them.
 *
 * Judges only the tickets handed to it, and the caller hands it the ones this run would DISPATCH: a
 * child a cross-run blocker holds is never claimed this pass, so parking over its status would stall
 * its independent siblings (PR #227 review).
 */
export function humanHeldTickets(tickets: Bead[]): HumanHeldTicket[] {
  return tickets
    .filter((t) => HUMAN_HELD_STATUSES.has(t.status) && !beads.isAbandoned(t))
    .map((t) => {
      const notes = machineNotes(t);
      const note = clampNote(notes.at(-1));
      // Read off the FULL notes, never the clamped one: the evidence clause sits at the end of a
      // block note, which is exactly what the cap above cuts off.
      const commit = latestBlockNoteCommit(notes);
      return {
        id: t.id,
        status: t.status,
        ...(note ? { note } : {}),
        ...(commit?.committed
          ? { committed: { branch: commit.branch, ...(commit.head ? { head: commit.head } : {}) } }
          : {}),
      };
    });
}

/** How much of a bead's note one park message may carry — enough to act on, bounded for the row. */
const HELD_NOTE_CHARS = 300;

/**
 * A bead's machine notes, newest last: anton's own account of why it stopped there. Human notes are
 * excluded — a person's steer is written to the AGENT, not to the operator reading this park.
 */
function machineNotes(bead: Bead): string[] {
  return parseTicketNotes(bead.notes)
    .filter((n) => n.source === "system")
    .map((n) => n.text);
}

/** One note as the run row may carry it: flattened, and capped so a runaway can't bloat the park. */
function clampNote(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > HELD_NOTE_CHARS ? `${flat.slice(0, HELD_NOTE_CHARS).trimEnd()}…` : flat;
}

/**
 * Where a held ticket's work stands relative to the pull request THIS run opens — the only thing its
 * remedy turns on (PR #227 review).
 *
 * `here` is the sole verdict that licenses "review it and close", and it takes a git answer, never a
 * branch NAME: anton's branches are deterministic per target, so a run resumed on another machine
 * derives the same name over a checkout that lacks the commit its note records (the machine that
 * made it parked before pushing) — the same cross-machine gap the dispatch loop closes with
 * `worktreeHasCommitFor`. `elsewhere` is the note of a re-parented ticket, still pointing at its
 * original run's branch. Both `elsewhere` and `absent` mean this run ships without that work.
 *
 * `unverified` is the note of a run that committed but could not read the sha (PR #227 review):
 * there IS work, and git cannot be asked where it is without a commit to ask about. It is its own
 * verdict rather than a lean either way — called `here` it would license closing a ticket whose work
 * may be in no pull request, called `none` it would send an operator to redo work already on the
 * branch.
 */
type HeldWork =
  | { where: "none" }
  | { where: "here"; head: string }
  | { where: "elsewhere"; branch: string; head?: string }
  | { where: "absent"; head: string }
  | { where: "unverified"; branch: string };

/** Read {@link HeldWork} off the ticket's note plus `commitsHere` — see {@link humanHeldPoison}. */
function heldWork(
  held: HumanHeldTicket,
  branch: string,
  commitsHere: ReadonlySet<string>,
): HeldWork {
  const committed = held.committed;
  if (!committed) return { where: "none" };
  if (committed.branch !== branch) return { where: "elsewhere", ...committed };
  if (!committed.head) return { where: "unverified", branch };
  return { where: commitsHere.has(held.id) ? "here" : "absent", head: committed.head };
}

/**
 * What one held ticket owes the operator: why no run may take it, and the move that frees it.
 *
 * A blocked ticket has FIVE remedies, and which one applies turns on where its work landed
 * (PR #227 review). Recommending `--status open` for a ticket that already committed HERE is wrong
 * twice over: reopening does not satisfy `resumeSkipped` (only `closed` does), so the resumed run
 * dispatches the agent again ON TOP of that commit and can block right back at the same zero diff —
 * and abandoning it drops the work from the board while its commit stays on the run branch. That
 * case is owed what the block note itself says: review the commit, then close.
 *
 * Work that is NOT here — committed on another branch, or on this branch but only in another
 * machine's unpushed checkout — is owed the opposite of that: it is in no PR this run opens, so
 * closing or abandoning the ticket settles the board over work this target never ships. Reopening is
 * the move — the same one a zero-diff block gets — with the commit named so the operator can bring
 * it across instead of redoing it.
 *
 * Work whose sha was never recorded is owed neither: the operator is pointed at the branch to settle
 * the question a machine could not, because both remedies above are wrong on the wrong answer.
 */
function humanHeldClause(held: HumanHeldTicket, work: HeldWork, branch: string): string {
  const why =
    held.status === "deferred"
      ? `${held.id} is deferred — snoozed out of the queue, so no run may claim it (\`bd undefer ` +
        `${held.id}\` to bring it back)`
      : work.where === "here"
        ? `${held.id} is blocked pending human review with its work ALREADY COMMITTED on this ` +
          `run's branch (@ ${work.head}) — review that commit and \`bd close ${held.id}\` if ` +
          `it satisfies the ticket, which is what lets a resume walk past it; reopen it ` +
          `(\`bd update ${held.id} --status open\`) only to have an agent keep working on top of ` +
          `that commit`
        : work.where === "elsewhere"
          ? `${held.id} is blocked pending human review and its work was committed on ` +
            `${work.branch}${work.head ? ` (@ ${work.head})` : ""}, NOT on this run's branch ` +
            `(${branch}) — so this run's pull request does not contain it, and closing or ` +
            `abandoning it would settle the board over work this target never ships. Reopen it ` +
            `(\`bd update ${held.id} --status open\`) to have an agent redo it here, or land that ` +
            `commit on ${branch} yourself before closing it`
          : work.where === "absent"
            ? `${held.id} is blocked pending human review and its note records a commit on ` +
              `${branch} (@ ${work.head}) that is NOT on this machine's ${branch} — the run that ` +
              `made it parked before pushing, so this run's pull request does not contain it and ` +
              `closing or abandoning it would settle the board over work this run never ships. ` +
              `Reopen it (\`bd update ${held.id} --status open\`) to have an agent redo it here, ` +
              `or push that commit from the machine holding it and land it on ${branch} before ` +
              `closing it`
            : work.where === "unverified"
              ? `${held.id} is blocked pending human review and its note records that its work ` +
                `WAS committed on ${branch}, but the run could not read the commit's sha — so ` +
                `nothing here can tell whether this run's pull request contains it. Find the ` +
                `ticket's commit (\`git log --oneline ${branch} | grep ${held.id}\`): review it ` +
                `and \`bd close ${held.id}\` if it satisfies the ticket, or reopen it ` +
                `(\`bd update ${held.id} --status open\`) to have an agent redo it here if it is ` +
                `not on the branch`
              : `${held.id} is blocked pending human review (\`bd update ${held.id} --status open\` once ` +
                `it is resolved)`;
  return held.note ? `${why}: "${held.note}"` : why;
}

/**
 * The park a run takes for a ticket only a person can release (anton-fude).
 *
 * PARK, never skip or auto-reopen. Reopening would re-run a ticket whose last run delivered nothing
 * and land it right back in `blocked` — the human-review gate answered by the machine that tripped
 * it — and skipping would open the target's single pull request missing work the board still shows
 * as open, the same reason the allowlist and contract gates park rather than narrow.
 *
 * `commitsHere` is the caller's git-verified answer to "which of these tickets' recorded commits are
 * actually reachable from `branch` on this machine" (PR #227 review). It is an INPUT rather than a
 * read of this module's own because the module is board-only, and it is required rather than
 * optional because every remedy that settles the board over a commit depends on it: a caller that
 * cannot verify passes the empty set and gets the answers that leave the work in the operator's
 * hands.
 */
export function humanHeldPoison(
  targetId: string,
  held: HumanHeldTicket[],
  branch: string,
  commitsHere: ReadonlySet<string>,
): PoisonEpic {
  const one = held.length === 1;
  const it = one ? "it" : "them";
  const work = held.map((h) => [h, heldWork(h, branch, commitsHere)] as const);
  // Abandoning is a BOARD move, not a branch one: for a ticket whose work is verifiably ON THIS
  // BRANCH it settles the bead and leaves the commit in the run's pull request, so it can't be
  // offered as "drops the work". A commit this checkout does not have buys none of that — this run
  // ships without it, so abandoning really does drop the work here (PR #227 review).
  //
  // A MIXED set names which tickets earn that reassurance (PR #227 review). An unqualified "a commit
  // already on the branch stays in the pull request" reads as covering every ticket listed, so an
  // operator abandoning the lot would drop the ones whose work is on another branch or another
  // machine — the exact loss the per-ticket clauses above warn about.
  const hereIds = work.filter(([, w]) => w.where === "here").map(([h]) => h.id);
  const abandon =
    hereIds.length === 0
      ? `or abandon ${it}, which drops the work from this run`
      : hereIds.length === work.length
        ? `or abandon ${it} to settle the board — a commit already on the branch stays in this ` +
          `run's pull request either way`
        : `or abandon ${it} to settle the board, bearing in mind that only the ` +
          `${hereIds.length === 1 ? "commit" : "commits"} already on this branch ` +
          `(${hereIds.join(", ")}) ${hereIds.length === 1 ? "stays" : "stay"} in this run's pull ` +
          `request either way — abandoning the rest drops that work from this run`;
  return new PoisonEpic(
    `${targetId} has ${one ? "a ticket" : `${held.length} tickets`} no agent can pick up: ` +
      work.map(([h, w]) => humanHeldClause(h, w, branch)).join("; ") +
      `. bd refuses \`--claim\` on ${one ? "that status" : "those statuses"}, so the run stopped ` +
      `before dispatching anything rather than dying at the ticket's claim gate. Resolve ${it} — ` +
      `${abandon} — then resume the run`,
  );
}

/**
 * Tickets whose `agent:` label names a specialist agent the project has disabled (anton-dm7).
 * `activeAgents` is settings.agents; `userAgentIds` are the project's own agents — discoverable
 * `agent:<id>` ids that anton does NOT ship as bundled specialists (see the caller). Semantics:
 *   • absent allowlist (never persisted / cleared) → all agents active (a project that never touched
 *     settings must not stall; the API persists a cleared value as `undefined`, never `[]`)
 *   • EMPTY allowlist `[]` → no BUNDLED agent active: a ticket needing a bundled specialist is parked.
 *     The operator explicitly toggled every bundled agent off, and the API persists `[]` as a real
 *     value distinct from clearing (settings/route.ts) — honoring it is the whole point.
 *   • `agent:human` → NEVER reported here (anton-mv70). It names no agent to enable — it is absent
 *     from AGENT_OPTIONS and from every `.claude/agents` discovery — so parking on it would send the
 *     operator to a Settings toggle that cannot exist, and would take the whole feature down with a
 *     ticket only a person can do. Human tickets are held by a gate of their own, armed before this
 *     gate runs, and their independent siblings still ship.
 *   • no `agent:` label → runs with the default agent, never blocked
 *   • a USER agent (id in `userAgentIds`) is NEVER gated — the operator brought it and labeled the
 *     ticket with it deliberately, so it runs regardless of the allowlist. This is the reversal of
 *     anton-dvo.1: the allowlist gates anton's bundled specialists only, not the project's own
 *     `.claude/agents`. An `agent:` label that is neither active nor a known user agent (a disabled
 *     bundled agent, or a typo that resolves nowhere) is still parked — the safety net stands.
 * `userAgentIds` defaults to none, so a caller that doesn't pass it gets the pre-reversal behavior
 * (every non-allowlisted labeled ticket parked) — used by callers/tests that only reason about the
 * allowlist itself.
 */
export function inactiveAgentTickets(
  tickets: Bead[],
  activeAgents: string[] | undefined,
  userAgentIds?: Iterable<string>,
): { id: string; agent: string }[] {
  if (activeAgents == null) return [];
  const active = new Set(activeAgents);
  const userAgents = userAgentIds ? new Set(userAgentIds) : null;
  const out: { id: string; agent: string }[] = [];
  for (const t of tickets) {
    const agent = labelValueOf(t.labels, "agent");
    if (!agent) continue;
    if (agent === HUMAN_AGENT) continue; // no toggle exists for it — see the note above
    if (active.has(agent)) continue;
    if (userAgents?.has(agent)) continue; // the project's own agent — never gated by the allowlist
    out.push({ id: t.id, agent });
  }
  return out;
}

/**
 * How the TARGET itself stopped being a run target while its run was starting (anton-e42l), named
 * for the error — or undefined when it is still one.
 *
 * {@link ticketSetDrift} watches the subtree; this watches the bead. A parentless task/bug that a
 * re-parent moved under another card has an empty ticket set on BOTH sides of that check — nothing
 * attached, nothing detached — while the bead itself has become a child ticket of somebody else's
 * run target. Left unasked, this run would execute (and settle) a bead the other target's run also
 * owns. Judged with the same `isRunTarget` predicate as the pre-lease gate, so the two agree.
 */
export function runTargetDrift(id: string, board: Bead[]): string | undefined {
  const live = board.find((b) => b.id === id);
  if (!live) return "it is no longer on the board";
  if (beads.isRunTarget(live, board)) return undefined;
  if (beads.isContainer(live, board)) {
    return "it gained a feature child and is now a container epic — run one of its features instead";
  }
  const parent = beads.parentOf(live);
  return parent
    ? `it now hangs under ${parent}, whose run owns it as a ticket`
    : `its type is now "${live.issue_type ?? "unknown"}", which anton never runs on its own`;
}

/**
 * How the target's ticket subtree moved between this run's selection and a board that can see the
 * run's lease (anton-e42l), named for the error — or undefined when it didn't move.
 *
 * Ids only, and status-blind on purpose: `runTickets` filters on SHAPE, not state, so a ticket
 * another machine merely closed mid-window is in both sets and reads as no drift. What this is for
 * is a bead genuinely attached to (or pulled out of) the target while the run was starting up —
 * chiefly an approved gardener re-parent, which is allowed to attach work to any card no run is
 * visibly holding.
 */
export function ticketSetDrift(selected: Bead[], confirmed: Bead[]): string | undefined {
  const before = new Set(selected.map((t) => t.id));
  const after = new Set(confirmed.map((t) => t.id));
  const attached = [...after].filter((id) => !before.has(id));
  const detached = [...before].filter((id) => !after.has(id));
  if (attached.length === 0 && detached.length === 0) return undefined;
  return [
    attached.length > 0 ? `attached ${attached.join(", ")}` : "",
    detached.length > 0 ? `detached ${detached.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * The run's INTERNAL dependency graph — `blocks` edges among the run's own tickets only, as
 * blocker id → the tickets that depend on it. Edges to beads outside the run are another gate's
 * business (`runReadiness` holds those tickets before the loop ever sees them).
 *
 * Shared by the two questions a run asks of that graph: what order to dispatch in
 * ({@link orderTickets}) and, once a ticket fails to deliver, what can no longer run
 * ({@link skippedDependents}). One reader, so the skip can never disagree with the order.
 */
function dependentEdges(tickets: Bead[], all: Bead[]): Map<string, string[]> {
  const ids = new Set(tickets.map((t) => t.id));
  const adj = new Map<string, string[]>(tickets.map((t) => [t.id, []]));
  for (const e of beads.edgesOf(all)) {
    if (e.type !== "blocks") continue;
    // e.from depends on e.to → e.to must come first.
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    adj.get(e.to)!.push(e.from);
  }
  return adj;
}

/** Why a ticket was never dispatched: the ticket it directly waits on, and the stopped ticket at
 * the head of that chain (the same id when the dependency is direct). */
export interface SkipCause {
  waitingOn: string;
  stopped: string;
}

/** One entry in a run's timeout ledger: the ticket the budget stopped, and what became of its work
 * — DELIVERED before the deadline, PRESERVED on the branch as an explicitly incomplete commit
 * (anton-d967 — only a childless run target can), or (neither flag) rolled back. Preserved and
 * delivered are not the same thing anywhere downstream: preserved work is on the branch and is
 * still nobody's delivery.
 *
 * `delivered` is the delivery gate's verdict, never the bare tree fact (PR #228 review): a deadline
 * landing while `assertDelivered` REFUSES a commit leaves that commit on the branch but makes it
 * nobody's delivery, and every reader below — the reopen, the cascade, the operator's ledger — owes
 * that ticket the same treatment as one stopped short.
 *
 * `preservedUnknown` is the fate a preserved/rolled-back pair cannot express (PR #228 review): the
 * rollback restores a baseline a previous attempt's preserved commit is part of, and when the
 * branch's history could not be read anton does not know whether one is there. Neither flag can
 * carry that — `preserved` would promise a resume continues from work that may not exist, and its
 * absence reads as a rollback that took the work off — so the doubt gets its own field, and the
 * park message speaks it instead of claiming the work was removed. */
export interface TicketTimeoutOutcome {
  id: string;
  delivered: boolean;
  preserved?: boolean;
  preservedUnknown?: boolean;
}

/**
 * Whether a LIVE read of a ticket this run's budget stopped is still the run's to reopen
 * (PR #199 review).
 *
 * A stopping run puts the timeouts it absorbed back at `open`, because the resume it advertises
 * starts at runTicket's hard claim gate and that gate refuses the status the timeout left. But the
 * ledger it works from is a snapshot taken when the timeout landed, and the run walked every
 * independent ticket behind it before it stopped: in that window a resumed attempt elsewhere can
 * have claimed the bead, and a human can have closed or abandoned it. Rewriting the status then
 * downgrades live work or undoes a person's decision, so the reopen is decided on the board as it
 * is now, against the state THIS run's timeout path leaves behind:
 *
 * - still carrying `not-delivered` — the marker runTicket clears the moment anyone re-runs the
 *   ticket, so it surviving means nobody has;
 * - unowned — the run gave its reservation back a few lines above, and an assignee that appeared
 *   since is somebody else's claim;
 * - `blocked`, or `in_progress` when the timeout's best-effort block write did not land — the two
 *   statuses the claim gate refuses, and the only two this path exists to repair. `open` needs no
 *   write; `closed` is a human's verdict.
 */
export function reopenableAfterStop(b: Bead): boolean {
  return (
    beads.isNotDelivered(b) &&
    ownerOf(b) === undefined &&
    (b.status === "blocked" || b.status === "in_progress")
  );
}

/**
 * The bd surface {@link reopenAbsorbedTimeouts} decides and writes through, declared structurally
 * (like claim.ts's `AssigneeStore`) so tests can drive the sequence without a real board.
 */
export interface ReopenBoard {
  show: (cwd: string, id: string) => Promise<Bead>;
  setStatus: (cwd: string, id: string, status: string) => Promise<unknown>;
}

/**
 * Put the ROLLED-BACK timeouts a stopping run absorbed back at `open`, each decided and written
 * under that ticket's OWN write lock (PR #199 review).
 *
 * {@link reopenableAfterStop} is what makes the write safe, but a predicate read that nothing
 * serializes only says the bead was ours a moment ago. Another run's claim gate
 * ({@link beads.claimVerified}) and an operator's Claim both write on the per-bead chain in
 * beads/claim-lock, so either could land between the read and this unconditional `open` and knock a
 * freshly-claimed `in_progress` ticket back into `bd ready` while its agent runs. Holding the lock
 * across both makes the two orders real: the claim wins and the locked re-read sees its owner, or it
 * queues behind this and finds `open`. Ordering is process-local by construction (see claim-lock);
 * the cross-machine half is anton-od4, which is why the predicate stays either way.
 *
 * Nothing inside may take that lock again, on pain of deadlock — `show`/`setStatus` are bare bd
 * spawns, unlike claimVerified and the claim CAS.
 *
 * Never throws: this runs on the stopping path, where one refused bd write must not hide the run's
 * own error. Every refusal is logged with the repair instead.
 */
export async function reopenAbsorbedTimeouts(
  repo: string,
  epicBeadId: string,
  timedOut: readonly TicketTimeoutOutcome[],
  board: ReopenBoard = beads,
): Promise<void> {
  for (const stalled of timedOut.filter((t) => !t.delivered)) {
    await withBeadWriteLock(repo, stalled.id, async () => {
      // Decided on a read taken HERE, not on the ledger (PR #199 review).
      const live = await board.show(repo, stalled.id).catch(() => undefined);
      // A read that failed is not evidence the ticket is still ours, and a reopen written on that
      // silence is the very overwrite this guard exists to prevent — so it takes the same escalation
      // as a refused write: left as it stands, with the repair named.
      if (!live) {
        console.error(
          `[execute-epic] ${epicBeadId}: could not re-read ${stalled.id} to reopen it, so its ` +
            `status stands — if it is still \`blocked\`, runTicket's claim gate refuses it and ` +
            `the resume this run advertises dies on it. Check it by hand: bd show ${stalled.id}`,
        );
        return;
      }
      if (!reopenableAfterStop(live)) {
        console.warn(
          `[execute-epic] ${epicBeadId}: left ${stalled.id} as it stands (status ` +
            `${live.status}${ownerOf(live) ? `, held by ${ownerOf(live)}` : ""}) — it moved on ` +
            `from the timeout this run recorded, so reopening it is not this run's call`,
        );
        return;
      }
      // The retries stay INSIDE the lock: a window reopened between attempts is the same window the
      // lock exists to close, and a claim can only land in it if we let go.
      if (!(await mustPersist(() => board.setStatus(repo, stalled.id, "open")))) {
        console.error(
          `[execute-epic] ${epicBeadId}: could not reopen ${stalled.id} — it stays \`blocked\`, ` +
            `which runTicket's claim gate refuses, so the resume this run advertises would die ` +
            `on it. Clear it by hand: bd update ${stalled.id} --status open`,
        );
      }
    });
  }
}

/**
 * Every ticket that transitively depends on a ticket whose work was ROLLED BACK, and why
 * (anton-67xj).
 *
 * A ticket whose budget ran out has its partial work rolled back, so the mechanism the tickets
 * behind it were written against is not on the branch. Dispatching them anyway hands each agent a
 * premise that does not exist — the same false-success shape a cross-run blocker is held for — and
 * the zero diff that follows poisons the whole run, stranding the work its INDEPENDENT tickets
 * already committed. So they are skipped instead, and the run narrows rather than dies.
 *
 * Only a rolled-back timeout cascades, which is why this reads the ledger rather than a list of
 * ids: a ticket stopped AFTER its commit left its work on the branch — the deadline landed on the
 * bookkeeping, not the code — so the tickets behind it still have what they were written against
 * and still run.
 *
 * Breadth-first from the stopped set over the run's own `blocks` edges, so a chain a→b→c skips both
 * b and c; a ticket already recorded is never revisited, which also makes a cycle terminate.
 *
 * `tickets` is the run's WHOLE set, ABANDONED members included (PR #199) — an abandoned ticket is a
 * node the walk crosses, never a verdict it reports. Leaving it out of the graph would cut a→b→c at
 * an abandoned `b` and dispatch `c` against a mechanism the rollback took off the branch; leaving it
 * in the result would have the run skip-note a bead a human already closed.
 *
 * A ticket in `onBranch` STOPS the walk, the same rule merge finalization applies to a delivered
 * dependent ({@link undeliveredAtMerge}). Its commit is on this branch — a resume finds work an
 * earlier attempt closed and committed here, whatever rolled back further up the chain — so the
 * tickets behind it have what they were written against and must still run. Passing through one
 * would skip valid work and leave it out of the run's pull request for no reason.
 */
export function skippedDependents(
  timedOut: readonly TicketTimeoutOutcome[],
  tickets: Bead[],
  all: Bead[],
  onBranch: ReadonlySet<string> = new Set(),
): Map<string, SkipCause> {
  const ids = new Set(tickets.map((t) => t.id));
  const adj = dependentEdges(tickets, all);
  const stoppedSet = new Set(
    timedOut.filter((t) => !t.delivered && ids.has(t.id)).map((t) => t.id),
  );
  const cause = new Map<string, SkipCause>();
  const queue = [...stoppedSet];
  while (queue.length) {
    const id = queue.shift()!;
    const root = stoppedSet.has(id) ? id : cause.get(id)!.stopped;
    for (const dependent of adj.get(id) ?? []) {
      if (stoppedSet.has(dependent) || cause.has(dependent)) continue;
      if (onBranch.has(dependent)) continue; // delivered here — it and its own dependents still run
      cause.set(dependent, { waitingOn: id, stopped: root });
      queue.push(dependent);
    }
  }
  for (const t of tickets) if (beads.isAbandoned(t)) cause.delete(t.id);
  return cause;
}

/**
 * Why a skipped dependent did not run, for its own bead — the board has to say this, or the ticket
 * reads as work anton simply forgot. Names the ticket it waits on AND the stopped one at the head
 * of the chain, since for a transitive dependent those differ and only the second is actionable.
 *
 * `movedOn` is the skip that touched nothing else (PR #199 review): the board had reparented or
 * re-statused this ticket out of the run before it could be marked, so the note must not promise
 * the state anton deliberately did not write.
 */
export function skipNote(cause: SkipCause, movedOn = false): string {
  const chain =
    cause.waitingOn === cause.stopped
      ? `${cause.stopped}, which ran out of time and had its work rolled back`
      : `${cause.waitingOn}, which was itself skipped behind ${cause.stopped} — that ticket ran ` +
        `out of time and had its work rolled back`;
  return (
    `anton: not dispatched — this ticket depends on ${chain}, so the work it builds on is not on ` +
    `the run's branch and an agent could not have finished it. ` +
    (movedOn
      ? `The board moved this ticket on while the run was working, so anton left its status, ` +
        `labels and assignee exactly as they are — whoever owns it now owns this work. `
      : `Left open and unassigned; the run delivered the rest of the feature. `) +
    `Re-scope ${cause.stopped} (or raise ticketTimeoutMinutes), run it, then run this ticket.`
  );
}

/**
 * Topologically order tickets so a ticket runs after the tickets it depends on (`blocks` edges
 * among the epic's own members). Falls back to input order on a cycle.
 */
export function orderTickets(tickets: Bead[], all: Bead[]): Bead[] {
  const adj = dependentEdges(tickets, all);
  const indeg = new Map<string, number>(tickets.map((t) => [t.id, 0]));
  for (const dependents of adj.values()) {
    for (const d of dependents) indeg.set(d, (indeg.get(d) ?? 0) + 1);
  }
  const queue = tickets.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  const order: string[] = [];
  const byId = new Map(tickets.map((t) => [t.id, t]));
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  if (order.length !== tickets.length) return tickets; // cycle → original order
  return order.map((id) => byId.get(id)!);
}

/**
 * What this run DELIVERED: the tickets whose work is actually on the branch, and the set every
 * run-level step speaks for — the review contract and the PR body.
 *
 * A ticket its budget STOPPED before its commit step is not in it (anton-t1mo): its work was either
 * rolled back, or preserved on the branch as an explicitly incomplete commit (anton-d967) — and
 * preserved work is nobody's delivery, so listing it would advertise a ticket the PR body cannot
 * honestly claim and hand the review gate acceptance criteria no diff in it satisfies.
 *
 * A HUMAN ticket normally contributed none either (anton-mv70) — a person did that work outside this branch — but the
 * label says who does the work, not what the diff contains: an agent ticket committed on an earlier
 * attempt and relabelled `agent:human` before the parked run resumed is still in the diff (PR #213
 * review). So the branch is asked, and only a human ticket with nothing on it is dropped; anything
 * whose commit is present stays, because a reviewer must read every change the PR carries.
 */
export async function deliveredTickets(
  live: Bead[],
  stopped: Set<string>,
  hasCommitFor: (ticketId: string) => Promise<boolean>,
): Promise<Bead[]> {
  const delivered: Bead[] = [];
  for (const ticket of live) {
    if (stopped.has(ticket.id)) continue;
    if (beads.isHumanWork(ticket) && !(await hasCommitFor(ticket.id))) continue;
    delivered.push(ticket);
  }
  return delivered;
}
