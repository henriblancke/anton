/**
 * Whether a timed-out ticket's work can be KEPT, and what it costs to prove it (anton-d967 —
 * extracted from execute-epic-ticket.ts).
 *
 * The settlement decides what a stopped ticket owes the board; this decides what happens to its
 * DIFF — the one judgement in the timeout path that can lose finished work, so it lives on its own
 * and reports its reason rather than a bare verdict.
 */
import type { Bead } from "../beads/bd";
import {
  commitAll,
  commitMarker,
  isAncestor,
  preservedCommitPrefix,
  readWorktreeState,
  stageAllAndHashTree,
  sameWorktreeState,
  worktreeHasPreservedCommitFor,
  type WorktreeState,
} from "../git/ops";
import { resolveVerifyGates } from "../projects";
import { appendSessionLog } from "../sessions";
import { safe } from "./execute-epic-persist";
import { startTicketBudget } from "./execute-epic-ticket-bookends";
import { runVerifyGates } from "./shell";
import type { StepContext } from "./step-registry";

/**
 * The share of a ticket's own budget the preserve is allowed to spend re-running the verify gates,
 * and the floor/ceiling it is clamped to. The ticket is already over time, so this cannot be
 * unbounded — but a gate that never gets to finish can never keep anything either.
 */
const PRESERVE_VERIFY_SHARE = 0.25;
const PRESERVE_VERIFY_MIN_MS = 60_000;
const PRESERVE_VERIFY_MAX_MS = 15 * 60_000;

/**
 * What became of a timed-out ticket's uncommitted work: kept on a branch, rolled back and why, or
 * nothing at all because the JOB was aborted while the preserve was deciding.
 *
 * `retained` separates the two ways work ends up kept. A fresh preserve COMMITTED this attempt's
 * tree; a retained one only reports what a previous attempt already preserved and this one did not
 * touch — the caller still rolls that tree back (the reset restores a baseline the commit is part
 * of), but the operator is owed the truth that the work is still on the branch.
 *
 * `retainedOn` carries that same truth through a REFUSAL (PR #228 review): a resume can start from a
 * previous attempt's preserved commit, write more, and have the additions rejected — the rollback
 * then drops only the additions, and reporting a bare rollback would tell the operator work that is
 * still on the branch was thrown away.
 *
 * `unmarkedOn` is the state that is neither kept nor lost (PR #228 review): the agent's own commits
 * are on the branch and must not be reset away, but anton could not record the marker every reader
 * of preserved work goes through, so no resume can find them. Reported apart from `branch` because
 * the difference is the whole meaning of the answer — "preserved" promises a resume that continues
 * from the work, and this one cannot make that promise. The caller halts on it for a person.
 */
export type PreservedWork =
  | { branch: string; retained: boolean }
  | { unmarkedOn: string }
  | { rolledBackWhy: string; retainedOn: string | null }
  | { jobAborted: true };

