/**
 * Everything between the run row and the first dispatched ticket (anton-1lix — extracted from
 * execute-epic.ts).
 *
 * The order here is the whole design: the READ-ONLY gates run first (a refusal costs nothing), then
 * the lease — which is what makes this machine the only one executing the target — then the writes
 * that follow from holding it (the human waits, the checkout, the claim and its cascade). Moving a
 * step across that line changes what a park leaves behind, so each one says where it sits and why.
 */
import { beads, LABELS, staleClaimReason, type Bead } from "../beads/bd";
import { cycleEvidenceFor } from "../beads/cycle-evidence";
import { loadAllIssues } from "../beads/issues";
import { formatStructureViolations, structureGaps } from "../beads/structure";
import { contractGatedBeads, resumeSkipped, runTickets } from "../ticket-view";
import {
  branchContainsCommit,
  preservedCommitPrefix,
  worktreeHasPreservedCommitFor,
} from "../git/ops";
import type { Worktree } from "../git/worktree";
import { PoisonEpic } from "./errors";
import {
  beadContractPoison,
  blockedRunPoison,
  humanHeldPoison,
  humanHeldTickets,
  type HumanHeldTicket,
  inactiveAgentTickets,
  runTargetDrift,
  ticketSetDrift,
  type RunReadiness,
} from "./execute-epic-board";
import {
  cascadeChildClaims,
  claimRunTarget,
  publishRunClaim,
  warmRunWorktree,
} from "./execute-epic-claim";
import { adoptRefreshedTarget, preflightHumanTickets } from "./execute-epic-human-gate";
import { refreshRunBoard, settleCompletedRun } from "./execute-epic-recover";
import type { EpicRun } from "./execute-epic-run";
// The formula/step family, the run-lease, AND the checkout-staleness preflight (anton-vzhf) sit
// behind ONE seam (anton-8x1k) — the run-shape helpers this module merely threads through or
// re-exports, kept out of its top-level import graph so the self-freshness and breaker modules do
// not fan out here and push preparation's coupling over the floor.
import {
  assertSelfCheckoutFresh,
  resolveRunPipeline,
  takeRunLease,
  type ResolvedStep,
  type StepContext,
} from "./execute-epic-run-shape";


/**
 * What the ticket loop and the run phase need from preparation — or `done`, when step 0a found this
 * target already carried to a live pull request and there is nothing left to execute.
 */
export type RunPreparation =
  | { done: true }
  | {
      done: false;
      /** The formula's steps up to and including its commit — dispatched once per ticket. */
      ticketSteps: ResolvedStep[];
      /** Its steps after the commit — dispatched once for the whole run. */
      runSteps: ResolvedStep[];
      /** The step context every dispatch narrows from. */
      runStep: Omit<StepContext, "tickets">;
      worktree: Worktree;
      /** The run's readiness verdict, as the last board refresh left it. */
      readiness: RunReadiness;
      /** Ticket ids a blocker OUTSIDE this run holds — never dispatched this pass. */
      gated: Set<string>;
      /** Whether a ticket's work already landed on a prior attempt (a resume marker). */
      isResumeSkipped: (t: Bead) => boolean;
    };

/** The verdict and ticket set the gates share, re-derived as each refresh brings back a new board. */
interface RunGates {
  readiness: RunReadiness;
  gated: Set<string>;
  /** The target's working-layer subtree on the current board — `tickets` minus the standalone case. */
  children: Bead[];
  isResumeSkipped: (t: Bead) => boolean;
}

/**
 * Walk a run from its opened row to the moment it may dispatch: refresh, gate, lease, arm, warm,
 * claim. Answers `{ done: true }` when the target needs nothing more from this attempt.
 */
export async function prepareEpicRun(run: EpicRun): Promise<RunPreparation> {
  const { preCheckTrusted, currentBoardTrusted, leaseTarget } = await refreshRunBoard(run);
  if (await settleCompletedRun(run, leaseTarget, currentBoardTrusted)) return { done: true };
  // Step 0-pre. Refuse to start a new run on a stale checkout (anton-mh3c). Placed AFTER the
  // completion short-circuit so a target already carried to its pull request still settles
  // idempotently rather than being grounded by a staleness with nothing left to run. The gate lives
  // behind the run-shape seam (anton-8x1k) so its freshness/breaker modules stay out of this module's
  // import graph; see {@link assertSelfCheckoutFresh} for the full contract.
  await assertSelfCheckoutFresh();
  const gates = regateRefreshedBoard(run, leaseTarget);
  assertAgentsEnabled(run, gates);
  assertBeadContract(run, gates);
  await assertTicketsClaimable(run, gates);
  const { ticketSteps, runSteps } = await resolveRunPipeline(run);
  gates.children = await takeRunLease(run, preCheckTrusted, gates.children, confirmSelectionUnderLease);
  // Re-asked after EVERY board this run adopts past the read-only gates (PR #227 review). Step 1c
  // swaps in the children the lease confirmed, and the arm below swaps in the ones ITS own refresh
  // brought back — so a person blocking or deferring a child inside either window arrives unjudged,
  // and the run would dispatch its earlier siblings before parking at that ticket's claim gate.
  // Re-asking is what makes "a held child stops the run before any dispatch" hold across both
  // windows; the gate reads no board and only a park reads git, so the extra calls cost nothing on
  // the path that matters. Both still park before any worktree, claim or session exists — the arm's
  // own waits stand, which is the state a resume reuses. The LAST window — between here and the
  // reservation — is closed by {@link assertReservedTicketsClaimable}, which reads a board of its own.
  await assertTicketsClaimable(run, gates);
  run.lease.startRefresh();
  await armHumanTicketWaits(run, gates);
  await assertTicketsClaimable(run, gates);
  const { worktree, runStep } = await warmRunWorktree(run);
  await assertPreservedWorkFitsShape(run, worktree);
  await claimRunTarget(run);
  await cascadeChildClaims(run);
  await assertReservedTicketsClaimable(run, gates);
  await publishRunClaim(run);
  await assertPublishedBoardCycleFree(run, gates);
  return {
    done: false,
    ticketSteps,
    runSteps,
    runStep,
    worktree,
    readiness: gates.readiness,
    gated: gates.gated,
    isResumeSkipped: gates.isResumeSkipped,
  };
}

