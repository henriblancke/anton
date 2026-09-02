/**
 * The REHOME: moving the tickets a merged PR did not contain onto a run target that can still run
 * them (anton-67xj), in two halves — {@link planRehome}, which writes nothing, and
 * {@link applyRehome}, which makes every move as a guarded write against a board other operators
 * share.
 *
 * Split out of review-fix.ts (anton-qeir). The seam between the halves is load-bearing: the caller
 * finishes each preserved ticket's setup (release, reopen) BETWEEN them, while the ticket is still
 * where a re-run of finalization would find it — a reparent takes it out of the merged target's
 * subtree, so no later sweep can finish a step this one leaves undone. Which is also why the plan's
 * verdicts are re-read rather than trusted when they are applied.
 */
import { beads, ownerOf, type Bead } from "../beads/bd";
import {
  memoisedShow,
  ridesOn,
  safe,
  stateOf,
  type ReadBead,
} from "./review-fix-board";
import { safeToRerunAtMerge } from "./review-fix-delivery";
import {
  disposeFollowUp,
  resolveFollowUp,
  untouchedFollowUp,
  type FollowUpContext,
  type FollowUpHome,
} from "./review-fix-followup";

/** What {@link planRehome} decided, before any of it is applied. */
export interface RehomePlan {
  /**
   * Ticket id → its fresh read, for the ones a follow-up target may still take. A verdict with a
   * lifetime, not a licence: {@link applyRehome} reads each one again immediately before it moves
   * it, since the caller writes to these tickets in between.
   */
  takeable: Map<string, Bead>;
  /**
   * Tickets a fresh read found outside the merged target's subtree — another operator rehomed them
   * while the PR sat in review. Left exactly where they are, and told apart from a move that merely
   * failed: their note must not hand the operator a `--parent` command that would undo that.
   */
  elsewhere: Map<string, string | undefined>;
  /**
   * Tickets a fresh read no longer finds rerunnable — claimed, closed or snoozed since the sweep,
   * or reserved by an operator other than the run's own whenever that claim landed. Left where
   * they are, status untouched, and named by their live state in the note.
   */
  changed: Map<string, string>;
  /**
   * Ticket id → why anton could not decide about it at all: its own read failed, or an ancestor's
   * did. Neither takeable nor deliberately left behind — so the rehome is UNFINISHED while any of
   * these stand ({@link Rehomed.unfinished}), and the merged target stays open for the next sweep.
   */
  unknown: Map<string, string>;
}

/** Where {@link applyRehome} got to: the new target's id, and which tickets actually reached it. */
export interface Rehomed {
  id?: string;
  /** Every ticket that ended up beneath the follow-up — reparented onto it, or {@link nested}. */
  moved: Set<string>;
  /**
   * Ticket id → the ticket it stayed nested under, which anton moved onto the follow-up. These
   * reached the new target without a reparent of their own, so their note must name the parent
   * they ride on rather than claim they sit directly under the follow-up.
   */
  nested: Map<string, string>;
  /**
   * Ticket id → the ticket hanging off it that anton is NOT moving — one the plan left behind, or
   * one this merge DELIVERED that could not be detached from it. Reparenting would
   * carry that descendant onto the follow-up on its own parent edge, so the ancestor stays under
   * the merged target instead, and its note names what pinned it rather than the generic remedy.
   */
  pinned: Map<string, string>;
  /**
   * Ticket id → what changed about it between the plan and the write (pass 1a): a claim, a status,
   * or a parent another operator set while anton was finalizing. Not moved, and not handed the
   * generic remedy either — the operator is told what overtook it instead.
   */
  stale: Map<string, string>;
  /**
   * The bead a rehome anton could not finish is about: a follow-up it failed to CREATE, one it
   * could not RE-READ to decide reuse on, one a human approved or a worker claimed while the moves
   * were landing, a childless one it could not DELETE, a duplicate of another process's it could
   * not reconcile, or the merged target itself when a preserved ticket's own read failed and no
   * verdict covers it ({@link RehomePlan.unknown}). Finalization has
   * left something undone, so the caller must keep the merged target open and discoverable —
   * closing it would either strand the preserved tickets beneath a merged target nothing anton runs
   * reaches, or leave an empty run target on the board permanently, inviting the approval its own
   * description asks for.
   */
  unfinished?: string;
}

// ── pass 1: the plan ──

