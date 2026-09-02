/**
 * Merge finalization (anton-ner.5): what the review-fix sweep does about a run target whose PR
 * MERGED. A merged PR is terminal, so instead of fixing review feedback the target and its
 * delivered tickets move to done, the work the run never delivered is preserved and rehomed,
 * `stage:in-review` is cleared, and the merged branch/worktree + run row are cleaned up.
 *
 * Split out of review-fix.ts (anton-qeir): the sweep drives PR feedback, this drives the merge.
 */
import {
  beads,
  ownerOf,
  type BatchOp,
  type Bead,
} from "../beads/bd";
import { claimGuard } from "../beads/claim";
import { withBeadWriteLock } from "../beads/claim-lock";
import {
  findWorktree,
  removeWorktree,
  worktreePathFor,
  type Worktree,
} from "../git/worktree";
import { findOpenRunForEpic, updateRun } from "../runs";
import { IN_REVIEW, safe, tryShow } from "./review-fix-board";
import { safeToRerunAtMerge, undeliveredAtMerge } from "./review-fix-delivery";
import { preservedNote, type PreservedSetup } from "./review-fix-notes";
import {
  applyRehome,
  planRehome,
  type RehomePlan,
  type Rehomed,
} from "./review-fix-rehome";
import type { AntonDb, Clock } from "./queue";

/**
 * The in-process lock one merged target's finalization holds (PR #199). `enqueueReviewFixIfAbsent`
 * deliberately lets two jobs reach the same target — the project-wide sweep and a gate-check's
 * targeted fix — and finalizing is a long read-decide-write sequence over the whole ticket subtree:
 * run concurrently, both read a board without a follow-up on it, each create one, and their
 * reparents then split the preserved tickets across two run targets or overwrite each other's
 * moves. Serialized, the second pass reads the board the first one left.
 *
 * Namespaced rather than keyed on the target's own bead id on purpose: the finalization takes the
 * CHILD tickets' claim locks inside it ({@link releasePreserved}), and a caller that holds a
 * ticket's lock while it waits for its parent's — `withBeadWriteLocks` acquires a set in sorted
 * order, which puts a ticket first whenever its id sorts lower — would deadlock against the
 * opposite order. No bead is named `review-fix:finalize:<id>`, so this key orders finalizations
 * against each other and against nothing else.
 *
 * In-process only, like every other lock on this seam: two anton servers sharing a board still
 * interleave (anton-od4), which is why every write below is guarded on a read of its own.
 */
const finalizeLockKey = (epicId: string): string =>
  `review-fix:finalize:${epicId}`;

/** What {@link finalizeMergedEpic} needs to finalize one merged run target. */
export interface FinalizeMergedEpicArgs {
  db: AntonDb;
  clock: Clock;
  repo: string;
  projectId: string;
  epic: Bead;
  /**
   * The run target's whole ticket subtree (runTickets), carrying its inline `blocks` edges. Open
   * ones close alongside the epic unless the run left them undelivered ({@link undeliveredAtMerge}).
   */
  children: Bead[];
  /** The merged PR's head branch — the local branch + worktree to clean up. */
  branch: string;
  /**
   * The full board — the follow-up epic's `area:` and the follow-up an interrupted earlier
   * finalization already created for this target.
   */
  all: Bead[];
}

/**
 * Finalize an epic whose PR merged: rehome the child tickets it did NOT deliver
 * ({@link undeliveredAtMerge}) onto a fresh run target, remove the merged branch + its worktree,
 * finalize the run row, and only then close the epic + the children it delivered and drop the
 * `stage:in-review` label.
 *
 * That order is the resumability contract. Closing the target is what ends this epic's life on the
 * board — inReviewEpics excludes a closed run target whatever labels it still carries — so the close
 * comes last, after every step that a stop mid-finalization would otherwise leave permanently
 * undone. Up to that line the epic stays open and `stage:in-review`, and the next review-fix sweep
 * re-selects it and finalizes again from the top; past it, the epic is done and is never finalized
 * twice.
 *
 * Which makes every step individually safe to repeat: already-closed beads are skipped,
 * removeWorktree is a no-op when the worktree/branch are already gone (execute-epic removes the
 * worktree at PR open, so it is usually already gone by merge time), and an already-finalized run
 * leaves no open run to touch.
 *
 * The rehome is the one step a later sweep can NOT resume, and the ordering inside it is what pays
 * for that (PR #199): a reparented ticket has left the target's subtree, so the next sweep's
 * `runTickets` no longer carries it and nothing still owed to it would ever be done. So the move is
 * the LAST thing done to a ticket — it is released and reopened first, while it is still where a
 * re-run of this function would find it. Only its note is written after, and a missing note is the
 * one thing that costs nobody a claim.
 *
 * All of it runs under {@link finalizeLockKey}, so two jobs racing on one merged target finalize it
 * one after the other rather than planning against the same pre-rehome board (PR #199).
 */