/**
 * Keep a timed-out ticket's work when it can be PROVEN fit to keep (anton-d967) — the branch it was
 * committed to, or the reason the run had to fall back to the rollback.
 *
 * The loss this exists to stop: a ticket that implemented, tested and verified its change and was
 * cut off during its closing bookkeeping had all of it deleted, from a tree no commit, reflog or
 * dangling object could recover it from. What proves the work fit is the project's OWN verify gates
 * — the same commands `step:verify` runs before any ordinary commit — so nothing is kept here that
 * anton would not have committed anyway.
 *
 * ONLY A CHILDLESS RUN TARGET may keep it, and that limit is the whole safety argument. Those gates
 * prove the tree is not BROKEN; they cannot prove the ticket is DONE, and half-work usually passes
 * them (a module nothing imports yet compiles and lints fine — and on a multi-ticket run they mostly
 * re-measure the siblings that already committed). On a run with other tickets, that unfinished diff
 * would ride into the pull request they open and be merged into the trunk under a delivery it is no
 * part of — the exact harm the rollback was written for. When the ticket IS the run target, the
 * timeout leaves the run with nothing delivered, so it parks: no pull request exists to carry the
 * work anywhere, it simply waits on the branch for the resume that continues it. That is the case
 * that lost two hours of finished work on 2026-08-17, and it is the one this keeps.
 *
 * Every refusal below falls back to the rollback rather than improvising, because the caller's
 * safety property is absolute and each of these is a case where "this diff is this ticket's, it is
 * sound, and nothing else will carry it" cannot be shown:
 *
 * - the ticket already committed — there is nothing loose to keep;
 * - the run has other tickets — see above;
 * - the JOB was aborted while the gates ran, or while the commit itself was being made — that abort
 *   outranks the timeout, so this reports it rather than a verdict, and the caller hands the work
 *   and the bead to whoever stopped the run;
 * - no baseline was readable — the delta in the tree cannot be attributed to this ticket at all;
 * - the tree is unchanged — there is nothing to keep, and the rollback is a no-op;
 * - HEAD left the run's branch, or the branch no longer contains where the ticket started — the
 *   same two states `step:commit` refuses to adopt (a stray checkout, a reset/amend/rebase), and
 *   the rollback is what puts the run back on its branch;
 * - the project pins NO verify gates — nothing can prove the tree sound, so the pre-anton-d967
 *   behaviour stands;
 * - the gates fail, error, or outrun their own budget — the tree is not fit to keep;
 * - git refuses the commit outright, or `git add -A` finds nothing to commit AND HEAD never moved —
 *   either way nothing was preserved, and the reason says which. An empty index with a HEAD that
 *   DID move is not that case: the agent committed its own work, and {@link adoptSelfCommittedWork}
 *   keeps it — or, when it cannot make that work findable, stops for a person rather than roll a
 *   commit back or call it preserved.
 */