/**
 * Pass 1 of the rehome, and the only part of it that writes nothing: decide which of the
 * `rerunnable` tickets a follow-up target may still take, and record what disqualified the rest.
 *
 * Split from {@link applyRehome} so the caller can finish each ticket's setup before the reparent
 * detaches it (PR #199) — and because these verdicts are what tells that setup which tickets have
 * become somebody else's to decide about.
 *
 * `rerunnable` comes off the sweep's snapshot and a PR can sit in review for days: if another
 * operator has reparented a ticket onto a target of their own since, moving it here steals it out
 * from under a run that may already be executing it — which then trips that run's own ticket-set
 * drift check and parks it. A read that fails moves nothing either, for the same reason the status
 * write doesn't: the snapshot is not evidence enough on its own.
 */
export async function planRehome(
  repo: string,
  epic: Bead,
  rerunnable: Bead[],
  subtree: Bead[],
  runOwner: string | undefined,
): Promise<RehomePlan> {
  const plan: RehomePlan = {
    takeable: new Map(),
    elsewhere: new Map(),
    changed: new Map(),
    unknown: new Map(),
  };
  if (rerunnable.length === 0) return plan;

  const bySubtreeId = new Map(subtree.map((b) => [b.id, b]));
  // Every read is memoised, so a chain shared by several candidates costs one `bd show` per bead,
  // not one per walk. The memo is the PLAN's alone: applyRehome reads the board again, after the
  // writes the caller makes in between.
  const readFresh = memoisedShow(repo, new Map());
  for (const bead of rerunnable) {
    const verdict = await planVerdict(bead, {
      epic,
      bySubtreeId,
      read: readFresh,
      runOwner,
    });
    record(plan, bead.id, verdict);
  }
  return plan;
}

/** What the board now says about one rerunnable candidate. */
type PlanVerdict =
  | { kind: "takeable"; live: Bead }
  | { kind: "elsewhere"; parent: string | undefined }
  | { kind: "changed"; state: string }
  | { kind: "unknown"; why: string };

/**
 * Re-read one candidate and rule on it.
 *
 * Belonging is ANCESTRY, not the direct parent (anton-67xj). A run owns every working-layer
 * descendant of its target (runTickets), and bd nesting is arbitrary-depth — so a ticket hanging
 * off another ticket is legitimately part of this run while its parent is not the epic. Reading
 * the direct parent filed every one of those as work another operator had moved: a nested ticket
 * whose parent shipped stayed stranded under the merged target, and one whose parent moved too
 * followed it without ever passing through the reopen, so nothing could claim it.
 *
 * The whole chain is re-read, not just the candidate. `bySubtreeId` is the sweep's snapshot, and an
 * ANCESTOR another operator reparented since carries every ticket beneath it out of this run:
 * resolving the walk from the snapshot answers "still on the merged target" for work that is now
 * somebody else's, and reparents it out of their target into this follow-up.
 *
 * A read that FAILS is not a decision, and it must not read as one (PR #199 review). Dropped from
 * every verdict, the ticket is indistinguishable from one anton excluded on purpose: the rehome
 * would report itself finished and the closing batch would retire the merged target with
 * undelivered work still beneath it, out of reach of every later sweep. Recorded instead, which
 * holds the close back and has the next sweep plan the whole rehome again. An unreadable ANCESTOR
 * decides nothing either — neither that the ticket still rides on the merged target nor that
 * somebody took it.
 */
async function planVerdict(
  bead: Bead,
  args: {
    epic: Bead;
    bySubtreeId: Map<string, Bead>;
    read: ReadBead;
    runOwner: string | undefined;
  },
): Promise<PlanVerdict> {
  const { epic, bySubtreeId, read, runOwner } = args;
  const candidate = await read(bead.id);
  if (!candidate)
    return { kind: "unknown", why: "anton could not re-read it from the board" };
  const belonging = await ridesOn(candidate, epic.id, bySubtreeId, read);
  if (belonging === "unknown")
    return {
      kind: "unknown",
      why: `anton could not confirm it still hangs under ${epic.id}`,
    };
  if (belonging === "elsewhere")
    return { kind: "elsewhere", parent: beads.parentOf(candidate) };
  if (!stillRerunnable(candidate, bead, runOwner))
    return { kind: "changed", state: stateOf(candidate) };
  return { kind: "takeable", live: candidate };
}

/**
 * Whether a rerun lane the SNAPSHOT earned is one the board still grants. In the same window the
 * ticket can have been claimed, closed or snoozed in place, or taken over by another operator:
 * moving a now-active ticket hands a second run the work someone is doing, and moving a closed one
 * puts finished work under a follow-up branch that carries no commit for it, which execute-epic
 * then reads as a cross-machine resume and runs again.
 *
 * Ownership is checked here on its own, not left to the allowlist: {@link safeToRerunAtMerge}
 * weighs the assignee only on the `in_progress` lane, so an `open` or `blocked` ticket another
 * operator had already reserved BEFORE the sweep read the board passes it — and reads as no
 * takeover either, since the snapshot carries the same foreign owner. Reparenting that one
 * advertises work somebody holds under a second target. Any owner but the dead run's own is a live
 * reservation, whenever it landed.
 */
