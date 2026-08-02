/**
 * gate-check job (anton-286r). The scheduled pass that closes satisfied gates and puts the work they
 * were blocking back in flight — the half of the gate model that makes parking on a gate cheaper
 * than polling: the whole project's waits cost a couple of bd calls per cron slot, whatever their
 * number, and nothing at all in between.
 *
 * Four moves, in order, each idempotent on its own:
 *
 *   1. EVALUATE — `bd gate check`, scoped to the gate types actually open. `human` is NEVER among
 *      those scopes: a human gate is a founder control point and only an explicit action resolves
 *      it. bd happens not to enumerate human gates at all, but the scope says so out loud rather
 *      than resting on that.
 *   2. SURFACE — an open gate whose own timeout has blown is no longer a wait, it's a stall. It gets
 *      one bd note on the bead it blocks and a `gate-expired` label on the gate, and is never raised
 *      again: surfaced once for a human, not retried forever. bd's own `--escalate` cannot do this
 *      job — measured on bd 1.1.2 it shells out to a `gt` binary that isn't installed, fails, still
 *      counts the gate as `escalated`, and leaves no mark on it, so it would re-fire every pass.
 *   3. RESUME — work whose gate has closed is re-dispatched. Discovery is `bd ready --gated`, the
 *      board's own answer, so anton keeps NO waiter list: a gate closing by this pass, by a human's
 *      `bd gate resolve`, or on another machine all surface here on the next slot. (A CLI-resolved
 *      human gate notifies no anton instance, which is exactly why the resume half runs every pass
 *      rather than only when this pass closed something.)
 *   4. FINALIZE — a run target whose `gh:pr` merge gate has closed is handed to review-fix, which
 *      closes it out exactly as it always has (anton-k0kj). This is the move that turns "waiting for
 *      merge" from a sweep that re-reads every open PR into one bd call per slot. Its discovery is
 *      the BOARD, not `bd ready --gated` — that call reports molecule steps only and never sees an
 *      ad-hoc gate on a plain bead.
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
import { beads, LABELS, type Bead, type Gate, type GateCheckScope, type GatedMolecule } from "../beads/bd";
import { isPipelineArtifact } from "../beads/contract";
import { loadAllIssues } from "../beads/issues";
import { prNumberFromRef } from "../git/pr";
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import { enqueueReviewFixIfAbsent, systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext, JobHandler } from "./runner";
import { resumeEpic } from "./unstick";

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

/** The stage label a run target carries while its PR is in review — cleared by merge-finalization. */
const IN_REVIEW = LABELS.stage("in-review");

/** Ancestor walk depth — a guard against a cyclic parent chain, not a real board shape. */
const MAX_PARENT_DEPTH = 20;

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

/**
 * The bead a gate blocks. bd records the edge on the BLOCKED bead (`depends_on` the gate), never on
 * the gate itself, so this is a scan of the board's inline dependencies rather than a field read.
 */