export async function preserveTimedOutWork(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  logPath: string;
  baseline: WorktreeState | null;
  committed: boolean;
  timeoutMs: number;
  standalone: boolean;
}): Promise<PreservedWork> {
  const { run, ticket, logPath, baseline, committed, timeoutMs, standalone } = args;
  const { worktreePath, branch, settings } = run;
  // What a PREVIOUS attempt already preserved, read once below and carried by every refusal after
  // it: the rollback a refusal asks for restores the baseline, which on a resume that started from
  // that commit still contains it.
  let retainedOn: string | null = null;
  // …and the third answer that read can give (PR #228 review): the history could not be READ at all.
  // Absence is what every refusal below reports as "nothing of this ticket is on the branch", so a
  // `git log` that failed may not decay into it — the operator would be told a resume starts over on
  // a branch that may still carry a previous attempt's commit. It cannot be asserted either, since a
  // claimed retention is what suppresses the marker a resume reads, so the doubt is what travels.
  let retainedUnreadable = false;
  const unreadableCaveat = (): string =>
    retainedUnreadable
      ? `; anton could not read \`${branch}\`'s history, so work a previous attempt preserved may ` +
        `still be on it`
      : ``;
  const rollBack = async (why: string): Promise<PreservedWork> => {
    const rolledBackWhy = why + unreadableCaveat();
    await logPreserve(
      logPath,
      `rolling back — ${rolledBackWhy}` +
        (retainedOn ? ` (a previous attempt's work stays on ${retainedOn})` : ``),
    );
    return { rolledBackWhy, retainedOn };
  };
  const now = await readWorktreeState(worktreePath).catch(() => null);
  // "Nothing kept" is a verdict on THIS attempt, never on the branch (PR #228 review). A resume that
  // starts from a previous attempt's preserved commit leaves it wherever the ticket ends — untouched
  // if nothing was written, and still there if what was written gets refused below, since the
  // rollback restores a baseline the commit is part of. Read once, here, so every answer past this
  // point tells the operator the truth about the branch; without it the bead note and the park say
  // the work is gone and the next resume starts over, when in fact it continues from that commit.
  // Only while HEAD is on the run's branch: off it, anton cannot say what the rollback puts back.
  //
  // Asked BEFORE the already-committed exit below, because that exit is one of the answers it has to
  // be true of (PR #228 review): a resume that adopted a previous attempt's preserved commit and had
  // the delivery gate REFUSE it leaves that work exactly where it was, and an exit reporting no
  // preserved branch tells the park the next resume starts over — when it continues from the commit.
  //
  // Read STRICTLY (PR #228 review): the non-strict read fails closed to "absent", which is this
  // caller's UNSAFE answer — a transient `git log` failure would be reported as proof that no
  // retained work exists, and the note and park built on it would send the next resume off to redo
  // work the rollback leaves untouched on the branch.
  if (now && now.ref === `refs/heads/${branch}`) {
    const preserved = await worktreeHasPreservedCommitFor(worktreePath, ticket.id, { strict: true })
      .then((yes) => (yes ? "yes" : "no"))
      .catch(() => "unreadable");
    if (preserved === "yes") retainedOn = branch;
    retainedUnreadable = preserved === "unreadable";
  }
  if (committed) return { rolledBackWhy: "its work was already committed", retainedOn };
  if (!baseline) {
    return rollBack(`anton could not read the worktree this ticket started from`);
  }
  if (!now) return rollBack(`anton could not read the worktree back`);
  // Asked before the sibling check below, so a ticket that left nothing is never told the reason it
  // could not keep work it never wrote.
  if (sameWorktreeState(now, baseline)) {
    if (retainedOn) {
      await logPreserve(
        logPath,
        `left the tree untouched — a previous attempt's work is still on ${retainedOn}`,
      );
      return { branch: retainedOn, retained: true };
    }
    return { rolledBackWhy: `it left nothing in the worktree` + unreadableCaveat(), retainedOn };
  }
  if (!standalone) {
    return rollBack(
      `this run has other tickets, and the pull request they open would carry this ticket's ` +
        `unfinished work into the trunk under a delivery it is no part of`,
    );
  }
  if (now.ref !== `refs/heads/${branch}` || !(await stillContains(worktreePath, baseline, now))) {
    return rollBack(
      `it left the run's branch (${branch}) rewritten or checked out elsewhere, so anton could ` +
        `not tell its changes apart from the rest of the tree`,
    );
  }

  const gates = resolveVerifyGates(settings);
  if (gates.length === 0) {
    return rollBack(`this project pins no verify gates, so nothing can show the work is sound`);
  }

  // The gates get a clock of their own, derived from the JOB's signal rather than the ticket's:
  // the ticket's is already aborted, so a gate started on it would be killed before it spawned.
  const gateBudget = startTicketBudget(run.ctx, preserveVerifyMs(timeoutMs));
  await logPreserve(
    logPath,
    `re-running ${gates.length} verify gate(s) to decide whether the work can be kept`,
  );
  let gateFailure: { error: unknown } | null = null;
  try {
    await runVerifyGates(
      gates,
      worktreePath,
      gateBudget.signal,
      logPath,
      (gate, code) => `${gate.label} gate failed for ${ticket.id} (exit ${code})`,
    );
  } catch (error) {
    gateFailure = { error };
  } finally {
    gateBudget.stop();
  }
  // A job-level abort inside this window is NOT a failed gate (PR #228 review). The gates run on the
  // job's own signal — the only clock left once the ticket's is spent — so an operator's kill, a lost
  // lease or the runner's no-progress timeout arriving during a window of up to 15 minutes rejects
  // them exactly as a broken tree does. Read that way it would hard-reset the worktree to the
  // baseline and write the board, which is what the abort must NOT do: a job-level abort outranks the
  // ticket timeout, and the work and the board belong to whoever stopped the run. Asked before the
  // failure, so an abort is never read as a verdict on the tree.
  if (run.ctx.signal.aborted) {
    await logPreserve(
      logPath,
      `the job was aborted while the verify gates ran — leaving this ticket's work and its bead to ` +
        `whoever stopped the run`,
    );
    return { jobAborted: true };
  }
  if (gateFailure) {
    return rollBack(
      `it does not pass this project's verify gates ` +
        `(${gateFailure.error instanceof Error ? gateFailure.error.message : String(gateFailure.error)})`,
    );
  }

  // An empty index and a REFUSED commit are two different facts an operator repairs differently
  // (PR #228 review), so the error is carried rather than flattened into "nothing to commit": a
  // locked index, a rejecting pre-commit hook or a full disk is what they need to see, and the
  // rollback below is safe either way.
  const kept = await commitPreservedTree({
    worktreePath,
    logPath,
    message: preservedCommitMessage(ticket, timeoutMs),
    before: now,
  });
  // The abort outranks the timeout on THIS side of the commit too (PR #228 review). `commitAll` runs
  // on no signal — a pre-commit hook can hold it for minutes — so an operator's kill, a lost lease or
  // the no-progress timeout can land here just as it can in the gate window above, and neither
  // outcome of the commit is a verdict once it has: a commit that landed simply stays on the branch,
  // and one that did not must not be read as "unfit" and rolled back. Reported as the abort so the
  // caller leaves the tree and the bead to whoever stopped the run.
  if (run.ctx.signal.aborted) {
    await logPreserve(
      logPath,
      kept.committed
        ? `committed this ticket's work on ${branch}, then found the job aborted — leaving it and ` +
            `the bead to whoever stopped the run`
        : `the job was aborted while committing this ticket's work — leaving the tree and the bead ` +
            `to whoever stopped the run`,
    );
    return { jobAborted: true };
  }
  if (!kept.committed) {
    // Neither an empty index NOR a rejected commit is proof that nothing was committed (PR #228
    // review), so HEAD decides before any refusal does — a rollback here hard-resets the branch, and
    // whatever is past the baseline goes with it.
    //
    // The empty index is the agent having committed its own work, which is exactly what
    // `step:commit` adopts rather than refuses. The rejection is `post-commit`: githooks(5) runs it
    // AFTER the commit is made, explicitly unable to affect the outcome, so a hook that outlives the
    // commit budget rejects a call whose commit is already on the branch — and rolling that back
    // deletes the very work this path had just finished saving.
    const after = "error" in kept ? await readWorktreeState(worktreePath).catch(() => null) : now;
    if (after && (await movedForwardOnBranch(worktreePath, baseline, after, branch))) {
      return adoptSelfCommittedWork({
        worktreePath,
        branch,
        ticket,
        timeoutMs,
        logPath,
        why:
          "error" in kept
            ? `git rejected this ticket's preserved commit after it had already landed`
            : `the agent committed this ticket's work itself`,
        // A landed-but-rejected commit is anton's OWN, so it already carries the `WIP <id>:` subject
        // a resume reads and needs no marker. An unmarked forward HEAD is the agent's work and does.
        alreadyMarked:
          retainedOn !== null ||
          ("error" in kept && (await worktreeHasPreservedCommitFor(worktreePath, ticket.id))),
      });
    }
    if ("error" in kept) {
      return rollBack(
        `anton could not commit the work (${kept.error instanceof Error ? kept.error.message : String(kept.error)})`,
      );
    }
    return rollBack(`there was nothing for git to commit`);
  }
  await logPreserve(logPath, `work PRESERVED on ${branch} as an explicitly incomplete commit`);
  return { branch, retained: false };
}

