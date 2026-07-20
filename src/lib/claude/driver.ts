/**
 * Headless claude driver (anton-dzh.3). Spawns `claude -p` for autonomous work: injects the
 * ticket's agent-tag prompt via --append-system-prompt, --model from settings, cwd = worktree;
 * streams stream-json events out (for the session log + UI SSE) and detects usage-limit signals
 * so the runner can back off. See DESIGN.md §5.
 *
 * ── CONTRACT (locked — implement the bodies, keep these signatures) ──
 * The execute-epic job depends on exactly these exports. Usage limits MUST surface as the
 * shared `UsageLimitError` so the runner parks + reschedules (never a plain throw).
 */
import { spawn } from "node:child_process";
import { RecoverableClaudeError, UsageLimitError } from "../jobs/errors";

/** Override the claude binary (tests point this at a fake stream-json emitter). */
export const CLAUDE_BIN_ENV = "ANTON_CLAUDE_BIN";

/** A normalized event streamed from claude's stream-json output. */
export interface ClaudeEvent {
  /** Coarse kind for the UI/log. `raw` carries the original stream-json object. */
  type: "system" | "assistant" | "tool" | "result" | "error" | "text";
  /** Human-readable text for logs/terminal, when the event has any. */
  text?: string;
  /** The original parsed stream-json line. */
  raw?: unknown;
}

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

export interface RunClaudeOptions {
  /** Working directory — the run's worktree. */
  cwd: string;
  /** The task prompt (the `-p` value). */
  prompt: string;
  /** Injected via --append-system-prompt (the resolved agent prompt). */
  appendSystemPrompt?: string;
  /** --model; falls back to claude's default when omitted. */
  model?: string;
  /** --permission-mode; default "bypassPermissions" for unattended autonomy. */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Restrict tools (--allowedTools), optional. */
  allowedTools?: string[];
  /**
   * Resume an existing Claude session (`--resume <id>`) instead of starting fresh (anton-juar).
   * Set on a retry after a transient mid-stream death: the run continues with the full in-session
   * conversation, so `prompt` should be a brief continuation, not the whole ticket spec again.
   */
  resumeSessionId?: string;
  /** Abort the child (lease lost / run cancelled). */
  signal?: AbortSignal;
  /** Streamed events (append to session log, push to SSE). */
  onEvent?: (event: ClaudeEvent) => void;
  /**
   * Kill the session after this long with NO output at all (anton-0oi). A headless agent that
   * blocks forever — e.g. on a shell wait-loop whose condition can never go false — emits nothing
   * and otherwise burns the run's entire budget looking alive. Silence is the only signal
   * available: a blocked tool call produces no stream-json events.
   *
   * Default {@link DEFAULT_STALL_TIMEOUT_MS} is deliberately generous, because *legitimate*
   * silence can be long: a full test suite runs for minutes, and under the host verify-gate lock a
   * gate can also wait its turn first. Set below that only when the work is known to be chatty.
   */
  stallTimeoutMs?: number;
}

/**
 * 60 minutes. Must exceed the longest legitimate silent stretch — a full suite (~13 min here) that
 * first waited out the host verify-gate lock (up to 30 min) is ~45 min of justified quiet. This is
 * a backstop against a hang that would otherwise run until the job lease expires, not a latency SLO.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 60 * 60_000;

/**
 * Case-insensitive usage-limit phrasing Claude Code emits on an exhausted quota, anchored to the
 * start of a line (`^\s*…`, multiline `m`): the notice lands as the *leading* content of an
 * assistant block / the result field, whereas a quotation buried mid-sentence never starts a line.
 *
 * This RE covers the terse machine banners only — the 5-hour/weekly "usage limit reached" wording
 * (and the bare "Claude AI usage limit reached|<epoch>" variant). Those read unmistakably as
 * machine output, so they are trusted wherever they surface: the scan runs over the *combined*
 * transcript (assistant text + result + stderr), because Claude Code has emitted them in the result
 * field, in an assistant text block, or on stderr depending on how the run exited (anton-ner.2).
 *
 * The monthly spend-limit wording is deliberately NOT in this RE — see `SPEND_LIMIT_RE`.
 */
const USAGE_LIMIT_RE = /^\s*(?:(?:claude ai\s+)?usage limit reached|(?:5-hour|weekly) limit reached)/im;