function stillRerunnable(
  candidate: Bead,
  snapshot: Bead,
  runOwner: string | undefined,
): boolean {
  const freshOwner = ownerOf(candidate);
  const heldByOther = freshOwner !== undefined && freshOwner !== runOwner;
  const tookOver = freshOwner !== undefined && freshOwner !== ownerOf(snapshot);
  return safeToRerunAtMerge(candidate, runOwner) && !heldByOther && !tookOver;
}

/** File one verdict under the lane whose note the operator will read. */
function record(plan: RehomePlan, id: string, verdict: PlanVerdict): void {
  if (verdict.kind === "takeable") plan.takeable.set(id, verdict.live);
  if (verdict.kind === "elsewhere") plan.elsewhere.set(id, verdict.parent);
  if (verdict.kind === "changed") plan.changed.set(id, verdict.state);
  if (verdict.kind === "unknown") plan.unknown.set(id, verdict.why);
}

// ── pass 2: applying it ──

/** The board reads, the verdicts and the outcome accumulators one apply pass shares. */
interface RehomeRun {
  repo: string;
  epic: Bead;
  runOwner: string | undefined;
  plan: RehomePlan;
  /** The run's whole ticket set by id — what tells a nested ticket from one moved out of the run. */
  bySubtreeId: Map<string, Bead>;
  /** Memoised reads, for the ancestry walks that only ORDER the writes. */
  readFresh: ReadBead;
  /** Evidence for a write that is about to happen: drops the memoised read and takes another. */
  reread: ReadBead;
  /** The preserved tickets the plan refused — they ride along on a reparent exactly as movers do. */
  excluded: Bead[];
  /** The subtree's DELIVERED tickets: what pass 1c detaches, and what pass 2 re-checks for. */
  shippedTickets: Bead[];
  /** The ones pass 1c took off their ancestor — anton's own write is the freshest edge there is. */
  detached: Set<string>;
  pinned: Map<string, string>;
  stale: Map<string, string>;
  moved: Set<string>;
  nested: Map<string, string>;
  /** Depth ORDER only — the edge each move is made on is re-read at the write itself. */
  liveParents: Map<string, string | undefined>;
}

/**
 * Apply the {@link planRehome} verdicts: move the tickets a merged PR did not contain, and that are
 * safe to run again, under a NEW epic — and answer that epic's id (undefined when there is nothing
 * to rehome, or bd refused). An epic with no `feature` children is a run target, so the preserved
 * work becomes claimable and runnable again — see the caller for why leaving it under the merged
 * target does not.
 *
 * Every ticket this moves has already been released and reopened by the caller (PR #199): a
 * reparent takes the ticket out of the merged target's subtree, so no later sweep can finish a step
 * this one leaves undone. Which is also why the plan's verdicts are re-checked here rather than
 * trusted: those writes are bd round-trips on a board other operators share, so ownership, status
 * and ancestry are all read once more. Twice, in fact — pass 1a decides which tickets pin their
 * ancestors BEFORE any of them move, and pass 2 then re-reads each mover and its riders adjacent to
 * the reparent that moves them, because the detaches and the earlier movers' writes in between are
 * themselves a window another worker can claim or reparent into.
 *
 * Nesting is preserved: only the ROOTS of the rehomed forest are reparented, and a ticket that
 * hangs off another moving ticket rides along on it. `subtree` is the run's whole ticket set
 * (runTickets), which is what tells a legitimately nested ticket apart from one another operator
 * moved onto a target of their own. The ride-along cuts both ways, so a ticket that still carries a
 * preserved descendant anton is NOT moving stays put as well ({@link Rehomed.pinned}), and a
 * DELIVERED descendant is detached back onto the merged target before its ancestor moves — its work
 * is in that merged diff, and carrying it onto a fresh branch is how a squash-merged ticket gets
 * re-run (pass 1c).
 *
 * Best-effort, like every other write here: a failure leaves the tickets parented where they were —
 * still open, still noted with the manual remedy — rather than aborting a finalization whose closes
 * have already landed. An epic that ends up with no children at all is deleted again, since a
 * childless epic is a poison run rather than a home.
 */