/**
 * The agent committed this ticket's work ITSELF and the deadline landed before `step:commit` could
 * record it (PR #228 review). Against the operating contract, but it happens — and `step:commit`
 * treats it as delivery for the same reason this must treat it as preserved: the commits are real,
 * they are on the run's branch, and here they have just passed the project's verify gates.
 *
 * The other way in is anton's OWN preserved commit landing under a `git commit` that then failed —
 * a `post-commit` hook outliving the commit budget (PR #228 review). Same fact, same handling: the
 * branch moved forward and what is past the baseline may not be reset away. That commit already
 * carries its `WIP` subject, so it arrives `alreadyMarked` and only the log line differs.
 *
 * The marker is what keeps that work FINDABLE, and it is the ONLY thing that does: both readers of
 * preserved work — `step:commit`, which turns a resume's zero diff into the delivery it already
 * earned, and `assertPreservedWorkFitsShape`, which refuses to dispatch children onto a branch that
 * carries one — go through the `WIP <id>:` subject, and the agent's own subjects carry no prefix at
 * all. So an unmarked adoption is not a preserve with a missing receipt; it is work no resume can
 * see, and reporting it preserved is the false success this path exists to refuse (PR #228 review):
 * unseen, every resume reports a zero diff and parks again, and a resume taken after the target is
 * split walks explicitly incomplete commits past the shape guard and into a child's pull request.
 *
 * A `commit-msg` hook enforcing its own subject convention is what would otherwise reject that
 * marker, so {@link commitMarker} makes it with this project's hooks bypassed — legitimate for that
 * commit and no other, since it is EMPTY and no hook is being asked about content. A rejected marker
 * call is then checked against the HISTORY rather than believed, and only work the branch genuinely
 * does not carry a marker for is truly unmarked — never rolled back, since the commits outrank their
 * bookkeeping, but handed to a person instead of reported as preserved.
 */