/**
 * Steps 0a-pre, 0a-bis and 0a-ter. Re-run the structure/cycle gate, the readiness gate, and re-derive
 * the target's SHAPE — all against the freshly-pulled board — then take the lease's leftovers. Every
 * one of these properties belongs to the whole BOARD, not to the bead, so a pull that changed any of
 * them must be judged before anything is held.
 */
function regateRefreshedBoard(run: EpicRun, leaseTarget: Bead): RunGates {
  const { targetId: epicBeadId, lease } = run;
  const { all } = run;
  let target = run.target;
  // 0a-pre. Re-run the authoritative structure/cycle gate against the freshly-pulled board too
  //     (PR #274 review). The top-of-handler check (execute-epic-start.ts) ran on the PRE-pull
  //     snapshot; `refreshRunBoard`'s pull, just above, can itself land an internal `blocks` cycle
  //     among this run's OWN tickets that check never saw — a cross-machine Dolt merge lands on its
  //     own schedule, not this job's. `runReadiness` below treats an internal edge as ORDERING, not
  //     a blocker, so it would never notice the cycle, and `orderTickets` (execute-epic-board.ts)
  //     falls back to input order the moment its topological sort can't place every ticket — which
  //     would dispatch a dependent ticket ahead of the prerequisite the very edges say it must
  //     follow. Poison before anything is held, exactly like the top-of-handler check; the fix is on
  //     the board, not a retry. Reads `all` (the board `refreshRunBoard` just adopted into `run.all`,
  //     or the pre-pull snapshot if that adoption failed) with `cycleEvidenceFor`, which is populated
  //     only when the read that produced `all` asked for cycles — `refreshRunBoard`'s re-list does.
  const structural = structureGaps(epicBeadId, all, { cycles: cycleEvidenceFor(all) });
  if (structural.blocking.length > 0) {
    throw new PoisonEpic(
      `${epicBeadId} breaks the tier structure: ${formatStructureViolations(structural.blocking)}`,
    );
  }
  // 0a-bis. Re-run the job-start readiness gate against the freshly-pulled board (anton-jz1).
  //     The top-of-handler `blockers` check ran on the PRE-pull `all`, so a `blocks` edge
  //     another machine pushed before this pull is invisible there — and the `fresh` adoption
  //     above swapped `all`/`tickets` to the pulled board WITHOUT re-checking readiness, which
  //     would let this path execute a now-blocked epic and bypass the gate. Recompute from the
  //     adopted board and PARK if a blocker reopened (recoverable, same as the top gate).
  //     Checked AFTER the completion short-circuit (step 0a) so a genuinely-finished epic still
  //     takes the idempotent "done" path instead of parking, and BEFORE adopting/publishing any
  //     lease (below) so a park leaves nothing for the cleanup to clear.
  //     This verdict is also what the ticket loop dispatches by (anton-1two), so the gate and the
  //     dispatch can't disagree about which tickets a cross-run blocker holds: `gated` is read
  //     from the same pulled board the loop iterates.
  //     Both bindings are reassigned once by the human-ticket arm (0b-pre), which runs after the
  //     run-lease is confirmed and puts a new blocker on the board, changing this same verdict.
  const freshReadiness = run.readiness(all);
  if (!freshReadiness.runnable) throw blockedRunPoison(epicBeadId, freshReadiness, all);
  const gated = new Set(freshReadiness.gated);

  // 0a-ter. Re-derive the target's SHAPE against the freshly-pulled board. Runnability and
  //     grouping are properties of the whole BOARD, not of the bead: another machine can add or
  //     remove a feature's first child between the top-of-handler list and the pull above. A
  //     legacy epic that just gained a feature is now a container — carrying the pre-pull shape
  //     forward would execute (and CLOSE) that unapproved feature as one of its own tickets —
  //     and a feature that just gained its first ticket must run that ticket instead of
  //     implementing itself. Recomputed from `all` unconditionally: when the re-list failed,
  //     `all` is still the pre-pull snapshot and this reproduces the top-of-handler result.
  //     Placed with 0a-bis for the same reason — AFTER the completion short-circuit, so an epic
  //     whose PR is already live still settles idempotently instead of parking on a shape change
  //     that no longer has any work to gate, and BEFORE any lease is adopted or published.
  if (!beads.isRunTarget(target, all)) {
    throw new PoisonEpic(
      beads.isContainer(target, all)
        ? `epic ${epicBeadId} gained a feature child while this run was queued — it is now a ` +
          `container, not a run target; run one of its features instead`
        : `bead ${epicBeadId} is no longer a run target (type "${target.issue_type ?? "unknown"}")` +
          ` — refusing to execute`,
    );
  }
  // The label the top-of-handler backstop judged moves in exactly the same window as the shape
  // (PR #213 review). The pull above adopted a fresh target and nothing downstream re-reads
  // `agent:human`, so a relabel landing here would carry a person's work into the dispatch loop
  // and hand it to the default agent. Re-asked in the backstop's own words, and here rather than
  // beside that backstop so a run whose PR is already live still settles idempotently above.
  target = adoptRefreshedTarget(all, epicBeadId, target);
  const freshChildren = runTickets(all, epicBeadId);
  run.standaloneRun = !beads.groupsChildren(target, freshChildren);
  run.tickets = run.standaloneRun ? [target] : freshChildren;
  if (run.tickets.length === 0) throw new PoisonEpic(`epic ${epicBeadId} has no tickets`);

  lease.refuseForeign(leaseTarget);
  // No foreign live lease: adopt any leftover leases on the freshly-read target (this run's own
  // from a crashed prior attempt, or an expired dead one from any machine) so the first publish
  // atomically replaces them. Adopted here — after the gate — so the run's cleanup only ever clears
  // leases we own.
  lease.adopt(leaseTarget);

  // A standalone target that already committed on a prior attempt carries stage:in-review and
  // is skipped straight to the PR step below — its agent never runs again on this resume. The
  // allowlist gate here, the ticket loop and the approve route share ONE "won't run" predicate
  // (ticket-view `resumeSkipped`) so none of them acts on a resume marker: gating on a
  // since-disabled agent would park a retry that only has the (agent-free) PR step left to do.
  // Caveat: "won't run" holds only when the ticket's commit is actually on this branch. A
  // done-on-board ticket whose commit is missing (cross-machine resume) DOES re-run, so the loop
  // re-applies this allowlist gate there — the worktree needed to prove commit presence doesn't
  // exist yet at this point.
  const isResumeSkipped = (t: Bead) => resumeSkipped(t, run.standaloneRun);
  run.target = target;
  return { readiness: freshReadiness, gated, children: freshChildren, isResumeSkipped };
}

