/**
 * What a run takes HOLD of once its lease is confirmed (anton-1lix — extracted from
 * execute-epic.ts): the checkout it executes in, and the reservations that stop every other worker
 * on a shared board from picking up the same tickets.
 *
 * Everything here writes — to the filesystem or to the board — so it runs strictly after the
 * read-only gates in {@link prepareEpicRun}: a refusal past this line has residue to hand back.
 */
import { beads, LABELS, unclaimableStatus } from "../beads/bd";
import { ownerOf } from "../beads/claim";
import { assignChildren, formatReservedChildren } from "../beads/child-assign";
import { latestBlockNoteCommit } from "../beads/block-note";
import { parseTicketNotes } from "../beads/notes";
import { latestSatisfiedRecord } from "../beads/satisfied-note";
import { commitParentShas, isAncestor, resolveCommitSha, resolveForkPoint, resolveFreshBase } from "../git/ops";
import {
  acquireWorktreeClaim,
  branchExists,
  createWorktree,
  releaseWorktreeClaim,
  removeWorktree,
  warmWorktreeBestEffort,
  type MutatingRefreshOutcome,
  type Worktree,
} from "../git/worktree";
import type { PendingRefresh } from "../runs";
import { resolveOperator } from "../operator";
import {
  BRANCH_RECREATED_REFRESH_TOMBSTONE,
  findPendingRefreshShaForBranch,
  findRunBaseForkShaForBranch,
  findRunBaseRefreshShaForBranch,
  getRunBaseForkSha,
  PENDING_REFRESH_OUTCOME,
  updateRun,
} from "../runs";
import { PoisonEpic } from "./errors";
import { safe } from "./safe";
import type { EpicRun } from "./execute-epic-run";
import type { StepContext } from "./step-registry";

/**
 * Who a run is, as its worktree claim records it. The RUN id, not the epic's: a resumed attempt takes
 * a fresh claim of its own, and naming the run is what makes a leftover claim traceable to the
 * attempt that took it — the same reason review-fix keys its owner by job id.
 */
export function claimOwnerFor(runId: string): string {
  return `execute-epic#${runId}`;
}

/**
 * Whether a dead attempt's pending mutation (see PENDING_REFRESH_OUTCOME) actually landed on
 * `branch`, verified with evidence specific to WHICH git operation it was (PR #279 review, P1,
 * seventh round) — not by "the target base is reachable and the branch moved off its pre-mutation
 * tip," which any unrelated commit landing on that tip satisfies just as well. A `pre-rebase` hook
 * that commits as a side effect before rejecting the rebase is exactly that: the branch moves off
 * `pendingRefresh.fromSha`, and `pendingRefresh.sha` — the rebase's unapplied TARGET — can already be
 * an ancestor of the branch regardless (an authoritative rewind is already reachable from the
 * branch's own pre-rewind history), so the old, kind-blind check would promote a rebase that never
 * ran, and a later `--onto` refresh derived from it replays commits the rewind meant to drop.
 *
 * Each operation leaves a different, checkable trace:
 * - `fast_forwarded` moves the branch to EXACTLY `pendingRefresh.sha` — nothing else produces that.
 * - `merged` leaves a tip whose parents are exactly the pre-mutation tip and the merged-in base.
 * - `rebased` always replays onto brand-new commit objects: a landed rebase makes the pre-mutation
 *   tip UNREACHABLE from the new one, which the hook side-effect shape above does not (the hook's
 *   commit sits directly on top of the untouched pre-mutation tip).
 *
 * Undefined `kind` (a pending row written before this field existed, or one whose `beforeMutate` call
 * predates it) fails closed, same as an undefined `fromSha` already does: there is no confirmation
 * shape to check, so the pending sha is never trusted.
 *
 * A MISSING branch also fails closed, checked before any operation-specific probe runs (PR #279
 * review, P2): an operator can delete a crashed attempt's checkout and branch between the crash and
 * this resume, and every probe below reads `refs/heads/<branch>` directly — `rev-parse --verify` and
 * `merge-base --is-ancestor` both throw on a ref that doesn't exist, rather than the clean exit-1
 * `isAncestor` already knows how to read as "no". Left unchecked, that throw would propagate out of
 * `warmRunWorktree` before `createWorktree` ever runs, so the branch's recreation path — the one
 * this exact situation is supposed to reach — is never given the chance to fire. Treating "branch
 * gone" as "mutation not confirmed" is correct, not just safe: a deleted branch belongs to a
 * generation `createWorktree` is about to replace, so nothing here needs confirming against it.
 */
async function confirmPendingRefreshMutation(
  repo: string,
  branch: string,
  pendingRefresh: Pick<PendingRefresh, "sha" | "kind"> & { fromSha: string },
): Promise<boolean> {
  if (!(await branchExists(repo, branch))) return false;
  const ref = `refs/heads/${branch}`;
  const kind = pendingRefresh.kind as MutatingRefreshOutcome | undefined;
  switch (kind) {
    case "fast_forwarded": {
      const tip = await resolveCommitSha(repo, ref);
      return tip === pendingRefresh.sha;
    }
    case "merged": {
      const tip = await resolveCommitSha(repo, ref);
      const parents = await commitParentShas(repo, tip);
      return parents.includes(pendingRefresh.fromSha) && parents.includes(pendingRefresh.sha);
    }
    case "rebased":
      return (
        (await isAncestor(repo, pendingRefresh.sha, ref)) &&
        !(await isAncestor(repo, pendingRefresh.fromSha, ref))
      );
    default:
      return false;
  }
}