/**
 * The monthly spend-limit banner Claude Code surfaces separately — observed as `You've hit your
 * monthly spend limit · raise it at claude.ai/settings/usage` (anton-b9l), or the no-link variant
 * `You've hit your monthly spend limit.` then `/usage-credits …` (Claude Code 2.1.172,
 * anthropics/claude-code#67579). A spend limit is a periodic quota that lifts on its own (a raised
 * cap or the next billing cycle), so it belongs with the usage limits: the runner reschedules past
 * a cool-off instead of burning attempts and parking.
 *
 * Unlike the terse banners above, this is an ordinary English sentence a model can reproduce
 * verbatim — an agent working this very ticket might quote it in its prose or a test fixture and
 * then fail for an unrelated reason (red tests, a rejected push). Matching that quote would refund
 * the attempt and reschedule the real failure forever. Three structural guards keep that out:
 *   1. The phrase must be followed by Claude Code's trailing remediation pointer — the
 *      `claude.ai/settings/usage` link or the `/usage-credits` slash-command pointer — within a
 *      bounded window (the banner renders across two lines), so a bare mention of the words
 *      "monthly spend limit" never matches.
 *   2. The model-authored assistant transcript is NEVER scanned for this wording (only the terse
 *      banners are — those can't be confused for prose). A model quoting the banner while it works
 *      lands in an assistant text block, which neither spend-limit RE ever sees.
 *   3. The remaining two channels are scanned with strictness matched to their authorship:
 *        • stderr is Claude Code's OWN diagnostic channel — the model streams to stdout, never the
 *          process stderr — so `SPEND_LIMIT_RE` (loose, line-anchored) is trusted there.
 *        • the result field IS the model's final text on an ordinary failed run, so it is trusted
 *          only via `SPEND_LIMIT_RESULT_RE`, which additionally end-anchors the match so the banner
 *          must constitute the WHOLE result. The genuine CLI abort emits the banner as the entire
 *          result with nothing appended; a failure that merely quotes the banner and then reports
 *          its own outcome ("…but three tests still fail") has trailing prose and no longer matches.
 *
 * Together these keep the genuine standalone notice matching in both wordings while letting a
 * failure that merely mentions the phrase — and ordinary payment failures (declined card, no
 * payment method) — fall through to a plain error for a human. The trade-off: a genuine spend-limit
 * banner surfaced *only* in an assistant block, or buried mid-result among other prose, is missed
 * and falls back to a plain error (park + burn an attempt) — the safe direction, far better than
 * infinite-rescheduling a real failure that happened to quote the banner.
 */