export function finalizeMergedEpic(args: FinalizeMergedEpicArgs): Promise<void> {
  return withBeadWriteLock(args.repo, finalizeLockKey(args.epic.id), () =>
    finalizeMergedTarget(args),
  );
}

async function finalizeMergedTarget(
  args: FinalizeMergedEpicArgs,
): Promise<void> {
  const { db, clock, repo, projectId, epic, children, branch, all } = args;
  const preserved = preservedAtMerge(epic, children);
  // The actor the finished run reserved its children for: execute-epic's claim cascade assigns
  // every child to the same operator it claimed the target for, so the target's assignee names it.
  const runOwner = ownerOf(epic);
  const rerunnable = preserved.filter((b) => safeToRerunAtMerge(b, runOwner));
  // Decide the rehome first, apply it last (PR #199). planRehome writes nothing: it answers which
  // tickets the follow-up may still take, and which ones another operator has moved out of the
  // target or moved on in place since the sweep — the verdicts the setup below must not overwrite.
  const plan = await planRehome(repo, epic, rerunnable, children, runOwner);
  const rerun = new Set(rerunnable.map((b) => b.id));
  const settled = await settlePreserved({
    repo,
    runOwner,
    preserved,
    plan,
    rerun,
  });
  // Claimable now, so the tickets the plan cleared can take their new home.
  const followUp = await applyRehome(
    repo,
    epic,
    plan,
    runOwner,
    rerunnable,
    preserved,
    children,
    all,
  );
  // Only once the moves have landed can a ticket say where it ended up, so the notes come last.
  await notePreserved({ repo, epic, preserved, settled, plan, rerun, followUp });
  await removeMergedWorktree(repo, branch);
  await finalizeRunRow(db, clock, projectId, epic.id);
  await closeFinalized(repo, epic, children, preserved, followUp);
}

/**
 * The children a merge preserves rather than closes. A merged PR does NOT mean every child shipped
 * in it (anton-67xj): a run that absorbed a ticket timeout opens its PR for the work that DID land
 * and leaves the rest undelivered — those beads are in no diff, so closing them with the target
 * would file work that was never done as shipped and lose it silently, against the note on the bead
 * telling the operator to run it. They are left open instead, and rehomed for a rerun when nothing
 * of theirs can be in the diff.
 */
function preservedAtMerge(epic: Bead, children: Bead[]): Bead[] {
  const undelivered = undeliveredAtMerge(children);
  return children.filter(
    (b) => b.id !== epic.id && b.status !== "closed" && undelivered.has(b.id),
  );
}

/** What one preserved ticket's setup is decided against. */
interface SettleContext {
  repo: string;
  runOwner: string | undefined;
  preserved: Bead[];
  plan: RehomePlan;
  /** The tickets that earned the rerun lane — the only ones a reopen is owed to. */
  rerun: Set<string>;
}

/**
 * Every preserved ticket is made claimable BEFORE it leaves the merged target's subtree (PR #199).
 * The reparent is the step that makes finalization unresumable for that one ticket: the next sweep
 * re-derives the children from the target (runTickets), and a moved ticket is no longer among them,
 * so anything still owed to it can never be picked up again. Owing it a release or a reopen is
 * exactly the state the rehome exists to prevent — a `blocked` or still-assigned ticket under the
 * un-approved follow-up parks every claim at execute-epic's gate, and no sweep would ever come back
 * for it. So the setup runs here, while the ticket is still where the next sweep would find it;
 * only the note, which has nothing to say until the move lands, waits for it.
 */
async function settlePreserved(
  ctx: SettleContext,
): Promise<Map<string, PreservedSetup>> {
  const settled = new Map<string, PreservedSetup>();
  for (const bead of ctx.preserved)
    settled.set(bead.id, await settleOne(ctx, bead));
  return settled;
}