/**
 * Step 2-bis. Preserved work may only ride the run SHAPE that kept it (anton-d967 / PR #228 review).
 *
 * A timed-out tree is kept ONLY when the ticket IS the whole run target: that run delivers nothing
 * and parks, so no pull request exists to carry the unfinished work anywhere. Splitting the target
 * into child tickets — which the park itself advises — changes that: the resumed run dispatches the
 * children on the SAME branch, and the first delivery among them opens a pull request whose diff
 * carries the parent's explicitly incomplete commit into the trunk, under a delivery it is no part
 * of and in no delivered list. That is precisely what the standalone-only limit exists to prevent,
 * so the new shape is refused until a person reconciles the commit rather than silently accepted.
 *
 * Placed right after the checkout — the branch is the only place this fact lives — and before any
 * claim, so the park leaves the board untouched.
 *
 * The history read is STRICT (PR #228 review). Everywhere else a failed `git log` fails closed to
 * "no such commit", which is the safe answer for a caller whose default is to re-run the ticket.
 * Here it is the permissive one: it would clear the branch for the children whose pull request is
 * the very thing this refuses. So a read that failed parks too, on its own message.
 */
export async function assertPreservedWorkFitsShape(
  run: EpicRun,
  worktree: Worktree,
): Promise<void> {
  const { targetId } = run;
  if (run.standaloneRun) return;
  if (!(await readPreservedCommitPresence(run, worktree))) return;
  throw new PoisonEpic(
    `${targetId} has child tickets now, but branch \`${worktree.branch}\` still carries the ` +
      `\`${preservedCommitPrefix(targetId)}\` commit a timed-out attempt preserved while ` +
      `${targetId} WAS this run's whole target. No child ticket delivers that commit, so the pull ` +
      `request they open from this branch would carry its unfinished work into the trunk under a ` +
      `delivery it is no part of. Take it off \`${worktree.branch}\` first (drop it, or fold it ` +
      `into the child it belongs to) in ${worktree.path} — or run ${targetId} as a single ticket ` +
      `again with a raised ticketTimeoutMinutes — then resume the run`,
  );
}

/** The guard's one fact, and the park for the case where the branch would not say. */
async function readPreservedCommitPresence(run: EpicRun, worktree: Worktree): Promise<boolean> {
  const { targetId } = run;
  try {
    return await worktreeHasPreservedCommitFor(worktree.path, targetId, { strict: true });
  } catch (e) {
    throw new PoisonEpic(
      `${targetId} has child tickets now, and anton could not read the history of ` +
        `\`${worktree.branch}\` in ${worktree.path} to tell whether a timed-out attempt's ` +
        `\`${preservedCommitPrefix(targetId)}\` commit is still on it ` +
        `(${e instanceof Error ? e.message : String(e)}). Refusing to dispatch the children on an ` +
        `unreadable branch — if that commit IS there, their pull request ships its unfinished work ` +
        `into the trunk. Repair the worktree, then resume the run`,
    );
  }
}

/** Step 0b. Refuse a run whose tickets need a bundled specialist this project has disabled. */
function assertAgentsEnabled(run: EpicRun, gates: RunGates): void {
  const { targetId: epicBeadId, settings, userAgentIds, tickets } = run;
  const { isResumeSkipped } = gates;
  // 0b. Dispatch honors the active-agents allowlist for anton's BUNDLED specialists (anton-dm7);
  // the project's own `.claude/agents` (userAgentIds) are always allowed. PARK, don't skip:
  // running the ticket with the default agent would silently produce work the operator disabled
  // the specialist for, and skipping it would open the epic's single PR incomplete. Parking is
  // recoverable — the operator enables the agent (Settings → Agents) or relabels the ticket,
  // then resumes; tickets and settings are re-read on every attempt. Checked before any
  // claim/worktree/session work so a run never half-executes into a config problem.
  const inactive = inactiveAgentTickets(
    tickets.filter((t) => !isResumeSkipped(t)),
    settings.agents,
    userAgentIds,
  );
  if (inactive.length > 0) {
    throw new PoisonEpic(
      `epic ${epicBeadId} needs agents enabled in this project's settings: ` +
        inactive.map((x) => `${x.id} → agent:${x.agent}`).join(", ") +
        ` — enable them in Settings → Agents (or relabel the tickets), then resume the run`,
    );
  }
}

