/**
 * THE TIMELINE'S SOURCE READERS (anton-4ldxk) — one bounded reader per row kind `foldTimeline`
 * (timeline.ts) already knows how to map, over one project and one time window.
 *
 * Seven sources are plain anton.db reads, each seeking a `(projectId, <event time>)` index rather
 * than scanning a table: `runs`, `run_attempts`, `escalations`, `picker_starts`, `picker_verdicts`,
 * `autopilot_disarms`, `scan_summaries`. Three of `runs_project_started_idx`,
 * `run_attempts_project_ended_idx`, and `escalations_project_raised_idx` (schema.ts) were added
 * alongside this module — the other four tables already carried the index this read needed.
 *
 * Three sources carry no table of their own: a proposal's filed/applied/refused and the
 * bead-closed / PR-merged pair are facts about BEADS, which live on the board, not in anton.db.
 * Those three readers are pure over the caller's own bd snapshot (`Bead[]`) — no `bd show`/`bd
 * list` of their own — the same contract `operator-queue.ts` and `feature-ledger.ts` hold: the
 * caller already paid for a board read, and a second one here would double it for nothing a
 * fresher read buys (this ticket's acceptance criterion).
 *
 * ## Window semantics
 *
 * `[since, until)` — the lower bound inclusive, the upper bound EXCLUSIVE. A caller that polls by
 * posting each read's `until` back as the next read's `since` (the mark-seen contract,
 * viewer-marks.ts) needs that half-openness: with both ends inclusive, an event timestamped
 * exactly `until` would land in this read AND be re-fetched by the next one (`since` === this
 * read's `until`), since whole-second timestamps make that collision ordinary, not rare. Excluding
 * `until` defers such an event to the next read instead of dropping it — the next read's
 * inclusive `since` picks it up — so it is shown exactly once, whichever read that ends up being.
 *
 * Each DB reader still seeks on the table's own indexed timestamp first (a run's `startedAt`, an
 * escalation's `raisedAt`, an attempt's `endedAt`, …), but `readRunRows` and `readEscalationRows`
 * widen that seek with an OR against the row's `updatedAt` — the proxy for the OTHER half of its
 * lifecycle (`prOpenedAt`, `resolvedAt`). Without it, a run started (or escalation raised) before
 * `since` whose PR opened (or which resolved) INSIDE the window would never be fetched at all: the
 * single-column WHERE excludes the row before folding ever sees it, so the in-window transition is
 * silently dropped rather than reported late. The OR necessarily overfetches — a row can come back
 * whose own `startedAt`/`raisedAt` sits outside the window — and `foldTimeline` always emits both
 * halves of a lifecycle row unconditionally (it has no window to filter against), so the caller
 * (events-since/route.ts) filters the folded events back down to `[since, until)` once, after the
 * fold, which is also what trims the run/escalation fetched purely for its OTHER half back to just
 * that half's event.
 *
 * The bd-derived readers have no such gap: they test every event they can see (`filed`/`applied`/
 * `refused`, `closedAt`, `mergedAt`) against the window directly, in memory, since the whole board
 * is already on hand.
 */
import { and, eq, gte, inArray, lt, or } from "drizzle-orm";

import { beads, type Bead } from "./beads/bd";
import { isPipelineArtifact } from "./beads/contract";
import * as schema from "./db/schema";
import { toEpoch } from "./db/epoch";
import { prNumberFromRef } from "./git/pr";
import { isFoldReason } from "./gardener/emit";
import { isProposalBead, proposalPlanOf } from "./gardener/detections";
import type { AntonDb } from "./jobs/queue";
import type {
  AutopilotDisarmRow,
  BeadClosedRow,
  EscalationRow,
  PickerStartRow,
  PickerVerdictRow,
  PrMergedRow,
  ProposalRow,
  RunAttemptRow,
  RunRow,
  ScanSummaryRow,
} from "./timeline";

/** The window every reader is asked for, epoch SECONDS: `since` inclusive, `until` exclusive. */
export interface TimelineWindow {
  since: number;
  until: number;
}

function range(window: TimelineWindow): { gte: Date; lt: Date } {
  return { gte: new Date(window.since * 1000), lt: new Date(window.until * 1000) };
}

/** A column-bounds test for one timestamp against `window`, `since` inclusive / `until` exclusive. */
function columnInWindow(
  w: { gte: Date; lt: Date },
  column: Parameters<typeof gte>[0],
): ReturnType<typeof and> {
  return and(gte(column, w.gte), lt(column, w.lt));
}

function inWindow(at: number, window: TimelineWindow): boolean {
  return at >= window.since && at < window.until;
}

