/**
 * The FOLLOW-UP run target a merged epic's undelivered tickets are rehomed onto (anton-67xj): how
 * one is elected, created, reconciled against a racing process's duplicate, and taken back off the
 * board when nothing reached it.
 *
 * Split out of the rehome itself (anton-qeir) because it answers a question of its own — where do
 * these tickets live now — and because every step of it is a guarded write against a board other
 * operators share. Nothing here decides WHICH tickets move; see review-fix-rehome.ts for that.
 */
import { beads, LABELS, ownerOf, type Bead } from "../beads/bd";
import {
  olderOf,
  safe,
  tryList,
  type ReadBead,
} from "./review-fix-board";

/**
 * Metadata key stamping a follow-up run target with the merged target it was created for — the
 * identity that makes the rehome retryable (PR #199). `beads.create` is a persistent write and
 * every step after it can be interrupted, so a retried finalization looks the stamp up on the board
 * and reuses the follow-up it already made rather than orphaning it.
 */
const REHOME_OF = "rehomeOf";

/** What {@link resolveFollowUp} needs to find (or make) one merged target's follow-up. */
export interface FollowUpContext {
  repo: string;
  epic: Bead;
  /** The sweep's board read: the `area:` to inherit, and a first look for an existing follow-up. */
  all: Bead[];
  /** The rerunnable ticket ids, named in the follow-up's description. */
  ids: string;
  /** The rehome's own memo-bypassing reader — every decision here is a read taken now. */
  reread: ReadBead;
}

/** The home the preserved tickets may be moved onto. */
export interface FollowUpHome {
  id: string;
  /**
   * Whether the follow-up is one anton may take back off the board when nothing reaches it. A
   * target another process created is being filled by that process right now, whatever this pass's
   * board read showed — deleting it would take its tickets' only home with them.
   */
  disposable: boolean;
  /** The parentage snapshot the childless tests believe, alongside a read taken at delete time. */
  board: Bead[];
  /**
   * A losing stamped duplicate this pass could not take off the board — the merged source stays
   * open until it is settled, since a childless stamped epic nobody deletes outlives the close.
   */
  strandedRival?: string;
}

/** A home, or the bead a rehome anton could not finish is about ({@link FollowUpHome}). */
export type FollowUpResult =
  | { ok: true; home: FollowUpHome }
  | { ok: false; unfinished: string };

/**
 * Whether the follow-up is still anton's to fill: `open` and nothing else, unclaimed, unapproved.
 *
 * That is the same status test the picker applies to a run target (`picker-targets.ineligibility`)
 * and the claim gate enforces (PR #199 review). A follow-up a human deferred, or that bd left
 * `blocked`, is not a target anton can ever run: moving the remaining tickets onto it and closing
 * their merged source would put that work somewhere no sweep re-selects and no approval can start,
 * short of an undocumented status repair. Approved or claimed, it is a run of its own, and adding
 * tickets to a live run's set is the drift that parks it.
 */
export const untouchedFollowUp = (b: Bead): boolean =>
  b.status === "open" &&
  ownerOf(b) === undefined &&
  !(b.labels ?? []).includes(LABELS.approved);

/** A follow-up stamped for this merged target that is still anton's to fill. */
const stampedFor = (b: Bead, epicId: string): boolean =>
  b.metadata?.[REHOME_OF] === epicId && untouchedFollowUp(b);

/** Whether anything on `boards` hangs off `id` — any snapshot seeing a child is enough. */
const hasChildren = (boards: Bead[][], id: string): boolean =>
  boards.some((board) => board.some((b) => beads.parentOf(b) === id));

/**
 * Find the follow-up an interrupted finalization already made for this target, or make one.
 *
 * The reuse is what keeps `beads.create` idempotent (PR #199). A create lands on the board for
 * good, and everything after it — the detaches, the moves, the empty-target cleanup — can be cut
 * short: a worker that stops between them leaves a childless epic, and the next sweep (which
 * re-selects this still-open target and finalizes from the top) would create a SECOND one and
 * strand the first there permanently. Reusing it also keeps a partly-done rehome's remainder with
 * the tickets that already moved, under one target instead of two.
 */