async function adoptSelfCommittedWork(args: {
  worktreePath: string;
  branch: string;
  ticket: Bead;
  timeoutMs: number;
  logPath: string;
  /** How the commits on this branch came to be there, for the operator reading the log. */
  why: string;
  /** A previous attempt's marker is already on the branch; one is all a resume needs. */
  alreadyMarked: boolean;
}): Promise<PreservedWork> {
  const { worktreePath, branch, ticket, timeoutMs, logPath, why, alreadyMarked } = args;
  const message = preservedCommitMessage(ticket, timeoutMs, { marker: true });
  // A REJECTED marker call is not proof the marker is absent (PR #228 review). `--no-verify` bypasses
  // only `pre-commit` and `commit-msg` (git-commit(1)); `post-commit` runs AFTER the commit is made,
  // so a hook outliving the commit budget fails a call whose marker is already on the branch — and
  // the halt below would then tell the operator to create a marker that exists. History decides, not
  // the call's exit status. A read that fails stays "unmarked": that answer stops for a person, where
  // a wrong "marked" reports work no resume can see as preserved.
  const marked =
    alreadyMarked ||
    (await safe(() => commitMarker(worktreePath, message))) ||
    (await worktreeHasPreservedCommitFor(worktreePath, ticket.id));
  if (!marked) {
    await logPreserve(
      logPath,
      `${why} — KEPT on ${branch}, but anton could not record the marker a resume reads: stopping ` +
        `for a person rather than reporting work no resume can see as preserved`,
    );
    return { unmarkedOn: branch };
  }
  await logPreserve(logPath, `${why} — KEPT on ${branch} rather than rolled back`);
  return { branch, retained: false };
}

/**
 * Whether the branch ADDED commits since the ticket started — the state `step:commit` adopts as
 * delivery, and the one thing that tells a commit anton made from one it never got to make.
 */
async function movedForwardOnBranch(
  worktreePath: string,
  baseline: WorktreeState,
  now: WorktreeState,
  branch: string,
): Promise<boolean> {
  if (now.head === baseline.head || now.ref !== `refs/heads/${branch}`) return false;
  return stillContains(worktreePath, baseline, now);
}

/** Whether the branch still CONTAINS where the ticket started — no reset, amend or rebase. */
function stillContains(
  worktreePath: string,
  baseline: WorktreeState,
  now: WorktreeState,
): Promise<boolean> {
  return isAncestor(worktreePath, baseline.head, now.head).catch(() => false);
}

/** How long the preserve may spend on the gates — a quarter of the ticket's own budget, clamped. */
function preserveVerifyMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return PRESERVE_VERIFY_MAX_MS;
  const share = timeoutMs * PRESERVE_VERIFY_SHARE;
  return Math.min(PRESERVE_VERIFY_MAX_MS, Math.max(PRESERVE_VERIFY_MIN_MS, share));
}

/** The preserve's own account, on the ticket's session log where the timeout line already is. */
async function logPreserve(logPath: string, line: string): Promise<void> {
  await appendSessionLog(logPath, `[ticket-timeout] ${line}\n`).catch(() => {});
}

/**
 * The subject of a preserved commit — deliberately NOT `<ticketId>:`, which is the delivery
 * attribution `worktreeHasCommitFor` reads. This commit is the opposite of a delivery: the
 * ticket is blocked, marked `not-delivered` and in no PR body, and a run that read this commit as
 * its work would close a ticket nobody finished.
 *
 * The resume still has to SEE it, or the work it kept can never reach a pull request — that read is
 * {@link worktreeHasPreservedCommitFor}, which `step:commit` asks before reporting a zero diff.
 */