/** A bd bead's ISO timestamp (`created_at`/`closed_at`) as epoch seconds, or null if unparseable. */
function beadEpochSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// ---- anton.db readers -----------------------------------------------------

/**
 * Runs started in this window, plus — best-effort — when each one's ticket first read as carrying
 * a PR.
 *
 * `prOpenedAt` has no column of its own: neither `runs` nor a bd bead records when a PR link
 * landed, and ADR-0001 scopes this feature to existing data, nothing new to meter. The row's own
 * `updatedAt` (already written on every change to the row) is the best already-existing proxy for
 * "when", used only once the caller's board snapshot shows the ticket actually carrying a PR ref —
 * never guessed from `startedAt` alone, which would fire on every run `foldTimeline` ever saw.
 *
 * The PR ref is checked against `epicBeadId`, not `ticketBeadId`: for a multi-ticket epic run,
 * `execute-epic-run-phase.ts` writes the PR ref onto the epic bead, while `ticketBeadId` on this
 * row only ever names whichever child ticket was being worked when the row was written
 * (execute-epic-ticket-bookends.ts). `ticketBeadId` is still what feature attribution
 * (`foldTimeline`'s `featureOf`) keys off, so it stays on the row unchanged.
 */
export async function readRunRows(
  db: AntonDb,
  projectId: string,
  window: TimelineWindow,
  board: readonly Bead[],
): Promise<RunRow[]> {
  const w = range(window);
  const rows = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        or(
          columnInWindow(w, schema.runs.startedAt),
          columnInWindow(w, schema.runs.updatedAt),
        ),
      ),
    );

  const ticketById = new Map(board.map((b) => [b.id, b] as const));

  const out: RunRow[] = [];
  for (const r of rows) {
    const startedAt = toEpoch(r.startedAt);
    if (startedAt == null) continue;
    const epic = ticketById.get(r.epicBeadId);
    const updatedAt = toEpoch(r.updatedAt);
    const hasPr = epic != null && beads.getPrRef(epic) !== undefined;
    // `failed` rows never deliver (runs.ts `findRunFormulaForBranch`: an ordinary handler error
    // settles the row `failed` and the retry gets a FRESH row) — without this guard, a retried
    // epic's stale failed row would claim the PR its successful retry opened, stamped with the
    // failed row's own `updatedAt` rather than the one that actually did it (PR #346 review, P2).
    // `status: "done"` is not enough on its own: a retired standalone target also settles `done`
    // but with `delivered: false` (execute-epic-run-phase.ts) when it opened no PR at all. Without
    // this guard, reopening that epic and landing a PR on a later run would make this earlier,
    // undelivered row claim the later PR, stamped with ITS OWN `updatedAt` (PR #346 review, round 3).
    const prOpenedAt =
      hasPr && r.status !== "failed" && r.delivered && updatedAt != null && updatedAt > startedAt
        ? updatedAt
        : null;
    out.push({
      source: "run",
      id: r.id,
      projectId: r.projectId,
      ticketBeadId: r.ticketBeadId,
      startedAt,
      prOpenedAt,
    });
  }
  return out;
}

/**
 * Settled run attempts (parked/done/failed) that ended in this window.
 *
 * `run_attempts` carries no `ticketBeadId` of its own (only `runId`) — one batched lookup against
 * `runs` resolves it, keyed on `runs`' primary key rather than a second windowed scan.
 */
export async function readRunAttemptRows(
  db: AntonDb,
  projectId: string,
  window: TimelineWindow,
): Promise<RunAttemptRow[]> {
  const w = range(window);
  const rows = await db
    .select()
    .from(schema.runAttempts)
    .where(and(eq(schema.runAttempts.projectId, projectId), columnInWindow(w, schema.runAttempts.endedAt)));
  if (rows.length === 0) return [];

  const runIds = [...new Set(rows.map((r) => r.runId))];
  const runs = await db
    .select({ id: schema.runs.id, ticketBeadId: schema.runs.ticketBeadId })
    .from(schema.runs)
    .where(inArray(schema.runs.id, runIds));
  const ticketByRunId = new Map(runs.map((r) => [r.id, r.ticketBeadId]));

  return rows.map((r) => ({
    source: "run_attempt",
    id: r.id,
    projectId,
    ticketBeadId: ticketByRunId.get(r.runId) ?? null,
    outcome: r.outcome,
    endedAt: toEpoch(r.endedAt) ?? null,
  }));
}

