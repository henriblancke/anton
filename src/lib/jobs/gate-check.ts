/**
 * gate-check job (anton-286r). The scheduled pass that closes satisfied gates and puts the work they
 * were blocking back in flight — the half of the gate model that makes parking on a gate cheaper
 * than polling: the whole project's waits cost a couple of bd calls per cron slot, whatever their
 * number, and nothing at all in between.
 *
 * Four moves, in order, each idempotent on its own and each a named phase below:
 *
 *   1. EVALUATE ({@link evaluateGates}) — `bd gate check`, scoped to the gate types actually open.
 *      `human` is NEVER among those scopes: a human gate is a founder control point and only an
 *      explicit action resolves it. bd happens not to enumerate human gates at all, but the scope
 *      says so out loud rather than resting on that.
 *   2. SURFACE ({@link surfaceStalls}) — an open gate whose own timeout has blown is no longer a
 *      wait, it's a stall. It gets one bd note on the bead it blocks and a `gate-expired` label on
 *      the gate, and is never raised again: surfaced once for a human, not retried forever. bd's own
 *      `--escalate` cannot do this job — measured on bd 1.1.2 it shells out to a `gt` binary that
 *      isn't installed, fails, still counts the gate as `escalated`, and leaves no mark on it, so it
 *      would re-fire every pass.
 *   3. DECIDE (`planResumes`, in ./gate-targets) — off ONE board read, which work a closed gate has
 *      released and which merged targets are ready to be finalized. Discovery is the BOARD, never a
 *      waiter list anton keeps: a gate closing by this pass, by a human's `bd gate resolve`, or on
 *      another machine all surface on the next slot alike. (A CLI-resolved human gate notifies no
 *      anton instance, which is exactly why the decision runs every pass rather than only when this
 *      pass closed something.)
 *   4. APPLY ({@link dispatchUngated} / {@link dispatchReleased} / {@link dispatchMerged}) — the
 *      plan's three paths, in order: re-dispatch released work, mark the ad-hoc gates it came from,
 *      and hand every merged run target to review-fix, which closes it out exactly as it always has
 *      (anton-k0kj). That last move is what turns "waiting for merge" from a sweep that re-reads
 *      every open PR into one bd call per slot.
 *
 * IDEMPOTENCE is the property to preserve. `bd ready --gated` keeps reporting an entry for as long
 * as its step is ready — it is a view of the board, not a queue of events — so this pass must never
 * read "listed" as "start it". Every dispatch goes through `resumeEpic`, the same decision the
 * unstick pass uses, whose first act is to refuse an epic an active job already covers. Two passes
 * that overlap therefore enqueue exactly one run.
 *
 * See DESIGN §4/§6 and .product/decisions/2026-07-28-bd-workflow-primitives.md §5 (the cwd hazard
 * every gate call here inherits — the seam in beads/bd.ts holds it).
 */
import { beads, type Bead, type Gate, type GateCheckScope } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { resolveOperator } from "../operator";
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import {
  beadBlockedByGate,
  isResumableTarget,
  mergedGateTargets,
  plainGateResumes,
  planResumes,
  resumeTargets,
  runTargetAbove,
  GATE_RESUMED_LABEL,
  type PlainGateResume,
  type ResumePlan,
} from "./gate-targets";
import { enqueueReviewFixIfAbsent, systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext, JobHandler } from "./runner";
import { resumeEpic } from "./unstick";

/**
 * The board-side decisions live in ./gate-targets (anton-m2e8) — re-exported so the pass keeps ONE
 * public face: what gate-check decides is read off this module, not off the seam it is split along.
 */
export {
  beadBlockedByGate,
  isResumableTarget,
  mergedGateTargets,
  plainGateResumes,
  planResumes,
  resumeTargets,
  runTargetAbove,
  GATE_RESUMED_LABEL,
  type PlainGateResume,
  type ResumePlan,
};

export interface GateCheckPayload {
  projectId: string;
  scheduleId?: string;
}

export interface GateCheckDeps {
  db: AntonDb;
  clock?: Clock;
}

/**
 * Marks a blown gate anton has already told a human about. Its presence is what turns "surface the
 * stall" into a one-shot: without it every pass would re-note the same dead gate forever, which is
 * the failure mode bd's own escalation has.
 */
export const GATE_EXPIRED_LABEL = "gate-expired";