export async function resolveFollowUp(
  ctx: FollowUpContext,
): Promise<FollowUpResult> {
  const board = await stampedBoard(ctx);
  // A list that fails proves nothing either way, and a second follow-up created on it would strand
  // the first: finalization stops short of the close instead, and the next sweep retries the whole
  // rehome.
  if (!board) return { ok: false, unfinished: ctx.epic.id };
  const election = await electFollowUp(ctx, board);
  if (!election.ok) return election;
  const strandedRival = await reconcileLosers(ctx, election.losers, board);
  if (election.reused)
    return {
      ok: true,
      home: { id: election.reused.id, disposable: true, board, strandedRival },
    };
  return createFollowUp(ctx, board, strandedRival);
}

/**
 * The board the stamped candidates are read off. A snapshot that names NO candidate is not evidence
 * that none exists (PR #199): two jobs may finalize the same merged target —
 * `enqueueReviewFixIfAbsent` counts the project-wide sweep and a gate-check's targeted fix as
 * different work — and whichever runs second holds a board read taken before the first created its
 * follow-up. Creating on that silence splits the preserved tickets across two run targets, so the
 * board itself is asked once more before anything is created.
 */
async function stampedBoard(ctx: FollowUpContext): Promise<Bead[] | undefined> {
  if (ctx.all.some((b) => stampedFor(b, ctx.epic.id))) return ctx.all;
  return tryList(ctx.repo);
}

/**
 * Elect the follow-up to reuse from EVERY stamped candidate, not the first one the board happens to
 * list (PR #199 review). Two processes that each crashed between their create and its
 * reconciliation leave two on the board, and a reuse that picks one arbitrarily never reaches the
 * rival cleanup the create path runs — the merged source then closes over a childless run target no
 * later sweep re-selects, asking the founder to approve a run with nothing in it. The election is
 * the create path's rule exactly ({@link olderOf}), so a process arriving at either entry point
 * converges on the same bead.
 *
 * Wherever a candidate is nominated, this PR sat in review for as long as it sat: the nomination
 * only POINTS AT it, and reuse is decided on a read taken here. An approval or a claim that landed
 * since is exactly the change {@link untouchedFollowUp} exists to catch. A candidate anton cannot
 * re-read decides nothing either way — and reusing a younger one while an older may still be out
 * there would split the preserved tickets across both — so finalization stops short of the close.
 */
async function electFollowUp(
  ctx: FollowUpContext,
  board: Bead[],
): Promise<
  { ok: true; reused?: Bead; losers: Bead[] } | { ok: false; unfinished: string }
> {
  const candidates: Bead[] = [];
  for (const stamped of board.filter((b) => stampedFor(b, ctx.epic.id))) {
    const live = await ctx.reread(stamped.id);
    if (!live) return { ok: false, unfinished: stamped.id };
    if (untouchedFollowUp(live)) candidates.push(live);
  }
  const reused = candidates.length > 0 ? candidates.reduce(olderOf) : undefined;
  return {
    ok: true,
    reused,
    losers: candidates.filter((b) => b.id !== reused?.id),
  };
}

/** Take the losing duplicates off the board, answering the first one that could not be settled. */
async function reconcileLosers(
  ctx: FollowUpContext,
  losers: Bead[],
  board: Bead[],
): Promise<string | undefined> {
  if (losers.length === 0) return undefined;
  // Childlessness is asked of the board as it is NOW: `board` may be this sweep's snapshot, and a
  // rival's own process can have parented tickets to it since. A list that fails proves nothing
  // against an irreversible delete, so the duplicates are left standing and the source held open.
  const now = await tryList(ctx.repo);
  if (!now) return losers[0].id;
  return deleteLosers(ctx, losers, [board, now]);
}

