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
import { UsageLimitError } from "../jobs/errors";

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
  /** Final assistant/result text. */
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
  /** Abort the child (lease lost / run cancelled). */
  signal?: AbortSignal;
  /** Streamed events (append to session log, push to SSE). */
  onEvent?: (event: ClaudeEvent) => void;
}

/**
 * Case-insensitive usage-limit phrasing claude emits on an exhausted quota.
 *
 * Covers the 5-hour/weekly "usage limit reached" wording *and* the monthly spend-limit
 * wording Claude Code surfaces separately — observed as `You've hit your monthly spend limit ·
 * raise it at claude.ai/settings/usage` (anton-b9l). A spend limit is a periodic quota that
 * lifts on its own (a raised cap or the next billing cycle), so it belongs here: the runner
 * reschedules past a cool-off instead of burning attempts and parking.
 *
 * We key on the captured Claude payload phrasing — "(You've) hit your monthly spend limit" — rather
 * than any occurrence of the bare words "monthly spend limit". That distinction matters because the
 * transcript scan runs over every non-successful run's combined assistant/result/stderr text: a run
 * that fails for an unrelated reason (e.g. an agent working this very ticket, whose output describes
 * the "monthly spend limit" feature, then fails tests or a push and exits non-zero) must NOT be
 * reclassified as a transient quota reset and rescheduled forever. Requiring the "hit your monthly
 * spend limit" wording — the actual quota payload — keeps ordinary payment failures (declined card,
 * no payment method) and ticket-work mentions falling through to a plain error for a human.
 */
const USAGE_LIMIT_RE =
  /usage limit reached|(?:5-hour|weekly) limit reached|(?:hit|reached) your monthly spend limit/i;

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
    // All human-readable text Claude emitted (assistant + result), so the usage-limit scan sees
    // the quota signal wherever it lands — Claude Code has surfaced "usage limit reached" in the
    // final result field, in an assistant text block, or on stderr depending on how it exited.
    // Scanning only the result field risked misclassifying a real quota hit as a plain error,
    // which burns maxAttempts and parks instead of rescheduling (anton-ner.2).
    let transcript = "";

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
      for (const event of toEvents(parsed)) {
        if (event.text) transcript += `${event.text}\n`;
        opts.onEvent?.(event);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (stdoutBuf.trim()) {
        handleLine(stdoutBuf);
        stdoutBuf = "";
      }

      const resultText = resultRaw && typeof resultRaw.result === "string" ? resultRaw.result : undefined;

      // Only a run that did NOT cleanly succeed can be a quota hit. Gate the transcript scan on
      // non-success so a healthy run whose assistant output merely *mentions* a usage limit (e.g.
      // an agent editing this very file, or working the anton-ner epic) is never reclassified as
      // UsageLimitError and rescheduled forever. Every real quota abort carries is_error / a
      // non-zero exit, so nothing legitimate is lost (anton-ner.2).
      const succeeded = code === 0 && resultRaw !== undefined && !resultRaw.is_error;

      if (!succeeded) {
        // Scan the full transcript (assistant + result text) plus stderr — the result field alone
        // isn't a reliable place to find the quota signal. See `transcript` above.
        const combined = `${transcript}\n${resultText ?? ""}\n${stderrBuf}`;

        if (USAGE_LIMIT_RE.test(combined)) {
          const message = resultText || stderrBuf.trim() || transcript.trim() || "Claude AI usage limit reached";
          reject(new UsageLimitError(message, parseResetAt(combined)));
          return;
        }
      }

      if (code !== 0) {
        const tail = stderrBuf.trim().slice(-2000) || `claude exited with code ${code}`;
        reject(new Error(`claude exited with code ${code}: ${tail}`));
        return;
      }

      if (!resultRaw) {
        reject(new Error("claude exited without a result event"));
        return;
      }

      resolve({
        ok: !resultRaw.is_error,
        sessionId: typeof resultRaw.session_id === "string" ? resultRaw.session_id : undefined,
        numTurns: typeof resultRaw.num_turns === "number" ? resultRaw.num_turns : undefined,
        costUsd: typeof resultRaw.total_cost_usd === "number" ? resultRaw.total_cost_usd : undefined,
        text: resultText,
        isError: !!resultRaw.is_error,
      });
    });
  });
}
