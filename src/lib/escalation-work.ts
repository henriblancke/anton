/**
 * The WORK an escalation names — the bead a run stalled on, or the job a stall named when there is
 * no bead at all — and the verbs a founder's answer applies to it.
 *
 * Two halves, both of them consequences of the escalation being a frozen snapshot while its button
 * lives on the board until someone clicks it:
 *
 *   • what the board says about that work NOW ({@link readTargetState}, {@link restartedLocally}) —
 *     the re-read a bead-backed verb runs before anything is settled;
 *   • the verbs themselves ({@link actOnBead}, {@link actOnJob}), which are the automatic path's own
 *     — `resumeStalledEpic` for a resume, `abandonTicket` for an abandon — never re-implemented here.
 *
 * The other half of a founder's answer, a wait on a PERSON, is escalation-gate.ts. The ORDER the two
 * are applied in — settle first, act second — belongs to neither: it is escalation-actions.ts's.
 */
import { abandonTicket } from "./abandon";
import { beads, isMissingBeadError } from "./beads/bd";
import { getDb } from "./db";
import { getJob, systemClock } from "./jobs/queue";
import { cancelJob, resumeJob, resumeStalledEpic, runIsLiveForTarget } from "./jobs/service";
import { settleParkedRun } from "./runs";
import { MAX_ABANDON_REASON_CHARS } from "./types";
import type { Bead } from "./beads/bd";
import type { EscalationAction, EscalationView } from "./escalations";
import type { Project } from "./types";

/**
 * One bead as bd answers for it now — the row, `missing` when bd says there is no such bead, or
 * `unreadable` when bd could not answer at all. The last two are NOT interchangeable: only `missing`
 * is evidence, and only evidence may refuse a founder's action (see {@link isMissingBeadError}).
 */
export type BeadRead = Bead | "missing" | "unreadable";

export async function readBead(repoPath: string, id: string): Promise<BeadRead> {
  try {
    // A successful lookup that names no issue says the same thing as bd's "no issue found" exit.
    return (await beads.show(repoPath, id)) ?? "missing";
  } catch (e) {
    return isMissingBeadError(e) ? "missing" : "unreadable";
  }
}

/**
 * What the board says NOW about the work an escalation froze: `clear` to act on, `contested` by a
 * run on another machine, `unverified` when bd couldn't say either way, `gone` because the bead
 * itself was deleted, or `closed` because someone settled it by hand. The last two are one meaning —
 * nothing left to act on — kept apart only so the panel can say which way the work ended.
 */
export type TargetState = "clear" | "contested" | "unverified" | "gone" | "closed";

/**
 * Re-read the work an escalation names, because the escalation is a frozen snapshot while the button
 * lives on the board until someone clicks it. Later sweeps hold the finding without resolving the
 * open row, so nothing else retires a stale control. Two things can have changed underneath it:
 *
 *   • Someone else picked the stall back up. Jobs and runs are machine-local, so the run-lease on the
 *     epic bead is the only record of that. Applying the stale button then resumes work already in
 *     flight — or, worse, abandons it.
 *     Judged HERE against the ancestor the escalation froze, which is the one a resume re-enqueues.
 *     An abandon executes under whatever run target sits above its ticket NOW — a different bead once
 *     the board has been reparented — so its own `requireStopped` boundary re-reads the lease on that
 *     one (see `stopRun`); this check is the cheap early half, not the whole of it.
 *     `judgeLease` is how a caller says the frozen ancestor is NOT what its verb acts on — a wait on a
 *     person, whose target is re-derived after the settle — and the lease read is skipped rather than
 *     answered off a pointer the gate has outlived (see the call site).
 *   • The work SETTLED — the bead was deleted, or closed by hand. Then the verb has nothing left to
 *     act on: a resume hands execute-epic a bead it either can only park back on with
 *     `bead ... not found`, turning an intentional deletion into a poison job, or runs work that was
 *     explicitly called done, and an abandon's `abandonTicket` throws on both — after the settle.
 *     The unstick pass makes this exact call on the sweep side (`epicSettled`); this is the same
 *     rule for the manual path.
 *
 * Pull before reading, like the runner's enqueue-time `liveRunCheck` and the unstick pass: the local
 * Dolt working set trails the shared remote by a sync heartbeat. Both verbs then FAIL CLOSED on
 * anything that leaves current shared state unread — a rejected pull, a bead bd couldn't answer for
 * — exactly as `leaseStandDown` does on the sweep side. A stale mirror can only be wrong in the
 * direction that double-runs, and neither verb is cheap to be wrong about: a resume duplicates a run
 * another machine owns, an abandon closes its bead underneath it. Refusing costs one more sweep of
 * stall and leaves the row on the panel, so the founder's move is deferred, never lost — and a
 * workspace with no remote at all resolves the pull (`not-wired`) rather than rejecting, so a
 * single-machine board is unaffected. `dismiss` reads none of this and stays available regardless.
 *
 * Evidence the local mirror does hold still counts against the work EXISTING — a deletion or a
 * close can only have got there by being made here or synced from elsewhere — because settling the
 * row on those changes nothing about the work.
 */
