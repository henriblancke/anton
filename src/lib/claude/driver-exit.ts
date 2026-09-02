/**
 * How a finished `claude` process is classified (anton-kvag): one pure decision over the exit code,
 * the stream state, and stderr — park on a quota, resume in-place on a transient death, fail loud
 * on a deterministic one, or hand back the result. Kept apart from the spawn/stream plumbing in
 * driver.ts because the ORDER of these checks is the contract the runner's durability logic is
 * built on, and it is only reviewable when it reads top to bottom in one place.
 */
import { RecoverableClaudeError, UsageLimitError } from "../jobs/errors";
import type { StreamState } from "./driver-events";
import { usageLimitError, type ClaudeChannels } from "./driver-limits";

export interface ClaudeResult {
  ok: boolean;
  /** claude session id (for resume / diagnostics), when present. */
  sessionId?: string;
  numTurns?: number;
  costUsd?: number;
  /** Final assistant/result text — the `result` field when present, else the last assistant text block. */
  text?: string;
  /** True if claude reported an error result subtype. */
  isError?: boolean;
}

/** Everything known about a claude process that has ended — the whole input to the classification. */
export interface ClaudeExit {
  /** Process exit code; null when the child died on a signal. */
  code: number | null;
  /** True when the stall watchdog killed the child for producing no output. */
  stalled: boolean;
  /** The stall window that was in force, for the message. */
  stallMs: number;
  /** Everything claude wrote to stderr. */
  stderr: string;
  /** What the stream-json stream left behind. */
  stream: StreamState;
}

/**
 * Broad transient/recoverable phrasing Claude Code emits on its OWN stderr when a run dies mid-stream
 * from network or upstream trouble (anton-juar). A match makes the failure resume-eligible: the runner
 * retries with `claude --resume <id>` (continue in-session) instead of re-running the ticket from
 * scratch. Includes bare HTTP status codes and generic upstream-error prose ("internal server error",
 * "503") — safe here because stderr is a machine channel, but NOT against the model-authored result
 * text (see `TRANSIENT_RESULT_RE`). Precision isn't load-bearing — a resume is bounded and always
 * falls back to a fresh spawn — so this errs toward recognizing recoverable causes.
 */
const TRANSIENT_STDERR_RE =
  /(connection (?:closed|reset|error|aborted)|closed mid-?response|econnreset|epipe|etimedout|socket hang ?up|network (?:error|is unreachable)|premature close|stream (?:closed|error|interrupted|truncat)|unexpected end of|overloaded|\b(?:429|500|502|503|504|529)\b|internal server error|bad gateway|service unavailable|gateway time-?out)/i;

/**
 * The subset of transient phrasing safe to match against the MODEL-AUTHORED result text. On an
 * agent-reported failure the `result` field is the agent's own summary, so bare status codes and
 * generic upstream-error prose are deliberately excluded: a summary that merely says "the local
 * endpoint returned 500" must surface as a real failure, not be misread as a transient death and
 * resumed with an "interrupted" prompt (anton-juar). Only socket/stream-level diagnostics a model
 * won't casually type in prose remain — enough to still catch Claude Code's own error results like
 * "Connection closed mid-response".
 */
const TRANSIENT_RESULT_RE =
  /(connection (?:closed|reset|aborted)|closed mid-?response|econnreset|epipe|etimedout|socket hang ?up|premature close|stream (?:closed|error|interrupted|truncat)|unexpected end of)/i;

/**
 * Coarsely categorize a transient failure so the runner can refuse to resume twice on the SAME
 * signature (a resume that dies the same way escalates to a fresh restart). stderr (Claude Code's own
 * channel) is scanned broadly; the model-authored result text only against socket/stream-level
 * wording. Returns null when neither channel carries a recoverable signal. `hadResult` is false when
 * the process exited without ever emitting the final `result` event — a mid-stream death that is
 * transient on its own.
 */
export function transientSignature(
  resultText: string,
  stderrText: string,
  hadResult: boolean,
): string | null {
  const stderrMatch = stderrText.match(TRANSIENT_STDERR_RE);
  if (stderrMatch) return signatureOf(stderrMatch[1]);
  const resultMatch = resultText.match(TRANSIENT_RESULT_RE);
  if (resultMatch) return signatureOf(resultMatch[1]);
  if (!hadResult) return "exit-without-result";
  return null;
}

function signatureOf(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "-");
}

/** The final result text, or "" when the run emitted no result event (or a non-string one). */
function resultTextOf(exit: ClaudeExit): string {
  const raw = exit.stream.resultRaw;
  return typeof raw?.result === "string" ? raw.result : "";
}

function channelsOf(exit: ClaudeExit): ClaudeChannels {
  return { transcript: exit.stream.transcript, resultText: resultTextOf(exit), stderr: exit.stderr };
}

/**
 * The session id for `--resume`: the final result carries it on a clean exit, but a mid-stream
 * death may never emit that event, so fall back to the id captured from the `system` init event
 * (anton-juar).
 */