/**
 * Which of `pinnedBase`/`shippedFallback` a dirty-resume checkout's already-shipped claims should be
 * checked against (PR #279 review, P1: excluding the newest base already present on dirty branches).
 *
 * `shippedFallback` is always something the branch is already confirmed to hold — the fork point
 * itself, or a refresh {@link confirmPendingRefreshMutation} (or a prior clean resume) verified
 * actually landed — so it is always a safe answer. `pinnedBase` is only what a dirty resume's fresh
 * base RESOLUTION saw; `refreshOntoBase` skipped applying it, so nothing here guarantees the branch
 * ever actually merged it.
 *
 * Three cases:
 * - `shippedFallback` is the more advanced side (or the two coincide) — the ordinary case, and also
 *   the offline lag where a dirty resume's fresh-base resolution fell back to a stale LOCAL ref
 *   behind a refresh a prior resume already applied. `shippedFallback` wins outright; it costs
 *   nothing to prefer it here since it is never behind what the branch can truthfully cite.
 * - Neither is an ancestor of the other — a genuine divergence, the shape a history-rewriting
 *   force-push leaves. Falls through to `pinnedBase`, the freshest resolved value: `shippedFallback`
 *   could cite a commit the rewrite already dropped.
 * - `pinnedBase` is the more advanced side. Newer alone isn't enough to trust it — an ordinary
 *   `skipped_dirty` never merged it — so it wins only when it is ALSO reachable from the branch tip
 *   (a prior attempt already landed the same commit this resume's resolution independently sees).
 *   Otherwise falls back to the always-safe `shippedFallback`.
 */
async function resolveComparableBase(
  worktreePath: string,
  branch: string,
  pinnedBase: string,
  shippedFallback: string,
): Promise<string> {
  if (await isAncestor(worktreePath, pinnedBase, shippedFallback)) return shippedFallback;
  if (!(await isAncestor(worktreePath, shippedFallback, pinnedBase))) return pinnedBase;
  return (await isAncestor(worktreePath, pinnedBase, `refs/heads/${branch}`)) ? pinnedBase : shippedFallback;
}