/** Step 0c. Refuse a run whose target or tickets leave the agent no definition of done. */
function assertBeadContract(run: EpicRun, gates: RunGates): void {
  const { targetId: epicBeadId, target } = run;
  const freshChildren = gates.children;
  // 0c. Dispatch honors the bead contract (anton-j9zs) — the target plus every ticket this run
  // will actually dispatch. A BLOCKING gap (no Acceptance on a ticket, no Success Criteria on
  // an epic) leaves the agent with no definition of done and self-review with no rubric, so the
  // run would produce work nothing can judge. PARK, don't skip, for the same reason as the
  // allowlist gate above: skipping the ticket opens the epic's single PR incomplete. Recoverable
  // — the operator writes the missing section (`bd update --acceptance`) and resumes.
  // Judged against the FRESHLY-PULLED board: `target`/`tickets` were re-read in step 0 (and
  // re-derived in 0a-ter), so a bead repaired between approve and dispatch passes this gate
  // rather than parking on the enqueue-time snapshot. Resume-skipped beads are excluded exactly
  // as above — a ticket whose work is already committed won't run its agent again, so its spec
  // can't strand this attempt; if it turns out it WILL re-run (the cross-machine
  // commit-missing case), the ticket loop re-applies this gate there. When the whole set is
  // resume-skipped this run dispatches no agent at all — the closed-PR recovery that falls
  // through step 0a with only the (agent-free) PR step left — so it is gated on nothing, in the
  // grouped shape as well as the standalone one.
  // The set comes from the same helper the approve route and the board card use
  // (`contractGatedBeads`), so a target this parks on is one the board already marked and
  // approval already refused, rather than a surprise at dispatch.
  // The verdict itself is the board layer's (`beadContractPoison`), so the contract module stays out
  // of this module's import graph (anton-8x1k) — the gate's PLACEMENT is what preparation owns.
  const { poison, advisory } = beadContractPoison(
    epicBeadId,
    contractGatedBeads(target, freshChildren),
  );
  if (poison) throw poison;
  // Advisory gaps NEVER gate — they cost quality, not runnability. Logged so a degraded run is
  // visible rather than silent, then the run proceeds.
  if (advisory) {
    console.warn(`[execute-epic] ${epicBeadId} runs with advisory contract gaps: ${advisory}`);
  }
}

/**
 * Step 0c-bis. Refuse a run holding a ticket whose status only a person can clear. Board-free, so
 * the caller asks it once per board this run adopts — the pre-lease read, the children the lease
 * confirmed, and the ones the human-ticket arm's refresh brought back. Only the PARK reads git
 * ({@link commitsHere}); a run with nothing held costs nothing to ask.
 */
async function assertTicketsClaimable(run: EpicRun, gates: RunGates): Promise<void> {
  // 0c-bis. A ticket in a status bd refuses `--claim` on cannot be dispatched by anyone
  // (anton-fude). The state that puts one there is anton's OWN: a zero-diff run blocks its ticket
  // for human review, and every resume of that target then re-derived the same child set, walked
  // the blocked ticket into runTicket, and died on its hard claim gate — reported as a foreign
  // claim or a locked Dolt DB, neither of which was true. Asked here, with the read-only gates, so
  // the park costs no worktree and no claim, and so the operator reads the ticket's own note
  // instead of bd's refusal.
  // PARK rather than skip: the target ships ONE pull request, so dropping the ticket would advertise
  // a feature missing work the board still shows open — the same call the allowlist and contract
  // gates above make. And never auto-reopen: the ticket is blocked precisely because a run already
  // failed to deliver it, so re-running it would reproduce the zero diff and re-block it.
  // `gates.children` is the working-layer subtree, so a STANDALONE target (its own single ticket) is
  // not judged here — its status is the epic claim's business (claimRunTarget), which already parks
  // on the same refusal with the target's own message.
  const held = humanHeldTickets(dispatchableChildren(gates));
  if (held.length === 0) return;
  throw humanHeldPoison(run.targetId, held, run.branch, await commitsHere(run, held));
}

/**
 * The children this run would actually DISPATCH — the only ones whose status can stop it
 * (PR #227 review).
 *
 * A child a blocker outside this run holds is never claimed this pass: the loop parks it in the
 * held tail (`partitionTickets`) without touching bd, so its status reaches no claim gate. Judging
 * it here would park the whole run over a ticket the run was already going to walk past, taking its
 * independent siblings down with it — the partial-gating rule anton-1two exists to keep.
 */
function dispatchableChildren(gates: RunGates): Bead[] {
  return gates.children.filter((c) => !gates.gated.has(c.id));
}

/**
 * Which held tickets' recorded commits this machine can actually ship — the git answer
 * {@link humanHeldPoison} needs before it may offer a remedy that settles the board over one
 * (PR #227 review).
 *
 * A block note names the branch its run was on, and anton's branch names are deterministic per
 * target: a run resumed on ANOTHER machine derives the same name over a checkout cut from origin,
 * while the commit the note records was never pushed. Branch-name equality alone would then tell the
 * operator that abandoning the ticket leaves its commit in this run's pull request — the advice that
 * drops the work and lets an incomplete PR proceed. Asked of the repository rather than the
 * worktree, so the same answer holds at every gate, including the ones that park before a checkout
 * exists.
 *
 * Only reached on the park path — a run with nothing held pays nothing for it.
 */