/**
 * Escalations raised in this window. `resolvedAt` reuses `updatedAt`, the write a resolve stamps.
 *
 * Derived from the row's CURRENT status, not an immutable log (Out of scope: "no stored/
 * denormalised events — computed on read", ADR-0001). A `restoreEscalation` that flips a dismissed
 * row back to `open` before the next poll erases the evidence this reader uses to report
 * `escalation.resolved` — the resolution genuinely happened, but nothing in the row still says so.
 * Accepted for v1: closing that gap needs a resolution history independent of the row's live
 * status, which is exactly the stored-event model this ticket chose not to build.
 */
export async function readEscalationRows(
  db: AntonDb,
  projectId: string,
  window: TimelineWindow,
): Promise<EscalationRow[]> {
  const w = range(window);
  const rows = await db
    .select()
    .from(schema.escalations)
    .where(
      and(
        eq(schema.escalations.projectId, projectId),
        or(
          columnInWindow(w, schema.escalations.raisedAt),
          columnInWindow(w, schema.escalations.updatedAt),
        ),
      ),
    );
  return rows.map((r) => ({
    source: "escalation",
    id: r.id,
    projectId,
    ticketBeadId: r.beadId ?? null,
    raisedAt: toEpoch(r.raisedAt) ?? 0,
    resolvedAt: r.status === "resolved" ? toEpoch(r.updatedAt) ?? null : null,
  }));
}

/** Unattended picker starts in this window. */
export async function readPickerStartRows(
  db: AntonDb,
  projectId: string,
  window: TimelineWindow,
): Promise<PickerStartRow[]> {
  const w = range(window);
  const rows = await db
    .select()
    .from(schema.pickerStarts)
    .where(and(eq(schema.pickerStarts.projectId, projectId), columnInWindow(w, schema.pickerStarts.startedAt)));
  return rows.map((r) => ({
    source: "picker_start",
    id: r.id,
    projectId,
    beadId: r.beadId ?? null,
    startedAt: toEpoch(r.startedAt) ?? 0,
  }));
}

/** Operator verdicts on the picker's plan, decided in this window. */
export async function readPickerVerdictRows(
  db: AntonDb,
  projectId: string,
  window: TimelineWindow,
): Promise<PickerVerdictRow[]> {
  const w = range(window);
  const rows = await db
    .select()
    .from(schema.pickerVerdicts)
    .where(
      and(eq(schema.pickerVerdicts.projectId, projectId), columnInWindow(w, schema.pickerVerdicts.decidedAt)),
    );
  return rows.map((r) => ({
    source: "picker_verdict",
    id: r.id,
    projectId,
    beadId: r.beadId ?? null,
    verdict: r.verdict,
    decidedAt: toEpoch(r.decidedAt) ?? 0,
  }));
}

/** Autopilot disarm latches raised in this window. */
export async function readAutopilotDisarmRows(
  db: AntonDb,
  projectId: string,
  window: TimelineWindow,
): Promise<AutopilotDisarmRow[]> {
  const w = range(window);
  const rows = await db
    .select()
    .from(schema.autopilotDisarms)
    .where(
      and(eq(schema.autopilotDisarms.projectId, projectId), columnInWindow(w, schema.autopilotDisarms.disarmedAt)),
    );
  return rows.map((r) => ({
    source: "autopilot_disarm",
    id: r.id,
    projectId,
    disarmedAt: toEpoch(r.disarmedAt) ?? 0,
  }));
}

/** Nightly-stringer scan summaries generated in this window. */
export async function readScanSummaryRows(
  db: AntonDb,
  projectId: string,
  window: TimelineWindow,
): Promise<ScanSummaryRow[]> {
  const w = range(window);
  const rows = await db
    .select()
    .from(schema.scanSummaries)
    .where(
      and(eq(schema.scanSummaries.projectId, projectId), columnInWindow(w, schema.scanSummaries.generatedAt)),
    );
  return rows.map((r) => ({
    source: "scan_summary",
    id: r.id,
    projectId,
    generatedAt: toEpoch(r.generatedAt) ?? 0,
  }));
}

// ---- bd-snapshot readers ---------------------------------------------------
// Pure over `board`, the caller's own bd snapshot — no bd spawn of either reader's own.

/**
 * Which ticket a gardener proposal concerns, when its plan names exactly one subject. A cluster
 * move can name several; `ProposalRow.ticketBeadId` is singular (feature resolution needs one bead
 * to walk from), so a multi-subject proposal resolves to no feature rather than an arbitrary one.
 */
function proposalSubjectBeadId(bead: Bead): string | null {
  const subjects = proposalPlanOf(bead)?.subjects;
  return subjects?.length === 1 ? subjects[0] : null;
}

