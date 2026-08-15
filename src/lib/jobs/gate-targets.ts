/**
 * The board-side half of the gate-check pass (anton-286r): given ONE board read and a clock, which
 * run targets a closed gate has released, and which merged ones are ready to be finalized. Split out
 * of gate-check.ts (anton-m2e8) so the resume DECISION can be read — and tested — without the job
 * around it. Everything here is pure: every bd call stays on the job's side of the seam, which is
 * what lets {@link planResumes} answer all three dispatch questions off a single snapshot.
 *
 * Three answers, one per dispatch path the pass has:
 *
 *   • {@link resumeTargets} — the targets `bd ready --gated` reports (a gated step under a PARENT).
 *   • {@link plainGateResumes} — the targets it cannot report: a gate hung straight on a parentless
 *     bead, which never appears there before or after it closes.
 *   • {@link mergedGateTargets} — the in-review targets whose `gh:pr` merge wait has closed.
 *
 * They share one dispatchability rule ({@link isDispatchableTarget} / {@link isResumableTarget}), and
 * that sharing is load-bearing: the three paths read the same board, so a target the founder never
 * approved — or one another operator holds — must be refused identically by all of them.
 */
import { beads, LABELS, type Bead, type GatedMolecule } from "../beads/bd";
import { isPipelineArtifact } from "../beads/contract";
import {
  computeEpicGraph,
  epicStandaloneBlockers,
  isUnit,
  standaloneBlockers,
} from "../epic-graph";
import { prNumberFromRef } from "../git/pr";
import { ownedByOperator } from "./review-fix";

/**
 * Marks a closed gate whose blocked work this pass has already handed back to the runner. A one-shot
 * marker, for a sharp reason: a resolved gate stays on its bead FOREVER, so without one every later
 * pass would re-dispatch the same target — a park a human asked for would become an endless retry.
 * On the SHARED board, so a second anton reading the same project doesn't dispatch it again either.
 */
export const GATE_RESUMED_LABEL = "gate-resumed";

/** The stage label a run target carries while its PR is in review — cleared by merge-finalization. */
const IN_REVIEW = LABELS.stage("in-review");

/** Ancestor walk depth — a guard against a cyclic parent chain, not a real board shape. */
const MAX_PARENT_DEPTH = 20;