async function commitsHere(run: EpicRun, held: HumanHeldTicket[]): Promise<Set<string>> {
  const verified = await Promise.all(
    held.map(async (h) => {
      // A committed block whose sha its run could not read has nothing to ask git about — it stays
      // out of the verified set, and the park hands it the `unverified` remedy (PR #227 review).
      const commit = h.committed;
      if (!commit?.head || commit.branch !== run.branch) return null;
      return (await branchContainsCommit(run.repo, run.branch, commit.head)) ? h.id : null;
    }),
  );
  return new Set(verified.filter((id): id is string => id !== null));
}

/**
 * Step 3b-bis. Ask 0c-bis one last time, on a board read AFTER the children are reserved
 * (PR #227 review).
 *
 * Every ask above it judges a board taken before {@link cascadeChildClaims} ran, and the gap between
 * the last of them and that reservation is wide — a worktree warm is minutes. A person blocking or
 * deferring a LATER child inside it arrives unjudged: the cascade still reserves it (assignment is
 * not a claim, so bd accepts it in any status), the loop dispatches its earlier siblings, and the run
 * only discovers the held ticket at its own claim gate — the failure shape anton-fude removed
 * everywhere else. Asked here, the reservation is already in place, so what this board says about a
 * child is what the loop will find.
 *
 * Not a race this can WIN: nothing stops a person writing a status a millisecond later, and no
 * reservation binds them. What it removes is the WIDE window — the minutes of setup between the last
 * pre-lease ask and the loop — leaving only the moments after this read, where runTicket's claim gate
 * (which now names the status itself) is the backstop.
 *
 * Status-only: the drift and label questions are settled behind the lease (step 1c), and a status a
 * person wrote needs no adoption — a child absent from this board keeps the object the gates above
 * judged, since a set that changed is drift 1c already proved cannot happen unseen.
 *
 * PULLED as well as read (PR #227 review): on an embedded board `loadAllIssues` lists only the LOCAL
 * database, so a status another machine wrote is invisible to it — while {@link publishRunClaim}, a
 * line later, runs a full sync that PULLS before it pushes. Without the pull this check would judge
 * the pre-pull board and publication would then import the very block it was asked about, which is
 * the stale-read shape it exists to remove. `beads.pull` resolves for a board with no remote and for
 * a shared server (nothing to reconcile in either), so only a real refresh failure rejects.
 *
 * Re-runs the structure/cycle gate too (PR #274 review), WITH its own `bd dep cycles` evidence: this
 * is the last pull BEFORE the claim publishes, so it is the last chance to catch a `blocks` cycle
 * among the run's own tickets that a cross-machine write landed after `regateRefreshedBoard`'s check.
 * Without it, a cycle that arrives in this specific window rides straight through — `orderTickets`
 * falls back to source order the moment its topological sort can't place every ticket, and dispatch
 * never learns the order it fell back to was never validated. Reusing the same pull this claimability
 * read already pays for costs nothing extra on the path that matters.
 *
 * Not the LAST pull overall, though: {@link publishRunClaim} right after this runs a full sync, which
 * pulls again as part of its own push. {@link assertPublishedBoardCycleFree} is what covers that
 * later window (PR #274 review, round 2) — this function only owns the one ending here.
 */
