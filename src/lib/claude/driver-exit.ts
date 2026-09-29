/**
 * How a finished `claude` process is classified (anton-kvag): one pure decision over the exit code,
 * the stream state, and stderr — park on a quota, resume in-place on a transient death, fail loud
 * on a deterministic one, or hand back the result. Kept apart from the spawn/stream plumbing in
 * driver.ts because the ORDER of these checks is the contract the runner's durability logic is
 * built on, and it is only reviewable when it reads top to bottom in one place.
 */
import { PoisonError, RecoverableClaudeError, UsageLimitError } from "../jobs/errors";
import type { StreamState } from "./driver-events";
import { usageLimitError, type ClaudeChannels } from "./driver-limits";
import { parseModelUsage, type ModelUsageEntry } from "./model-usage";

export interface ClaudeResult {
  ok: boolean;
  /** claude session id (for resume / diagnostics), when present. */
  sessionId?: string;
  numTurns?: number;
  costUsd?: number;
  /**
   * The per-model token counts the result event reported (anton-77l9), one entry per model it named.
   * CUMULATIVE for the session, so it is the latest result's map — never a sum across results (see
   * {@link parseModelUsage}). Empty when the field was absent, `{}`, or unreadable: that is an
   * invocation with unknown usage, which is still recorded rather than dropped.
   */
  modelUsage: ModelUsageEntry[];
  /** Wall-clock ms the result event reported for the invocation, when it reported one. */
  durationMs?: number;
  /** Ms of that spent in API calls, when reported — the rest is tool and hook time. */
  durationApiMs?: number;
  /** Final assistant/result text — the `result` field when present, else the last assistant text block. */
  text?: string;
  /**
   * The model that authored {@link text} (anton-528bw) — read off the same assistant message's own
   * `model` field, never guessed from `modelUsage`'s key order, which lists every model the session
   * touched (sidecars included) with no guarantee the answering model comes first.
   */
  answeringModel?: string;
  /** True if claude reported an error result subtype. */
  isError?: boolean;
  /**
   * Yield-shaped tools the session's LAST assistant message armed (anton-wjfkn) — a `ScheduleWakeup`,
   * a `Monitor`, or a `run_in_background` call, by name.
   *
   * A clean exit carrying one of these is not a finished ticket: the agent handed its turn back to a
   * wake-up that an autonomous run never delivers, so whatever it was in the middle of is unfinished
   * and whatever it set aside to measure a baseline is still set aside. The callers that read one
   * final message and settle the ticket on it use this to tell that stop from a real finish
   * (`step:implement`'s report, and the delivery gate through it). Empty for every ordinary session.
   */
  pendingYields?: string[];
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
 * Claude Code's own `API Error: <status> ...` diagnostic prefix (driver-limits.ts observes it
 * verbatim for both the gateway-billing and rate-limit envelopes) — a shape a model narrating its
 * own failure would not organically type, unlike the generic prose `TRANSIENT_STDERR_RE` also
 * matches ("internal server error", a bare "500", "overloaded", …). `isRecoverableClaudeText`'s
 * legacy fallback trusts only this narrower shape, and only when it OPENS the surfaced detail
 * (never a quoted occurrence deeper in the string): the merged `claude exited with code N: <detail>`
 * envelope's `detail` can be the model's own freeform result text, and a deterministic failure that
 * merely narrates or quotes "API Error: 503" mid-sentence (e.g. describing a test fixture) must not
 * be misread as Claude Code's own diagnostic (review finding on PR #339).
 */
const TRANSIENT_STDERR_ENVELOPE_RE = /^API Error:\s*\d{3}\b/i;

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

