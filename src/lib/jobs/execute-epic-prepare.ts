/**
 * Everything between the run row and the first dispatched ticket (anton-1lix — extracted from
 * execute-epic.ts).
 *
 * The order here is the whole design: the READ-ONLY gates run first (a refusal costs nothing), then
 * the lease — which is what makes this machine the only one executing the target — then the writes
 * that follow from holding it (the human waits, the checkout, the claim and its cascade). Moving a
 * step across that line changes what a park leaves behind, so each one says where it sits and why.
 */
import { beads, type Bead } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { withBeadWriteLock } from "../beads/claim-lock";
import { contractGaps, formatContractGaps } from "../beads/contract";
import { contractGatedBeads, resumeSkipped, runTickets } from "../ticket-view";
import { preservedCommitPrefix, worktreeHasPreservedCommitFor } from "../git/ops";
import type { Worktree } from "../git/worktree";
import { findRunFormulaForBranch, updateRun } from "../runs";
import { PoisonEpic } from "./errors";
import {
  blockedRunPoison,
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
import { assertRunFormulaFloor } from "./formula-floor";
import { validateRunFormula, type ResolvedStep } from "./run-formula";
import { splitFormulaPhases } from "./execute-epic-formula";
import type { StepContext } from "./step-registry";


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
  const { preCheckTrusted, leaseTarget } = await refreshRunBoard(run);
  if (await settleCompletedRun(run, leaseTarget)) return { done: true };
  const gates = regateRefreshedBoard(run, leaseTarget);
  assertAgentsEnabled(run, gates);
  assertBeadContract(run, gates);
  const { ticketSteps, runSteps } = await resolveRunPipeline(run);
  await takeRunLease(run, preCheckTrusted, gates);
  run.lease.startRefresh();
  await armHumanTicketWaits(run, gates);
  const { worktree, runStep } = await warmRunWorktree(run);
  await assertPreservedWorkFitsShape(run, worktree);
  await claimRunTarget(run);
  await cascadeChildClaims(run);
  await publishRunClaim(run);
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
 * Steps 0a-bis and 0a-ter. Re-run the readiness gate and re-derive the target's SHAPE against the
 * freshly-pulled board, then take the lease's leftovers. Both properties belong to the whole BOARD,
 * not to the bead, so a pull that changed either must be judged before anything is held.
 */
function regateRefreshedBoard(run: EpicRun, leaseTarget: Bead): RunGates {
  const { targetId: epicBeadId, lease } = run;
  const { all } = run;
  let target = run.target;
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
 */
export async function assertPreservedWorkFitsShape(
  run: EpicRun,
  worktree: Worktree,
): Promise<void> {
  const { targetId } = run;
  if (run.standaloneRun) return;
  if (!(await worktreeHasPreservedCommitFor(worktree.path, targetId))) return;
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
  const contractGated = contractGatedBeads(target, freshChildren);
  const contractBlocking = contractGaps(contractGated, "blocking");
  if (contractBlocking.length > 0) {
    throw new PoisonEpic(
      `epic ${epicBeadId} has beads that don't meet the bead contract: ` +
        formatContractGaps(contractBlocking) +
        ` — write the missing section(s), then resume the run`,
    );
  }
  // Advisory gaps NEVER gate — they cost quality, not runnability. Logged so a degraded run is
  // visible rather than silent, then the run proceeds.
  const contractAdvisory = contractGaps(contractGated, "advisory");
  if (contractAdvisory.length > 0) {
    console.warn(
      `[execute-epic] ${epicBeadId} runs with advisory contract gaps: ` +
        formatContractGaps(contractAdvisory),
    );
  }
}

/** Step 0d. Cook, floor-check and pin the pipeline this run walks, then split it into its phases. */
async function resolveRunPipeline(
  run: EpicRun,
): Promise<{ ticketSteps: ResolvedStep[]; runSteps: ResolvedStep[] }> {
  const { db, clock, projectId, repo, runId, branch, targetId: epicBeadId, settings, existing, target } = run;
  // 0d. Validate the project's run pipeline (anton-hrql). The formula is what a run walks, so a
  //     broken one must fail at the START of a run rather than halfway through: cook it and
  //     resolve every step's handler here — before the lease is published and before any worktree
  //     exists — so an unparseable file, a key bd would silently drop, or a `step:` label that
  //     maps to no handler parks with the file path and the offending step instead of stranding a
  //     half-executed run. PARK, like the gates above: the operator fixes the file (or deletes it
  //     to fall back to anton's default) and resumes. Cheap and read-only — the project copy when
  //     it has one, else anton's bundled default.
  //     Then hold the cooked pipeline to anton's invariant floor (anton-6b99): the project owns
  //     the steps, anton owns the guarantees, so a formula may ADD steps freely but may not omit
  //     implement/commit/pr or order them so the run's work is thrown away (a PR opened before
  //     the commit, an agent dispatched after it). Same park, same place — before the worktree.
  //     WHICH pipeline is a per-label choice (anton-aa3m): the project may map a bead label to a
  //     formula of its own, so this run walks the first mapped label the TARGET carries (one run
  //     is one worktree and one PR, so it walks one pipeline), else the project's default. The
  //     floor is applied to whatever came back — selection only changes which file is loaded —
  //     so a variant cannot escape it. The choice is then recorded ON THE RUN below rather than
  //     left to be inferred from settings and labels that may since have changed.
  //     Selection happens ONCE PER BRANCH, not once per attempt: an attempt that already
  //     recorded a pipeline pins it, and this one re-validates that source instead of selecting
  //     again. Every attempt re-reads the board and the settings, so re-selecting would let a
  //     label added since (`stage:implementing` — which this very job adds below — or an
  //     operator's relabel) or an edited variant map switch pipelines after some tickets had
  //     already committed, while the record below claimed the whole run used the new one. The
  //     pin is not limited to the open run row: an ordinary handler error settles the row
  //     `failed`, so the runner's retry lands here with `existing` undefined while still reusing
  //     that attempt's worktree and its committed tickets — hence the branch-scoped lookup
  //     (findRunFormulaForBranch), which is the same continuity the retry itself resumes by.
  //     `{{var}}` values make this a RUNTIME cook: the pipeline is resolved with the run's own
  //     target, and bd's "every declared variable needs a value" check fires here rather than a
  //     formula anton cannot satisfy walking with literal placeholders in it.
  const pinnedFormula = existing?.formula
    ? { source: existing.formula, variant: existing.formulaVariant ?? undefined }
    : await findRunFormulaForBranch(db, projectId, epicBeadId, branch);
  const formula = await validateRunFormula(repo, {
    labels: target.labels,
    variants: settings.formulaVariants,
    pinned: pinnedFormula,
    vars: { target: epicBeadId },
  });
  assertRunFormulaFloor(formula);
  // `recorded`, not `source`: anton's bundled default is stored as a sentinel rather than an
  // install-absolute path, so a run in flight across an upgrade that moved the install root
  // re-reads the pipeline it pinned instead of parking on a path that only changed.
  await updateRun(db, clock, runId, {
    formula: formula.recorded,
    formulaVariant: formula.variant ?? null,
  });
  // The pipeline this run walks (anton-lnkt), split at the commit into its two phases. Steps run
  // ONE AT A TIME — they share one worktree and one PR, so a formula whose steps could run
  // concurrently is not a licence to fan out.
  const { ticketSteps, runSteps } = splitFormulaPhases(formula);
  return { ticketSteps, runSteps };
}

/** Steps 1 → 1c. Take the lease, then re-confirm the selection against a board that can SEE it. */
async function takeRunLease(
  run: EpicRun,
  preCheckTrusted: boolean,
  gates: RunGates,
): Promise<void> {
  const { repo, targetId: epicBeadId, lease } = run;
  let freshChildren = gates.children;
  // 1. Publish the cross-machine run-liveness lease BEFORE any slow setup — worktree creation,
  //    operator resolution, the epic claim — and keep it fresh while this run executes
  //    (anton-jz1). Acquiring it up front closes the window where another machine's Force run
  //    (whose local jobs table is empty) sees no lease during our setup and starts a second
  //    concurrent run; the fresh foreign-lease gate above already ruled out an existing one. The
  //    initial publish fails closed (`lease.claim` throws if the label can't be written OR
  //    pushed to the shared remote) — a run whose lease no other machine can see must not
  //    proceed. `claim` also settles the post-publish race (step 1b) before it returns, so
  //    reaching the confirmation below means this run is the only one holding the target.
  //    `preCheckTrusted` is what forbids arbitrating by owner order after a stale pre-check.
  // Steps 1 → 1c run under the TARGET's own bead write lock (anton-e42l). The lease and the
  // confirmation read below are what stop an approved gardener re-parent attaching a ticket to a
  // set this run has already selected — but a read alone serializes nothing: the gardener writes
  // under `withBeadWriteLock` (gardener/apply.ts `applyStep` locks the subject AND the home), and
  // it yields between passing `homeUnusable` and running the write. Outside that lock, this
  // confirmation could land in exactly that gap, see the old ticket set, and let the run proceed
  // while the delayed re-parent hangs a ticket nothing will dispatch — later closed unrun with
  // the target. Holding the home's lock across the publish and the confirmation makes the two
  // orders real: either the re-parent completes first and this read sees the drift (retry), or it
  // queues behind this block and its own locked re-read finds the live lease (refuse). Released
  // before the claim in step 3, which takes this same lock (beads/claim.ts) — nothing inside here
  // may take it, on pain of deadlock.
  await withBeadWriteLock(repo, epicBeadId, async () => {
    await lease.claim(preCheckTrusted);

    // 1c. Re-confirm the ticket selection against a board that can SEE this run (anton-e42l).
    //     Steps 0a-ter/0b/0c chose and gated the tickets from a read taken BEFORE the publish
    //     above, and until that lease landed the target carried neither a lease nor a claim — so
    //     for that whole window it reads as free work to anyone else. An approved gardener
    //     re-parent is the case that matters: its home check (gardener/apply.ts `homeUnusable`)
    //     asks exactly "is a run holding this card", sees nothing, and attaches a ticket this run
    //     has already finished selecting. That newcomer is never dispatched, and merge
    //     finalization closes it unrun along with the rest of the target's subtree.
    //     The lease is now published, pushed and arbitrated, and this read runs under the
    //     target's write lock (see the wrapper above) — which is what makes it a serialization
    //     point rather than just a later read: a move that landed before it is IN this board, and
    //     one that has not written yet cannot write until the lock is released, by which time its
    //     own locked re-read sees the live lease and refuses. Cross-machine the lock buys
    //     nothing, and the lease is still the only guard there. A set that differs means our
    //     selection is the stale half of
    //     that race — retry (a plain Error, not a park) so the next attempt re-gates and runs the
    //     whole set rather than silently dropping the newcomer. Converges: the retry re-reads the
    //     board from the top and selects the set this read just saw.
    //     Fails closed on an unreadable board, like the arbitration reads above — we cannot prove
    //     the set is stable — and costs nothing, since no worktree exists yet.
    //     Status-blind by construction: `runTickets` filters on shape, not state, so a ticket
    //     another machine closed mid-window is still in both sets and doesn't trip this.
    let confirmedBoard: Bead[];
    try {
      confirmedBoard = await loadAllIssues(repo, { strictGates: true });
    } catch (e) {
      throw new Error(
        `${epicBeadId} could not re-read the board after publishing its run-lease to confirm its ` +
          `ticket set — retrying rather than executing a selection that may already be stale. ` +
          `(${e instanceof Error ? e.message : String(e)})`,
      );
    }
    //     The target's OWN run shape is re-confirmed here, not just its subtree: a parentless
    //     task/bug re-parented under another card in this same window keeps an EMPTY ticket set
    //     on both sides of the drift check below, so nothing would fire while the bead has
    //     become a ticket in someone else's run — executed here as well as there. PARK rather
    //     than retry, like 0a-ter: a target that stopped being one doesn't become one again by
    //     trying, and the message names what took it.
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
    //     And the target's LABEL, on the freshest board this run ever reads (PR #213 review).
    //     `agent:human` is asked in exactly two places — the top-of-handler backstop and this
    //     adopt — so a relabel that lands in the lease window is refused here or nowhere.
    //     Adopted, not merely checked: the two drift gates just proved this board describes the
    //     same run, so its bead is the one every later label read should be answering.
    //     Read out of the board rather than off `target`, which widens back to
    //     `Bead | undefined` inside this closure; the drift gate above already proved it is here.
    const confirmedTarget = confirmedBoard.find((b) => b.id === epicBeadId);
    //     The CHILDREN are adopted for the same reason, not just compared (PR #213 review). The
    //     drift gate above asks about IDs, so a child RELABELLED `agent:human` inside the lease
    //     window passes it untouched — and a grouped run that carried its pre-lease objects
    //     forward would classify human work off the superseded labels below and hand the ticket
    //     to the default agent. The confirmed objects are the ones every later label read
    //     answers. A standalone run's ticket IS its target, so the two never diverge.
    freshChildren = confirmedChildren;
    if (confirmedTarget) {
      run.target = adoptRefreshedTarget(confirmedBoard, epicBeadId, confirmedTarget);
      run.tickets = run.standaloneRun ? [run.target] : freshChildren;
    }
  });
  gates.children = freshChildren;
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