/** Step 2. Warm (or reuse) the run's checkout and build the context every step is narrowed from. */
export async function warmRunWorktree(
  run: EpicRun,
): Promise<{ worktree: Worktree; runStep: Omit<StepContext, "tickets"> }> {
  const {
    db,
    clock,
    ctx,
    projectId,
    repo,
    runId,
    branch,
    project,
    settings,
    lease,
    target,
    tickets,
  } = run;
  // 2. Warm worktree (idempotent — reused on resume). Branch off the FRESHEST base
  // (anton-x3o): resolveFreshBase fetches origin/<base> and returns `origin/<base>` so a run
  // whose local base is stale still starts at the remote tip; it's best-effort and falls back
  // to the local base offline. On resume, createWorktree short-circuits to the existing
  // worktree, but the `refresh: true` below (anton-s55u) still brings a reused checkout up to
  // this freshly-resolved base before returning it — see refreshOntoBase's own doc comment for
  // how. Note the PR `base` below stays the plain branch name (gh needs a branch, not a
  // remote-tracking ref).
  const baseBranch = settings.baseBranch ?? project.defaultBranch;
  // Held for the review gate below too: it diffs the branch against this base's MERGE BASE, so
  // the remote-tracking ref is the accurate fork point even when the local base has drifted.
  // `resolveFreshBase` returns `origin/<baseBranch>` only once it has fetched AND verified that ref
  // (anton-nyz1v, PR #279 review, fifth round) — anything else falls back to the plain local
  // `<baseBranch>` name instead, but that fallback covers two shapes `refreshOntoBase` must NOT
  // treat alike (P1, PR #279 review, sixth round). A FAILED fetch (this repo HAS an origin, just
  // couldn't reach it) is merely stale: a base reading behind the branch's own fork point there
  // just means the last successful fetch predates a commit the branch already forked from — safe
  // to leave alone. A repo with NO origin at all has nothing to be stale relative to — the local
  // branch IS the only source of truth, so an intentional rewind behind that fork point is exactly
  // as authoritative as a confirmed fetch reporting the same shape from a remote would be; treating
  // it as a stale fallback would let the branch's eventual diff silently reintroduce whatever the
  // rewind dropped. See `baseIsAuthoritative`'s own doc comment on `refreshOntoBase`.
  //
  // `baseIsAuthoritative` comes straight from `resolveFreshBase` rather than a second `hasRemote`
  // probe here (PR #279 review, P1): a redundant re-probe can fail for an operational reason that
  // has nothing to do with whether `origin` exists, and `hasRemote` folding that into the same
  // `false` it returns for a confirmed-absent remote would wrongly mark a stale local fallback
  // authoritative. `resolveFreshBase` already made this determination once, from its own single
  // `hasRemote` call; carrying it out here removes the second probe entirely.
  const { ref: freshBase, baseIsAuthoritative } = await resolveFreshBase(repo, baseBranch);
  // Claim the checkout for the whole run (anton-hrun.1). The claim's `git worktree lock` is the
  // ONLY evidence a second anton process over this repository has that the directory is in use:
  // its teardown and its sweep judge residue from their own run rows and the board, which say
  // nothing about a run on this machine, so an unclaimed checkout on a still-open bead reads as
  // "release the worktree" and is force-removed with this run's uncommitted work in it.
  const worktreeClaim = claimOwnerFor(runId);
  run.worktreeClaim = worktreeClaim;
  await acquireWorktreeClaim(repo, branch, worktreeClaim);
  // Commits a satisfied-note already cites as this ticket's evidence (anton-8h4b), for THIS branch —
  // a note from elsewhere proves nothing here (the same filter notedSatisfaction applies). A refresh
  // that rebased one of these out from under the board would leave the note pointing at an object
  // the branch no longer carries (PR #279 review), so refreshOntoBase merges instead when it finds one.
  const satisfiedShas = tickets
    .map((t) => latestSatisfiedRecord(t.notes))
    .filter((record): record is NonNullable<typeof record> => record !== undefined && record.branch === branch)
    .map((record) => record.commit);
  // A block note's committed sha is just as durable a reference as a satisfied note's (PR #279
  // review): a ticket that fails after committing, or times out with preserved work, records its
  // branch tip via `blockNoteEvidence`; a human later closing or reopening that ticket leaves the
  // note in place while a clean resume can still rebase the branch onto an advanced base. Without
  // this, only satisfied-note shas were protected, so the rebase would rewrite the commit the
  // still-durable block note names and its review evidence would go unreachable.
  const blockNoteShas = tickets
    .map((t) =>
      latestBlockNoteCommit(
        parseTicketNotes(t.notes)
          .filter((n) => n.source === "system")
          .map((n) => n.text),
      ),
    )
    .filter(
      (record): record is { committed: true; branch: string; head: string } =>
        record !== undefined && record.committed && record.branch === branch && record.head !== undefined,
    )
    .map((record) => record.head);
  const preserveShas = [...satisfiedShas, ...blockNoteShas];
  // The fork commit a PRIOR ATTEMPT on this branch already pinned, if any (PR #279 review) —
  // resolved BEFORE the checkout is created/reused so a REUSED checkout's refresh below can rebase
  // with `--onto` that exact boundary instead of the plain one-argument form, which would otherwise
  // replay commits from the ORIGINAL base as if they were this branch's own once `baseBranch` has
  // been rewritten past the branch's true fork point (see refreshOntoBase's `forkSha` doc). Branch-
  // scoped only, not this run's own row too: THIS row is fresh far more often than not (a retry after
  // an ordinary failure opens one), and re-reading it here as well would consume the same pin-read
  // the try block below performs as its own atomic setup step — harmless when it succeeds, but a
  // rejection there is exactly what the try block's own cleanup path exists to catch, and firing it a
  // second time earlier would answer to a checkout this call hasn't created yet. Harmless to resolve
  // even when the checkout turns out to be freshly created: refreshOntoBase never runs for one, so
  // the value is simply unused.
  const knownForkSha = await findRunBaseForkShaForBranch(db, projectId, run.targetId, branch);
  // The last EFFECTIVE (non-`skipped_dirty`) refresh this branch received, from whichever row on it
  // recorded one — branch-scoped, not this run's own row alone, for the same reason `knownForkSha`
  // above is (findRunBaseRefreshShaForBranch's own doc comment): an ordinary handler failure settles
  // its row `failed`, and the retry opens a FRESH row while reusing the same branch and worktree, so
  // scoping to one row would miss a refresh an earlier, now-dead row on this branch already recorded.
  //
  // Preferred over `knownForkSha` as the `--onto` rebase boundary below (PR #279 review): after one
  // successful `--onto` refresh, the branch's ORIGINAL fork point is no longer reachable on it at all
  // (the rebase replayed only what came after it, onto the new base) — passing `knownForkSha` on a
  // later refresh would find it missing and silently fall back to the plain, unsafe form of rebase.
  // The most recently applied base IS still on the branch — it's what everything got rebased onto —
  // and describes exactly the boundary a second `--onto` needs.
  const priorEffectiveRefreshSha = await findRunBaseRefreshShaForBranch(db, projectId, run.targetId, branch);
  // A PRIOR attempt on this branch may have started a merge/rebase/fast-forward and never lived to
  // finalize its row with the real outcome (PR #279 review, P1) — `beforeMutate` below is what
  // leaves that "pending" trace, for exactly the process-killed-mid-mutation gap the finalize write
  // in the try block can't cover on its own (a hard kill runs no catch). Not trusted blindly: a kill
  // BEFORE the mutating git call ever ran leaves this pending but never applied, and preferring it
  // regardless would derive `--onto` from a boundary the branch was never actually moved onto.
  //
  // Reachability against the branch's CURRENT history alone can't settle that, though (PR #279
  // review, P1 re-review): when the authoritative base is REWOUND — say from `A-B` back to `A` — the
  // pending target `A` is already an ancestor of a branch cut at `A-B-W` before any rebase ever runs,
  // exactly as it would be once one actually lands. A resume trusting reachability alone here would
  // derive `--onto`'s boundary from `A` regardless, and `git rebase --onto <newbase> A` replays `B` —
  // history the rewind dropped — back onto the branch as if it were the branch's own work.
  //
  // The tie is broken with evidence specific to WHICH git operation the pending mutation was
  // attempting (PR #279 review, P1, seventh round) — not by asking merely whether the branch moved
  // off its recorded pre-mutation tip. Any commit landing on `pendingRefresh.fromSha` satisfies "the
  // branch moved" (a `pre-rebase` hook can commit as a side effect before rejecting the rebase
  // itself), and in the authoritative-rewind shape above `pendingRefresh.sha` is already reachable
  // from that same `fromSha` regardless of whether anything ever actually rebased onto it — so
  // neither signal alone, nor their conjunction, tells a landed mutation apart from an unrelated one
  // that happened to move the branch off the same tip. `confirmPendingRefreshMutation` checks each
  // operation's own specific trace instead — see its own doc comment. A row written before `fromSha`
  // or `kind` existed has nothing to check against and fails closed: its pending sha is never
  // trusted. Every probe it makes is `isAncestor`, which only resolves `false` for git's own exit-1
  // "no" and rethrows anything else (PR #279 review, P1 fix) — an operational failure here fails the
  // resume loudly rather than silently discarding a real boundary or trusting a stale one.
  const pendingRefresh = await findPendingRefreshShaForBranch(db, projectId, run.targetId, branch);
  let reconciledRefreshSha = priorEffectiveRefreshSha;
  if (
    pendingRefresh !== undefined &&
    pendingRefresh.fromSha !== undefined &&
    pendingRefresh.sha !== priorEffectiveRefreshSha &&
    (await confirmPendingRefreshMutation(repo, branch, {
      sha: pendingRefresh.sha,
      fromSha: pendingRefresh.fromSha,
      kind: pendingRefresh.kind,
    }))
  ) {
    reconciledRefreshSha = pendingRefresh.sha;
  }
  // Set from within `beforeCreate` below, before `createWorktree` ever cuts the branch — see that
  // callback's own doc comment for why the write (and this flag) can no longer wait until after.
  let isRecreatedBranch = false;
  const worktree = await createWorktree({
    repoPath: repo,
    branch,
    baseBranch: freshBase,
    // Warmed explicitly below, AFTER the refresh boundary this call may just have rebased/merged
    // the branch onto is safely persisted (anton-s55u, PR #279 review, P1) — warming can run for
    // minutes, and a process killed mid-warm must not leave a mutated branch with nothing recording
    // what it was refreshed onto, or a resume after the crash re-derives a boundary against a base
    // that may have moved again since, risking the same resurrected-commit bug the pin prevents.
    warm: false,
    claimedBy: worktreeClaim,
    // anton-s55u: a resumed run must implement against the tree it will merge into, not whatever
    // base a parked or failed prior attempt cut this branch from. Safe here specifically: this
    // branch tracks `baseBranch` by construction (unlike review-fix's PR branches, which diverge
    // from base by design and must never be rebased underneath an already-pushed PR).
    refresh: true,
    preserveShas,
    forkSha: reconciledRefreshSha ?? knownForkSha,
    baseIsAuthoritative,
    // The write-ahead half of the pending-refresh recovery above (PR #279 review, P1): persisted
    // BEFORE refreshOntoBase's mutating fast-forward/merge/rebase call, under the same branch lock,
    // so a process killed anywhere after this point — mid-mutation, or after it lands but before
    // this call returns and the normal finalize write below runs — leaves a durable trace of the
    // boundary the mutation targeted instead of nothing at all. NOT best-effort (PR #279 review, P2
    // — swallowing this used to let the caller proceed regardless): a failure to persist intent here
    // means the mutation is about to run with no write-ahead record at all, exactly the unrecorded-
    // mutation gap this mechanism exists to close, so the rejection propagates and the mutating call
    // never runs. `refreshOntoBase` awaits this before touching the branch, so the checkout is left
    // untouched — the retry that follows finds the same, still-unmutated branch.
    // `priorBaseRefreshSha` alongside the pending marker (PR #279 review, P1): this write is about to
    // overwrite THIS row's own `baseRefreshOutcome`/`baseRefreshSha` — which, on a resumed run calling
    // this a second time, can already hold a genuinely confirmed boundary from an earlier, successful
    // refresh on this same row. `reconciledRefreshSha`, not the pre-reconciliation `priorEffectiveRefreshSha`
    // (PR #279 review, P1, second re-review): when THIS call's own reconciliation above just promoted a
    // crashed-but-landed pending refresh into `reconciledRefreshSha`, that promoted value is the row's
    // true last-confirmed boundary — snapshotting the older `priorEffectiveRefreshSha` instead would
    // lose it the moment this new pending write lands, and a later crash recovery would fall back to
    // the stale pre-reconciliation boundary, replaying history the confirmed refresh already dropped.
    // `kind` (PR #279 review, P1, seventh round): recorded alongside the boundary and pre-mutation
    // tip above so a resume's reconciliation knows WHICH operation this pending write describes — see
    // `confirmPendingRefreshMutation`'s own doc comment for why that's required evidence, not just the
    // boundary and tip.
    beforeMutate: (baseSha, branchSha, kind) =>
      updateRun(db, clock, runId, {
        baseRefreshOutcome: PENDING_REFRESH_OUTCOME,
        baseRefreshSha: baseSha,
        pendingRefreshFromSha: branchSha,
        pendingRefreshKind: kind,
        priorBaseRefreshSha: reconciledRefreshSha ?? null,
      }),
    // Fires BEFORE `createWorktree` cuts a new branch (PR #279 review, P1 re-review) — see
    // `materializeFreshWorktree`'s own doc comment for why the write can no longer wait until after
    // creation. `createdBranch` alone doesn't distinguish a genuine deletion-and-recreation from this
    // branch's very first-ever creation, which is exactly as fresh as a brand-new row and has no
    // older, potentially-stale pair to guard against — gated on actual evidence of an OLDER row for
    // this branch (`knownForkSha`, `priorEffectiveRefreshSha`, or `pendingRefresh`, all resolved above,
    // before this checkout existed). The tombstone (anton-nyz1v, PR #279 review, fifth round), not a
    // plain null: a null `baseRefreshOutcome` is also what THIS row carried before this call ever ran
    // (every row starts that way), so a later walk over this branch's rows can't tell "nothing
    // recorded" from "deliberately cleared" without a value only a genuine recreation ever writes —
    // see the constant's own doc comment for how `findRunBaseRefreshShaForBranch` reads it back. Not
    // best-effort: a rejection here propagates out of `createWorktree` and the branch is never cut,
    // rather than letting a recreated branch's stale pair survive unrecorded.
    beforeCreate: (createdBranch) => {
      if (!createdBranch) return Promise.resolve();
      if (knownForkSha === undefined && priorEffectiveRefreshSha === undefined && pendingRefresh === undefined) {
        return Promise.resolve();
      }
      isRecreatedBranch = true;
      return updateRun(db, clock, runId, {
        baseRefreshOutcome: BRANCH_RECREATED_REFRESH_TOMBSTONE,
        baseRefreshSha: null,
      });
    },
  });
  run.worktree = worktree;
  // `createWorktree` made this decision under its branch lock; a caller-side ref probe could go
  // stale while the checkout is created and misclassify the fork provenance.
  const reusedCheckout = !worktree.createdBranch;
  // Pin the fork COMMIT now, while origin/<base> is freshly fetched and — on a FIRST creation — HEAD
  // still sits at it (PR #238 review). A fresh creation's fork is already fixed at the instant
  // `createWorktree` cut the branch (before warming could rewind the base); only a legacy row or a
  // reused checkout without a recorded fork re-derives it, and the derived value is persisted so
  // dispatch partitions against the commit the branch was cut from — never re-derived against
  // `baseRef` a sibling run's fetch can rewind mid-run. A resume READS the stored value rather than
  // recomputing: its worktree already carries this run's commits, so `merge-base <base> HEAD` then
  // would answer far behind the true fork.
  //
  // The pin follows the CHECKOUT, not this run row alone (PR #238 review). Attempts do not all share
  // a row: an ordinary handler failure settles it `failed`, so the runner's retry opens a FRESH row
  // while deliberately reusing this branch and worktree (execute-epic-prepare's branch-scoped
  // retry). Keyed by `runId` only, that retry finds nothing pinned and recomputes against a base a
  // sibling run's fetch may have rewound since — the exact widening the pin exists to prevent. So a
  // run that INHERITED its branch recovers what the attempt that cut it recorded, and only one
  // standing on a branch it just created resolves a fork point of its own. A pre-column branch has
  // neither, and recomputes once — no worse than the old behaviour — storing the answer on its row.
  let storedFork: string | undefined;
  let baseForkSha: string;
  // `reconciledRefreshSha` (resolved above, before the checkout) is also what the write below must
  // NOT clobber: a later resume's `skipped_dirty` records that THIS attempt didn't move the branch,
  // not that no attempt ever did, so overwriting a prior success's record with the fresh base it was
  // never brought up to would lose the only base a truthful already-shipped claim naming that
  // success's commits could still be checked against. `reconciledRefreshSha`, not the
  // pre-reconciliation `priorEffectiveRefreshSha` (anton-s55u, PR #279 review, third re-review): a
  // dead attempt's pending write can be the branch's ONLY refresh ever, so `priorEffectiveRefreshSha`
  // (which only recognizes a SETTLED outcome) reads undefined even once this call's own reconciliation
  // above has confirmed that pending write landed. Guarding on the pre-reconciliation value would let
  // THIS clobber through regardless, overwriting the still-`pending` row (and the confirmed boundary
  // its `priorBaseRefreshSha` carries) with this attempt's `skipped_dirty` — which
  // `findRunBaseRefreshShaForBranch` skips outright without ever reading that field back, unlike its
  // `PENDING_REFRESH_OUTCOME` branch. That would strand the confirmed boundary for good: a later walk
  // finds neither the pending row (overwritten) nor a settled one to fall back to.
  //
  // Computed once, outside the try, so the catch below can retry the SAME payload (PR #279 review,
  // P1): `createWorktree` already mutated the branch (rebased/merged it) by this point — the payload
  // here is the only durable record of what onto, and losing it would leave a later resume deriving
  // `forkSha` from the stale, pre-refresh pin instead.
  //
  // A freshly CREATED branch (`worktree.createdBranch`) forks straight off `freshBase` and never runs
  // a refresh (see `materializeFreshWorktree`), so `worktree.refreshOutcome` is always undefined here
  // and this has nothing of its own to record — but THIS row can still carry a refresh an EARLIER
  // attempt recorded before its checkout and branch were deleted and recreated (PR #279 review). That
  // stale pair is tombstoned already, by `beforeCreate` above, BEFORE `createWorktree` ever cut the
  // branch (PR #279 review, P1 re-review) — see its own doc comment for why persisting it here, after
  // the fact, left a crash window where the recreated branch could survive with the tombstone never
  // written. `isRecreatedBranch` (set from within that callback) is read below only to skip the
  // now-redundant write this block used to make.
  const refreshFields =
    !isRecreatedBranch &&
    worktree.refreshOutcome &&
    !(worktree.refreshOutcome.outcome === "skipped_dirty" && reconciledRefreshSha !== undefined)
      ? { baseRefreshOutcome: worktree.refreshOutcome.outcome, baseRefreshSha: worktree.refreshOutcome.baseSha }
      : undefined;
  try {
    // Pin reads are part of the same atomic setup as the pin write: a fresh checkout with neither
    // must be removed, or a retry could reuse its branch and derive a fork from a moved base.
    storedFork = await getRunBaseForkSha(db, runId);
    const reusedFork =
      storedFork ??
      (reusedCheckout
        ? await findRunBaseForkShaForBranch(db, projectId, run.targetId, branch)
        : undefined);
    try {
      // The creation-captured fork is FROZEN only on a first creation (PR #238 review): there
      // `readForkAtCreation` reads the checkout's HEAD in the instant `worktree add -b` cut it, so the
      // base cannot since have rewound it. A reused checkout's `forkSha` is read off the SAME call
      // checking the existing branch out, so it returns the branch's current HEAD — already carrying
      // this run's prior-attempt commits — not the fork point. Preferring it would partition against
      // `<HEAD>..HEAD>` and read a ticket already closed on a prior attempt as a pre-existing
      // retirement. Only a checkout this call just created takes `worktree.forkSha`; a reused one asks
      // `reusedFork` first, the row and the attempt that cut the branch.
      baseForkSha = reusedCheckout
        ? reusedFork ?? (await resolveForkPoint(worktree.path, freshBase))
        : worktree.forkSha ?? reusedFork ?? (await resolveForkPoint(worktree.path, freshBase));
    } catch (e) {
      // Only reachable when a legacy row (no pinned fork) resumes over a worktree whose base was
      // rewritten to an unrelated history — a fresh creation forks off `freshBase` and always shares
      // it. Partitioning the run's tickets against a moving ref instead could read work this checkout
      // never forked from as its own delivery, so stop rather than guess a fork point.
      throw new PoisonEpic(
        `anton could not resolve the commit \`${worktree.branch}\` forked from ${freshBase} in ` +
          `${worktree.path} (${e instanceof Error ? e.message : String(e)}) — refusing to partition ` +
          `the run's tickets against a moving base. Repair the worktree, then resume the run`,
      );
    }
    await updateRun(db, clock, runId, {
      worktreePath: worktree.path,
      branch: worktree.branch,
      attempts: ctx.attempt,
      // Persist the creation-captured fork (and a recovered sibling's pin) onto this row. A reused
      // checkout retains its own pin, but a recreated branch must replace a stale row pin: that old
      // value describes the deleted checkout and could widen delivery evidence on a later retry.
      ...(!reusedCheckout || !storedFork ? { baseForkSha } : {}),
      // What refreshOntoBase did to a reused checkout at this warm (anton-s55u) — the only durable
      // record of whether this attempt implemented against a stale tree that got fixed. Undefined
      // (a fresh creation, or a caller that didn't opt into refresh) leaves the row's prior value
      // alone rather than overwriting it with a claim this attempt never made. A `skipped_dirty`
      // following a prior EFFECTIVE refresh is likewise left alone (PR #279 review): the branch still
      // carries that refresh's commits, so overwriting its record with this attempt's non-move would
      // erase the only durable evidence of it.
      ...(refreshFields ?? {}),
    });
  } catch (error) {
    // A newly-created checkout without a pinned fork is unsafe to reuse: any setup failure before
    // persistence would otherwise leave a retry free to derive against a base another run has moved.
    // A reused checkout belongs to its prior attempt and is already pinned, so this attempt leaves it
    // intact — UNLESS this warm's own refresh just mutated it (PR #279 review, P1): `createWorktree`
    // already rebased/merged the branch onto `freshBase` before this try block ever ran, so the
    // failure above (whatever it was) has nothing to do with whether that mutation happened. Losing
    // `refreshFields` here would leave the branch at its new, mutated state with the row still
    // pointing at the OLD boundary; a later resume would then derive `--onto`'s upstream from that
    // stale pin and replay commits the mutation already carried forward — the resurrection this
    // column exists to prevent (see `refreshFields` above, and `priorEffectiveRefreshSha`'s doc
    // comment for the replay mechanics). Best-effort retry the boundary alone; if even that write
    // won't land, fail closed rather than resume against an unrecorded mutation.
    if (reusedCheckout && refreshFields) {
      try {
        await updateRun(db, clock, runId, refreshFields);
      } catch (persistError) {
        throw new PoisonEpic(
          `anton ${refreshFields.baseRefreshOutcome} ${branch} onto ${freshBase} but could not persist ` +
            `the refresh boundary (${persistError instanceof Error ? persistError.message : String(persistError)}) ` +
            `— resuming would derive a rebase boundary from the stale, pre-refresh pin and could replay ` +
            `already-applied commits onto a later base rewrite. Repair the run row for ${runId}, then ` +
            `resume (original failure: ${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    if (!reusedCheckout) {
      await releaseWorktreeClaim(repo, branch, worktreeClaim).catch((cleanupError) => {
        console.error(`[execute-epic] could not release the failed worktree claim for ${branch}`, cleanupError);
      });
      const removal = await removeWorktree(worktree, { deleteBranch: true }).catch((cleanupError) => {
        console.error(`[execute-epic] could not remove the unpinned worktree for ${branch}`, cleanupError);
        return undefined;
      });
      if (!removal?.removed || !removal.branchDeleted) {
        throw new PoisonEpic(
          `anton could not persist ${branch}'s fork pin, and its newly-created checkout could not be ` +
            `fully removed${removal?.skipped ? ` (${removal.skipped})` : ""}${removal?.branchSkipped ? ` (${removal.branchSkipped})` : ""} — ` +
            `leaving it reusable would let a retry recompute against a moved base. Remove the checkout ` +
            `and branch, then resume (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    throw error;
  }
  // Deferred from `createWorktree` itself (`warm: false` above) until now, once the refresh boundary
  // it may have just rebased/merged the branch onto is safely on the run row (anton-s55u, PR #279
  // review, P1) — this call is the only thing left that can run for minutes, and its own signal lets
  // an operator's kill interrupt it without holding the run's concurrency slot for the full timeout.
  await warmWorktreeBestEffort(worktree, ctx.signal);
  await ctx.heartbeat();

  // What an `already-shipped` claim is checked against (PR #279 review). `baseForkSha` above is
  // deliberately frozen across resumes for dispatch partitioning; a refresh that actually moved this
  // reused checkout onto a newer base (anything but `skipped_dirty` — that outcome left the branch
  // untouched) brought commits into the branch's history that a claim can truthfully cite, so the
  // verifier checks against the base the tree was JUST refreshed onto rather than the older, frozen
  // fork it would otherwise reject a true claim against. A `skipped_dirty` THIS attempt falls back to
  // the last EFFECTIVE refresh a prior resume already applied and left recorded on the row, not
  // straight to `baseForkSha` (PR #279 review) — `skipped_dirty` means only that this attempt didn't
  // move the branch, and the commits an earlier resume's refresh brought in are still on it.
  //
  // Only trusted for a REUSED checkout (PR #279 review): `reconciledRefreshSha` is read from the
  // branch's run-row history (reconciled, above, against a dead attempt's write-ahead pending write),
  // not from the checkout itself, so it survives a branch delete-and-recreate that leaves old rows
  // behind. A freshly CREATED checkout (`worktree.createdBranch`) forks straight off `freshBase` and
  // carries none of that old branch's history — the old base normally stays an ancestor of the fresh
  // one, so the frozen-sha guard below would accept the stale value rather than catch it, checking a
  // truthful claim against a commit the recreated branch never had. `baseForkSha` — this checkout's
  // own, freshly resolved fork — is the only value that describes it.
  //
  // `reconciledRefreshSha`, not the pre-reconciliation `priorEffectiveRefreshSha` (anton-s55u, PR #279
  // review, third re-review): the same dead-attempt's-pending-write gap the `refreshFields` guard
  // above closes applies here too — a confirmed-but-never-finalized refresh reads as undefined in
  // `priorEffectiveRefreshSha` (a still-`pending` row isn't a recognized settled outcome), which would
  // fall this straight to the stale, frozen `baseForkSha` and reject a truthful already-shipped claim
  // citing commits the reconciled refresh already brought onto the branch.
  //
  // That fallback is itself frozen at the instant the refresh it came from ran, and origin can move
  // between then and now — including a force-push that drops a commit an already-shipped claim
  // cites (PR #279 review). Verifying against the frozen sha regardless would accept evidence the
  // CURRENT base no longer holds. So it is kept only while `pinnedBase` below — resolved moments
  // ago, at the top of this very attempt — still descends from it: ordinary forward motion, where
  // nothing the fallback already proved could have been dropped. Once it doesn't, the fallback is
  // stale in exactly the way a rewritten base makes it, and `pinnedBase` is asked instead — the only
  // read here that reflects origin as it stands now.
  //
  // `pinnedBase`, not the bare `freshBase` local (PR #279 review): two `await`s sit between
  // `refreshOntoBase` pinning its base sha and this check, during which a sibling run's fetch on the
  // same local repo can move `origin/<base>` out from under the mutable ref `freshBase` names.
  // `refreshOntoBase` resolves its base sha once, up front, for exactly this reason — including on
  // `skipped_dirty`, which still returns the sha it reasoned about (`refreshOntoBase`'s own
  // `return { outcome: "skipped_dirty", baseSha }`) — so reusing that pin here keeps this check
  // evaluated against the same commit the refresh itself saw, rather than one a race moved on to.
  //
  // A freshly CREATED checkout never runs a refresh (see `materializeFreshWorktree`), so
  // `refreshOutcome` is always undefined there — falling back to the bare `freshBase` local would
  // reintroduce the very race the comment above guards against for a reused checkout: nothing stops
  // `warmWorktreeBestEffort` (which runs for minutes) from racing a sibling run's force-fetch that
  // rewrites `origin/<base>` before this line re-reads it (PR #279 review, P1). `baseForkSha` is
  // already the immutable commit this checkout was cut from — frozen at creation, before any warm
  // could rewind the base — so it, not the mutable ref, is what a fresh creation must pin against.
  const pinnedBase = worktree.refreshOutcome?.baseSha ?? (reusedCheckout ? freshBase : baseForkSha);
  const shippedFallback = reusedCheckout ? (reconciledRefreshSha ?? baseForkSha) : baseForkSha;
  const alreadyShippedBase =
    worktree.refreshOutcome && worktree.refreshOutcome.outcome !== "skipped_dirty"
      ? worktree.refreshOutcome.baseSha
      : await resolveComparableBase(worktree.path, worktree.branch, pinnedBase, shippedFallback);

  // Every step of the walk runs through the step registry (anton-4npr) — one entry point per step,
  // dispatched in the order the project's formula declares. This is what they all operate on; each
  // dispatch adds the ticket(s) in scope (and, per ticket, that ticket's session) plus the formula
  // step itself, which is where a `step:claude` reads its prompt.
  const runStep: Omit<StepContext, "tickets"> = {
    db,
    clock,
    ctx,
    projectId,
    runId,
    repoPath: repo,
    worktreePath: worktree.path,
    branch: worktree.branch,
    baseBranch,
    baseRef: freshBase,
    baseForkSha,
    alreadyShippedBase,
    target,
    settings,
    assertLeaseHeld: lease.assertHeld,
  };
  return { worktree, runStep };
}

/** Step 3. Assert this process still owns the target, then claim it for the operator. */
export async function claimRunTarget(run: EpicRun): Promise<void> {
  const { repo, targetId: epicBeadId } = run;
  // 3. Assert this process still owns the epic, THEN claim it for the human operator (idempotent).
  //    An approved-but-unstarted (backlog) target can be TAKEN OVER — reassigned to another
  //    operator via the approve route's steal — after this run was queued but before it leased the
  //    epic (a queued or autonomy-paused job). The take-over enqueues a fresh run on the NEW
  //    owner's instance, but the jobs table is machine-local: THIS stale job still sits on the
  //    ORIGINAL operator's instance. Running it now would execute under the new owner's
  //    reservation — the exact "run under someone else's claim" state the soft-lock
  //    forbids (DESIGN.md §Soft-lock). So gate on ownership FIRST — like the ticket-claim hard gate
  //    in runTicket — AND make the claim itself hard (below): a steal landing between this read and
  //    the claim is caught by `bd update --claim` refusing to reassign, not swallowed by `safe`.
  //    Re-read the owner here (not from the job-start snapshot): the worktree warm
  //    above is several ops wide, so ownership settles against current state, mirroring the approve
  //    route re-reading the assignee at its own run trigger. PARK (not fail) on a mismatch —
  //    recoverable, it stops the stale run without stomping the new owner, and the current owner
  //    approving afresh enqueues a run under their identity on their instance. A runner with no
  //    operator identity can't assert ownership, so it falls through to the prior best-effort claim.
  //    The claim's own sync nudge (below) still makes it visible on teammates' boards within a
  //    heartbeat (anton-live-sync R6); fire-and-forget, the end-of-run sync is the backstop.
  const operator = await resolveOperator();
  const currentOwner = ownerOf(await beads.show(repo, epicBeadId));
  if (operator && currentOwner && currentOwner !== operator) {
    throw new PoisonEpic(
      `${epicBeadId} is reserved by ${currentOwner}, not ${operator} — it was taken over after ` +
        `this run was queued; refusing to run under another operator's claim. Approve ${epicBeadId} ` +
        `as ${currentOwner} to start a run under the current owner.`,
    );
  }
  if (operator) {
    // Fold the ownership gate INTO the claim so a take-over that lands in the window between the
    // read above and this write can't slip through. `bd update --claim` refuses to reassign a
    // bead a different operator now holds, so it — not the stale pre-read — is the operation that
    // actually observes a racing steal. That refusal MUST stop the run (like runTicket's ticket
    // hard gate), never be swallowed by `safe`: swallowing would tag and execute the epic under
    // the new owner's reservation, the exact state the soft-lock forbids. On the NORMAL path the
    // approve route already pre-assigned this same operator (approve/route.ts `cas(owner, operator)`),
    // so this is a same-actor re-claim — and `bd update --claim` is idempotent for the same actor
    // ("idempotent if already claimed by you" per its own help; verified on bd 1.0.4), so it
    // succeeds and the run proceeds. Same story on resume, so a retry re-claims cleanly. What a
    // refusal actually means is classified by {@link claimFailure}.
    try {
      await beads.claim(repo, epicBeadId, operator);
    } catch (e) {
      throw await claimFailure(repo, epicBeadId, operator, e);
    }
  } else if (currentOwner) {
    // No operator identity, but the epic is owned by someone. We can't assert we ARE that
    // owner, and a best-effort `safe` claim would swallow bd's refusal to reassign a foreign
    // bead — tagging and running the epic under the current owner's reservation, the exact
    // state the soft-lock forbids (DESIGN.md §Soft-lock). So mirror the pre-read gate above
    // and PARK: this is an older queued approved-but-unassigned job on an instance without
    // ANTON_OPERATOR/global user.name, and another operator took the epic over before the
    // lease. Poison (recoverable) — a human must re-approve as the current owner to enqueue a
    // run under their identity. Retrying is pointless: this runner still can't assert ownership.
    throw new PoisonEpic(
      `${epicBeadId} is reserved by ${currentOwner}, but this runner has no operator identity ` +
        `(set ANTON_OPERATOR or the global git user.name) to assert ownership — refusing to ` +
        `run under another operator's claim. Approve ${epicBeadId} as ${currentOwner} to start ` +
        `a run under the current owner.`,
    );
  } else {
    // No operator identity AND the epic is unowned → nobody's reservation to stomp, so keep
    // the prior best-effort claim (bd falls back to its own actor resolution).
    await safe(() => beads.claim(repo, epicBeadId, operator));
  }
  await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("implementing")]));
  run.operator = operator;
}