export async function applyRehome(
  repo: string,
  epic: Bead,
  plan: RehomePlan,
  runOwner: string | undefined,
  rerunnable: Bead[],
  preserved: Bead[],
  subtree: Bead[],
  all: Bead[],
): Promise<Rehomed> {
  const none: Rehomed = {
    moved: new Set(),
    nested: new Map(),
    pinned: new Map(),
    stale: new Map(),
  };
  if (rerunnable.length === 0) return none;
  // A candidate the plan could not READ is finalization left undone, whatever else this pass
  // manages (PR #199 review): nobody decided that ticket stays behind, so closing the merged target
  // over it would strand undelivered work under a target no later sweep re-selects. Carried onto
  // every outcome below rather than checked once — the moves that CAN be made are still worth
  // making, and the next sweep re-plans what is left.
  const unread = plan.unknown.size > 0 ? epic.id : undefined;
  // Nothing the plan still allows anton to move means nothing for a follow-up to hold (PR #199).
  // Creating one anyway and deleting it again writes an empty run target to a shared board twice
  // over — and a delete that fails then holds the merged target's close back for a home nobody
  // needed. Every ticket that got here belongs to somebody else now, and each says so in its note.
  if (plan.takeable.size === 0) return { ...none, unfinished: unread };

  const run = makeRehomeRun(repo, epic, plan, runOwner, preserved, subtree);
  const followUp: FollowUpContext = {
    repo,
    epic,
    all,
    ids: rerunnable.map((b) => b.id).join(", "),
    reread: run.reread,
  };
  const home = await resolveFollowUp(followUp);
  if (!home.ok) return { ...none, unfinished: home.unfinished };

  await pinStaleMovers(run);
  await pinExcluded(run);
  await detachDelivered(run);
  const taken = await moveTickets(run, home.home.id);
  return finishRehome(run, followUp, home.home, { taken, unread });
}

/**
 * A memo of this pass's OWN reads, not the plan's (PR #199). Every read here is made after the
 * caller released and reopened the preserved tickets — bd round-trips on a board other operators
 * share — so reusing the plan's reads would decide these writes on evidence from before that
 * window. A bead read in both halves is read twice; that is the price of writing against the board
 * as it is now.
 */
function makeRehomeRun(
  repo: string,
  epic: Bead,
  plan: RehomePlan,
  runOwner: string | undefined,
  preserved: Bead[],
  subtree: Bead[],
): RehomeRun {
  const memo = new Map<string, Bead | undefined>();
  const readFresh = memoisedShow(repo, memo);
  const preservedIds = new Set(preserved.map((b) => b.id));
  return {
    repo,
    epic,
    runOwner,
    plan,
    bySubtreeId: new Map(subtree.map((b) => [b.id, b])),
    readFresh,
    reread: async (id) => {
      memo.delete(id);
      return readFresh(id);
    },
    excluded: preserved.filter((b) => !plan.takeable.has(b.id)),
    shippedTickets: subtree.filter(
      (b) => b.id !== epic.id && !preservedIds.has(b.id),
    ),
    detached: new Set(),
    pinned: new Map(),
    stale: new Map(),
    moved: new Set(),
    nested: new Map(),
    liveParents: new Map(),
  };
}

/**
 * What this pass got to. A follow-up somebody took mid-pass is theirs now: not this rehome's to
 * keep filling, and not anton's to delete either, whatever did or did not reach it before the
 * takeover.
 */
async function finishRehome(
  run: RehomeRun,
  ctx: FollowUpContext,
  home: FollowUpHome,
  args: { taken: boolean; unread: string | undefined },
): Promise<Rehomed> {
  const outcome = {
    moved: run.moved,
    nested: run.nested,
    pinned: run.pinned,
    stale: run.stale,
  };
  if (args.taken) return { ...outcome, id: home.id, unfinished: home.id };
  if (run.moved.size > 0)
    return {
      ...outcome,
      id: home.id,
      unfinished: args.unread ?? home.strandedRival,
    };
  const disposed = await disposeFollowUp(ctx, home);
  return {
    ...outcome,
    unfinished: disposed ?? args.unread ?? home.strandedRival,
  };
}

// ── pass 1a/1b: the pins ──

/**
 * Pass 1a — the plan is evidence with a lifetime (PR #199). Between planRehome's reads and these
 * writes the caller released and reopened every preserved ticket, so a claim, a status change or
 * a reparent another operator made can have landed in that window: `takeable` says the follow-up
 * MAY take these tickets, not that it still may. Each one is checked against the board once more
 * before anything moves, and one that changed hands neither moves nor rides along — it pins its
 * ancestors exactly as an undelivered descendant does, since the reparent above it would carry it
 * onto the follow-up all the same.
 *
 * This pass exists to settle the PINS while nothing has moved yet: a pin has to be known before
 * the ancestor it protects is written, which is why the verdicts cannot simply be deferred to the
 * guarded writes in pass 2. They are not trusted there either — pass 2 re-reads what it is about
 * to move.
 */
