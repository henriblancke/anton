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
 * Each DB reader seeks on the ONE timestamp its table is indexed by (a run's `startedAt`, an
 * attempt's `endedAt`, …) — the column every other reader of that table already treats as "when
 * this row happened". A row can still fold into an event whose `at` falls outside `[since, until]`
 * (a run's `prOpenedAt`, an escalation's `resolvedAt`) when the OTHER half of its lifecycle moved
 * outside the queried window; that is an accepted v1 simplification (ADR-0001 scopes this feature
 * as a read-side fold over existing data, nothing new to meter) rather than a second index per
 * table. A caller that needs every event's `at` to land inside the window strictly should filter
 * `foldTimeline`'s output after folding, the same as it would for any overfetch.
 *
 * The bd-derived readers have no such gap: they test every event they can see (`filed`/`applied`/
 * `refused`, `closedAt`, `mergedAt`) against the window directly, in memory, since the whole board
 * is already on hand.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";

import { beads, type Bead } from "./beads/bd";
import { isPipelineArtifact } from "./beads/contract";
import * as schema from "./db/schema";
import { toEpoch } from "./db/epoch";
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

/** The window every reader is asked for, epoch SECONDS, both ends inclusive. */
export interface TimelineWindow {
  since: number;
  until: number;
}

function range(window: TimelineWindow): { gte: Date; lte: Date } {
  return { gte: new Date(window.since * 1000), lte: new Date(window.until * 1000) };
}

function inWindow(at: number, window: TimelineWindow): boolean {
  return at >= window.since && at <= window.until;
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
        gte(schema.runs.startedAt, w.gte),
        lte(schema.runs.startedAt, w.lte),
      ),
    );

  const ticketById = new Map(board.map((b) => [b.id, b] as const));

  const out: RunRow[] = [];
  for (const r of rows) {
    const startedAt = toEpoch(r.startedAt);
    if (startedAt == null) continue;
    const ticket = r.ticketBeadId ? ticketById.get(r.ticketBeadId) : undefined;
    const updatedAt = toEpoch(r.updatedAt);
    const hasPr = ticket != null && beads.getPrRef(ticket) !== undefined;
    const prOpenedAt = hasPr && updatedAt != null && updatedAt > startedAt ? updatedAt : null;
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
    .where(
      and(
        eq(schema.runAttempts.projectId, projectId),
        gte(schema.runAttempts.endedAt, w.gte),
        lte(schema.runAttempts.endedAt, w.lte),
      ),
    );
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

/** Escalations raised in this window. `resolvedAt` reuses `updatedAt`, the write a resolve stamps. */
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
        gte(schema.escalations.raisedAt, w.gte),
        lte(schema.escalations.raisedAt, w.lte),
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
    .where(
      and(
        eq(schema.pickerStarts.projectId, projectId),
        gte(schema.pickerStarts.startedAt, w.gte),
        lte(schema.pickerStarts.startedAt, w.lte),
      ),
    );
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
      and(
        eq(schema.pickerVerdicts.projectId, projectId),
        gte(schema.pickerVerdicts.decidedAt, w.gte),
        lte(schema.pickerVerdicts.decidedAt, w.lte),
      ),
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
      and(
        eq(schema.autopilotDisarms.projectId, projectId),
        gte(schema.autopilotDisarms.disarmedAt, w.gte),
        lte(schema.autopilotDisarms.disarmedAt, w.lte),
      ),
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
      and(
        eq(schema.scanSummaries.projectId, projectId),
        gte(schema.scanSummaries.generatedAt, w.gte),
        lte(schema.scanSummaries.generatedAt, w.lte),
      ),
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

    if (beads.getPrRef(bead) !== undefined && !beads.isAbandoned(bead)) {
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