/**
 * True when `message` is text this file constructs for a `RecoverableClaudeError` — a transient
 * driver-level death (a truncated stream, a stalled session, or a network/upstream drop), never a
 * deterministic agent-authored failure. `failure-cause.ts` needs this: once an in-session resume
 * exhausts (or never gets attempted), `settleRunRow` stores the error's `.message` as plain text, so
 * classifying a settled run's cause has nothing but that string to go on — and a deterministic
 * `claude exited with code N: <the agent's own report>` shares the exact same envelope as the
 * transient `exitCodeError` case above.
 *
 * `code` is nullable (a signal kill leaves `null`, per `ClaudeExit.code` and `driver.ts`'s `close`
 * handler), so the exit-code envelope this matches is `claude exited with code (?:\d+|null): ` —
 * a digit-only guard would silently reject every signal-kill message, including ones carrying the
 * anchored transient tag below (anton-r0tb follow-up).
 *
 * The exit-code envelope's surfaced detail prefers the agent's own result summary over stderr
 * (`exitCodeError`), so a signature matched solely in stderr (e.g. a 503) can leave the rendered
 * message with no transient wording in `detail` at all. Both `exitCodeError` and `failureError`'s
 * `is_error`+transient branch append a stable `(transient: <signature>)` tag whenever they actually
 * build a `RecoverableClaudeError`, precisely so this function never has to reconstruct that fact
 * from prose that may not carry it — that anchored suffix is the PRIMARY signal this checks for the
 * exit-code envelope.
 *
 * The one exception is a `runs.error` row written before that tag existed, which carries no suffix
 * at all — for those this falls back to the two narrower signals below, never the broad
 * `TRANSIENT_STDERR_RE`: `detail` can be the agent's own freeform report (see `TRANSIENT_RESULT_RE`'s
 * doc on why that channel is scanned narrowly), so a bare status code or generic server-error phrase
 * the agent merely typed in prose (e.g. "the local endpoint returned 500") would otherwise match the
 * broad regex and misclassify a genuine deterministic failure as transient — exactly the collision
 * `transientSignature` was already narrowed to avoid.
 *   - `TRANSIENT_RESULT_RE` — the same socket/stream-level wording already vetted safe against
 *     model-authored text, since `detail` may in fact be the model's own result summary.
 *   - `TRANSIENT_STDERR_ENVELOPE_RE` — Claude Code's own `API Error: <status>` diagnostic prefix,
 *     not wording a model would organically type while narrating a failure, so it stays safe to
 *     trust — but only when it opens the surfaced `detail`, never a quoted occurrence deeper in
 *     the agent's own prose (review finding on PR #339): checked against `detail` alone, not the
 *     merged message, so an anchored `^` actually means "starts the detail."
 */
export function isRecoverableClaudeText(message: string): boolean {
  if (/^claude exited without a result event\b/.test(message)) return true;
  if (/^claude produced no output for .*killed as stalled\b/i.test(message)) return true;
  if (/^claude reported a transient error result\b/i.test(message)) return true;
  const prefixMatch = message.match(/^claude exited with code (?:\d+|null): /);
  if (!prefixMatch) return false;
  const detail = message.slice(prefixMatch[0].length);
  return (
    /\(transient: [^)]+\)$/.test(message) ||
    TRANSIENT_RESULT_RE.test(message) ||
    TRANSIENT_STDERR_ENVELOPE_RE.test(detail)
  );
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
 * Claude Code's own refusal when `--model` names something that doesn't exist OR that the current
 * account/credential isn't entitled to use — a typo'd/withdrawn id, or a valid id the configured
 * account or gateway credential lacks access to (anton-ggf6). Observed verbatim in anton.db:
 * "There's an issue with the selected model (claude-opus-4-8). It may not exist or you may not
 * have access to it. Run --model to pick a different model." Claude Code emits the identical
 * diagnostic for both causes, and nothing here can tell which one fired, so the park must name
 * both remedies rather than assuming the id itself is wrong. No retry fixes either case, so a
 * match here must park instead of burning the job's whole retry budget the way a plain
 * deterministic Error would.
 */
const MODEL_REFUSAL_RE =
  /there's an issue with the selected model \(([^)]+)\)\.\s*it may not exist or you may not have access to it/i;

