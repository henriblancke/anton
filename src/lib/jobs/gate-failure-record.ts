/**
 * The last red verify gate, as the RUN ROW carries it (anton-vynb8) — the record's shape, the rule
 * that caps it, and the codec that gets it in and out of `runs.last_gate_failure`.
 *
 * Why a record at all: a retry is a fresh walk over the same run row, and the resume that reopens a
 * parked row clears `error`, `reviewScore` and `attemptStartedAt` so the new attempt is judged on its
 * own. That clear is what makes this necessary — a gate failure is the one thing the next attempt
 * needs to INHERIT, and the row is the only place it can survive to reach it.
 *
 * Built from the typed {@link VerifyGateFailedError} rather than by re-parsing the run's error
 * sentence: the outcome the gate already computed carries every field, and a message is prose that
 * an operator-facing reword would silently break.
 */
import { isVerifyGateFailedError } from "./errors";
import { MAX_GATE_OUTPUT_CHARS, tailLines } from "./gate-output";

/**
 * A red gate as the row remembers it: which gate, what it ran, how it exited, what it printed — and
 * WHERE it went red, which is what makes it actionable on a re-attempt.
 *
 * The first four fields are deliberately the ones `ticketPrompt`'s own recorded-failure block reads
 * (anton-ahsja), so what is stored is exactly what can be shown.
 */
export interface RecordedGateFailure {
  label: string;
  command: string;
  code: number | null;
  output: string;
  /** The bead the gate ran under: a ticket in a ticket-phase verify, else the run target. */
  beadId: string;
  /** The formula step that ran it, when the gate ran as one rather than by a direct call. */
  stepId?: string;
}

/**
 * Encode a gate failure for the run row, capped and TAILED at {@link MAX_GATE_OUTPUT_CHARS} — the
 * same bound and the same direction the reviewer's own gate evidence gets. Tailed, not headed,
 * because a runner prints its progress dots first and its failures and totals last: keeping the head
 * of a suite log keeps the part that says nothing.
 *
 * Returns undefined when the error is not a gate failure, so a caller can hand it any settle error.
 */
export function encodeGateFailure(
  e: unknown,
  fallback: { beadId: string },
): string | undefined {
  if (!isVerifyGateFailedError(e)) return undefined;
  const { label, command, code, output } = e.outcome;
  const record: RecordedGateFailure = {
    label,
    command,
    code,
    output: tailLines(output, MAX_GATE_OUTPUT_CHARS),
    beadId: e.site?.beadId ?? fallback.beadId,
    ...(e.site?.stepId ? { stepId: e.site.stepId } : {}),
  };
  return JSON.stringify(record);
}

/**
 * Read a record back off the row, or undefined when there is none.
 *
 * Defensive on every field: the column is free-form text a hand-edited db or an older anton could
 * have put anything in, and a re-attempt that CRASHES on its predecessor's record is strictly worse
 * than one that starts without it. An unreadable record therefore reads exactly like an absent one.
 */
export function decodeGateFailure(raw: string | null | undefined): RecordedGateFailure | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { label, command, code, output, beadId, stepId } = parsed as Record<string, unknown>;
  if (typeof label !== "string" || typeof command !== "string") return undefined;
  if (typeof output !== "string" || typeof beadId !== "string") return undefined;
  return {
    label,
    command,
    code: typeof code === "number" ? code : null,
    output,
    beadId,
    ...(typeof stepId === "string" ? { stepId } : {}),
  };
}