function sessionIdOf(exit: ClaudeExit): string | undefined {
  const raw = exit.stream.resultRaw;
  return (typeof raw?.session_id === "string" ? raw.session_id : undefined) ?? exit.stream.initSessionId;
}

/**
 * A watchdog kill (anton-0oi) is resume-eligible: the session may have real work banked before it
 * wedged, and the caller refuses to resume twice on the same signature, so a re-stall escalates to
 * a fresh run rather than looping. `initSessionId` is captured at session start, so it is available
 * even though no result event ever arrived.
 */
function stallError(exit: ClaudeExit): RecoverableClaudeError | null {
  if (!exit.stalled) return null;
  return new RecoverableClaudeError(
    `claude produced no output for ${Math.round(exit.stallMs / 60_000)}m — killed as stalled`,
    { sessionId: exit.stream.initSessionId, signature: "stalled" },
  );
}

/**
 * Only a run that did NOT cleanly succeed can be a quota hit. Gating the scan on non-success is
 * what keeps a healthy run whose assistant output merely *mentions* a usage limit from being
 * reclassified and rescheduled forever; every real quota abort carries is_error / a non-zero exit,
 * so nothing legitimate is lost (anton-ner.2).
 */
function quotaError(exit: ClaudeExit): UsageLimitError | null {
  const raw = exit.stream.resultRaw;
  const succeeded = exit.code === 0 && raw !== undefined && !raw.is_error;
  return succeeded ? null : usageLimitError(channelsOf(exit));
}

/**
 * A non-zero exit is resume-eligible only when it looks transient — a network/upstream drop in
 * Claude Code's own channels (broadly in stderr, narrowly in the model-authored result text), or a
 * death before the final result event. A deterministic non-zero exit (the agent errored, a real
 * content failure) has a result event and no transient signal, so it stays a plain Error → today's
 * fresh retry.
 */
function exitCodeError(exit: ClaudeExit, sessionId: string | undefined): Error {
  const resultText = resultTextOf(exit);
  // Prefer the agent's own result summary over stderr for the surfaced message — on a deterministic
  // failure that's where the real reason lives (anton-juar).
  const detail = resultText.trim() || exit.stderr.trim() || `claude exited with code ${exit.code}`;
  const message = `claude exited with code ${exit.code}: ${detail.slice(-2000)}`;
  const signature = transientSignature(resultText, exit.stderr, exit.stream.resultRaw !== undefined);
  return signature
    ? new RecoverableClaudeError(message, { sessionId, signature })
    : new Error(message);
}

/**
 * The three ways a run that cleared the quota check still failed: a non-zero exit, a clean exit
 * with no result event (a truncated stream — transient, so resume-eligible), and a run that
 * reported failure via `is_error` while exiting 0. Claude Code surfaces a mid-stream drop (e.g.
 * "Connection closed mid-response") that last way, so it is classified over Claude's own channels
 * too — otherwise it would resolve `{ ok: false }` and force a fresh restart instead of an in-place
 * resume (anton-juar).
 */
function failureError(exit: ClaudeExit): Error | null {
  const sessionId = sessionIdOf(exit);
  if (exit.code !== 0) return exitCodeError(exit, sessionId);
  if (!exit.stream.resultRaw) {
    return new RecoverableClaudeError("claude exited without a result event", {
      sessionId,
      signature: "exit-without-result",
    });
  }
  if (!exit.stream.resultRaw.is_error) return null;

  const resultText = resultTextOf(exit);
  const signature = transientSignature(resultText, exit.stderr, true);
  return signature
    ? new RecoverableClaudeError(resultText || "claude reported a transient error result", {
        sessionId,
        signature,
      })
    : null;
}

/**
 * The error a finished run must reject with, or null when it produced a result the caller can
 * resolve with. Order is the contract: a stall outranks everything, a quota hit outranks the exit
 * code (it must never burn an attempt), and only then does the ordinary failure shape decide.
 */
export function exitError(exit: ClaudeExit): Error | null {
  return stallError(exit) ?? quotaError(exit) ?? failureError(exit);
}

/** Shape the run's result. Only valid once {@link exitError} returned null. */
export function toClaudeResult(stream: StreamState): ClaudeResult {
  const raw = stream.resultRaw ?? {};
  return {
    ok: !raw.is_error,
    sessionId: typeof raw.session_id === "string" ? raw.session_id : undefined,
    numTurns: typeof raw.num_turns === "number" ? raw.num_turns : undefined,
    costUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : undefined,
    // Fall back to the last assistant message when the result field is absent (a result-less
    // success, observed on `claude --resume`) so the agent's final text — and its ANTON-RESULT
    // self-report — isn't lost, which would let partial work close as a false success (anton-juar).
    text: typeof raw.result === "string" ? raw.result : stream.lastAssistantText,
    isError: !!raw.is_error,
  };
}