/**
 * Why `bd update --claim` refused, as the error the caller should throw. Three causes, and only the
 * transient one is worth a retry — returning the built error (rather than a discriminant the caller
 * re-expands) keeps each cause's remedy next to the check that detects it.
 */
async function claimFailure(
  repo: string,
  epicBeadId: string,
  operator: string,
  e: unknown,
): Promise<Error> {
  const cause = e instanceof Error ? e.message : String(e);
  // Re-read the owner to spot the first cause: if a DIFFERENT operator now holds the epic, this is
  // a confirmed take-over — retrying is pointless, so poison (human must re-approve as the current
  // owner). A racing steal is still caught either way: either this re-read sees it, or the pre-read
  // gate in claimRunTarget does on the next attempt. If the re-read ITSELF fails we can't confirm a
  // take-over, so fall through to the status check.
  const ownerNow = await beads
    .show(repo, epicBeadId)
    .then(ownerOf)
    .catch(() => undefined);
  if (ownerNow && ownerNow !== operator) {
    return new PoisonEpic(
      `${epicBeadId} is reserved by ${ownerNow}, not ${operator} — it was taken over after this ` +
        `run was queued; refusing to run under another operator's claim. Approve ${epicBeadId} as ` +
        `${ownerNow} to start a run under the current owner. (${cause})`,
    );
  }
  // The second cause: bd refused because the bead's STATUS isn't claimable (blocked, closed,
  // deferred), with no ownership change at all — so the re-read above sees nothing wrong and the
  // old code bucketed it as transient, retried it 3× against an error that can never change, and
  // parked telling the operator the Dolt DB was locked (anton-e5ix, observed on anton-f5f3). Poison
  // on the FIRST attempt instead, naming the status and the fix: only a human moving the bead out
  // of that status can make the claim succeed.
  const status = unclaimableStatus(e);
  if (status) {
    return new PoisonEpic(
      `${epicBeadId} cannot be claimed while its status is "${status}" — bd refuses the claim ` +
        `and no retry can change that. Reopen/unblock ${epicBeadId} (its status must be ` +
        `claimable, e.g. open) and approve it again to start a run. (${cause})`,
    );
  }
  // The third: a transient failure (a Dolt lock, a CLI timeout) with NO ownership change. Poisoning
  // those would park a valid approved epic that a retry would claim cleanly, so return a plain
  // retryable Error — the same call runTicket's hard gate makes.
  return new Error(
    `${epicBeadId} could not be claimed for ${operator} — the beads DB is locked or the claim ` +
      `command failed transiently; retrying. (${cause})`,
  );
}