async function pinStaleMovers(run: RehomeRun): Promise<void> {
  for (const mover of run.plan.takeable.values()) {
    const reason = await takenSince(run, await run.readFresh(mover.id));
    if (!reason) continue;
    run.stale.set(mover.id, reason);
    await pinAncestors(run, mover);
  }
}

/**
 * Pass 1b — a DELIVERED ticket never pins: it closed with the merge, so it holds no reservation
 * and no pending decision of its own — it is detached in 1c instead, and blocking on it would
 * strand a parent merely because part of its work shipped. A PRESERVED one the plan refused does
 * pin, for everything the pin exists for.
 */
async function pinExcluded(run: RehomeRun): Promise<void> {
  for (const bead of run.excluded) await pinAncestors(run, bead);
}

/**
 * A reparent is an edge on the ANCESTOR alone (anton-67xj), so a ticket anton is NOT moving pins
 * every takeable ancestor it hangs off: moving that ancestor would carry it onto the follow-up
 * regardless — a reservation another operator holds, or a status a human set, ends up advertised
 * under a target anton wrote, and the note telling them anton left it under the merged target
 * becomes false. So the ancestor stays where it is, named with what pinned it; its own takeable
 * descendants still flatten onto the follow-up in pass 2, exactly as when bd refuses a reparent.
 */
async function pinAncestors(run: RehomeRun, bead: Bead): Promise<void> {
  const seen = new Set<string>([bead.id]);
  let parentId = await liveParentOf(run, bead);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId); // a parent cycle terminates rather than hanging finalization
    pinTakeable(run, parentId, bead.id);
    const parent = run.bySubtreeId.get(parentId);
    if (!parent) break; // the chain left the run's subtree — nothing moving carries this ticket
    parentId = await liveParentOf(run, parent);
  }
}

/** Pin one ancestor, keeping the FIRST ticket that pinned it — that is the one the note names. */
function pinTakeable(run: RehomeRun, parentId: string, pinnedBy: string): void {
  if (run.plan.takeable.has(parentId) && !run.pinned.has(parentId))
    run.pinned.set(parentId, pinnedBy);
}

/** The parent edge as the board has it now, falling back to the snapshot when it cannot be read. */
async function liveParentOf(
  run: RehomeRun,
  bead: Bead,
): Promise<string | undefined> {
  return beads.parentOf((await run.readFresh(bead.id)) ?? bead);
}

/**
 * What has changed about a mover since the plan cleared it, as a note fragment — undefined while
 * it is still this run's to move. Ownership, status and ancestry, the same three the plan weighed,
 * because any of them can have moved on: a claim makes the ticket somebody's live work, a status a
 * human set is their decision about it, and a reparent puts it under a target that owns it now.
 *
 * Takes the read rather than making it, so the caller decides its vintage: the prepass reads
 * through the memo, pass 2 re-reads immediately before the write it is about to make.
 *
 * The whole ANCESTOR CHAIN follows that vintage, not just the mover (PR #199). Ancestry is what
 * says the ticket still belongs to the merged target, and it is decided one bead at a time: a
 * freshly read mover whose parent came out of the prepass memo still answers `target` after
 * another operator reparented that parent away, and the guarded write then moves a ticket out of
 * their subtree. So a guarded caller passes `reread`, which drops each link from the memo before
 * taking it again.
 */
async function takenSince(
  run: RehomeRun,
  live: Bead | undefined,
  read: ReadBead = run.readFresh,
): Promise<string | undefined> {
  if (!live) return "anton could not re-read it from the board";
  if (!stillRunOwn(live, run.runOwner)) return `it changed to ${stateOf(live)}`;
  return belongingNote(run, live, read);
}

/** Still unclaimed by anyone else, and still in a state the merge left rerunnable. */
function stillRunOwn(live: Bead, runOwner: string | undefined): boolean {
  const owner = ownerOf(live);
  const heldByOther = owner !== undefined && owner !== runOwner;
  return !heldByOther && safeToRerunAtMerge(live, runOwner);
}

/** Where the board now hangs this ticket, as the sentence its note needs (silent when unmoved). */
async function belongingNote(
  run: RehomeRun,
  live: Bead,
  read: ReadBead,
): Promise<string | undefined> {
  const belonging = await ridesOn(live, run.epic.id, run.bySubtreeId, read);
  if (belonging === "target") return undefined;
  if (belonging === "elsewhere")
    return `another operator moved it under ${beads.parentOf(live) ?? "a target of their own"}`;
  return `anton could not confirm it still hangs under ${run.epic.id}`;
}

// ── pass 1c: the delivered descendants ──