/**
 * The park a model-id refusal deserves, or null when `stderr` isn't one. Checked ONLY against
 * Claude Code's own stderr, never the model-authored result text: a failed session whose result
 * quotes this diagnostic (e.g. while testing or documenting this exact error) would otherwise park
 * immediately even though the configured model demonstrably ran — that failure belongs on the
 * ordinary retry path, not here (anton-r0tb).
 *
 * The rejected id can come from any of the three places `resolveModel` (model-routing.ts) and
 * `buildClaudeArgs` (driver-spawn.ts) leave it: a matching row in this project's Model routing
 * table, the General default `settings.model` when nothing matched, or — when neither is set —
 * `--model` is omitted entirely and Claude Code falls back to its OWN default configuration,
 * outside this project's settings altogether. Nothing here knows which one actually fired, so the
 * message names all three rather than sending the operator to edit a routing rule that was never
 * in play, which would leave a bad default active for every unmatched job and the park unresolved.
 */
function modelRefusalError(stderr: string): PoisonError | null {
  const modelId = stderr.match(MODEL_REFUSAL_RE)?.[1]?.trim();
  if (!modelId) return null;
  return new PoisonError(
    `claude refused to start: the model "${modelId}" doesn't exist, or the configured account ` +
      `or gateway credential doesn't have access to it. Configured in this project's settings as ` +
      `the General default model or a matching Model routing rule (settings_json.modelRoutes) — ` +
      `or, if neither is set, inherited from Claude Code's own default configuration outside this ` +
      `project. Fix the id there if it's wrong, or grant that account/credential access to the ` +
      `model if the id is correct — retrying alone will not resolve either case.`,
  );
}

/**
 * A non-zero exit is resume-eligible only when it looks transient — a network/upstream drop in
 * Claude Code's own channels (broadly in stderr, narrowly in the model-authored result text), or a
 * death before the final result event. A deterministic non-zero exit (the agent errored, a real
 * content failure) has a result event and no transient signal, so it stays a plain Error → today's
 * fresh retry — UNLESS it's a nonexistent/inaccessible model id, which no retry can fix and must
 * park on the first attempt instead (anton-ggf6, checked ahead of the transient scan since a bad
 * model id is deterministic no matter how its wording brushes past a transient phrase).
 */
function exitCodeError(exit: ClaudeExit, sessionId: string | undefined): Error {
  const resultText = resultTextOf(exit);
  // Prefer the agent's own result summary over stderr for the surfaced message — on a deterministic
  // failure that's where the real reason lives (anton-juar).
  const detail = resultText.trim() || exit.stderr.trim() || `claude exited with code ${exit.code}`;
  // stderr only — see modelRefusalError's doc on why the model-authored result text is excluded.
  const modelRefusal = modelRefusalError(exit.stderr);
  if (modelRefusal) return modelRefusal;
  const message = `claude exited with code ${exit.code}: ${detail.slice(-2000)}`;
  const signature = transientSignature(resultText, exit.stderr, exit.stream.resultRaw !== undefined);
  // The surfaced `detail` above can omit the transient wording entirely (it preferred a resultText
  // that doesn't carry it, while the signature was matched in stderr) — append a stable tag so
  // `isRecoverableClaudeText` can still recognize this as recoverable from the stored string alone.
  return signature
    ? new RecoverableClaudeError(`${message} (transient: ${signature})`, { sessionId, signature })
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
  // Stable-prefixed rather than bare `resultText`: the model-authored text can say anything (or
  // nothing), so it alone can never be recognized as recoverable once stored as plain `runs.error`
  // text — `isRecoverableClaudeText` anchors on this exact envelope.
  return signature
    ? new RecoverableClaudeError(
        `claude reported a transient error result (${signature})${resultText ? `: ${resultText}` : ""}`,
        { sessionId, signature },
      )
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
    modelUsage: parseModelUsage(raw.modelUsage),
    durationMs: typeof raw.duration_ms === "number" ? raw.duration_ms : undefined,
    durationApiMs: typeof raw.duration_api_ms === "number" ? raw.duration_api_ms : undefined,
    // Fall back to the last assistant message when the result field is absent (a result-less
    // success, observed on `claude --resume`) so the agent's final text — and its ANTON-RESULT
    // self-report — isn't lost, which would let partial work close as a false success (anton-juar).
    text: typeof raw.result === "string" ? raw.result : stream.lastAssistantText,
    answeringModel: stream.lastAssistantModel,
    isError: !!raw.is_error,
    pendingYields: stream.pendingYields,
  };
}
