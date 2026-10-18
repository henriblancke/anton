/**
 * THE TIMELINE'S EVENT MODEL AND PURE FOLD (anton-uxgze): one typed shape every reader of "what
 * anton did" renders from — the digest, the headline writer, push notifications — and the merge
 * that produces it from rows anton already writes.
 *
 * Pure over rows the caller already holds, the same pure-over-snapshot pattern as
 * operator-queue.ts: this module reads no DB and spawns no `bd` of its own. Reading each source
 * (runs/run_attempts, escalations, the picker log, autopilot disarms, proposals, scan summaries,
 * and the bead-closed / PR-merged pair off the caller's bd snapshot) is anton-4ldxk's job; this
 * module only knows the shape those rows must already be in by the time they reach `foldTimeline`.
 *
 * `at` is epoch SECONDS, the convention every view model here uses (viewer-marks.ts) — the reader
 * normalizes a DB `Date`/`integer` column with `toEpoch`/`epochOrZero` (db/epoch.ts) before a row
 * ever reaches this module, so the fold itself stays Drizzle-free.
 *
 * ## Why an unmapped row throws instead of dropping or bucketing
 *
 * `run_attempts.outcome` and a proposal's outcome are plain `text` columns, not real enums — SQLite
 * enforces nothing, so a value outside the vocabulary this module knows is a live possibility, not a
 * hypothetical. feature-ledger.ts buckets a row it cannot classify as `unattributed` because money
 * must still total correctly with a hole in it; a timeline has no such bucket — an event with no
 * kind cannot be rendered, and silently dropping it would misrepresent "what anton did" as "what
 * anton did, minus whatever snuck past the mapper". Throwing surfaces the gap to whoever wired a new
 * status in, immediately, which is what "an unmapped source row fails a test" below exercises.
 */
import type { Bead } from "./beads/bd";
import { boardCards } from "./ticket-view";

// ---- Event shape --------------------------------------------------------

export type TimelineEventKind =
  | "run.started"
  | "run.pr_opened"
  | "run.parked"
  | "run.finished"
  | "run.failed"
  | "escalation.raised"
  | "escalation.resolved"
  | "picker.started"
  | "picker.verdict"
  | "autopilot.disarmed"
  | "proposal.filed"
  | "proposal.applied"
  | "proposal.refused"
  | "scan.summary"
  | "bead.closed"
  | "pr.merged";

/** One fact on the timeline. `featureId` is the ticket's card (boardCards.cardOf), or null when
 * the event has no ticket to resolve one from, or the ticket rides on no card at all. */
export interface TimelineEvent {
  /** Epoch seconds. */
  at: number;
  projectId: string;
  featureId: string | null;
  kind: TimelineEventKind;
  /** Kind-specific detail — small and already-serializable, never a hydrated row. */
  data: Readonly<Record<string, unknown>>;
  /** The id(s) of the row(s) this event was folded from, for a reader that wants to trace it back. */
  sourceRefs: readonly string[];
}

// ---- Source rows ---------------------------------------------------------
// Every status/outcome field below is `string`, matching the plain-text columns these rows are
// read from (see the header) — the Record maps further down narrow it, and throw when they can't.

export interface RunRow {
  source: "run";
  id: string;
  projectId: string;
  ticketBeadId: string | null;
  startedAt: number;
  /** Null until (if ever) this run's ticket bead picked up a PR link. */
  prOpenedAt: number | null;
}

export interface RunAttemptRow {
  source: "run_attempt";
  id: string;
  projectId: string;
  ticketBeadId: string | null;
  /** `run_attempts.outcome`: null while the attempt is still running — not an event yet. */
  outcome: string | null;
  /** `run_attempts.ended_at`. Null exactly when `outcome` is. */
  endedAt: number | null;
}

export interface EscalationRow {
  source: "escalation";
  id: string;
  projectId: string;
  ticketBeadId: string | null;
  raisedAt: number;
  /** Null while the escalation is still open. */
  resolvedAt: number | null;
}

export interface PickerStartRow {
  source: "picker_start";
  id: string;
  projectId: string;
  beadId: string | null;
  startedAt: number;
}

export interface PickerVerdictRow {
  source: "picker_verdict";
  id: string;
  projectId: string;
  beadId: string | null;
  /** `picker_verdicts.verdict`: "accepted" | "declined". */
  verdict: string;
  decidedAt: number;
}

export interface AutopilotDisarmRow {
  source: "autopilot_disarm";
  id: string;
  projectId: string;
  disarmedAt: number;
}

export interface ProposalRow {
  source: "proposal";
  id: string;
  projectId: string;
  /** The ticket this proposal concerns, when it concerns one. */
  ticketBeadId: string | null;
  /** The proposal's lifecycle word: "filed" | "applied" | "refused". */
  outcome: string;
  at: number;
}

export interface ScanSummaryRow {
  source: "scan_summary";
  id: string;
  projectId: string;
  generatedAt: number;
}

export interface BeadClosedRow {
  source: "bead_closed";
  id: string;
  projectId: string;
  ticketBeadId: string | null;
  closedAt: number;
}

export interface PrMergedRow {
  source: "pr_merged";
  id: string;
  projectId: string;
  ticketBeadId: string | null;
  mergedAt: number;
}

export type TimelineSourceRow =
  | RunRow
  | RunAttemptRow
  | EscalationRow
  | PickerStartRow
  | PickerVerdictRow
  | AutopilotDisarmRow
  | ProposalRow
  | ScanSummaryRow
  | BeadClosedRow
  | PrMergedRow;