/**
 * Pass 1c — a DELIVERED descendant is taken off its ancestor BEFORE that ancestor moves
 * (anton-67xj). The reparent carries the whole subtree with it, so a ticket that shipped in this
 * merge would land under the follow-up too — and a squash-merge leaves none of its `<id>:` commit
 * subjects on the follow-up's fresh branch, so execute-epic reads that closed ticket as a
 * cross-machine resume: it reopens it and re-runs work the merge already shipped. Detaching it
 * onto the merged target keeps it with the diff that carries it, on a closed and terminal home
 * nothing anton runs reaches again.
 *
 * Only DIRECT children need a write — detaching one carries its own descendants with it — and a
 * detach that does not land pins the ancestor exactly as an undelivered descendant does: a move
 * anton cannot make safe must not happen at all.
 *
 * An ancestor pass 1a found STALE is skipped for the same reason it is: it is not moving, so there
 * is nothing to take the child off — and it now belongs to whoever claimed or reparented it, so
 * detaching their descendant would rewrite an edge inside somebody else's subtree.
 */
async function detachDelivered(run: RehomeRun): Promise<void> {
  for (const bead of run.shippedTickets) {
    const parentId = beads.parentOf(bead);
    if (!movingAncestor(run, parentId)) continue;
    await detachFrom(run, bead, parentId);
  }
}

/** Whether this delivered ticket's snapshot parent is one pass 2 would actually move. */
function movingAncestor(
  run: RehomeRun,
  parentId: string | undefined,
): parentId is string {
  return (
    parentId !== undefined &&
    run.plan.takeable.has(parentId) &&
    !run.pinned.has(parentId) &&
    !run.stale.has(parentId)
  );
}

/**
 * Take one delivered child off the mover it hangs under, on reads taken HERE (PR #199).
 *
 * Memo-BYPASSING, like every other guarded write: pass 1a's ancestry walks read through the memo,
 * so a delivered child that is also an ancestor of a mover is already cached by the time this
 * detach reads it — and a stale closed/unowned copy is exactly what {@link strandedByDetach}
 * clears, moving live work under a target the closing snapshot then omits.
 *
 * The ANCESTOR is re-read at the write too. `stale` only reflects pass 1a, and this detach is a bd
 * round trip — plus every earlier detach — later: an ancestor another operator has claimed or
 * reparented since is no longer moving, so there is nothing to take the child off and the detach
 * would rewrite an edge inside their subtree. Recorded as stale exactly as 1a would have, pinning
 * whatever above it would otherwise carry it onto the follow-up.
 */
async function detachFrom(
  run: RehomeRun,
  bead: Bead,
  parentId: string,
): Promise<void> {
  const shipped = await run.reread(bead.id);
  // Still the sweep's evidence until the board confirms it: a ticket another operator has since
  // moved off this ancestor rides on nothing, and detaching would rewrite an edge that is theirs.
  if (shipped && beads.parentOf(shipped) !== parentId) return;
  const takenAncestor = await takenSince(
    run,
    await run.reread(parentId),
    run.reread,
  );
  if (takenAncestor) {
    run.stale.set(parentId, takenAncestor);
    await pinAncestors(run, run.plan.takeable.get(parentId)!);
    return;
  }
  if (await detachedOntoTarget(run, bead, shipped)) {
    run.detached.add(bead.id);
    return;
  }
  await pinAncestors(run, bead);
}

/** The detach itself, refused when it would strand the child or bd turns it down. */
async function detachedOntoTarget(
  run: RehomeRun,
  bead: Bead,
  shipped: Bead | undefined,
): Promise<boolean> {
  if (!shipped) return false;
  if (strandedByDetach(run, shipped, bead)) return false;
  return safe(() => beads.reparent(run.repo, bead.id, run.epic.id));
}

/**
 * Whether detaching this child onto the merged target would STRAND it (PR #199). Delivery is the
 * sweep's verdict, and the closing batch is built from that same snapshot: a child it read as
 * `closed` is left out of the batch, so one another operator has reopened, deferred or claimed
 * since would sit open beneath a closed target nothing anton runs reaches — neither rehomed with
 * its ancestor nor closed with the merge. A claim says as much on its own, whatever the status:
 * the detach would pull live work out of the subtree its operator picked.
 */
function strandedByDetach(
  run: RehomeRun,
  live: Bead,
  snapshot: Bead,
): boolean {
  const owner = ownerOf(live);
  if (owner !== undefined && owner !== run.runOwner) return true;
  return snapshot.status === "closed" && live.status !== "closed";
}

// ── pass 2: the moves ──