/**
 * Hand back the reservation and the status the dead run left on one preserved ticket.
 *
 * ONLY this run's own claim, matched by actor and swapped under a CAS (anton-67xj). A PR can sit in
 * review for days, and an operator who picked a preserved ticket up in that window is doing live
 * work: clearing THAT assignee would advertise their ticket as claimable and invite a second run of
 * it. So an owner that is not the run's own — including any owner at all when the run had no
 * identity to reserve under — is left exactly as it is and named in the note instead.
 *
 * …and only while the board still reads this ticket as the dead run's. A ticket planRehome found
 * under another target, or moved on in place, may be a SECOND run's live work — and project
 * concurrency lets that run reserve it under the same actor string this one claimed under, so an
 * actor-only CAS matches and clears a valid reservation. Its claim is left exactly as its parent
 * and status are, for the same reason.
 *
 * The status is the other half: a timed-out ticket carries `blocked` from the run that stopped it,
 * and bd refuses to claim a bead in that status — so an operator who approves the follow-up target
 * would watch every attempt die at execute-epic's claim gate. The parent makes the ticket
 * reachable; the status is what makes it runnable. A ticket already `open` (a dependent skipped
 * behind the timeout) is left untouched, and one on the manual path stays `blocked` on purpose — it
 * must not become runnable.
 */
async function settleOne(
  ctx: SettleContext,
  bead: Bead,
): Promise<PreservedSetup> {
  const owner = ownerOf(bead);
  const foreignOwner = owner !== undefined && owner !== ctx.runOwner;
  const plannedElsewhere =
    ctx.plan.elsewhere.has(bead.id) || ctx.plan.changed.has(bead.id);
  const release = await releaseRunsOwn(ctx.repo, bead, owner, {
    foreignOwner,
    plannedElsewhere,
  });
  const heldElsewhere = plannedElsewhere || release === "moved";
  const stillOwned = owner !== undefined && release !== "released";
  const statusNote =
    ctx.rerun.has(bead.id) && !heldElsewhere
      ? await reopenPreserved(ctx.repo, bead, ctx.runOwner)
      : "";
  return { owner, stillOwned, foreignOwner, heldElsewhere, statusNote };
}

/**
 * Release the reservation the run that skipped this ticket still holds. Its own unassign at skip
 * time is best-effort (and older runs had none), and a claim that outlives its run hides the ticket
 * from `bd ready --unassigned` and refuses the claim cascade of whoever approves the follow-up — so
 * the rerun path the note advertises works only once ownership is cleared. When it cannot be, the
 * note says so rather than pointing at a target no one can claim through. A ticket on the manual
 * path is released too: nobody is running it, and a dead run's claim only misreports who owns the
 * review it is waiting for.
 *
 * Silent (undefined) when there is nothing this run may release: no owner, a foreign one, or a
 * board that has moved the ticket on.
 */
async function releaseRunsOwn(
  repo: string,
  bead: Bead,
  owner: string | undefined,
  args: { foreignOwner: boolean; plannedElsewhere: boolean },
): Promise<"released" | "moved" | "kept" | undefined> {
  if (owner === undefined || args.foreignOwner || args.plannedElsewhere)
    return undefined;
  return releasePreserved(repo, bead, owner);
}

/**
 * Hand back the dead run's own reservation on a preserved ticket — guarded on a read taken here,
 * not on the plan (PR #199).
 *
 * A CAS on the ACTOR alone is not enough: project concurrency lets a second run for the same
 * operator hold this ticket under the very string this one claimed under, so the swap matches and
 * clears a live reservation. What tells the two runs apart is the rest of the bead — a second run
 * reparents the ticket onto a target of its own and claims it there — so the release lands only
 * while a fresh read still finds the ticket exactly where and as the sweep left it, and a board
 * that has moved it on keeps its claim (the same rule {@link reopenPreserved} applies to the
 * status, one bd round trip later).
 *
 * That parent/status check and the unassign are ONE guarded operation (PR #199): both run inside
 * the ticket's claim-write lock, with the swap deciding on the read taken under it. Taken apart,
 * they leave a window in which a second run adopts the ticket after the read and before the swap —
 * and the actor-only CAS then clears the reservation it just made. The lock orders every claim
 * write made in THIS process (a run's `beads.claimVerified`, a human's Claim, this release); the
 * cross-process half stays open on bd's current primitives, which is why a claim is advisory at all
 * (beads/claim.ts, anton-od4).
 *
 * A read that fails releases nothing either: the snapshot is not evidence enough to clear a claim.
 *
 * Answers what the note must say — `moved` for a reservation deliberately left to whoever owns the
 * ticket now, `kept` for one bd would not release and an operator has to clear by hand.
 */