/** Step 3b. Reserve the target's open children for the same actor, so bd stops offering them. */
export async function cascadeChildClaims(run: EpicRun): Promise<void> {
  const { targetId: epicBeadId, repo, tickets, standaloneRun, operator } = run;
  // 3b. Cascade the claim to the target's open children (anton-0d85). The claim above settles the
  //     FEATURE, but `bd ready --unassigned` filters on each TASK's assignee — so without this a
  //     running feature keeps offering its own children to every other worker on the board, and
  //     the only thing standing between them and a duplicate run is anton-side knowledge no plain
  //     `bd` client has. Assigning them makes bd's own readiness query exclude them natively.
  //     A child a DIFFERENT actor holds is left exactly as it is and reported here — a human's
  //     reservation outranks a run's, and clobbering it would hide the conflict that runTicket's
  //     hard claim gate is about to stop the run on anyway.
  //     Only for a grouped run: a standalone target IS its own ticket and was just claimed above.
  //     Skipped without an operator identity too — `bd assign` names an assignee, and there is
  //     none to name (the same reason that path keeps a best-effort claim).
  //     Fails CLOSED, like the run-lease publish and for the same reason: a run executing children
  //     the board still offers to everyone else is the duplicate-work hazard this exists to
  //     prevent, so half a cascade must stop the attempt rather than proceed quietly. Retryable
  //     (a plain Error, not poison) — a locked bd DB self-heals within the retry budget.
  if (operator && !standaloneRun) {
    const cascade = await assignChildren(repo, tickets, operator);
    // Recorded BEFORE the incomplete-cascade throw below, so the stopping path hands back the
    // reservations this cascade did take rather than stranding them.
    run.childCascade = { actor: operator, ids: cascade.held };
    if (cascade.reserved.length > 0) {
      console.warn(
        `[execute-epic] ${epicBeadId}: left ${cascade.reserved.length} child ticket(s) with ` +
          `another assignee untouched — ${formatReservedChildren(cascade.reserved)}`,
      );
    }
    if (cascade.failed.length > 0) {
      throw new Error(
        `${epicBeadId} could not reserve ${cascade.failed.map((f) => f.id).join(", ")} for ` +
          `${operator} — the beads DB is locked or the assign failed transiently; retrying ` +
          `rather than running a feature whose children the board still offers to other ` +
          `workers. (${cascade.failed[0].error})`,
      );
    }
  }
}

/** Step 3c. Publish the claim and the cascade before executing anything. */
export async function publishRunClaim(run: EpicRun): Promise<void> {
  const { repo, targetId: epicBeadId, operator } = run;
  // 3c. PUBLISH the claim and the cascade before executing anything (anton-0d85). A reservation
  //     only exists locally until it reaches the Dolt remote, so a fire-and-forget push would
  //     leave every other machine reading these beads as unassigned for the whole run — exactly
  //     the duplicate-work window 3a/3b are here to close, reopened at the last step. Await it
  //     and fail CLOSED, the same rule the run-lease publish follows and for the same reason.
  //     Retryable (a plain Error): the claim and the cascade are idempotent for this actor, so a
  //     retry re-publishes rather than re-reserving. `beads.sync` tolerates a no-remote
  //     workspace, so a single-machine run is unaffected.
  try {
    await beads.sync(repo);
  } catch (e) {
    throw new Error(
      `${epicBeadId} was claimed${operator ? ` for ${operator}` : ""} but the claim could not be ` +
        `published to the shared board — other machines would still see this work as unassigned; ` +
        `retrying rather than running it unpublished. ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
}