export async function readTargetState(
  project: Project,
  view: EscalationView,
  target: string,
  judgeLease: boolean,
): Promise<TargetState> {
  const pulled = await beads.pull(project.repoPath).then(
    () => true,
    () => false,
  );
  // Existence is checked on the bead the VERB acts on — the epic a resume re-enqueues, the ticket an
  // abandon closes — which is not always the one carrying the lease.
  const acted = await readBead(project.repoPath, target);
  if (acted === "missing") return "gone";
  // A bead bd could not answer for is no evidence of anything (see {@link BeadRead}): it can neither
  // say the work was closed out from under this escalation nor rule out a run holding it.
  if (acted === "unreadable") return "unverified";
  if (acted.status === "closed") return "closed";

  if (judgeLease) {
    const held = await leaseState(project, view, target, acted);
    if (held) return held;
  }
  // Every read landed — but a write another machine made seconds ago (the lease, or the close that
  // settled this work) reaches this mirror only through the pull, so without one "nothing has changed"
  // is an unread answer, not a clear board.
  return pulled ? "clear" : "unverified";
}

/**
 * Whether a run on ANOTHER machine holds the work — the half of {@link readTargetState} that reads a
 * lease, and `undefined` when none does.
 *
 * Runs are keyed by RUN TARGET, so that is the bead execute-epic publishes the lease on, and it is
 * what `epicBeadId` holds for every kind: the run's epic for a parked run, the finding's own bead
 * for a stale PR or a dead lease (both name a run target — `inReviewTargets` classifies with
 * `isRunTarget`, and only run targets ever carry a lease). `target` is the fallback for a finding
 * that recorded no epic at all, and the common case where the two coincide costs no second read.
 *
 * The lease is published under the RUN id, so the stalled run's own leftover is ours, not a foreign
 * holder; a finding with no run of its own (a dead lease) treats any live lease as foreign.
 */
async function leaseState(
  project: Project,
  view: EscalationView,
  target: string,
  acted: Bead,
): Promise<"contested" | "unverified" | undefined> {
  const epicBeadId = view.epicBeadId ?? target;
  const holder = epicBeadId === target ? acted : await readBead(project.repoPath, epicBeadId);
  if (holder === "unreadable") return "unverified";
  // A gone EPIC carries no lease — and that is evidence, not a failed read — so an abandon of its
  // (existing) ticket is still worth doing.
  if (holder === "missing") return undefined;
  const nowMs = systemClock.now();
  const live = view.runId
    ? beads.foreignRunLeaseLive(holder, nowMs, view.runId)
    : beads.isRunLive(holder, nowMs);
  return live ? "contested" : undefined;
}

/**
 * Has the work restarted on THIS machine since the stall was raised? Runs and jobs are machine-local,
 * so a local resume reuses the stalled run's id and republishes the lease under it — which
 * {@link leaseState} reads as ours by design, leaving the stale control unguarded.
 *
 * Only an abandon consults this, because only an abandon is destructive: `abandonTicket` cancels the
 * run target's ACTIVE job before closing the bead, so it would kill the execution the resume just
 * started and undo it. Nothing downstream catches that — {@link settleAbandonedWork}'s status-guarded
 * settles run after the cancel already terminalized the job. A resume needs no such guard: `resumeEpic`
 * absorbs an epic that is already active as a no-op.
 *
 * An active execute-epic job is exactly what the abandon's cancel would reach, so this refuses in
 * precisely the cases where it has something live to destroy — a job that has parked again since is
 * stopped work, and stays abandonable.
 *
 * Every call here is a SNAPSHOT: the settle, and the bd reads inside the abandon, all await after it.
 * It refuses early and cheaply; the answer that actually gates the destruction is the one
 * `abandonTicket`'s `requireStopped` makes at the cancel boundary itself — this read plus the shared
 * lease, on the run target the abandon re-derives rather than the ancestor frozen here. Which is why
 * a wait on a person skips this read entirely (see the call site): there the two beads routinely
 * differ, so the boundary check is not an extra half but the only one that can answer.
 */