async function releasePreserved(
  repo: string,
  bead: Bead,
  owner: string,
): Promise<"released" | "moved" | "kept"> {
  return claimGuard.withClaimLock<"released" | "moved" | "kept">(
    repo,
    bead.id,
    async (swap) => {
      const live = await tryShow(repo, bead.id);
      if (!live) return "kept";
      if (ownerOf(live) === undefined) return "released"; // nothing left to hand back
      if (movedSince(live, bead, owner)) return "moved";
      // `live` was read under this lock, so it IS the swap's own re-read — hand it in rather than
      // pay for a second `bd show` that cannot say anything different.
      const swapped = await swap(owner, undefined, live).catch(() => undefined);
      return swapped?.ok ? "released" : "kept";
    },
  );
}

/** Whether the board has moved this ticket on since the sweep read it — owner, parent or status. */
function movedSince(live: Bead, snapshot: Bead, owner: string): boolean {
  return (
    ownerOf(live) !== owner ||
    beads.parentOf(live) !== beads.parentOf(snapshot) ||
    live.status !== snapshot.status
  );
}

/**
 * Return a rerunnable preserved ticket to a claimable `open`, and answer the sentence its note must
 * add when that did not happen (empty once the ticket is claimable).
 *
 * The re-read is the point (anton-67xj). `bead` comes off the sweep's snapshot and a PR can sit in
 * review for days: if another worker claimed, reopened onto its own path, or closed this ticket in
 * that window, writing `open` would downgrade their live work — or reopen finished work and
 * advertise it for a second run — on the strength of a status that was already stale. So the
 * transition lands only on a ticket a fresh read still finds exactly where the run left it and held
 * by nobody but that run (which is nobody at all once the release above succeeded). Anything else is
 * another worker's state: left alone, and named in the note instead.
 *
 * The PARENT is half of "where the run left it" (PR #199 review). Status and owner alone let an
 * unowned ticket another operator reparented onto a target of their own pass this gate — its
 * ancestry is never compared with the snapshot — and the reopen then rewrites a status INSIDE their
 * run, possibly making the ticket runnable there. {@link planRehome} declines to MOVE such a ticket
 * one bd round trip later, which does nothing about a write already made.
 *
 * Read and write are ONE guarded operation, under the same per-bead lock {@link releasePreserved}
 * takes: split, they leave a window in which a claim or a reparent lands between the evidence and
 * the write it justifies. The lock orders the claim writes made in THIS process; the cross-process
 * half stays open on bd's current primitives (beads/claim.ts, anton-od4).
 *
 * A read that fails writes nothing either — the snapshot is not evidence enough to move a status —
 * and falls back to the same manual remedy a failed write leaves behind.
 */
async function reopenPreserved(
  repo: string,
  bead: Bead,
  runOwner: string | undefined,
): Promise<string> {
  if (bead.status === "open") return "";
  return withBeadWriteLock(repo, bead.id, () =>
    reopenUnderLock(repo, bead, runOwner),
  );
}

async function reopenUnderLock(
  repo: string,
  bead: Bead,
  runOwner: string | undefined,
): Promise<string> {
  const fresh = await tryShow(repo, bead.id);
  if (!fresh) return manualStatusRemedy(bead.id, bead.status);
  if (fresh.status === "open") return "";
  if (movedOnSince(fresh, bead, runOwner)) return boardChangedNote(fresh, bead);
  const reopened = await safe(() => beads.setStatus(repo, bead.id, "open"));
  return reopened ? "" : manualStatusRemedy(bead.id, fresh.status);
}

/** The board changed after the run stopped this ticket: a status, a parent, or somebody's claim. */
function movedOnSince(
  fresh: Bead,
  snapshot: Bead,
  runOwner: string | undefined,
): boolean {
  const owner = ownerOf(fresh);
  const heldByOther = owner !== undefined && owner !== runOwner;
  return (
    fresh.status !== snapshot.status || rehomedSince(fresh, snapshot) || heldByOther
  );
}

const rehomedSince = (fresh: Bead, snapshot: Bead): boolean =>
  beads.parentOf(fresh) !== beads.parentOf(snapshot);

/** Why anton left the status alone — what the board says now, against what the run left. */
function boardChangedNote(fresh: Bead, snapshot: Bead): string {
  const owner = ownerOf(fresh);
  const rehomed = rehomedSince(fresh, snapshot);
  return (
    ` Its status is \`${fresh.status}\`${owner ? ` under ${owner}` : ""}` +
    (rehomed
      ? `, under ${beads.parentOf(fresh) ?? "no parent"} rather than the target the run left it in`
      : "") +
    ` — the board changed after the run stopped it, so anton left the status alone rather than ` +
    `reopening a ticket someone else has moved on.`
  );
}

