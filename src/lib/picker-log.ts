/**
 * THE DECISION LOG (anton-vfvg / R3.10): the picker's unattended starts and the operator's vetoes,
 * merged into one time-ordered record for the Health page's applied section.
 *
 * Two stores, one question. `picker-starts.ts` holds what anton began on its own; `picker-veto.ts`
 * holds what the operator refused. An operator asking "what has been happening here without me"
 * needs both in one place and in one order — a page with a starts list beside a vetoes list makes
 * them do the interleaving in their head, and the interesting reading is precisely where the two
 * alternate.
 *
 * ACCEPTS are deliberately left out. A `[Release]` is the operator starting a pick themselves, which
 * is neither something anton did unattended nor a disagreement with it; folding it in would make the
 * one surface that reports unwatched decisions also report watched ones, and the count of "what
 * happened while I was away" would stop meaning anything. The accept still lives in the track record
 * earned autonomy reads (`pickerTrackRecord`), which is the question it answers.
 *
 * Pure — types only across the two stores, no database, no React — so the page assembles it server
 * side and the component renders it without either owning the merge.
 */
import type { PickerStartRow } from "./picker-starts";
import type { PickerVerdictRow } from "./picker-veto";

/**
 * What one entry records.
 *
 *   • `start`    — anton approved, claimed and enqueued this target under the standing policy.
 *   • `deferral` — `✕ not now`: the operator set this pick aside for a bounded window. Pacing.
 *   • `veto`     — `Never`: the same decline, plus the criterion they were sent to tighten. Judgment
 *                  about the RULE, which is why it is drawn apart from the deferral beside it.
 */
export type PickerLogKind = "start" | "deferral" | "veto";

export interface PickerLogEntry {
  /** Stable across renders for the same recorded decision — the list's React key. */
  key: string;
  kind: PickerLogKind;
  beadId: string;
  /** When it was decided (epoch ms). */
  atMs: number;
  /** The admitting rule, as the plan recorded it — what the entry's policy link opens. */
  rule?: string;
  /** The criterion a `Never` named, so its link opens the editor at the control, not the panel. */
  criterion?: string;
  /** Where the target stood in the plan behind the decision, and how many that plan ranked. */
  rank?: number;
  ranked?: number;
  /** When a veto's hold runs out (epoch ms) — the answer to "how long did I set this aside for". */
  heldUntilMs?: number;
}

/**
 * How many entries the log shows. Enough that a day of a ten-minute cadence reads as a sequence
 * rather than a snapshot, few enough that the section stays a summary — the page's other sections
 * fold at roughly this size too.
 */
export const PICKER_LOG_LIMIT = 12;

/** `never` is the only veto that names a rule to tighten; `not-now` is pacing and names none. */
function kindOf(verdict: PickerVerdictRow): PickerLogKind {
  return verdict.action === "never" ? "veto" : "deferral";
}

/**
 * Merge the two records into the newest-first log.
 *
 * Ordered by decision time, with a deterministic tie-break on kind then bead: a start and the veto
 * that answered it can land in the same second (both timestamps are second-resolution), and a log
 * whose order depended on which store was read first would re-order itself between renders.
 */
export function pickerLogEntries(input: {
  starts: readonly PickerStartRow[];
  verdicts: readonly PickerVerdictRow[];
  limit?: number;
}): PickerLogEntry[] {
  const entries: PickerLogEntry[] = [
    ...input.starts.map((start) => ({
      key: `start:${start.beadId}:${start.startedAtMs}`,
      kind: "start" as const,
      beadId: start.beadId,
      atMs: start.startedAtMs,
      rule: start.rule,
      rank: start.rank,
      ranked: start.ranked,
    })),
    // Only the declines: an accept is the operator's own start — see the module note.
    ...input.verdicts
      .filter((verdict) => verdict.verdict === "declined")
      .map((verdict) => ({
        key: `${kindOf(verdict)}:${verdict.beadId}:${verdict.decidedAtMs}`,
        kind: kindOf(verdict),
        beadId: verdict.beadId,
        atMs: verdict.decidedAtMs,
        ...(verdict.rule ? { rule: verdict.rule } : {}),
        ...(verdict.criterion ? { criterion: verdict.criterion } : {}),
        ...(typeof verdict.rank === "number" ? { rank: verdict.rank } : {}),
        ...(verdict.deferredUntilMs ? { heldUntilMs: verdict.deferredUntilMs } : {}),
      })),
  ];
  entries.sort(
    (a, b) => b.atMs - a.atMs || a.kind.localeCompare(b.kind) || a.beadId.localeCompare(b.beadId),
  );
  return entries.slice(0, input.limit ?? PICKER_LOG_LIMIT);
}