const SPEND_LIMIT_RE =
  /^\s*(?:you['’]ve\s+)?(?:hit|reached) your monthly spend limit\b[\s\S]{0,80}?(?:claude\.ai\/settings\/usage|\/usage-credits\b)/im;

/**
 * Result-field variant of `SPEND_LIMIT_RE`: the same banner + remediation pointer, but end-anchored
 * so the banner must be the ENTIRE result — only its own trailing line and whitespace may follow.
 * The result field is model-authored on ordinary failed runs, so a leading quote of the banner
 * followed by a failure report must NOT match (guard 3 above). Deliberately single-line (`i`, no
 * `m`): `$` anchors to the end of the whole result string, not each line.
 */
const SPEND_LIMIT_RESULT_RE =
  /^\s*(?:you['’]ve\s+)?(?:hit|reached) your monthly spend limit\b[\s\S]{0,80}?(?:claude\.ai\/settings\/usage|\/usage-credits\b)[^\n]*\s*$/i;

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
function transientSignature(resultText: string, stderrText: string, hadResult: boolean): string | null {
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

/** Best-effort extraction of a reset time (unix seconds) from claude's usage-limit text. */
function parseResetAt(text: string | undefined): number | undefined {
  if (!text) return undefined;

  const epochMatch = text.match(/\|\s*(\d{10,13})\s*$/m);
  if (epochMatch) {
    const n = Number(epochMatch[1]);
    // Normalize millisecond epochs down to seconds.
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }

  const resetAtMatch = text.match(/reset(?:s)?\s+at\s+([^\n,;]+)/i);
  if (resetAtMatch) {
    const ms = Date.parse(resetAtMatch[1].trim());
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }

  const isoMatch = text.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
  );
  if (isoMatch) {
    const ms = Date.parse(isoMatch[0]);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }

  return undefined;
}

/** Normalize one parsed stream-json line into zero or more `ClaudeEvent`s. */
function toEvents(raw: Record<string, unknown>): ClaudeEvent[] {
  const type = raw.type;

  if (type === "system") {
    return [{ type: "system", text: typeof raw.subtype === "string" ? raw.subtype : undefined, raw }];
  }

  if (type === "assistant") {
    const message = raw.message as { content?: unknown[] } | undefined;
    const blocks = Array.isArray(message?.content) ? message!.content : [];
    const events: ClaudeEvent[] = [];

    const text = blocks
      .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (text) events.push({ type: "assistant", text, raw });

    for (const b of blocks) {
      if (typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_use") {
        const name = (b as { name?: string }).name;
        events.push({ type: "tool", text: name, raw });
      }
    }

    if (events.length === 0) events.push({ type: "assistant", raw });
    return events;
  }

  if (type === "result") {
    const text = typeof raw.result === "string" ? raw.result : undefined;
    return [{ type: "result", text, raw }];
  }

  return [];
}

/**
 * Run claude headless to completion. Resolves with the final result on success.
 * THROWS `UsageLimitError` (with resetAt when parseable) when claude reports a usage limit.
 * Throws a plain Error on spawn failure / non-zero exit that isn't a usage limit.
 */
export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  const bin = process.env[CLAUDE_BIN_ENV] ?? "claude";

  const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
  // Resume an interrupted session in-place (anton-juar) — continue the same conversation rather than
  // spawning fresh. Placed first so it reads clearly in the recorded argv; order is otherwise moot.
  if (opts.resumeSessionId) args.unshift("--resume", opts.resumeSessionId);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.model) args.push("--model", opts.model);
  args.push("--permission-mode", opts.permissionMode ?? "bypassPermissions");
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }

  return new Promise<ClaudeResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      signal: opts.signal,
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let resultRaw: Record<string, unknown> | undefined;
    // Claude's session id captured from the `system` init event — emitted at session start, BEFORE
    // any work. Held separately so a mid-stream death that never reaches the final `result` event
    // still surfaces an id the runner can `claude --resume` (anton-juar).
    let initSessionId: string | undefined;
    // All human-readable text Claude emitted (assistant + result), so the usage-limit scan sees
    // the quota signal wherever it lands — Claude Code has surfaced "usage limit reached" in the
    // final result field, in an assistant text block, or on stderr depending on how it exited.
    // Scanning only the result field risked misclassifying a real quota hit as a plain error,
    // which burns maxAttempts and parks instead of rescheduling (anton-ner.2).
    let transcript = "";
    // The last assistant text block — the `text` fallback for a success that omits the final
    // `result` field (see the resolve below, anton-juar).
    let lastAssistantText: string | undefined;

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (parsed.type === "result") resultRaw = parsed;
      if (parsed.type === "system" && typeof parsed.session_id === "string") {
        initSessionId = parsed.session_id;
      }
      for (const event of toEvents(parsed)) {
        if (event.text) transcript += `${event.text}\n`;
        if (event.type === "assistant" && event.text) lastAssistantText = event.text;
        opts.onEvent?.(event);
      }
    };

    // Stall watchdog (anton-0oi): any byte on either stream counts as liveness and rearms the
    // timer. On expiry the child is killed, which reaches `close` below — but `stalled` is latched
    // first so that handler reports the hang instead of a bare "exited with code null".
    const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    let stalled = false;
    let stallTimer: NodeJS.Timeout | undefined;
    const clearStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
    };
    const armStall = () => {
      clearStall();
      if (!Number.isFinite(stallMs) || stallMs <= 0) return; // 0/Infinity disables the watchdog
      stallTimer = setTimeout(() => {
        stalled = true;
        child.kill("SIGKILL");
      }, stallMs);
      stallTimer.unref?.();
    };
    armStall();

    child.stdout?.on("data", (chunk: Buffer) => {
      armStall();
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      armStall();
      stderrBuf += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearStall();
      reject(err);
    });

    child.on("close", (code) => {
      clearStall();
      if (stdoutBuf.trim()) {
        handleLine(stdoutBuf);
        stdoutBuf = "";
      }

      if (stalled) {
        // Resume-eligible: the session may have real work banked before it wedged, and the caller
        // refuses to resume twice on the same signature, so a re-stall escalates to a fresh run
        // rather than looping. `initSessionId` is captured at session start, so it is available
        // even though no result event ever arrived.
        reject(
          new RecoverableClaudeError(
            `claude produced no output for ${Math.round(stallMs / 60_000)}m — killed as stalled`,
            { sessionId: initSessionId, signature: "stalled" },
          ),
        );
        return;
      }

      const resultText = resultRaw && typeof resultRaw.result === "string" ? resultRaw.result : undefined;

      // Only a run that did NOT cleanly succeed can be a quota hit. Gate the transcript scan on
      // non-success so a healthy run whose assistant output merely *mentions* a usage limit (e.g.
      // an agent editing this very file, or working the anton-ner epic) is never reclassified as
      // UsageLimitError and rescheduled forever. Every real quota abort carries is_error / a
      // non-zero exit, so nothing legitimate is lost (anton-ner.2).
      const succeeded = code === 0 && resultRaw !== undefined && !resultRaw.is_error;

      if (!succeeded) {
        // Terse machine banners are trusted across the full transcript (assistant + result text +
        // stderr) — the result field alone isn't a reliable place to find them. See `transcript`.
        const combined = `${transcript}\n${resultText ?? ""}\n${stderrBuf}`;
        // The monthly spend-limit sentence is model-reproducible prose, so it is never scanned in
        // the assistant transcript, and the two remaining channels are matched with strictness
        // suited to their authorship: stderr (Claude Code's own) loosely, and the model-authored
        // result field only when the banner is the WHOLE result — otherwise an agent quoting the
        // banner verbatim (a fixture, prose) then failing for an unrelated reason would be misread
        // as a quota hit and its real failure rescheduled forever. See `SPEND_LIMIT_RE` /
        // `SPEND_LIMIT_RESULT_RE`.
        const spendLimited =
          SPEND_LIMIT_RE.test(stderrBuf) || SPEND_LIMIT_RESULT_RE.test(resultText ?? "");

        if (USAGE_LIMIT_RE.test(combined) || spendLimited) {
          const message = resultText || stderrBuf.trim() || transcript.trim() || "Claude AI usage limit reached";
          reject(new UsageLimitError(message, parseResetAt(combined)));
          return;
        }
      }

      // The session id for `--resume`: the final result carries it on a clean exit, but a mid-stream
      // death may never emit that event, so fall back to the id captured from the `system` init
      // event (anton-juar).
      const capturedSessionId =
        (resultRaw && typeof resultRaw.session_id === "string" ? resultRaw.session_id : undefined) ??
        initSessionId;

      if (code !== 0) {
        // Prefer the agent's own result summary over stderr for the surfaced message — on a
        // deterministic failure that's where the real reason lives (anton-juar).
        const detail = (resultText ?? "").trim() || stderrBuf.trim() || `claude exited with code ${code}`;
        const message = `claude exited with code ${code}: ${detail.slice(-2000)}`;
        // A non-zero exit is resume-eligible only when it looks transient — a network/upstream drop
        // in Claude Code's own channels (broadly in stderr, narrowly in the model-authored result
        // text), or a death before the final result event. A deterministic non-zero exit (the agent
        // errored, a real content failure) has a result event and no transient signal, so it stays a
        // plain Error → today's fresh retry.
        const signature = transientSignature(resultText ?? "", stderrBuf, resultRaw !== undefined);
        if (signature) {
          reject(new RecoverableClaudeError(message, { sessionId: capturedSessionId, signature }));
          return;
        }
        reject(new Error(message));
        return;
      }

      if (!resultRaw) {
        // Exited 0 but never emitted the final result event — a truncated/interrupted stream. This is
        // a transient mid-stream death, so it's resume-eligible (anton-juar).
        reject(
          new RecoverableClaudeError("claude exited without a result event", {
            sessionId: capturedSessionId,
            signature: "exit-without-result",
          }),
        );
        return;
      }

      // A run can report failure via `is_error` while still exiting 0 — Claude Code surfaces a
      // mid-stream drop (e.g. "Connection closed mid-response") as an error result on a clean exit.
      // Classify it over Claude's own channels (result text + stderr) so a transient death here is
      // resume-eligible too, matching the non-zero-exit branch — otherwise it would resolve
      // `{ ok: false }` and force a fresh restart instead of an in-place resume (anton-juar).
      if (resultRaw.is_error) {
        const signature = transientSignature(resultText ?? "", stderrBuf, true);
        if (signature) {
          reject(
            new RecoverableClaudeError(resultText || "claude reported a transient error result", {
              sessionId: capturedSessionId,
              signature,
            }),
          );
          return;
        }
      }

      resolve({
        ok: !resultRaw.is_error,
        sessionId: typeof resultRaw.session_id === "string" ? resultRaw.session_id : undefined,
        numTurns: typeof resultRaw.num_turns === "number" ? resultRaw.num_turns : undefined,
        costUsd: typeof resultRaw.total_cost_usd === "number" ? resultRaw.total_cost_usd : undefined,
        // Fall back to the last assistant message when the result field is absent (a result-less
        // success, observed on `claude --resume`) so the agent's final text — and its ANTON-RESULT
        // self-report — isn't lost, which would let partial work close as a false success (anton-juar).
        text: resultText ?? lastAssistantText,
        isError: !!resultRaw.is_error,
      });
    });
  });
}
