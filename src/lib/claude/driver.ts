/**
 * Headless claude driver (anton-dzh.3). Spawns `claude -p` for autonomous work: delivers the task
 * prompt on the child's stdin and the composed system prompt via --append-system-prompt-file, so no
 * bead or contract text ever lands on the process command line (anton-14tj) — `ps` during a run
 * shows neither. --model from settings, cwd = worktree; streams stream-json events out (for the
 * session log + UI SSE) and detects usage-limit signals so the runner can back off. See DESIGN.md §5.
 *
 * The run reads as a pipeline (anton-kvag), each stage owning one seam:
 *   driver-spawn.ts   → which binary, which argv, the off-argv prompt channels, killing the tree
 *   driver-events.ts  → stream-json lines → `ClaudeEvent`s + the stream state the exit needs
 *   driver-exit.ts    → what the process's end means (with driver-limits.ts for quota/reset)
 *
 * ── CONTRACT (locked — implement the bodies, keep these signatures) ──
 * The execute-epic job depends on exactly these exports. Usage limits MUST surface as the
 * shared `UsageLimitError` so the runner parks + reschedules (never a plain throw).
 */
import { consumeLine, createLineReader, createStreamState, type ClaudeEvent } from "./driver-events";
import { exitError, toClaudeResult, type ClaudeResult } from "./driver-exit";
import {
  buildClaudeArgs, createStallWatchdog, killTree, resolveClaudeBin, spawnClaude, writePrompt,
  writeSystemPromptFile, type ClaudeCliOptions,
} from "./driver-spawn";

export { CLAUDE_BIN_ENV } from "./driver-spawn";
export type { ClaudeEvent } from "./driver-events";
export type { ClaudeResult } from "./driver-exit";

export interface RunClaudeOptions extends ClaudeCliOptions {
  /** Working directory — the run's worktree. */
  cwd: string;
  /** The task prompt — delivered on the child's stdin, never on argv (anton-14tj). */
  prompt: string;
  /** The composed system prompt — written to a temp file and passed via --append-system-prompt-file. */
  appendSystemPrompt?: string;
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
 * Spawn claude and stream it to completion: the child's stdout becomes events, its ending becomes
 * either the classified rejection or the run's result. Cancellation and the stall watchdog both
 * signal the whole process GROUP, since Node's built-in AbortSignal handling reaches only the
 * direct child and would leave the shell commands claude spawned orphaned.
 */
function streamClaude(bin: string, args: string[], opts: RunClaudeOptions): Promise<ClaudeResult> {
  return new Promise<ClaudeResult>((resolve, reject) => {
    const child = spawnClaude(bin, args, opts);

    const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const watchdog = createStallWatchdog(stallMs, () => killTree(child, "SIGKILL"));
    const onAbort = () => killTree(child, "SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    writePrompt(child, opts.prompt);

    const stream = createStreamState();
    const lines = createLineReader((line) => consumeLine(stream, line, opts.onEvent));
    let stderr = "";

    watchdog.arm();
    child.stdout?.on("data", (chunk: Buffer) => {
      watchdog.arm();
      lines.push(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      watchdog.arm();
      stderr += chunk.toString("utf8");
    });

    /**
     * Every ending settles exactly once, and always releases the timer and the abort listener. The
     * once-flag matters because an abort delivers two endings — Node's `spawn({signal})` emits
     * 'error' with an AbortError AND `onAbort` fires — and the loser must not re-run `finish()`.
     */
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      opts.signal?.removeEventListener("abort", onAbort);
      finish();
    };

    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) =>
      settle(() => {
        lines.flush();
        const error = exitError({ code, stalled: watchdog.stalled, stallMs, stderr, stream });
        if (error) reject(error);
        else resolve(toClaudeResult(stream));
      }),
    );
  });
}

/**
 * Run claude headless to completion. Resolves with the final result on success.
 * THROWS `UsageLimitError` (with resetAt when parseable) when claude reports a usage limit.
 * Throws a plain Error on spawn failure / non-zero exit that isn't a usage limit.
 */
export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  const bin = resolveClaudeBin();
  const systemPrompt = writeSystemPromptFile(opts.appendSystemPrompt);
  const args = buildClaudeArgs(opts, systemPrompt.path);

  // Remove the system-prompt temp file on every path — success, throw, or abort — while passing the
  // original result/error through unchanged.
  return streamClaude(bin, args, opts).finally(systemPrompt.cleanup);
}