/** Label test that reads the same whether `labels` is absent, empty, or set. */
function hasLabel(bead: Bead, label: string): boolean {
  return bead.labels?.includes(label) ?? false;
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
 * The target's open blockers, by the SAME rule execute-epic re-checks at job start: a graph unit
 * (epic/feature) takes them from the epic-graph rollup plus the standalone prerequisites the rollup
 * drops, a standalone task/bug from its own `blocks` edges. Anything looser here would dispatch work
 * execute-epic then refuses, turning a wait into a parked job a human has to clear.
 *
 * Exported because the MANUAL resolve-and-resume runs the identical risk: closing one of a target's
 * two gates and re-enqueueing it parks the run just the same (see escalation-actions.ts).
 */
export function openBlockersOf(board: Bead[], target: Bead): string[] {
  return isUnit(target)
    ? [
        ...(computeEpicGraph(board).epics.find((n) => n.id === target.id)?.blockedBy ?? []),
        ...epicStandaloneBlockers(board, target.id),
      ]
    : standaloneBlockers(board, target.id);
}

/**
 * The full test both resume halves apply to a target a closed gate names. Beyond resumability:
 *
 *   • the target is THIS OPERATOR'S (unclaimed, or claimed by it) — the anton-zoh test. The board is
 *     SHARED and this schedule is machine-local, so every instance sees the same gate close;
 *     unfiltered, each enqueues an execute-epic for the same bead in its own job table, one wins the
 *     claim, and the other retries on `RunAlreadyLiveError` until the bead closes.
 *   • the target is not `stage:in-review` — its implementation is done, and its merge is the
 *     finalization path's territory. Without this a target whose `gh:pr` gate closes would get both
 *     a review-fix and a redundant execute-epic that reaches step 0a and exits.
 *   • no OTHER open blocker — execute-epic's own readiness check would refuse the dispatch and park
 *     the job, and because gate discovery is a VIEW of the board (not a queue of events), every later
 *     pass would resume and re-park it. Holding costs nothing: the entry is still there when the
 *     blocker lands. (A closed gate is `done`, so it never counts against its own release.)
 *
 * Blockers last: the rollup is a whole-board walk, and the cheap tests reject most targets first.
 */
function isDispatchableTarget(
  board: Bead[],
  target: Bead,
  nowMs: number,
  operator: string | undefined,
): boolean {
  return (
    isResumableTarget(target, nowMs) &&
    ownedByOperator(target, operator) &&
    !hasLabel(target, IN_REVIEW) &&
    openBlockersOf(board, target).length === 0
  );
}

/** A gate that has closed, paired with the run target its closing releases. */
export interface PlainGateResume {
  gate: Bead;
  target: Bead;
}

/**
 * A closed gate whose release is a RESUME rather than a finalization:
 *
 *   • NOT a `gh:pr` merge wait — that flavour closing means "the PR merged", which is finalization,
 *     not a resume. Dispatching both would re-run a target while review-fix closes it out.
 *   • not already handed back ({@link GATE_RESUMED_LABEL}) — see there.
 */
function isPlainResumeGate(gate: Bead): boolean {
  return (
    gate.issue_type === "gate" &&
    gate.status === "closed" &&
    !beads.isMergeWaitGate(gate) &&
    !hasLabel(gate, GATE_RESUMED_LABEL)
  );
}

/** The run target a closed gate releases, or undefined when this pass may not dispatch it. */
function releasedTarget(
  board: Bead[],
  gate: Bead,
  nowMs: number,
  operator: string | undefined,
): Bead | undefined {
  const blocked = beadBlockedByGate(board, gate.id);
  const target = blocked ? runTargetAbove(board, blocked.id) : undefined;
  if (!target) return undefined;
  return isDispatchableTarget(board, target, nowMs, operator) ? target : undefined;
}

/**
 * The gate-closed work `bd ready --gated` CANNOT report. Measured on bd 1.1.2: that call reports a
 * gated bead only when it HAS a parent (which it names as the `molecule_id`, molecule or not). A gate
 * hung straight on a PARENTLESS run target — an approved standalone task/bug, a top-level feature,
 * the founder's `bd gate create --blocks <task>` "not until the design review lands" — never appears
 * there, before or after it closes: the bead simply returns to ordinary `bd ready`, which nothing in
 * anton polls. The merge path doesn't cover it either (that is `gh:pr` + `stage:in-review` only), so
 * without this half the parked run waits forever on a wait that is already over.
 *
 * Derived from the BOARD, for the same reason the merge path is: a gate resolved by a human's CLI or
 * on another machine has to surface here too, and this pass keeps no waiter list.
 *
 * NOT deduped by target: the marker is per-GATE, so two closed gates on one target must both be
 * marked. The second dispatch is absorbed by `resumeEpic`, which refuses an epic a live job covers.
 */
export function plainGateResumes(
  board: Bead[],
  nowMs: number,
  operator?: string,
): PlainGateResume[] {
  return board
    .filter(isPlainResumeGate)
    .map((gate) => ({ gate, target: releasedTarget(board, gate, nowMs, operator) }))
    .filter((resume): resume is PlainGateResume => resume.target !== undefined);
}

/** The bead a `bd ready --gated` entry speaks for — its ready step, or the molecule it names. */
function gatedEntryTarget(board: Bead[], entry: GatedMolecule): Bead | undefined {
  const startId = entry.ready_step?.id ?? entry.molecule_id;
  return startId ? runTargetAbove(board, startId) : undefined;
}

/**
 * The distinct run targets a gate-closed board says are ready to move again. Deduped by id BEFORE
 * the dispatchability test, because two steps of the same epic ungating in the same pass are still
 * one run — and that test walks the whole board for blockers, which one epic must not pay for twice.
 *
 * The gated entry speaks for the STEP, never for the ancestor anton would actually run, so every
 * clause of {@link isDispatchableTarget} still applies to what the walk lands on.
 */
export function resumeTargets(
  board: Bead[],
  gated: GatedMolecule[],
  nowMs: number,
  operator?: string,
): Bead[] {
  const targets = new Map<string, Bead>();
  for (const entry of gated) {
    const target = gatedEntryTarget(board, entry);
    if (target) targets.set(target.id, target);
  }
  return [...targets.values()].filter((t) => isDispatchableTarget(board, t, nowMs, operator));
}

/**
 * The PR an in-review target would finalize, or undefined when the target is not this pass's to
 * finalize at all. The target must still be OPEN and still `stage:in-review` — the two things
 * finalization clears, so a finalized target drops out on the next pass (which is what stops a
 * permanently closed gate from re-dispatching forever), while a finalize that FAILED half-way keeps
 * both marks and gets retried. Ownership is the anton-zoh test: a TARGETED review-fix bypasses the
 * sweep's own filter, so the concurrent-finalization race has to be excluded here.
 */
function finalizablePr(bead: Bead, operator: string | undefined): number | undefined {
  const mine =
    bead.status !== "closed" && hasLabel(bead, IN_REVIEW) && ownedByOperator(bead, operator);
  // No PR number means nothing to finalize — a tracker ref, or no ref at all.
  return mine ? prNumberFromRef(beads.getPrRef(bead)) : undefined;
}

/**
 * Has the target's CURRENT PR merged? Two clauses, each load-bearing:
 *
 *   • the gate is CLOSED — and a `gh:pr` gate closes on MERGE and on nothing else. A PR closed
 *     WITHOUT merging leaves it open forever (bd reports "escalate", changes no state; measured on
 *     1.1.0 and 1.1.2), which is precisely what keeps a closed-unmerged PR out of this answer and
 *     its PR ref in place for a recovery run.
 *   • the gate awaits the target's CURRENT PR. A recovery run resolves the superseded PR's gate
 *     itself (armMergeGate) and that resolved edge stays on the bead forever — so without this a
 *     target whose replacement PR is still open would read as merged and be dispatched to review-fix
 *     on every single pass.
 */
function mergedOnPr(bead: Bead, byId: Map<string, Bead>, prNumber: number): boolean {
  return (bead.dependencies ?? []).some((d) => {
    const gate = d.type === "blocks" ? byId.get(d.depends_on_id) : undefined;
    if (gate?.status !== "closed" || !beads.isMergeWaitGate(gate)) return false;
    return gate.await_id === String(prNumber);
  });
}

/**
 * The in-review run targets whose merge wait has been ANSWERED BY A MERGE — the beads to hand to
 * review-fix for finalization (anton-k0kj). Derived from the board rather than from "what this pass
 * closed", for the same reason the resume halves are: a gate closed on another machine, or by an
 * operator's `bd gate resolve`, has to surface here too, and this pass keeps no waiter list.
 *
 * `bd ready --gated` is not usable here: it reports a gated bead only when it has a PARENT, and a
 * merge gate blocks the run target itself — which for a standalone task/bug or a top-level feature
 * has none, so it never appears there, not even the pass after it closes.
 */
export function mergedGateTargets(board: Bead[], operator?: string): Bead[] {
  const byId = new Map(board.map((b) => [b.id, b]));
  return board.filter((bead) => {
    const prNumber = finalizablePr(bead, operator);
    return prNumber !== undefined && mergedOnPr(bead, byId, prNumber);
  });
}

/**
 * Everything a gate-closed board says should move, decided before anything is dispatched — the whole
 * "what now?" of a pass, off ONE board read and ONE clock reading. Holding the three answers together
 * is what keeps them consistent: they overlap by design (a `gh:pr` gate closing is a finalization,
 * never a resume), and deciding them against the same snapshot is what makes that split total.
 */
export interface ResumePlan {
  /** `bd ready --gated`, verbatim — kept so the pass can report the entries it matched nothing to. */
  gated: GatedMolecule[];
  /** Run targets to re-dispatch, from the gated entries. */
  targets: Bead[];
  /** Run targets released by a gate `bd ready --gated` cannot report, each with the gate to mark. */
  released: PlainGateResume[];
  /** In-review targets whose PR has merged, to hand to review-fix. */
  merged: Bead[];
}

/** Decide all three dispatch paths against one board. Pure — the apply half owns every write. */
export function planResumes(
  board: Bead[],
  gated: GatedMolecule[],
  nowMs: number,
  operator?: string,
): ResumePlan {
  return {
    gated,
    targets: resumeTargets(board, gated, nowMs, operator),
    released: plainGateResumes(board, nowMs, operator),
    merged: mergedGateTargets(board, operator),
  };
}