/** A status bd refuses to claim, left for the operator to clear by hand. */
const manualStatusRemedy = (id: string, status: string): string =>
  ` Its status is also still \`${status}\`, which bd refuses to claim, so a run would stop at ` +
  `that gate: clear it with \`bd update ${id} --status open\`.`;

/** Say on each preserved ticket that the feature shipped without it, and where it lives now. */
async function notePreserved(args: {
  repo: string;
  epic: Bead;
  preserved: Bead[];
  settled: Map<string, PreservedSetup>;
  plan: RehomePlan;
  rerun: Set<string>;
  followUp: Rehomed;
}): Promise<void> {
  for (const bead of args.preserved) {
    const note = preservedNote({
      epic: args.epic,
      bead,
      setup: args.settled.get(bead.id)!,
      rerun: args.rerun.has(bead.id),
      plan: args.plan,
      followUp: args.followUp,
    });
    await safe(() => beads.note(args.repo, bead.id, note));
  }
}

/**
 * Remove the merged branch and its worktree. If the worktree is already gone (the common case),
 * removeWorktree still prunes and deletes the local branch off a synthetic descriptor.
 */
async function removeMergedWorktree(
  repo: string,
  branch: string,
): Promise<void> {
  const wt: Worktree = (await findWorktree(repo, branch)) ?? {
    path: worktreePathFor(repo, branch),
    branch,
    baseBranch: branch,
    repoPath: repo,
  };
  await safe(() => removeWorktree(wt, { deleteBranch: true }));
}

/** Finalize the run row if one is still open (a run already marked done at PR-open is left as-is). */
async function finalizeRunRow(
  db: AntonDb,
  clock: Clock,
  projectId: string,
  epicId: string,
): Promise<void> {
  const run = await findOpenRunForEpic(db, projectId, epicId);
  if (run)
    await updateRun(db, clock, run.id, {
      status: "done",
      endedAt: clock.now(),
      error: null,
    });
}

/**
 * Close the remaining open tickets and the target in ONE bd transaction (anton-aijz), children
 * first. All-or-nothing: a failure part-way leaves every bead exactly as it was, rather than a
 * half-closed unit no reader can interpret. Only drop the in-review stage once that transaction
 * lands — a transient failure (swallowed by `safe`) must leave the label in place so the next
 * review-fix sweep re-selects the epic (inReviewEpics) and retries, rather than orphaning a
 * still-open ticket/epic behind a run already marked done.
 *
 * LAST on purpose, after every other finalization write (PR #199 review). It is the CLOSE, not the
 * label, that makes this epic undiscoverable: inReviewEpics drops a closed run target whatever
 * labels it carries, so anything left undone once the target is closed can never be retried — a
 * stop between the close and the rehome would strand the undelivered children under a merged target
 * anton cannot run, which is the exact failure the rehome exists to prevent. Closing last means a
 * stop anywhere before this line leaves the epic open and still `stage:in-review`, and the whole
 * finalization re-runs next sweep: a rehomed ticket has left the subtree, so it is neither rehomed
 * nor re-noted twice, and the remainder of a partly-done rehome lands on the follow-up the
 * interrupted sweep already made rather than a second one.
 *
 * The target is never itself "preserved": a leaf run target marked undelivered has no merged PR to
 * finalize, and excluding it from the close would leave `stage:in-review` on forever, re-selecting
 * this epic on every sweep.
 *
 * A rehome anton could not FINISH is finalization left undone, so the close is held back for the
 * same reason a failure anywhere above holds it back: the epic stays open and `stage:in-review`,
 * and the next sweep retries it.
 */
async function closeFinalized(
  repo: string,
  epic: Bead,
  children: Bead[],
  preserved: Bead[],
  followUp: Rehomed,
): Promise<void> {
  const skip = new Set(preserved.map((b) => b.id));
  // By id: a leaf run target is its own ticket, so it can appear on both sides.
  const stillOpen = new Map(
    [...children, epic]
      .filter((b) => b.status !== "closed" && !skip.has(b.id))
      .map((b) => [b.id, b]),
  );
  const closed =
    followUp.unfinished === undefined &&
    (await safe(() =>
      beads.batch(
        repo,
        [...stillOpen.keys()].map((id): BatchOp => ({ op: "close", id })),
      ),
    ));
  if (closed) await safe(() => beads.untag(repo, epic.id, [IN_REVIEW]));
}