function preservedCommitMessage(
  ticket: Bead,
  timeoutMs: number,
  options: { marker?: boolean } = {},
): string {
  return (
    `${preservedCommitPrefix(ticket.id)} ${ticket.title}\n\n` +
    `INCOMPLETE — the ticket exceeded its ${Math.round(timeoutMs / 60_000)}m budget and was ` +
    `stopped before it finished. anton kept this work rather than deleting it because the ` +
    `project's verify gates passed on the tree; the ticket itself is blocked for review and is in ` +
    `no pull request's delivered list. Resuming the run continues from this commit.` +
    (options.marker
      ? `\n\nThis commit is EMPTY: the agent committed the work itself, under subjects that name ` +
        `neither this ticket nor its incompleteness. Those commits are the work; this one records ` +
        `whose it is.`
      : ``)
  );
}

/**
 * Commit the preserved tree — retrying with this project's hooks BYPASSED when they rejected it
 * without landing anything and without touching it (PR #228 review).
 *
 * A `commit-msg` hook enforcing conventional subjects refuses anton's `WIP <id>:` one, and without
 * this retry that refusal costs a gate-passing tree its only path back to a pull request: the caller
 * rolls the work back and reports "anton could not commit the work" on a ticket where every gate
 * passed — the exact loss anton-d967 exists to stop, reintroduced by a message check.
 *
 * Narrow on purpose, and on two counts.
 *
 * HEAD must be exactly where it was before the attempt: a commit that LANDED and was then rejected
 * — a `post-commit` hook, which githooks(5) runs after the commit is made — is already on the
 * branch, and committing again would duplicate it. The caller adopts that one instead.
 *
 * And the tree must still be the one the gates passed on (PR #228 review). Bypassing the hooks is
 * defensible only because this commit is reached after the project's OWN verify gates proved THAT
 * tree sound — but a `pre-commit` hook can rewrite files before it rejects, which lint-staged does
 * routinely when it fixes one file and fails another. HEAD does not move, so without this check the
 * retry would stage the hook's post-gate edits with `git add -A` and commit them under `--no-verify`
 * — a tree that passed neither the gates nor the hook, kept for a resume to adopt. Unprovable is
 * treated as changed: the fallback is the rollback the refusal always meant.
 *
 * That proof is owed by the BYPASS and by nothing else (PR #228 review). A hook that edits, stages
 * and then ACCEPTS — a formatter, a generator — also lands a tree the gates never saw, but it landed
 * it the same way every ordinary `step:commit` does: `commitAll` with this project's hooks on,
 * straight after `step:verify`, with no re-verification of what the hook staged. The hook is the
 * project's own gate on content and it said yes, so the run has exactly the proof its normal commits
 * carry, and the resume that adopts this commit re-runs the gates over that content before any pull
 * request opens. Re-running them HERE could only be honoured by resetting a commit that has already
 * landed — the one act this whole path exists to refuse.
 */
async function commitPreservedTree(args: {
  worktreePath: string;
  logPath: string;
  message: string;
  before: WorktreeState;
}): Promise<{ committed: boolean } | { committed: false; error: unknown }> {
  const { worktreePath, logPath, message, before } = args;
  const rejected = (error: unknown) => ({ committed: false as const, error });
  // Hashed BEFORE the attempt, because after it a hook's edits are indistinguishable from the
  // agent's own work.
  const verified = await stageAllAndHashTree(worktreePath).catch(() => null);
  const first = await commitAll(worktreePath, message).catch(rejected);
  // Accepted by this project's hooks — the same proof an ordinary commit ships on, so `verified` is
  // not re-compared here; it exists for the bypass below, where no hook is left to say yes.
  if (!("error" in first)) return first;
  const after = await readWorktreeState(worktreePath).catch(() => null);
  if (!after || after.head !== before.head) return first;
  const retried = await stageAllAndHashTree(worktreePath).catch(() => null);
  if (!verified || retried !== verified) {
    await logPreserve(
      logPath,
      `a hook rejected this ticket's preserved commit and the tree is no longer provably the one ` +
        `the verify gates passed on, so anton did not retry with the hooks bypassed`,
    );
    return first;
  }
  return commitAll(worktreePath, message, { bypassHooks: true }).catch(rejected);
}