/**
 * Take the stamped follow-ups that LOST the election off the board — the same reconciliation
 * whichever way this pass got its home, since a childless stamped epic nobody deletes outlives the
 * merged source's close and no later sweep re-selects it.
 *
 * Only an UNTOUCHED, CHILDLESS loser, on a read taken here: one a human has since approved or a
 * worker claimed is a run of its own, and one that already carries tickets is a real home —
 * `bd delete --force` does not cascade, so removing it would strand its children parentless.
 * `boards` are the parentage snapshots to believe; any of them seeing a child is enough. A loser
 * anton cannot settle is answered back to the caller rather than deleted on a guess.
 */
async function deleteLosers(
  ctx: FollowUpContext,
  losers: Bead[],
  boards: Bead[][],
): Promise<string | undefined> {
  let stranded: string | undefined;
  for (const loser of losers) {
    const live = await ctx.reread(loser.id);
    if (!live) {
      stranded ??= loser.id;
      continue;
    }
    if (!deletableLoser(live, boards)) continue;
    if (!(await safe(() => beads.delete(ctx.repo, loser.id))))
      stranded ??= loser.id;
  }
  return stranded;
}

/** A loser anton may remove: still nobody's run, and still nothing's home. */
const deletableLoser = (live: Bead, boards: Bead[][]): boolean =>
  untouchedFollowUp(live) && !hasChildren(boards, live.id);

/**
 * Create the follow-up, then reconcile it against a duplicate a racing process made.
 *
 * A follow-up anton could not create is finalization left undone, exactly like a childless one it
 * could not delete (PR #199): the preserved tickets are still parented to the merged target, and
 * closing that target is what puts them out of reach for good — no later sweep re-selects a closed
 * run target, so nothing would ever retry the create.
 */
async function createFollowUp(
  ctx: FollowUpContext,
  board: Bead[],
  strandedRival: string | undefined,
): Promise<FollowUpResult> {
  const created = await newFollowUpEpic(ctx);
  if (!created) return { ok: false, unfinished: ctx.epic.id };
  return reconcileCreate(ctx, board, created, strandedRival);
}

/**
 * The follow-up bead itself. Deliberately NOT `approved`: approval is the founder's gate, and
 * re-running work a run already failed to deliver — after a timeout, possibly needing re-scoping
 * first — is exactly the decision that gate exists for. It carries the epic-tier contract (an
 * outcome and Success Criteria) so the approve route and execute-epic's own gate admit it rather
 * than refusing a target anton wrote.
 */
async function newFollowUpEpic(
  ctx: FollowUpContext,
): Promise<string | undefined> {
  const area = areaLabelOf(ctx.epic, ctx.all);
  try {
    return await beads.create(ctx.repo, {
      title: `${ctx.epic.title} — undelivered tickets`,
      type: "epic",
      // The roadmap groups by `area:`, and the contract wants exactly one: inherit the merged
      // target's so the follow-up lands in the same column its work was always meant to ship in.
      labels: area ? [area] : [],
      // Written in the SAME call as the bead, so no window exists in which the follow-up is on the
      // board without the stamp a retry finds it by.
      metadata: { [REHOME_OF]: ctx.epic.id },
      description:
        `The pull request for ${ctx.epic.id} merged without ${ctx.ids}. The run that opened it ran ` +
        `out of time, so that work is in no diff — this epic is its home, because a ticket parented ` +
        `to an already-merged target is not something anton can run.\n\n` +
        `Approve this epic to have anton pick the work back up; re-scope or close the tickets ` +
        `first if the timeout means they were too big.`,
      acceptance: `- [ ] Every ticket below is delivered, or closed as no longer wanted.`,
    });
  } catch {
    return undefined;
  }
}

/**
 * A create is not a CLAIM (PR #199 review). The finalize lock orders finalizations inside one
 * process; two anton servers sharing a board both read a stamp-free board and both create, and bd
 * offers no board-level uniqueness to key the create on (anton-od4). So the create is followed by
 * the same verify-after-the-fact a claim uses — read the stamp back off the board, and let the
 * OLDEST follow-up win. That rule converges without either process seeing the whole race: a process
 * whose read predates its rival's create is necessarily the older one, so keeping its own is the
 * same verdict the rival reaches when it sees both.
 *
 * A list that fails cannot rule a duplicate out, and filling a home that may be one splits the
 * preserved tickets across two run targets. The follow-up keeps its stamp, so the next sweep reuses
 * this very epic and reconciles then.
 */