/**
 * Pass 2 — move them ancestors first. A ticket whose own parent is moving rides along on it
 * rather than being flattened onto the follow-up: the nesting is how its work was scoped, and
 * reparenting it separately would hand the same subtree two homes. Ordering is what makes that
 * safe — the ride-along is decided on what actually MOVED, so a parent whose reparent bd refused
 * leaves its descendant to take a home of its own rather than staying stranded behind it.
 *
 * Answers whether the follow-up was taken mid-pass, which stops the moves where they are.
 */
async function moveTickets(
  run: RehomeRun,
  followUp: string,
): Promise<boolean> {
  for (const mover of run.plan.takeable.values())
    run.liveParents.set(mover.id, await liveParentOf(run, mover));
  for (const mover of ancestorsFirst(run.plan.takeable, run.liveParents)) {
    if ((await moveOne(run, mover, followUp)) === "taken") return true;
  }
  return false;
}

/**
 * One GUARDED move (PR #199): the mover, and everything takeable that would ride along on it, are
 * re-read here rather than trusted from pass 1a. That prepass is separated from this one by the
 * delivered-child detaches and by every earlier mover's reparent — bd round trips on a board other
 * workers share — so a claim or a reparent of their own has a real window to land in between, and
 * moving on stale evidence hands a second run work somebody is already doing.
 *
 * The FOLLOW-UP is re-read at each of those writes too. Its home was settled at the top of the
 * pass, and pass 1a, the detaches and every earlier mover sit between that decision and this write.
 * In that window a human can approve that epic, or a worker claim it, which turns it into a live
 * run: adding tickets to a run's set is the ticket-set drift that parks it. So the moves stop at
 * the first write that would land on a taken follow-up, and the merged target stays open — the next
 * sweep finds the candidate no longer untouched and gives the remainder a fresh follow-up of its
 * own. A follow-up anton just CREATED is guarded on exactly the same read (PR #199 review): being
 * seconds old makes it no less reachable, and one rule for both homes is one rule to reason about.
 */
async function moveOne(
  run: RehomeRun,
  mover: Bead,
  followUp: string,
): Promise<"taken" | "done"> {
  if (settledAlready(run, mover)) return "done";
  const live = await run.reread(mover.id);
  if (ridesOnMover(run, mover, live)) return "done";
  if (await moverBlocked(run, mover, live)) return "done";
  if (!(await homeStillOpen(run, followUp))) return "taken";
  if (await safe(() => beads.reparent(run.repo, mover.id, followUp)))
    run.moved.add(mover.id);
  return "done";
}

/** Pass 1 already ruled this mover out: it changed hands, or something pinned it in place. */
const settledAlready = (run: RehomeRun, mover: Bead): boolean =>
  run.pinned.has(mover.id) || run.stale.has(mover.id);

/**
 * Already carried by its ancestor's write — and validated as that write's rider, so it is reported
 * as what it is (nested under a mover) rather than re-decided after the fact.
 *
 * The ride-along edge is re-read for the same reason the move is guarded (PR #199): another
 * operator can have reparented a rerunnable ticket onto a DIFFERENT bead still beneath the merged
 * target, which pass 1a accepts since its ancestry still reaches the target. Riding along on the
 * PLANNED parent would issue no reparent of its own, leaving the ticket under the merged target
 * while its note told the founder it reached the follow-up.
 */
function ridesOnMover(
  run: RehomeRun,
  mover: Bead,
  live: Bead | undefined,
): boolean {
  const parentId = live ? beads.parentOf(live) : run.liveParents.get(mover.id);
  if (!parentId || !run.moved.has(parentId)) return false;
  run.nested.set(mover.id, parentId);
  run.moved.add(mover.id);
  return true;
}

/** Whatever stops this mover: it changed hands, or something that did rides along on it. */
async function moverBlocked(
  run: RehomeRun,
  mover: Bead,
  live: Bead | undefined,
): Promise<boolean> {
  const reason = await takenSince(run, live, run.reread);
  if (reason) {
    run.stale.set(mover.id, reason);
    return true;
  }
  const rider = await staleRider(run, mover.id);
  if (rider) {
    run.pinned.set(mover.id, rider);
    return true;
  }
  return false;
}

/** The follow-up is still anton's to fill, on a read taken immediately before the write. */
async function homeStillOpen(
  run: RehomeRun,
  followUp: string,
): Promise<boolean> {
  const home = await run.reread(followUp);
  return !!home && untouchedFollowUp(home);
}

/**
 * The first ticket that would RIDE ALONG on `moverId`'s reparent and is not this rehome's to move —
 * undefined while the whole subtree is still this run's. A reparent carries everything beneath it,
 * so a rider anton may no longer move stops its ancestor exactly as an excluded descendant does
 * (pass 1b): the alternative is advertising somebody's live work under a target anton wrote, on an
 * edge nobody checked.
 */
