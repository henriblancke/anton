/**
 * The two steps that write the run's EVIDENCE: `step:commit` turns a worktree into history, and
 * `step:pr` turns that history into the one place a human meets it.
 *
 * They share a module because they share a subject — git — and because the delivery verdict the
 * commit reports is what the PR is opened on the strength of.
 */
import {
  commitAll,
  commitMarker,
  isAncestor,
  openPullRequest,
  readWorktreeState,
  worktreeHasCommitFor,
  worktreeHasPreservedCommitFor,
  type WorktreeState,
} from "../../git/ops";
import { PoisonEpic } from "../errors";
import { buildPrTitle } from "../pr-title";
import { stepSubject, type StepContext } from "./context";
import { prBody } from "./prompts";
import type { StepResultWith } from "./result";

/**
 * `step:commit` — commit whatever the run changed. An empty tree is reported as `ok: false`, never
 * as a quiet success: a clean agent exit that left no diff delivered nothing, and git is the run's
 * evidence of record.
 *
 * "Empty tree" means the ticket produced NOTHING — not merely that the index was empty when this
 * step ran (anton-8t1f). The base contract tells the agent not to commit, but agents do it anyway,
 * and a self-committed ticket leaves the same empty index as one that did nothing at all. Reading
 * the index alone then discards real, gate-passed work: the delivery-evidence gate blocks the
 * ticket, halts the epic and parks the job as poison, writing "nothing landed" onto a board while
 * the branch carries the commits that say otherwise. Worse, the state is self-reinforcing — the
 * worktree is reused on resume, so the next run finds the work already done, reports `blocked` for
 * the honest reason, and is read as corroborating the very block it contradicts.
 *
 * So HEAD is consulted whenever the index is empty, and four cases fall out:
 *
 * 1. **HEAD stood still** — nothing was delivered, unless a previous attempt's TIMEOUT preserved
 *    this ticket's work on the branch (anton-d967), in which case the work is here and this run
 *    found nothing left to do. Adopted, with the same attribution marker as case 2.
 * 2. **HEAD moved FORWARD on the run's branch** — the agent committed its own work. That IS
 *    delivery, and it is already where the PR push will find it. Adopted, with a marker commit
 *    recording the ticket attribution the agent's own subjects lack (see {@link commitMarker}).
 * 3. **HEAD left the run's branch** — a branch of the agent's own, or a detached HEAD. Any commits
 *    there are unreachable: anton pushes the run's branch BY NAME, so they would never reach the PR
 *    while every later step read them as present. Poison, so a human moves them back by hand rather
 *    than a retry burying them deeper — the same call the review gate makes for a review fix
 *    that wanders off-branch.
 * 4. **HEAD moved but the branch no longer contains where the ticket started** — a `reset --hard`,
 *    an amend, a rebase. HEAD moves exactly as visibly as case 2 while history is REMOVED, so
 *    "different HEAD" alone would adopt it and, on a multi-ticket run, open a PR missing an earlier
 *    ticket's commits that anton has already closed the bead for. Poison.
 */
export async function commitStep(ctx: StepContext): Promise<StepResultWith<"committed">> {
  const { committed } = await commitAll(ctx.worktreePath, commitMessage(ctx));
  if (committed) return { ok: true, detail: "committed", facts: { committed: true } };

  // No anchor to compare against: fall back to the index alone. The pre-anton-8t1f behaviour, kept
  // deliberately — a missing anchor must not be able to manufacture the false success the gate
  // exists to catch.
  if (!ctx.ticketStartHead) return nothingDelivered();

  // `commitAll` just ran `git add -A` here, so git is demonstrably working: a read that fails now is
  // a real fault and propagates, rather than being absorbed into a delivery verdict either way.
  const state = await readWorktreeState(ctx.worktreePath);
  if (state.head === ctx.ticketStartHead) return adoptPreservedWork(ctx);

  assertHeadOnRunBranch(ctx, state);
  await assertTicketStartReachable(ctx, state, ctx.ticketStartHead);
  return adoptAgentCommits(ctx);
}

/** Case 1: HEAD stood still — the ticket produced nothing, which is never a quiet success. */
function nothingDelivered(): StepResultWith<"committed"> {
  return { ok: false, detail: "nothing to commit (zero diff)", facts: { committed: false } };
}

/**
 * Case 3: HEAD left the run's branch. Deliberately worded for BOTH ways this fires — the agent
 * committed off-branch, and the agent merely checked something else out. The park note is read by a
 * human who has to work out which.
 */
function assertHeadOnRunBranch(ctx: StepContext, state: WorktreeState): void {
  if (state.ref === `refs/heads/${ctx.branch}`) return;
  throw new PoisonEpic(
    `${stepSubject(ctx).id} left HEAD on ${state.ref ? state.ref : `a detached HEAD (${state.head})`} ` +
      `instead of the run's ${ctx.branch}. Parked instead of retried — anton pushes the run's branch ` +
      `by name, so any commits made there would never reach the PR while every later step read them ` +
      `as delivered. If there are commits, move them onto ${ctx.branch} by hand, then resume the run`,
  );
}