async function assertReservedTicketsClaimable(run: EpicRun, gates: RunGates): Promise<void> {
  const { repo, targetId: epicBeadId } = run;
  // A STANDALONE target has no working-layer subtree, so there is nothing here to re-read: its own
  // status is claimRunTarget's business, which already parked on the same refusal. Same exclusion
  // 0c-bis makes, made before the read rather than after it.
  if (gates.children.length === 0) return;
  // Fails CLOSED, like the confirmation read in step 1c and the cascade it follows: a run that
  // cannot prove its reserved children are claimable must not enter the loop. Retryable — the next
  // attempt reuses this worktree and re-takes the same idempotent reservations. `withCycles: true`
  // lets a `bd dep cycles` failure reject this same read rather than silently omitting evidence — the
  // structure gate below must not mistake "couldn't ask" for "asked, none reported".
  let reservedBoard: Bead[];
  try {
    await beads.pull(repo);
    reservedBoard = await loadAllIssues(repo, { strictGates: true, withCycles: true });
  } catch (e) {
    throw new Error(
      `${epicBeadId} could not refresh and re-read the board after reserving its tickets to ` +
        `confirm none of them is held for a person — retrying rather than dispatching into a ` +
        `claim gate that would stop the run mid-feature. ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const structural = structureGaps(epicBeadId, reservedBoard, { cycles: cycleEvidenceFor(reservedBoard) });
  if (structural.blocking.length > 0) {
    throw new PoisonEpic(
      `${epicBeadId} breaks the tier structure: ${formatStructureViolations(structural.blocking)}`,
    );
  }
  const reserved = new Map(runTickets(reservedBoard, epicBeadId).map((t) => [t.id, t]));
  const held = humanHeldTickets(dispatchableChildren(gates).map((c) => reserved.get(c.id) ?? c));
  if (held.length === 0) return;
  throw humanHeldPoison(epicBeadId, held, run.branch, await commitsHere(run, held));
}

/**
 * Step 3c-bis. Re-run the structure/cycle gate ONE more time, on the board {@link publishRunClaim}'s
 * own sync just pulled (PR #274 review, round 2).
 *
 * `assertReservedTicketsClaimable` pulls and gates the board right before the claim publishes — but
 * `publishRunClaim`'s `beads.sync` pulls AGAIN, as the first half of its own push, one line later. On
 * an embedded board that is a second window, after the last gate ran, in which another machine's
 * write can land a `blocks` cycle among this run's own tickets before dispatch starts. Nothing here
 * asks about it: `publishRunClaim` only cares whether the push landed, and this is the last point
 * before the ticket loop where a board read is still cheap. Asked here, on the board that pull
 * actually left behind, closes the window the same way `assertReservedTicketsClaimable` closes the
 * one before it.
 *
 * No pull of its own: `beads.sync` already pulled as its first step, so the local db already carries
 * whatever landed, and pulling again would race the push that same sync may still be finishing.
 *
 * ADOPTED, not merely checked (PR #274 review, round 3): a valid `blocks` edge landing in this same
 * window is invisible to the structure gate above — it is acyclic, so nothing blocks — but it is a
 * new prerequisite `orderTickets` must place. Judging it against `board` and then dispatching from
 * the stale `run.all`/`run.tickets` would carry it nowhere, so `partitionTickets`'s
 * `orderTickets(tickets, all)` would still sort by the pre-pull edges and could dispatch the
 * dependent first. Adopted the same way {@link confirmSelectionUnderLease} adopts its own read.
 *
 * MEMBERSHIP is not adopted the same way (PR #274 review, round 5): the board this reads is the one
 * `publishRunClaim`'s own sync just pulled, and that pull can bring back a child ticket attached
 * (say, an approved gardener re-parent landing in the same window `confirmSelectionUnderLease`
 * already guards earlier) AFTER `assertBeadContract`, `assertAgentsEnabled` and
 * `assertReservedTicketsClaimable` have all already run over the set this run reserved. Silently
 * widening `run.tickets` to `runTickets(board, epicBeadId)` here would carry a ticket into dispatch
 * that none of those gates, nor the cascade, ever looked at — the exact drift
 * {@link confirmSelectionUnderLease} exists to catch, just one window later. So membership is
 * DIFFED against the set this run already reserved, the same way that function diffs its own read,
 * and a change retries preparation rather than being adopted — the retry re-reserves and re-gates
 * whatever set the board holds by then.
 *
 * READINESS is re-derived from the same adopted board, for the same reason (PR #274 review, round
 * 4): the edge this window can land is not only an internal cycle — it is just as validly a new
 * EXTERNAL blocker on one of this run's own tickets (or on the target itself). `partitionTickets`
 * dispatches by `gates.gated` alone; its own re-gate ({@link regateReopened}) fires only for a
 * ticket a supersede reopened, so a plain new blocker on an ordinary live ticket would otherwise
 * ride the stale `gated` this function's caller already captured straight through as dispatchable.
 * Recomputed the same way `regateRefreshedBoard` and `armHumanTicketWaits` do, and PARKED on the
 * same poison a blocker reopening at either of those points already takes: this is just the last
 * window one can land in before the loop starts.
 *
 * The TARGET's own eligibility is RE-ASSERTED against this board, not just its label (PR #274
 * review, round 6): `adoptRefreshedTarget` only ever asked `agent:human`, so a target this same
 * pull found deleted, unapproved, abandoned, or reparented out of run-target shape (a standalone
 * task a re-parent landed under another card in this exact window) rode straight through — either
 * as `adoptRefreshedTarget`'s stale fallback (nothing on the board to find) or as the fresh,
 * newly-ineligible bead itself, since nothing downstream of here repeats what
 * {@link assertRunnableTarget} already asked once at the top of the run. `staleClaimReason` is the
 * SAME question `claimVerified` asks after its own settle window; asked again here because
 * `publishRunClaim`'s sync is one more window the same drift can land in. PARKED, not retried, for
 * the reason {@link runTargetDrift}'s callers park: a target that has stopped being runnable does
 * not become one again by trying.
 *
 * The CHILDREN's `agent:human` label is watched too (PR #274 review, round 6): `armHumanTicketWaits`
 * ran its preflight — and armed its gates — on the board its OWN refresh brought back, which sits
 * before `publishRunClaim`'s sync. A relabel landing in the gap keeps the ticket's id in both the
 * pre- and post-sync sets, so {@link ticketSetDrift} (id-only, by design) reads it as no change at
 * all, and the readiness re-derived above never asks the label either — a person's work would
 * dispatch to the default agent with no wait ever armed for it. Re-running the full arm-and-write
 * preflight here is out: it is documented to run BEFORE any worktree, claim or session exists,
 * exactly because arming is a write racing the very claim this function follows. So the label is
 * REJECTED as drift instead, the same shape `ticketSetDrift` already retries on: the next attempt
 * re-enters from the top, where `armHumanTicketWaits` sees the fresh label and arms its wait properly.
 *
 * EXCLUDES anything already in `gates.gated` (fresh evidence, PR #274 review round 7):
 * `preflightHumanTickets` arms a wait WITHOUT clearing the label — only a person relabelling the
 * ticket does that — so every ticket this run already armed still carries `agent:human` here, and
 * the open gate it armed already blocks the ticket, which is exactly what put its id in `gated` when
 * `armHumanTicketWaits` re-derived readiness. Judging the label alone would reject those same
 * already-handled tickets as "newly relabelled" on every attempt, parking the whole run forever
 * instead of dispatching its independent siblings. Excluding `gated` narrows this to what it must
 * catch: a ticket relabelled human AFTER the preflight ran, which never got a wait armed and so
 * never joined `gated` at all.
 */
async function assertPublishedBoardCycleFree(run: EpicRun, gates: RunGates): Promise<void> {
  const { repo, targetId: epicBeadId } = run;
  let board: Bead[];
  try {
    board = await loadAllIssues(repo, { strictGates: true, withCycles: true });
  } catch (e) {
    throw new Error(
      `${epicBeadId} could not re-read the board after publishing its claim to confirm it is ` +
        `still cycle-free — retrying rather than dispatching into an ordering nobody validated. ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const structural = structureGaps(epicBeadId, board, { cycles: cycleEvidenceFor(board) });
  if (structural.blocking.length > 0) {
    throw new PoisonEpic(
      `${epicBeadId} breaks the tier structure: ${formatStructureViolations(structural.blocking)}`,
    );
  }
  const freshTargetBead = board.find((b) => b.id === epicBeadId);
  if (!freshTargetBead) {
    throw new PoisonEpic(
      `${epicBeadId} is no longer on the board after its claim published — refusing to execute ` +
        `work that vanished from under this run`,
    );
  }
  const adoptedTarget = adoptRefreshedTarget(board, epicBeadId, run.target);
  const staleReason = staleClaimReason(adoptedTarget, board);
  if (staleReason) {
    throw new PoisonEpic(
      `${epicBeadId} is no longer eligible to run (${staleReason}) — its claim published to a ` +
        `board that had already moved on, so refusing to execute work this run no longer owns`,
    );
  }
  const freshTickets = run.standaloneRun ? [adoptedTarget] : runTickets(board, epicBeadId);
  const drift = ticketSetDrift(run.tickets, freshTickets);
  if (drift) {
    throw new Error(
      `${epicBeadId}'s ticket set changed while its claim was publishing (${drift}) — retrying so ` +
        `the contract, agent and reserved-ticket gates run over the whole set rather than ` +
        `dispatching a ticket none of them judged`,
    );
  }
  const relabelledHuman = freshTickets.filter(
    (t) =>
      t.id !== epicBeadId &&
      beads.isHumanWork(t) &&
      !gates.isResumeSkipped(t) &&
      !gates.gated.has(t.id),
  );
  if (relabelledHuman.length > 0) {
    throw new Error(
      `${epicBeadId}'s claim published to a board that had already relabelled ` +
        `${relabelledHuman.map((t) => t.id).join(", ")} ${LABELS.agentHuman} — retrying so the ` +
        `human-ticket preflight arms a wait for it before anything dispatches, rather than sending ` +
        `a person's work to the default agent`,
    );
  }
  run.all = board;
  run.target = adoptedTarget;
  run.tickets = freshTickets;
  const freshReadiness = run.readiness(run.all);
  if (!freshReadiness.runnable) throw blockedRunPoison(epicBeadId, freshReadiness, run.all);
  gates.readiness = freshReadiness;
  gates.gated = new Set(freshReadiness.gated);
}

/**
 * 1c. The retry/steal decision {@link takeRunLease} runs UNDER the lease's write lock: re-read the
 * board that can now SEE this run, and decide whether the selection stands, must retry, or must
 * park (anton-e42l). A board gate like the ones above it — injected into the lease seam so the seam
 * keeps only the lease mechanism (anton-8x1k) — and it re-derives the confirmed children the caller
 * re-gates on.
 *
 * Steps 0a-ter/0b/0c chose and gated the tickets from a read taken BEFORE the lease was published,
 * and until it landed the target carried neither a lease nor a claim — so for that whole window it
 * reads as free work to anyone else. An approved gardener re-parent is the case that matters: its
 * home check (gardener/apply.ts `homeUnusable`) asks exactly "is a run holding this card", sees
 * nothing, and attaches a ticket this run has already finished selecting. That newcomer is never
 * dispatched, and merge finalization closes it unrun along with the rest of the target's subtree.
 * The lock (held by the caller) is what makes this read a serialization point rather than just a
 * later read; cross-machine the lock buys nothing and the lease is the only guard there.
 *
 * Status-blind by construction: `runTickets` filters on shape, not state, so a ticket another
 * machine closed mid-window is still in both sets and doesn't trip the drift check.
 */
async function confirmSelectionUnderLease(run: EpicRun, freshChildren: Bead[]): Promise<Bead[]> {
  const { targetId: epicBeadId } = run;
  const confirmedBoard = await reReadConfirmedBoard(run);
  // The target's OWN run shape is re-confirmed here, not just its subtree: a parentless task/bug
  // re-parented under another card in this same window keeps an EMPTY ticket set on both sides of
  // the drift check below, so nothing would fire while the bead has become a ticket in someone
  // else's run — executed here as well as there. PARK rather than retry, like 0a-ter: a target that
  // stopped being one doesn't become one again by trying, and the message names what took it.
  const targetDrift = runTargetDrift(epicBeadId, confirmedBoard);
  if (targetDrift) {
    throw new PoisonEpic(
      `${epicBeadId} stopped being a run target while this run was starting (${targetDrift}) ` +
        `— refusing to execute work another target now owns`,
    );
  }
  const confirmedChildren = runTickets(confirmedBoard, epicBeadId);
  const drift = ticketSetDrift(freshChildren, confirmedChildren);
  if (drift) {
    throw new Error(
      `${epicBeadId}'s ticket set changed while this run was starting (${drift}) — retrying so ` +
        `the run gates and executes the whole set rather than dropping work moved under it ` +
        `before its run-lease was visible`,
    );
  }
  // And the target's LABEL, on the freshest board this run ever reads (PR #213 review).
  // `agent:human` is asked in exactly two places — the top-of-handler backstop and this adopt — so a
  // relabel that lands in the lease window is refused here or nowhere. Adopted, not merely checked:
  // the two drift gates just proved this board describes the same run, so its bead is the one every
  // later label read should be answering. The CHILDREN are adopted for the same reason — a child
  // RELABELLED `agent:human` inside the lease window passes the id-only drift gate untouched, and a
  // grouped run carrying its pre-lease objects forward would hand human work to the default agent. A
  // standalone run's ticket IS its target, so the two never diverge.
  const confirmedTarget = confirmedBoard.find((b) => b.id === epicBeadId);
  if (confirmedTarget) {
    run.target = adoptRefreshedTarget(confirmedBoard, epicBeadId, confirmedTarget);
    run.tickets = run.standaloneRun ? [run.target] : confirmedChildren;
  }
  return confirmedChildren;
}

/**
 * The confirmation's one read. Fails closed, like the arbitration reads it follows — a run that
 * cannot prove its selection is stable must not proceed — and costs nothing, since no worktree
 * exists yet.
 */
async function reReadConfirmedBoard(run: EpicRun): Promise<Bead[]> {
  try {
    return await loadAllIssues(run.repo, { strictGates: true });
  } catch (e) {
    throw new Error(
      `${run.targetId} could not re-read the board after publishing its run-lease to confirm its ` +
        `ticket set — retrying rather than executing a selection that may already be stale. ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/** Step 0b-pre. Turn every ticket only a person can do into a gate at its own boundary. */
async function armHumanTicketWaits(run: EpicRun, gates: RunGates): Promise<void> {
  const { repo, targetId: epicBeadId, ctx, standaloneRun } = run;
  const { isResumeSkipped } = gates;
  let freshReadiness = gates.readiness;
  let freshChildren = gates.children;
  // 0b-pre. A ticket only a PERSON can do becomes a gate at its own boundary (anton-mv70).
  //     `agent:human` resolves to no specialist prompt, so dispatching it falls through to the
  //     DEFAULT agent and spends the ticket's whole budget improvising at a credential, a
  //     purchase or a taste call. The target-level refusal at the top of this handler covers a
  //     human RUN TARGET; this covers a human ticket INSIDE an otherwise ordinary run, which no
  //     claimable-set exclusion can reach — the feature is the claimable thing, not its child.
  //     A gate, not a park of the whole run: the ask blocks the ticket and (through the graph's
  //     own transitive closure) the steps that depend on it, while every independent sibling
  //     still runs to the branch — the partial-gating rule anton-1two/anton-4hxl already set.
  //     Armed through the SAME helper as the run-level ask (`armHumanGate`), so re-entering the
  //     run reuses the wait instead of stacking a second one, and nothing but a person's
  //     `bd gate resolve` ends it. That resolve is the whole answer: bd refuses to close a bead
  //     an open gate blocks, so anton closes the ticket for them on the way back in
  //     ({@link answeredHumanGate}) — otherwise the resume would land straight back on a fresh
  //     arm of the same ask.
  //     Resume-skipped tickets are excluded exactly as the allowlist and contract gates above
  //     exclude them: a human ticket already closed is finished work, and arming a wait on it
  //     would ask for something that already happened.
  //     Armed AFTER the run-lease is published, arbitrated and confirmed (step 1c) and before
  //     any worktree, claim or session exists, because arming is a WRITE (PR #213 review). Every
  //     gate above it is read-only, so two machines starting the same target race through them
  //     together — and `armHumanGate` reads the board and then creates, so armed ahead of the
  //     lease both would create a wait for the same ticket. Neither park then names the twin: an
  //     all-human target parks both attempts at the readiness check below without either ever
  //     taking a lease, and on a mixed target the attempt that later loses the lease leaves its
  //     gates standing for an operator to reconcile by hand. Behind the lease exactly one run
  //     reaches here, so the wait a person answers is the only one on the board. Parking here
  //     still costs nothing — no checkout has been warmed — and the cleanup clears the lease this
  //     run published on the way out.
  //     The verdict is then re-read from the board the gates are ON, so the dispatch loop holds
  //     them by the ordinary blocked-child rule rather than a second, parallel notion of "held".
  //     Classification and arming loop together ({@link preflightHumanTickets}): each arm pulls
  //     the shared board, so a sibling relabelled in that window is only ever caught by
  //     re-classifying what the refresh brought back.
  const humanPreflight = await preflightHumanTickets({
    repo,
    targetId: epicBeadId,
    board: run.all,
    target: run.target,
    children: freshChildren,
    standaloneRun,
    isResumeSkipped,
    signal: ctx.signal,
  });
  if (humanPreflight.armed) {
    const { answeredButBlocked } = humanPreflight;
    run.all = humanPreflight.board;
    run.target = humanPreflight.target;
    freshChildren = humanPreflight.children;
    run.tickets = humanPreflight.tickets;
    freshReadiness = run.readiness(run.all);
    // A held answered-gate ticket joins the verdict as gated, so the dispatch loop holds it by
    // the same rule as any other blocked child rather than reaching it as open human work and
    // parking on the "it should be held by a gate" backstop. Its blockers join the list the park
    // names — an in-run sibling never appears in the rollup, and the tail would otherwise name a
    // held ticket with nothing to wait for.
    if (answeredButBlocked.size > 0) {
      freshReadiness = {
        blockers: [
          ...new Set([
            ...freshReadiness.blockers,
            ...[...answeredButBlocked.values()].flat(),
          ]),
        ],
        gated: [...new Set([...freshReadiness.gated, ...answeredButBlocked.keys()])],
        runnable: freshReadiness.runnable,
      };
    }
    gates.gated = new Set(freshReadiness.gated);
    // Every ticket is human work (or held behind it): there is nothing for an agent to do here,
    // so park BEFORE any worktree, claim or session exists rather than opening a run that can
    // only deliver an empty diff. The park names the gates and their asks (blockedRunPoison), so
    // the row a person acts on is the wait itself.
    if (!freshReadiness.runnable) throw blockedRunPoison(epicBeadId, freshReadiness, run.all);
  }
  gates.readiness = freshReadiness;
  gates.children = freshChildren;
}