async function staleRider(
  run: RehomeRun,
  moverId: string,
): Promise<string | undefined> {
  return (
    (await staleTakeableRider(run, moverId)) ??
    (await excludedRider(run, moverId)) ??
    (await deliveredRider(run, moverId))
  );
}

/**
 * A takeable rider that changed hands since the prepass. Every candidate is re-read BEFORE it is
 * written off as a non-rider (PR #199): whether a ticket rides along is an ancestry question, and
 * the prepass answered it into the memo — a ticket another operator has since reparented beneath
 * `moverId` and claimed still reads as a SIBLING from that cache, so the ride-along test drops it
 * and the mover carries their live work onto the follow-up, the takeover check never reached.
 */
async function staleTakeableRider(
  run: RehomeRun,
  moverId: string,
): Promise<string | undefined> {
  for (const rider of run.plan.takeable.values()) {
    if (rider.id === moverId || run.moved.has(rider.id)) continue;
    const known = (await run.reread(rider.id)) ?? rider;
    if (!(await ridesOnTicket(run, known, moverId))) continue;
    if (await takenSince(run, known, run.reread)) return rider.id;
  }
  return undefined;
}

/**
 * A preserved ticket the plan EXCLUDED rides along on exactly the same edge (PR #199), and pass 1b
 * pinned on the ancestry it read THEN: one another operator reparents beneath a mover after that
 * prepass is under no pin at all, so the reparent would carry their deferred or reserved ticket
 * onto a target anton wrote. Scanning `takeable` alone never sees it. No takeover test — the plan
 * already refused this ticket, so any ride-along disqualifies the mover.
 */
async function excludedRider(
  run: RehomeRun,
  moverId: string,
): Promise<string | undefined> {
  for (const rider of run.excluded) {
    const known = (await run.reread(rider.id)) ?? rider;
    if (await ridesOnTicket(run, known, moverId)) return rider.id;
  }
  return undefined;
}

/**
 * A DELIVERED ticket rides along on that same edge too (PR #199 review), and it is in neither set
 * above: pass 1c detaches the ones whose SNAPSHOT parent was a mover, so one another operator
 * reparents beneath this mover afterwards was never inspected at all. Carrying it onto the
 * follow-up is what pass 1c exists to prevent — a squash-merged branch shows none of its `<id>:`
 * commits, so execute-epic reads the closed ticket as a cross-machine resume and reruns work the
 * merge already shipped — and if it was reopened since, the reparent pulls live work into another
 * run. No takeover test: a delivered ticket is not this rehome's to move either way, so any
 * ride-along pins the mover, exactly as a failed detach does.
 */
async function deliveredRider(
  run: RehomeRun,
  moverId: string,
): Promise<string | undefined> {
  for (const rider of run.shippedTickets) {
    if (run.detached.has(rider.id)) continue; // anton's own detach took it off this edge
    const known = (await run.reread(rider.id)) ?? rider;
    if (await ridesOnTicket(run, known, moverId)) return rider.id;
  }
  return undefined;
}

/** Whether `bead` hangs beneath `moverId` on the board as it is now. */
async function ridesOnTicket(
  run: RehomeRun,
  bead: Bead,
  moverId: string,
): Promise<boolean> {
  return (
    (await ridesOn(bead, moverId, run.bySubtreeId, run.reread)) === "target"
  );
}

/**
 * The beads of a rehome set ordered so a ticket always follows every ancestor that is moving with
 * it — depth within the set, which is stable under a sort that preserves board order among peers.
 *
 * Depth is walked over `liveParents`, the same edges the ride-along is decided on: ordering by the
 * plan's parents would place a reparented ticket ahead of the ancestor it now hangs off, and its
 * ride-along would then be judged before that ancestor had moved.
 */
function ancestorsFirst(
  takeable: Map<string, Bead>,
  liveParents: Map<string, string | undefined>,
): Bead[] {
  const parentOf = (bead: Bead): string | undefined =>
    liveParents.has(bead.id) ? liveParents.get(bead.id) : beads.parentOf(bead);
  const depth = (bead: Bead): number => {
    const seen = new Set<string>([bead.id]);
    let steps = 0;
    let parentId = parentOf(bead);
    while (parentId && !seen.has(parentId)) {
      const parent = takeable.get(parentId);
      if (!parent) break;
      seen.add(parentId); // a parent cycle terminates rather than hanging finalization
      steps++;
      parentId = parentOf(parent);
    }
    return steps;
  };
  return [...takeable.values()].sort((a, b) => depth(a) - depth(b));
}