/**
 * How a closed proposal settled, in `ProposalRow`'s vocabulary — or undefined when it settled
 * nothing. Mirrors `gardener/track-record.ts`'s `settlementOf`, with one difference: that reader
 * excludes an unattended policy apply (it must not count anton agreeing with itself as a founder's
 * verdict), but the timeline reports what HAPPENED regardless of who decided it, so a policy apply
 * still reports `applied`. A fold reports nothing either way — it is a plain close that settled no
 * ask (see `isFoldReason`).
 */
function proposalOutcomeOf(bead: Bead): "applied" | "refused" | undefined {
  if (beads.isAbandoned(bead)) return "refused";
  if (isFoldReason(bead.close_reason)) return undefined;
  return "applied";
}

/** Proposals filed, applied, or refused in this window, off the caller's own board snapshot. */
export function readProposalRows(
  board: readonly Bead[],
  projectId: string,
  window: TimelineWindow,
): ProposalRow[] {
  const rows: ProposalRow[] = [];
  for (const bead of board) {
    if (!isProposalBead(bead)) continue;
    const ticketBeadId = proposalSubjectBeadId(bead);

    const filedAt = beadEpochSeconds(bead.created_at);
    if (filedAt != null && inWindow(filedAt, window)) {
      rows.push({
        source: "proposal",
        id: `${bead.id}:filed`,
        projectId,
        ticketBeadId,
        outcome: "filed",
        at: filedAt,
      });
    }

    if (bead.status === "closed") {
      const closedAt = beadEpochSeconds(bead.closed_at);
      const outcome = closedAt != null ? proposalOutcomeOf(bead) : undefined;
      if (closedAt != null && outcome != null && inWindow(closedAt, window)) {
        rows.push({
          source: "proposal",
          id: `${bead.id}:${outcome}`,
          projectId,
          ticketBeadId,
          outcome,
          at: closedAt,
        });
      }
    }
  }
  return rows;
}

/**
 * Has `bead`'s CURRENT pr ref actually merged? Mere presence of `getPrRef(bead)` is not enough — a
 * PR closed without merging leaves the ref in place too (gate-targets.ts's `mergedOnPr`, whose
 * header spells out the measured bd behaviour this mirrors: a `gh:pr` gate closes on MERGE and on
 * nothing else, 1.1.0/1.1.2). So the proof has to be the gate, not the pointer: a `blocks` edge to a
 * CLOSED `gh:pr` gate whose `await_id` names this bead's own PR number — a bead closed manually with
 * an open or superseded merge-wait gate reports no `pr.merged` event here, same as gate-targets.ts
 * would refuse to finalize it.
 */
function prActuallyMerged(bead: Bead, byId: ReadonlyMap<string, Bead>): boolean {
  const prNumber = prNumberFromRef(beads.getPrRef(bead));
  if (prNumber === undefined) return false;
  return (bead.dependencies ?? []).some((d) => {
    const gate = d.type === "blocks" ? byId.get(d.depends_on_id) : undefined;
    return gate?.status === "closed" && beads.isMergeWaitGate(gate) && gate.await_id === String(prNumber);
  });
}

/**
 * Beads closed in this window, and — among them — the ones that shipped behind a PR, off the
 * caller's own board snapshot. One pass, since both facts come off the same `closed_at` test.
 *
 * Excludes proposals (their closure is `proposal.applied`/`proposal.refused`, read above — a
 * double report of the one close would misrepresent one decision as two events) and pipeline
 * artifacts (`isPipelineArtifact`: a poured molecule or gate coordinates work without being work,
 * same exclusion `board.ts` and `operator-queue.ts` apply).
 */
export function readBeadBoardRows(
  board: readonly Bead[],
  projectId: string,
  window: TimelineWindow,
): { closed: BeadClosedRow[]; merged: PrMergedRow[] } {
  const closed: BeadClosedRow[] = [];
  const merged: PrMergedRow[] = [];
  const byId = new Map(board.map((b) => [b.id, b] as const));

  for (const bead of board) {
    if (bead.status !== "closed") continue;
    if (isProposalBead(bead) || isPipelineArtifact(bead)) continue;
    const closedAt = beadEpochSeconds(bead.closed_at);
    if (closedAt == null || !inWindow(closedAt, window)) continue;

    closed.push({
      source: "bead_closed",
      id: bead.id,
      projectId,
      ticketBeadId: bead.id,
      closedAt,
    });

    if (prActuallyMerged(bead, byId)) {
      merged.push({
        source: "pr_merged",
        id: bead.id,
        projectId,
        ticketBeadId: bead.id,
        mergedAt: closedAt,
      });
    }
  }

  return { closed, merged };
}