/**
 * The `bd gate check` scopes that cover `gates`, and only those: a project with no timer gate never
 * spawns the timer check. `human` is deliberately unreachable here (see the header), and so is
 * `bead` — cross-rig bead gates are unresolvable at this bd (decision doc §2).
 */
export function checkScopes(gates: Gate[]): GateCheckScope[] {
  const scopes: GateCheckScope[] = [];
  if (gates.some((g) => g.await_type === "timer")) scopes.push("timer");
  if (gates.some((g) => g.await_type === "gh:run" || g.await_type === "gh:pr")) scopes.push("gh");
  return scopes;
}

/**
 * When a gate stops being a wait, in ms epoch — `created_at + timeout` — or undefined when it
 * carries no timeout (bd's default: a gate waits forever). bd stores the timeout in NANOSECONDS
 * (Go duration: `--timeout=2h` reads back as 7.2e12), and Go duration syntax has no `d` unit — a
 * day is `24h`.
 */
export function gateDeadline(gate: Gate): number | undefined {
  const timeoutNs = typeof gate.timeout === "number" ? gate.timeout : undefined;
  if (!timeoutNs || timeoutNs <= 0) return undefined;
  const created = gate.created_at ? Date.parse(gate.created_at) : NaN;
  if (Number.isNaN(created)) return undefined;
  return created + timeoutNs / 1e6;
}

/**
 * Open gates that have blown their timeout and haven't been surfaced yet — the waits a human now has
 * to settle. Two types are excluded, for opposite reasons:
 *
 *   • `human` — never anton's to judge, blown timeout or not. It is already with a human.
 *   • `timer` — its timeout is when it RESOLVES, not when it gives up. An elapsed timer gate is a
 *     success bd closes on the next check, so treating it as a stall would flag every timer.
 *
 * Everything else qualifies: a `gh:*` gate past its deadline (the CI run that never went green, the
 * PR nobody merged) and a `bead` gate, which this bd cannot resolve at all (decision doc §2) — so a
 * deadline is the only thing that will ever end that wait.
 */
export function expiredGates(gates: Gate[], nowMs: number): Gate[] {
  return gates.filter((gate) => {
    if (gate.status === "closed") return false;
    if (gate.await_type === "human" || gate.await_type === "timer") return false;
    if (gate.labels?.includes(GATE_EXPIRED_LABEL)) return false;
    const deadline = gateDeadline(gate);
    return deadline !== undefined && nowMs > deadline;
  });
}