export function beadBlockedByGate(board: Bead[], gateId: string): Bead | undefined {
  return board.find((b) =>
    (b.dependencies ?? []).some((d) => d.depends_on_id === gateId && d.type === "blocks"),
  );
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

/**
 * The bead anton would actually run for a gated step: the first bead at or above it that is a run
 * target. Walking UP is what makes the mapping work at all — bd reports the gated STEP, while anton
 * runs the epic/feature above it (`bd ready --gated` names that parent as `molecule_id`).
 *
 * The walk STOPS at pipeline plumbing, exactly as `boardCards` does (anton-ve2r): a poured
 * molecule's steps ride on that molecule, whose gates bd sequences, so a molecule parented under a
 * feature does NOT make its steps that feature's work. Walking through it would resume the feature
 * for a step `runTickets` deliberately never dispatches — an unrelated run, after which the same
 * `bd ready --gated` entry stays eligible and re-triggers on every later slot. No run target above
 * plumbing means no resume; the pass logs the unmatched step instead.
 */
export function runTargetAbove(board: Bead[], startId: string): Bead | undefined {
  const byId = new Map(board.map((b) => [b.id, b]));
  const seen = new Set<string>();
  let current = byId.get(startId);
  for (let depth = 0; current && depth < MAX_PARENT_DEPTH; depth += 1) {
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    if (isPipelineArtifact(current)) return undefined;
    if (beads.isRunTarget(current, board)) return current;
    const parent = beads.parentOf(current);
    current = parent ? byId.get(parent) : undefined;
  }
  return undefined;
}

/**
 * May this pass re-dispatch `target`? Approval is the load-bearing check: discovery comes from the
 * board, so a gate someone hung on unapproved work must never turn into a run — the founder decides
 * what executes, and a gate closing is not that decision. The rest is hygiene: finished or abandoned
 * work isn't resumed, and a target carrying an UNEXPIRED run-lease is already executing somewhere
 * (possibly another machine, which the local job table cannot see).
 */
export function isResumableTarget(target: Bead, nowMs: number): boolean {
  return (
    beads.isApproved(target) &&
    !beads.isAbandoned(target) &&
    target.status !== "closed" &&
    !beads.isRunLive(target, nowMs)
  );
}

/**
 * The in-review run targets whose merge wait has been ANSWERED BY A MERGE — the beads to hand to
 * review-fix for finalization (anton-k0kj). Derived from the board rather than from "what this pass
 * closed", for the same reason the resume half is: a gate closed on another machine, or by an
 * operator's `bd gate resolve`, has to surface here too, and this pass keeps no waiter list.
 *
 * Every clause carries weight:
 *
 *   • the gate is CLOSED — and a `gh:pr` gate closes on MERGE and on nothing else. A PR closed
 *     WITHOUT merging leaves it open forever (bd reports "escalate", changes no state; measured on
 *     1.1.0 and 1.1.2), which is precisely what keeps a closed-unmerged PR out of this list and its
 *     PR ref in place for a recovery run.
 *   • the gate awaits the target's CURRENT PR. A recovery run resolves the superseded PR's gate
 *     itself (armMergeGate) and that resolved edge stays on the bead forever — so without this
 *     clause a target whose replacement PR is still open would read as merged and be dispatched to
 *     review-fix on every single pass.
 *   • the target is still OPEN and still `stage:in-review` — the two things finalization clears. A
 *     finalized target therefore drops out on the next pass, which is what stops a permanently
 *     closed gate from re-dispatching forever; a finalize that FAILED half-way leaves them in place
 *     and gets retried.
 *
 * `bd ready --gated` is not usable here: it reports molecule steps only, so an ad-hoc gate on a
 * plain bead never appears in it, not even the pass after it closes.
 */
export function mergedGateTargets(board: Bead[]): Bead[] {
  const byId = new Map(board.map((b) => [b.id, b]));
  return board.filter((bead) => {
    if (bead.status === "closed") return false;
    if (!(bead.labels?.includes(IN_REVIEW) ?? false)) return false;
    const prNumber = prNumberFromRef(beads.getPrRef(bead));
    if (prNumber === undefined) return false; // no PR to finalize (a tracker ref, or none at all)
    return (bead.dependencies ?? []).some((d) => {
      if (d.type !== "blocks") return false;
      const gate = byId.get(d.depends_on_id);
      if (gate === undefined || gate.status !== "closed" || !beads.isMergeWaitGate(gate)) {
        return false;
      }
      return (gate as Gate).await_id === String(prNumber);
    });
  });
}

/**
 * The distinct run targets a gate-closed board says are ready to move again. Deduped by id, because
 * two steps of the same epic ungating in the same pass are still one run.
 */
export function resumeTargets(board: Bead[], gated: GatedMolecule[], nowMs: number): Bead[] {
  const targets = new Map<string, Bead>();
  for (const entry of gated) {
    const startId = entry.ready_step?.id ?? entry.molecule_id;
    if (!startId) continue;
    const target = runTargetAbove(board, startId);
    if (!target || !isResumableTarget(target, nowMs)) continue;
    targets.set(target.id, target);
  }
  return [...targets.values()];
}

/** Build the runner handler bound to a db/clock. Register it as the "gate-check" handler. */
export function makeGateCheckHandler(deps: GateCheckDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;

  return async function gateCheck(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as GateCheckPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);
    const repo = project.repoPath;

    // 1. Evaluate the open gates anton may close. Every call spawns bd with cwd = repo (the seam
    //    enforces it): a `gh:*` verdict is only trustworthy from the gate's own repository.
    const openGates = await beads.gateList(repo);
    const scopes = checkScopes(openGates);
    let errors = 0;
    let resolved = 0;
    for (const scope of scopes) {
      const result = await beads.gateCheck(repo, { scope });
      errors += result.errors;
      resolved += result.resolved;
      await ctx.heartbeat();
    }
    if (resolved > 0) console.log(`[gate-check] ${projectId}: closed ${resolved} satisfied gate(s)`);

    // The board, read once for both halves below, and read DIRECTLY (`loadAllIssues`) rather than
    // through the UI snapshot: a write landing while a cold snapshot is loading discards that load
    // and hands the caller an EMPTY board. A page renders empty and self-corrects; here an empty
    // board reads as "nothing to resume" and the gated run silently never restarts — the exact
    // failure this job exists to prevent, and one this pass's own gate writes can trigger. It also
    // carries the gate beads `bd list` omits, which is what makes the blocked-bead lookup possible.
    const board = await loadAllIssues(repo);
    const nowMs = clock.now();

    // 2. Surface the waits that died. Re-read the gates when a check ran — the ones it closed are no
    //    longer stalls. The note lands BEFORE the marker label, so a failed note is retried next pass
    //    rather than being silently marked as told-to-a-human.
    const gatesAfterCheck = scopes.length > 0 ? await beads.gateList(repo) : openGates;
    let surfaced = 0;
    for (const gate of expiredGates(gatesAfterCheck, nowMs)) {
      const blocked = beadBlockedByGate(board, gate.id);
      try {
        await beads.note(repo, blocked?.id ?? gate.id, expiredGateNote(gate, nowMs));
        // Counted the moment the NOTE lands, not after the label: a note this pass wrote but did
        // not sync is invisible to every other reader of the board, so a failed tag must still
        // push. The gate is then re-surfaced next pass (it carries no marker yet) — one duplicate
        // note on a partial write, versus a stall nobody outside this machine can see.
        surfaced += 1;
        console.log(`[gate-check] ${projectId}: gate ${gate.id} blew its timeout — surfaced for a human`);
        await beads.tag(repo, gate.id, [GATE_EXPIRED_LABEL]);
      } catch (e) {
        console.error(`[gate-check] failed to surface expired gate ${gate.id}:`, e);
      }
    }

    // 3. Re-dispatch the work whose gate has closed. `resumeEpic` decides the verb (resume a parked
    //    job, or enqueue a fresh one) and refuses anything an active job already covers — which is
    //    what makes an overlapping pass a no-op instead of a second run.
    const gated = await beads.readyGated(repo);
    const targets = resumeTargets(board, gated, nowMs);
    for (const target of targets) {
      const outcome = await resumeEpic(db, clock, projectId, target.id);
      if (outcome === "resumed-job" || outcome === "enqueued") {
        console.log(`[gate-check] ${projectId}: ${target.id} ungated — ${outcome}`);
      }
    }
    // 4. Hand every MERGED run target to review-fix (anton-k0kj). This is the whole point of the
    //    merge gate: the sweep no longer has to re-read every open PR to notice a merge — one
    //    `bd gate check` settles the project's merge waits, and the targets whose wait closed are
    //    dispatched by id. review-fix's merge-finalize behaviour is untouched; only its trigger
    //    moved. Deduped against a live job for the same target, and re-dispatched every pass until
    //    the finalize actually lands, so a half-done finalize heals itself.
    for (const target of mergedGateTargets(board)) {
      const jobId = enqueueReviewFixIfAbsent(db, clock, projectId, target.id);
      if (jobId) console.log(`[gate-check] ${projectId}: ${target.id} merged — dispatched review-fix`);
    }

    // Ungated work anton chose not to run is a decision worth seeing: unapproved, abandoned, or
    // already live. Silence here would be indistinguishable from a resume that never happened.
    if (gated.length > 0 && targets.length === 0) {
      console.log(
        `[gate-check] ${projectId}: ${gated.length} ungated step(s) matched no runnable target ` +
          `(${gated.map((g) => g.ready_step?.id ?? g.molecule_id).join(", ")})`,
      );
    }

    // Only when this pass actually wrote to the board. The resume half writes to anton.db alone, and
    // an idle pass is the common case on this cadence — pushing dolt every slot for nothing would
    // make a project with no gates the noisiest thing on the remote.
    if (resolved > 0 || surfaced > 0) {
      await beads.sync(repo).catch((e) => console.error("[gate-check] beads dolt sync failed", e));
    }

    // A gate bd could not evaluate is UNKNOWN, not unresolved — reading it as "still waiting" is how
    // a wait becomes permanent. Thrown last so the pass's real work still lands: the runner retries,
    // and a gate that keeps erroring parks the job for a human instead of waiting forever in silence.
    if (errors > 0) {
      throw new Error(
        `bd gate check could not evaluate ${errors} gate(s) in ${repo} — their state is unknown, ` +
          `not unresolved (is \`gh\` installed and authenticated?)`,
      );
    }
  };
}