export function restartedLocally(projectId: string, epicBeadId: string): boolean {
  return runIsLiveForTarget(projectId, epicBeadId);
}

/** Resume/abandon against the work itself — the epic a run stalled on, or the bead to close. */
export async function actOnBead(
  project: Project,
  action: EscalationAction,
  view: EscalationView,
  target: string,
): Promise<string> {
  if (action === "resume") return resumeStalledEpic(project.id, target);
  const reason = abandonReason(view);
  // `requireStopped`: the checks above are snapshots, and the settle that follows them awaits. The
  // abandon re-reads liveness where it would actually kill the run and refuses there instead (see
  // {@link restartedLocally}), so a resume landing in that window is answered with a
  // `RunRestartedError` and an untouched board rather than a cancelled job and a closed bead.
  //
  // That boundary is also the only check that sees the run target this abandon ACTUALLY kills: the
  // lease check in {@link readTargetState} judged the escalation's frozen ancestor, and a bead
  // reparented since (the gardener's apply, `beads.reparent`) executes under a different one — which
  // the abandon re-derives and this machine's job table cannot speak for. So it re-reads the shared
  // lease there too, with `ownRunId` exempting the stalled run's own leftover exactly as
  // {@link leaseState} does.
  await abandonTicket(project, target, reason, { requireStopped: true, ownRunId: view.runId });
  await settleAbandonedWork(project.id, view, reason);
  return "abandoned";
}

/** The abandon reason recorded on the bead — the escalation's own evidence, capped to bd's limit. */
function abandonReason(escalation: EscalationView): string {
  const reason = `Abandoned from a run-health escalation (${escalation.kind}): ${escalation.reason}`;
  return reason.slice(0, MAX_ABANDON_REASON_CHARS);
}

/**
 * The machine-local rows an abandon must settle beyond the bead. `abandonTicket` kills only an ACTIVE
 * (queued/running) job, but an escalation is raised precisely against work that already STOPPED — a
 * parked run, a parked/failed job. Left as they are, the bead closes while the local rows stay in the
 * exact state `detectParkedRuns` / `detectExhaustedJobs` report, so the next sweep escalates work
 * whose target is already abandoned. Both settles are status-guarded CASes, so work an operator
 * restarted between the raise and the click keeps running.
 *
 * Runs after the bead closes, so a failure here propagates like any other action failure (see
 * escalation-actions.ts) while the abandon it follows still stands.
 */
async function settleAbandonedWork(
  projectId: string,
  view: EscalationView,
  reason: string,
): Promise<void> {
  if (view.jobId) await cancelJob(projectId, view.jobId, STOPPABLE_FROM);
  if (view.runId) await settleParkedRun(getDb(), systemClock, projectId, view.runId, reason);
}

/**
 * The statuses an exhausted-job escalation is raised against, and the only ones its "stop retrying"
 * may terminalize. The unstick pass re-validates before RAISING, but the button lives on the board
 * until someone clicks it: an operator who resumed the job in between put it back to work, and
 * cancelling then would abort a live child on the strength of a stale control.
 */
const STOPPABLE_FROM = ["parked", "failed"] as const;

/**
 * The same decision for a stall that names only a job: resume gives it a fresh retry budget, abandon
 * cancels it so it never runs again. Both move the job out of `parked`/`failed` — the only states
 * `detectExhaustedJobs` reports — so settling here also stops the next sweep re-raising this exact
 * finding. A job that has since moved on reports that rather than claiming an action it didn't take.
 */
export async function actOnJob(
  projectId: string,
  action: EscalationAction,
  jobId: string,
): Promise<string> {
  if (action === "resume") {
    return (await resumeJob(projectId, jobId)) ? "resumed-job" : "job-not-resumable";
  }
  const result = await cancelJob(projectId, jobId, STOPPABLE_FROM);
  if (result.ok) return "cancelled-job";
  // The guard refused it. Say WHICH way, so the operator learns their stale button hit a job that is
  // running again rather than one that had merely stopped on its own.
  const job = await getJob(getDb(), jobId);
  return job?.status === "queued" || job?.status === "running"
    ? "job-restarted"
    : "job-already-settled";
}