async function reconcileCreate(
  ctx: FollowUpContext,
  board: Bead[],
  followUp: string,
  strandedRival: string | undefined,
): Promise<FollowUpResult> {
  const afterCreate = await tryList(ctx.repo);
  if (!afterCreate) return { ok: false, unfinished: followUp };
  const rivals = rivalsOf(ctx, afterCreate, followUp);
  const home = { id: followUp, disposable: true, board };
  if (rivals.length === 0) return { ok: true, home: { ...home, strandedRival } };
  const mine = await ctx.reread(followUp);
  if (!mine) return { ok: false, unfinished: followUp };
  const winner = [mine, ...rivals].reduce(olderOf);
  if (winner.id !== followUp)
    return deferToRival(ctx, board, followUp, winner, afterCreate);
  // Ours WON, so the rivals that lost are ours to reconcile too (PR #199 review). A live rival
  // process deletes its own duplicate the moment it sees this one — but a process that crashes
  // right after its create never gets there, and cleanup that only ever runs on this process's own
  // loser leaves that childless stamped epic on the board for good.
  const stranded = await deleteLosers(ctx, rivals, [afterCreate]);
  return { ok: true, home: { ...home, strandedRival: strandedRival ?? stranded } };
}

/**
 * The UNTOUCHED stamped epics that are not ours — the same set reuse selects from (PR #199 review).
 * A stamped follow-up a human already approved, or an operator claimed, is a run of its own;
 * counting it here would elect it the older winner, delete the home just created, then reject the
 * winner as non-untouched. The remaining tickets would be rehomed by no sweep and the merged target
 * could never close, since every later pass repeats that create-and-delete. A rival worth
 * converging on is by construction untouched: it was created moments ago by a process racing this
 * one.
 */
function rivalsOf(
  ctx: FollowUpContext,
  afterCreate: Bead[],
  followUp: string,
): Bead[] {
  return afterCreate.filter(
    (b) => b.id !== followUp && stampedFor(b, ctx.epic.id),
  );
}

/**
 * Ours is the duplicate: take it off the board before anything can land on it, and move onto the
 * winner instead — the rival reaches that same bead, so the preserved tickets stay under one
 * target. A delete that fails leaves finalization undone rather than a second run target on the
 * board asking to be approved.
 *
 * …unless the winner has since become somebody's run, which is the one thing tickets must not be
 * added to. Decided on a read taken HERE, not on the list snapshot the winner came out of: the
 * rival's own process may have had it approved or claimed in that window. Left to the next sweep,
 * which finds no untouched candidate and creates a fresh follow-up of its own.
 */
async function deferToRival(
  ctx: FollowUpContext,
  board: Bead[],
  followUp: string,
  winner: Bead,
  afterCreate: Bead[],
): Promise<FollowUpResult> {
  if (!(await dropOurDuplicate(ctx, followUp, afterCreate)))
    return { ok: false, unfinished: followUp };
  const live = await ctx.reread(winner.id);
  if (!live || !untouchedFollowUp(live))
    return { ok: false, unfinished: ctx.epic.id };
  return { ok: true, home: { id: winner.id, disposable: false, board } };
}

/**
 * Delete the duplicate this pass created — but only while it is still ANTON'S to delete, on a read
 * taken HERE rather than on the one the winner was elected from (PR #199 review). `beads.delete` is
 * irreversible, and a human approving this epic or a worker claiming it is exactly what the losing
 * rivals are guarded against; the same window sits between that election read and this call.
 *
 * CHILDLESSNESS is re-read here too (PR #199 review). `untouchedFollowUp` answers who OWNS the
 * follow-up, not what now hangs off it, and this branch never reaches the childless cleanup a
 * finished pass runs — a losing duplicate is deleted the moment the election names it. Its stamp
 * makes it a reuse candidate for any other sweep of this same merged target, so another process can
 * be parenting tickets to it right now while it is still open, unassigned and unapproved; `bd
 * delete --force` does not cascade, so deleting it would leave those tickets parentless. A list
 * that FAILS proves nothing against the irreversible half — either way the duplicate is left
 * standing and the source held open, and the next sweep converges.
 */
