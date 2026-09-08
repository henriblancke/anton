/**
 * Everything between the run row and the first dispatched ticket (anton-1lix — extracted from
 * execute-epic.ts).
 *
 * The order here is the whole design: the READ-ONLY gates run first (a refusal costs nothing), then
 * the lease — which is what makes this machine the only one executing the target — then the writes
 * that follow from holding it (the human waits, the checkout, the claim and its cascade). Moving a
 * step across that line changes what a park leaves behind, so each one says where it sits and why.
 */
import { BREAKER_EFFECT } from "../autopilot-breaker";
import { beads, type Bead } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { contractGaps, formatContractGaps } from "../beads/contract";
import { contractGatedBeads, resumeSkipped, runTickets } from "../ticket-view";
import {
  branchContainsCommit,
  preservedCommitPrefix,
  worktreeHasPreservedCommitFor,
} from "../git/ops";
import type { Worktree } from "../git/worktree";
import { PoisonEpic } from "./errors";
import {
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
import { checkSelfFreshness, selfRepoRoot, type SelfFreshness } from "./self-freshness";
import type { EpicRun } from "./execute-epic-run";
// The formula/step family and the run-lease sit behind ONE seam (anton-8x1k) — the run-shape
// helpers this module merely threads through or re-exports, kept out of its top-level import graph
// so the checkout-staleness preflight (anton-vzhf) can join them there rather than fan out here.
import {
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
  const { preCheckTrusted, leaseTarget } = await refreshRunBoard(run);
  if (await settleCompletedRun(run, leaseTarget)) return { done: true };
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
 * Step 0-pre. Refuse to START a new run when anton is running behind its own latest code
 * (anton-mh3c). anton pulls before it starts, but a fix merged after that pull — or a lockfile bump
 * nobody reinstalled — leaves the process a step behind its own repairs; starting new work on it
 * ships that stale code into the trunk.
 *
 * Machine-level, not board-level: the self-freshness verdict (anton-vzhf) is about the PROCESS, so
 * it is read against anton's OWN install root — not the project checkout in {@link EpicRun.repo}.
 *
 * A read-only refusal like every gate around it, and it inherits their contract: the park costs no
 * lease, worktree or claim, and a run already in flight — a separate job long past this gate — is
 * untouched, only a new start is stopped ({@link BREAKER_EFFECT}). Placed AFTER the completion
 * short-circuit so a target already carried to its pull request still settles idempotently rather
 * than being grounded by a staleness with nothing left to run. The PoisonEpic parks the job for a
 * human — the fix is theirs (pull/reinstall, then restart anton) — and its message is the durable
 * record the run row keeps and the run-health sweep surfaces.
 */
async function assertSelfCheckoutFresh(): Promise<void> {
  const root = selfRepoRoot();
  const refusal = staleCheckoutRefusal(await checkSelfFreshness(root), root);
  if (refusal) throw new PoisonEpic(refusal);
}

/**
 * The refusal a stale checkout parks a new start on (anton-mh3c), or undefined when anton is running
 * its own latest code. Names WHAT is stale and the command that clears it, and closes with the
 * disarm's contract line ({@link BREAKER_EFFECT}) so the operator reads the same "running work is
 * unaffected" promise a disarm makes rather than fearing a full stop.
 *
 * Only a verdict anton can act on by rebuilding counts as stale: HEAD behind its own upstream, or
 * installed packages that no longer match the lockfile. Every INDETERMINATE verdict — a remote it
 * could not reach, a branch with no upstream, a lockfile it could not read — passes exactly as a
 * clean one does: refusing a start on a check that never answered would ground an offline runner on
 * no evidence, the line anton-vzhf drew and this honours.
 */
export function staleCheckoutRefusal(
  freshness: SelfFreshness,
  repoPath: string,
): string | undefined {
  const stale: string[] = [];
  if (freshness.checkout.state === "behind") {
    const { behind, upstream } = freshness.checkout;
    stale.push(`its checkout is ${behind} commit(s) behind ${upstream} — run \`git pull\``);
  }
  if (freshness.dependencies.state === "drift") {
    stale.push(
      `its installed packages no longer match bun.lock ` +
        `(${freshness.dependencies.packages.join(", ")}) — run \`bun install\``,
    );
  }
  if (stale.length === 0) return undefined;
  return (
    `anton is running behind its own latest code, so it will not start new work: ` +
    `${stale.join("; ")} in ${repoPath}, then restart anton. ${BREAKER_EFFECT}`
  );
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
 */
async function assertReservedTicketsClaimable(run: EpicRun, gates: RunGates): Promise<void> {
  const { repo, targetId: epicBeadId } = run;
  // A STANDALONE target has no working-layer subtree, so there is nothing here to re-read: its own
  // status is claimRunTarget's business, which already parked on the same refusal. Same exclusion
  // 0c-bis makes, made before the read rather than after it.
  if (gates.children.length === 0) return;
  // Fails CLOSED, like the confirmation read in step 1c and the cascade it follows: a run that
  // cannot prove its reserved children are claimable must not enter the loop. Retryable — the next
  // attempt reuses this worktree and re-takes the same idempotent reservations.
  let reservedBoard: Bead[];
  try {
    await beads.pull(repo);
    reservedBoard = await loadAllIssues(repo, { strictGates: true });
  } catch (e) {
    throw new Error(
      `${epicBeadId} could not refresh and re-read the board after reserving its tickets to ` +
        `confirm none of them is held for a person — retrying rather than dispatching into a ` +
        `claim gate that would stop the run mid-feature. ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const reserved = new Map(runTickets(reservedBoard, epicBeadId).map((t) => [t.id, t]));
  const held = humanHeldTickets(dispatchableChildren(gates).map((c) => reserved.get(c.id) ?? c));
  if (held.length === 0) return;
  throw humanHeldPoison(epicBeadId, held, run.branch, await commitsHere(run, held));
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