/**
 * Case 4: a moved HEAD is delivery only if the branch still CONTAINS where this ticket started. A
 * `reset --hard`, an amend or a rebase moves it just as visibly while dropping history — on a
 * multi-ticket run, an earlier ticket's commits, whose bead anton has already closed.
 */
async function assertTicketStartReachable(
  ctx: StepContext,
  state: WorktreeState,
  startHead: string,
): Promise<void> {
  if (await isAncestor(ctx.worktreePath, startHead, state.head)) return;
  throw new PoisonEpic(
    `${stepSubject(ctx).id} left ${ctx.branch} at ${state.head}, which no longer contains the commit ` +
      `the ticket started from (${startHead}) — history was reset, amended or rebased ` +
      `rather than added to. Parked instead of retried: work this run already committed and closed ` +
      `beads for may be gone, so adopting this as a delivery would open a PR missing it. Reconcile ` +
      `the branch by hand, then resume the run`,
  );
}

/**
 * Case 2: the agent committed its own work on the run's branch. That IS delivery and it is already
 * where the PR push will find it.
 *
 * The agent's commits keep their own subjects, so `worktreeHasCommitFor` cannot see this ticket in
 * them and a resume would re-run it onto a tree with nothing left to do. The marker is what makes
 * the work discoverable under the ticket's own id — and it is skipped when the agent happened to
 * write a conforming subject itself, so nothing is recorded twice.
 */
async function adoptAgentCommits(ctx: StepContext): Promise<StepResultWith<"committed">> {
  const recorded = await recordAttribution(
    ctx,
    `The implementing agent committed this ticket's work itself, against the operating contract ` +
      `("anton commits your working-tree changes"). Its commits are the delivery and are left as they ` +
      `are; this empty commit records the ticket they belong to, which their own subjects do not.`,
  );
  return {
    ok: true,
    detail: recorded
      ? "the agent committed its own work — adopted as delivered, ticket attribution recorded"
      : "the agent committed its own work — adopted as delivered",
    facts: { committed: true },
  };
}

/**
 * Case 1 continued: HEAD stood still because there was nothing left to do. A ticket whose budget
 * expired on a gate-passing tree has that tree PRESERVED on the branch as an explicitly incomplete
 * `WIP <id>:` commit (anton-d967), and the resume re-runs the ticket from it — so an agent that
 * finds the change already made delivers exactly that commit, not an empty tree.
 *
 * Without this the preserved case could never reach a pull request. The `WIP` subject is invisible
 * to {@link worktreeHasCommitFor} by design, so the resume's zero diff read as "nothing landed",
 * poison-parked the run, and the next resume did the same — the code-finished/bookkeeping-cut-short
 * case, permanently stuck one step from the PR it had already earned.
 *
 * This is not a free pass on the delivery gate: a ticket with no preserved commit still reports the
 * zero diff it always did, and an agent that self-reported `blocked` is still blocked by
 * `assertDelivered` on the strength of its own report.
 */
async function adoptPreservedWork(ctx: StepContext): Promise<StepResultWith<"committed">> {
  const subject = stepSubject(ctx);
  if (!(await worktreeHasPreservedCommitFor(ctx.worktreePath, subject.id))) {
    return nothingDelivered();
  }
  const recorded = await recordAttribution(
    ctx,
    `A previous attempt exceeded this ticket's budget and its work was PRESERVED on this branch as ` +
      `an explicitly incomplete commit; this run found nothing left to do, so that work is the ` +
      `delivery. This empty commit records the ticket it belongs to, which the \`WIP\` subject ` +
      `deliberately does not.`,
  );
  return {
    ok: true,
    detail: recorded
      ? "a timed-out attempt's preserved work is the delivery — adopted, ticket attribution recorded"
      : "a timed-out attempt's preserved work is the delivery — adopted",
    facts: { committed: true },
  };
}

/**
 * Record the ticket attribution a commit's own subject lacks — false when one is already there, so
 * nothing is recorded twice.
 */
async function recordAttribution(ctx: StepContext, why: string): Promise<boolean> {
  const subject = stepSubject(ctx);
  if (await worktreeHasCommitFor(ctx.worktreePath, subject.id)) return false;
  await commitMarker(ctx.worktreePath, `${subject.id}: ${subject.title}\n\n${why}`);
  return true;
}

/**
 * `step:pr` — open (or refresh) the run's single PR. The unresolved advisories from `step:review`
 * ride in the body, which is where the founder meets them at the merge gate.
 */
export async function prStep(ctx: StepContext): Promise<StepResultWith<"pr">> {
  ctx.assertLeaseHeld?.();
  const pr = await openPullRequest({
    repoPath: ctx.repoPath,
    branch: ctx.branch,
    base: ctx.baseBranch,
    title: buildPrTitle(ctx.target, ctx.target.id, ctx.settings.conventionalCommits),
    body: prBody(ctx.target, ctx.tickets, ctx.advisories ?? []),
  });
  return { ok: true, detail: `PR ${pr.ref}`, facts: { pr } };
}

/** The commit message for the run's work. */
function commitMessage(ctx: StepContext): string {
  const subject = stepSubject(ctx);
  return `${subject.id}: ${subject.title}`;
}