/** Coarse, human duration for a note — minutes of precision read as noise on an overdue wait. */
function overdueFor(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The board-native record that a wait has died: one machine note on the bead the gate blocks, so the
 * stall is readable with plain `bd` and not only inside anton. Single-line by construction — beads
 * stores notes as one newline-joined blob where each unindented line is a separate entry, so an
 * embedded newline would split into two notes.
 */
export function expiredGateNote(gate: Gate, nowMs: number): string {
  const overdue = overdueFor(nowMs - (gateDeadline(gate) ?? nowMs));
  const awaited = [gate.await_type, gate.await_id].filter(Boolean).join(" ");
  return (
    `anton: gate ${gate.id} (${awaited}) blew its timeout ${overdue} ago and is still open — ` +
    `this wait now needs a human: settle it with \`bd gate resolve ${gate.id}\`, or abandon the ` +
    `work it blocks. anton has surfaced it once and will not raise it again.`
  );
}

/** What every phase of one pass needs: the queue it dispatches into and the repo it reads. */
export interface PassContext {
  db: AntonDb;
  clock: Clock;
  projectId: string;
  repo: string;
}

/** What phase 1 learned about the project's gates — the input every later phase is scoped by. */
export interface GateEvaluation {
  /** The gates open when the pass began; also the expiry input when no check ran. */
  openGates: Gate[];
  scopes: GateCheckScope[];
  resolved: number;
  errors: number;
}

/**
 * 1. EVALUATE — close the gates anton may close. Every call spawns bd with cwd = repo (the seam
 * enforces it): a `gh:*` verdict is only trustworthy from the gate's own repository.
 */
export async function evaluateGates(
  pass: PassContext,
  ctx: JobContext,
): Promise<GateEvaluation> {
  const openGates = await beads.gateList(pass.repo);
  const scopes = checkScopes(openGates);
  let errors = 0;
  let resolved = 0;
  for (const scope of scopes) {
    const result = await beads.gateCheck(pass.repo, { scope });
    errors += result.errors;
    resolved += result.resolved;
    await ctx.heartbeat();
  }
  if (resolved > 0) {
    console.log(`[gate-check] ${pass.projectId}: closed ${resolved} satisfied gate(s)`);
  }
  return { openGates, scopes, resolved, errors };
}

/**
 * Tell a human about one dead wait, and report whether they can now see it. The note lands BEFORE
 * the marker label, so a failed note is retried next pass rather than being silently marked as
 * told-to-a-human — while a failed LABEL still counts as surfaced: a note this pass wrote but did
 * not sync is invisible to every other reader of the board, so the push must still happen. The gate
 * is then re-surfaced next pass (it carries no marker yet) — one duplicate note on a partial write,
 * versus a stall nobody outside this machine can see.
 */
async function surfaceStall(
  pass: PassContext,
  board: Bead[],
  gate: Gate,
  nowMs: number,
): Promise<boolean> {
  const blocked = beadBlockedByGate(board, gate.id);
  try {
    await beads.note(pass.repo, blocked?.id ?? gate.id, expiredGateNote(gate, nowMs));
  } catch (e) {
    console.error(`[gate-check] failed to surface expired gate ${gate.id}:`, e);
    return false;
  }
  console.log(
    `[gate-check] ${pass.projectId}: gate ${gate.id} blew its timeout — surfaced for a human`,
  );
  await beads
    .tag(pass.repo, gate.id, [GATE_EXPIRED_LABEL])
    .catch((e) =>
      console.error(`[gate-check] failed to tag expired gate ${gate.id} (${GATE_EXPIRED_LABEL}):`, e),
    );
  return true;
}

/**
 * 2. SURFACE — the waits that died, one note each. The gates are re-read when a check ran: the ones
 * it just closed are no longer stalls.
 */
export async function surfaceStalls(
  pass: PassContext,
  board: Bead[],
  evaluation: GateEvaluation,
  nowMs: number,
): Promise<number> {
  const gates =
    evaluation.scopes.length > 0 ? await beads.gateList(pass.repo) : evaluation.openGates;
  let surfaced = 0;
  for (const gate of expiredGates(gates, nowMs)) {
    if (await surfaceStall(pass, board, gate, nowMs)) surfaced += 1;
  }
  return surfaced;
}

/**
 * 4a. APPLY — re-dispatch the work whose gated step is ready again. `resumeEpic` decides the verb
 * (resume a parked job, or enqueue a fresh one) and refuses anything an active job already covers,
 * which is what makes an overlapping pass a no-op instead of a second run.
 */
export async function dispatchUngated(pass: PassContext, targets: Bead[]): Promise<void> {
  for (const target of targets) {
    const outcome = await resumeEpic(pass.db, pass.clock, pass.projectId, target.id);
    if (outcome === "resumed-job" || outcome === "enqueued") {
      console.log(`[gate-check] ${pass.projectId}: ${target.id} ungated — ${outcome}`);
    }
  }
}

/**
 * 4b. APPLY — the same resume for the gates `bd ready --gated` cannot report, marked one-shot on the
 * gate itself because a resolved gate stays on its bead forever. The mark lands AFTER the dispatch
 * decision, so a failed resume is retried next pass rather than being silently recorded as handled —
 * and every outcome is marked, including `already-active`/`job-cancelled`: the gate has done its job
 * in all four cases. Returns how many marks landed — the count that decides the dolt push, because
 * the marker is what keeps a SECOND anton sharing this board from re-dispatching the same target.
 */
export async function dispatchReleased(
  pass: PassContext,
  released: PlainGateResume[],
): Promise<number> {
  let handedBack = 0;
  for (const { gate, target } of released) {
    const outcome = await resumeEpic(pass.db, pass.clock, pass.projectId, target.id);
    console.log(
      `[gate-check] ${pass.projectId}: ${target.id} released by gate ${gate.id} — ${outcome}`,
    );
    try {
      await beads.tag(pass.repo, gate.id, [GATE_RESUMED_LABEL]);
      handedBack += 1;
    } catch (e) {
      console.error(`[gate-check] failed to mark gate ${gate.id} as handed back:`, e);
    }
  }
  return handedBack;
}

/**
 * 4c. APPLY — hand every MERGED run target to review-fix (anton-k0kj), which finalizes it exactly as
 * it always has; only its trigger moved. Deduped against a live job for the same target, and
 * re-dispatched every pass until the finalize actually lands, so a half-done finalize heals itself.
 */
export async function dispatchMerged(pass: PassContext, merged: Bead[]): Promise<void> {
  for (const target of merged) {
    const jobId = enqueueReviewFixIfAbsent(pass.db, pass.clock, pass.projectId, target.id);
    if (jobId) {
      console.log(`[gate-check] ${pass.projectId}: ${target.id} merged — dispatched review-fix`);
    }
  }
}

/**
 * Ungated work anton chose not to run is a decision worth seeing: unapproved, abandoned, already
 * live, or held behind a blocker of its own. Silence here would be indistinguishable from a resume
 * that never happened. Undefined when there is nothing to report.
 */
export function unmatchedGatedReport(plan: ResumePlan): string | undefined {
  if (plan.gated.length === 0 || plan.targets.length > 0) return undefined;
  const steps = plan.gated.map((g) => g.ready_step?.id ?? g.molecule_id).join(", ");
  return `${plan.gated.length} ungated step(s) matched no runnable target (${steps})`;
}

/**
 * Did this pass write to the SHARED board? Only then is a dolt push worth its noise: the resume half
 * writes to anton.db alone, and an idle pass is the common case on this cadence — pushing every slot
 * for nothing would make a project with no gates the noisiest thing on the remote.
 */
export function wroteToBoard(resolved: number, surfaced: number, handedBack: number): boolean {
  return resolved > 0 || surfaced > 0 || handedBack > 0;
}

/**
 * A gate bd could not evaluate is UNKNOWN, not unresolved — reading it as "still waiting" is how a
 * wait becomes permanent. Thrown last so the pass's real work still lands: the runner retries, and a
 * gate that keeps erroring parks the job for a human instead of waiting forever in silence.
 */
function assertGatesEvaluated(repo: string, errors: number): void {
  if (errors === 0) return;
  throw new Error(
    `bd gate check could not evaluate ${errors} gate(s) in ${repo} — their state is unknown, ` +
      `not unresolved (is \`gh\` installed and authenticated?)`,
  );
}

/** Build the runner handler bound to a db/clock. Register it as the "gate-check" handler. */
export function makeGateCheckHandler(deps: GateCheckDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;

  return async function gateCheck(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as GateCheckPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);
    const pass: PassContext = { db, clock, projectId, repo: project.repoPath };

    const evaluation = await evaluateGates(pass, ctx);

    // The board, read once for every phase below, and read DIRECTLY (`loadAllIssues`) rather than
    // through the UI snapshot: a write landing while a cold snapshot is loading discards that load
    // and hands the caller an EMPTY board. A page renders empty and self-corrects; here an empty
    // board reads as "nothing to resume" and the gated run silently never restarts — the exact
    // failure this job exists to prevent, and one this pass's own gate writes can trigger. It also
    // carries the gate beads `bd list` omits, which is what makes the blocked-bead lookup possible.
    // Strict on the gate listing: a swallowed failure there hands this pass a board with the gate
    // EDGES but not the gates, which reads as "nothing closed" — every resume and finalization below
    // silently no-ops. A rejection retries the pass instead.
    const board = await loadAllIssues(pass.repo, { strictGates: true });
    const nowMs = clock.now();

    const surfaced = await surfaceStalls(pass, board, evaluation, nowMs);

    // Every dispatch below is scoped to this operator's targets: the board is shared, this schedule
    // is machine-local, and `resumeEpic`'s dedupe only sees the local job table (anton-zoh).
    const operator = await resolveOperator();
    const plan = planResumes(board, await beads.readyGated(pass.repo), nowMs, operator);
    await dispatchUngated(pass, plan.targets);
    const handedBack = await dispatchReleased(pass, plan.released);
    await dispatchMerged(pass, plan.merged);

    const unmatched = unmatchedGatedReport(plan);
    if (unmatched) console.log(`[gate-check] ${projectId}: ${unmatched}`);

    if (wroteToBoard(evaluation.resolved, surfaced, handedBack)) {
      await beads.sync(pass.repo).catch((e) => console.error("[gate-check] beads dolt sync failed", e));
    }

    assertGatesEvaluated(pass.repo, evaluation.errors);
  };
}