// ---- Exhaustive status → kind maps ---------------------------------------
// Same shape as feature-ledger.ts's JOB_TYPE_PHASES / HANDLER_PHASES and operator-queue.ts's
// predicates: a Record over the known literal union, so a new status fails typecheck here until it
// declares a kind. The lookup below is what also catches a value TypeScript never sees — real DB
// text drifting outside the union it was supposed to hold.

type AttemptOutcome = "parked" | "done" | "failed";

const ATTEMPT_OUTCOME_KIND: Readonly<Record<AttemptOutcome, TimelineEventKind>> = Object.freeze({
  parked: "run.parked",
  done: "run.finished",
  failed: "run.failed",
});

type ProposalOutcome = "filed" | "applied" | "refused";

const PROPOSAL_OUTCOME_KIND: Readonly<Record<ProposalOutcome, TimelineEventKind>> = Object.freeze({
  filed: "proposal.filed",
  applied: "proposal.applied",
  refused: "proposal.refused",
});

function lookupKind(
  map: Readonly<Record<string, TimelineEventKind>>,
  value: string,
  sourceLabel: string,
): TimelineEventKind {
  const kind = map[value];
  if (!kind) {
    throw new Error(`timeline: unmapped ${sourceLabel} "${value}"`);
  }
  return kind;
}

// ---- The fold --------------------------------------------------------------

/** Resolves a ticket bead id to the feature (card) it rides on, or null when there is none. */
function makeFeatureResolver(board: readonly Bead[]): (ticketBeadId: string | null) => string | null {
  const cards = boardCards(board as Bead[]);
  const byId = new Map(board.map((b) => [b.id, b]));
  return (ticketBeadId) => {
    if (!ticketBeadId) return null;
    const bead = byId.get(ticketBeadId);
    if (!bead) return null;
    return cards.cardOf(bead) ?? null;
  };
}

function event(
  row: { projectId: string },
  kind: TimelineEventKind,
  at: number,
  featureId: string | null,
  data: Record<string, unknown>,
  sourceRefs: readonly string[],
): TimelineEvent {
  return { at, projectId: row.projectId, featureId, kind, data, sourceRefs };
}

function mapRow(
  row: TimelineSourceRow,
  featureOf: (ticketBeadId: string | null) => string | null,
): TimelineEvent[] {
  switch (row.source) {
    case "run": {
      const events = [
        event(row, "run.started", row.startedAt, featureOf(row.ticketBeadId), {}, [row.id]),
      ];
      if (row.prOpenedAt != null) {
        events.push(
          event(row, "run.pr_opened", row.prOpenedAt, featureOf(row.ticketBeadId), {}, [row.id]),
        );
      }
      return events;
    }
    case "run_attempt": {
      if (row.outcome == null || row.endedAt == null) return [];
      const kind = lookupKind(ATTEMPT_OUTCOME_KIND, row.outcome, "run_attempt outcome");
      return [
        event(row, kind, row.endedAt, featureOf(row.ticketBeadId), { outcome: row.outcome }, [
          row.id,
        ]),
      ];
    }
    case "escalation": {
      const events = [
        event(row, "escalation.raised", row.raisedAt, featureOf(row.ticketBeadId), {}, [row.id]),
      ];
      if (row.resolvedAt != null) {
        events.push(
          event(row, "escalation.resolved", row.resolvedAt, featureOf(row.ticketBeadId), {}, [
            row.id,
          ]),
        );
      }
      return events;
    }
    case "picker_start":
      return [event(row, "picker.started", row.startedAt, featureOf(row.beadId), {}, [row.id])];
    case "picker_verdict":
      return [
        event(row, "picker.verdict", row.decidedAt, featureOf(row.beadId), { verdict: row.verdict }, [
          row.id,
        ]),
      ];
    case "autopilot_disarm":
      return [event(row, "autopilot.disarmed", row.disarmedAt, null, {}, [row.id])];
    case "proposal": {
      const kind = lookupKind(PROPOSAL_OUTCOME_KIND, row.outcome, "proposal outcome");
      return [event(row, kind, row.at, featureOf(row.ticketBeadId), {}, [row.id])];
    }
    case "scan_summary":
      return [event(row, "scan.summary", row.generatedAt, null, {}, [row.id])];
    case "bead_closed":
      return [event(row, "bead.closed", row.closedAt, featureOf(row.ticketBeadId), {}, [row.id])];
    case "pr_merged":
      return [event(row, "pr.merged", row.mergedAt, featureOf(row.ticketBeadId), {}, [row.id])];
    default: {
      // Exhaustiveness: a new source added to the union above fails here at compile time, and a
      // row arriving at runtime with a `source` none of the cases above claim fails loud rather
      // than vanishing silently (see the header for why this module throws instead of bucketing).
      const unmapped: never = row;
      throw new Error(`timeline: unmapped source row ${JSON.stringify(unmapped)}`);
    }
  }
}

/**
 * The timeline's only real logic: map every row to its event(s), resolve each one's feature off
 * `board` (the caller's own bd snapshot — no spawn of its own here), and sort by time.
 *
 * `Array.prototype.sort` is stable (guaranteed since ES2019, and true of every engine anton runs
 * on), so two events at the exact same `at` keep the relative order they arrived in `rows` — the
 * fold never reorders a tie, it just never bothers to break one.
 */
export function foldTimeline(rows: readonly TimelineSourceRow[], board: readonly Bead[]): TimelineEvent[] {
  const featureOf = makeFeatureResolver(board);
  const events = rows.flatMap((row) => mapRow(row, featureOf));
  return events.sort((a, b) => a.at - b.at);
}