async function dropOurDuplicate(
  ctx: FollowUpContext,
  followUp: string,
  afterCreate: Bead[],
): Promise<boolean> {
  const ours = await ctx.reread(followUp);
  if (!ours || !untouchedFollowUp(ours)) return false;
  const beforeDelete = await tryList(ctx.repo);
  if (!beforeDelete) return false;
  if (hasChildren([afterCreate, beforeDelete], followUp)) return false;
  return safe(() => beads.delete(ctx.repo, followUp));
}

/**
 * Nothing moved — the epic is a childless run target no one asked for. Take it back off the board,
 * unless something already hangs off it: a REUSED follow-up an earlier sweep moved tickets onto, or
 * one another operator has filled since — deleting either would take those tickets' only home with
 * it. Nor one a CONCURRENT process created and is filling right now (`disposable`) — its children
 * may not be on any read this pass can take.
 *
 * Nor one that has since become somebody's RUN (PR #199 review). `beads.delete` is an irreversible
 * `bd delete --force`, and this pass has been reading and writing a shared board since the
 * follow-up was created or reused — its own description asks to be approved, so a human approving
 * it or a worker claiming it in that window is exactly the outcome it invites.
 *
 * CHILDLESSNESS is re-read here too: `untouchedFollowUp` says nothing about what now HANGS off the
 * epic, and for one anton just created there is no snapshot that could answer it at all. A list
 * that FAILS proves nothing either way, and the delete is the irreversible half.
 *
 * Answers the bead a delete that did NOT land is about (PR #199), which keeps the merged target
 * open and `stage:in-review` rather than closing it — a swallowed cleanup failure would strand the
 * childless follow-up on the board for good, and its own description asks to be approved, which
 * puts an empty run target into the claimable queue where execution can only park on "nothing left
 * to run". Left discoverable, the next sweep reuses this same follow-up and retries the delete.
 */
export async function disposeFollowUp(
  ctx: FollowUpContext,
  home: FollowUpHome,
): Promise<string | undefined> {
  if (!home.disposable) return undefined;
  const live = await ctx.reread(home.id);
  if (!live) return home.id;
  if (!untouchedFollowUp(live)) return ctx.epic.id;
  const now = await tryList(ctx.repo);
  if (!now) return home.id;
  if (hasChildren([home.board, now], home.id)) return undefined;
  return (await safe(() => beads.delete(ctx.repo, home.id)))
    ? undefined
    : home.id;
}

/**
 * The `area:` label a merged target's follow-up epic inherits: the target's own, else the nearest
 * ancestor that carries one.
 *
 * Walking up is what makes this work for the normal shape (anton-67xj). A `feature` run target
 * carries no `area:` of its own — the Add-work path puts it on the PRODUCT EPIC above the feature
 * (lib/backlog.ts) and every roadmap/board reader resolves it from there. Reading only the merged
 * target's labels would leave the follow-up arealess: ungrouped on the roadmap, missing the Linear
 * routing key, and flagged by the contract validator — and it has no parent of its own to derive
 * one from, since it lands top-level.
 */
function areaLabelOf(bead: Bead, all: Bead[]): string | undefined {
  const seen = new Set<string>();
  let current: Bead | undefined = bead;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); // a parent cycle terminates rather than hanging finalization
    const area = (current.labels ?? []).find((l) => l.startsWith("area:"));
    if (area) return area;
    const parent = beads.parentOf(current);
    current = parent ? all.find((b) => b.id === parent) : undefined;
  }
  return undefined;
}
