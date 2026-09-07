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
  abortGraceMs, buildClaudeArgs, createStallWatchdog, groupAlive, killTree, resolveClaudeBin,
  spawnClaude, writePrompt, writeSystemPromptFile, type ClaudeCliOptions,
} from "./driver-spawn";

export { ABORT_GRACE_ENV, CLAUDE_BIN_ENV } from "./driver-spawn";
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

/** How often a cancelled session re-checks whether its process group has finally emptied. */
const GROUP_EXIT_POLL_MS = 50;

/**
 * The rejection a cancelled session settles with when its own abort produced none — shaped like
 * Node's `AbortError`, which is what callers discriminate cancellation by.
 */
function abortError(): Error {
  const err: Error & { code?: string } = new Error("The operation was aborted");
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

/**
 * Spawn claude and stream it to completion: the child's stdout becomes events, its ending becomes
 * either the classified rejection or the run's result. Cancellation and the stall watchdog both
 * signal the whole process GROUP, since Node's built-in AbortSignal handling reaches only the
 * direct child and would leave the shell commands claude spawned orphaned.
 *
 * A FORCIBLY TERMINATED session — cancelled, or killed as stalled — settles only once that group is
 * actually gone (PR #228 review). Signalling is not stopping: Node emits the abort's `error` the
 * instant it delivers SIGTERM, and claude — or a test runner, a formatter, a `git` it spawned —
 * keeps writing the worktree until it exits. The ticket-timeout path re-runs the verify gates and
 * COMMITS that tree the moment this promise settles, so settling on the signal hands it a snapshot
 * still being written: the commit is inconsistent, and whatever lands after the final cleanliness
 * check is thrown away with the failed run's worktree. So both terminations hold their rejection
 * until the whole GROUP is gone — not merely until the direct child closes, which a descendant that
 * traps the signal or holds none of claude's pipes outlives — escalating SIGTERM → SIGKILL for
 * anything that ignores the first one.
 */
function streamClaude(bin: string, args: string[], opts: RunClaudeOptions): Promise<ClaudeResult> {
  return new Promise<ClaudeResult>((resolve, reject) => {
    const child = spawnClaude(bin, args, opts);

    const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const watchdog = createStallWatchdog(stallMs, () => killTree(child, "SIGKILL"));

    /** The abort's own rejection, held until the whole process GROUP is proven gone. */
    let aborting: Error | null = null;
    let escalate: NodeJS.Timeout | undefined;
    let abandon: NodeJS.Timeout | undefined;
    let groupWatch: NodeJS.Timeout | undefined;
    const clearTermination = () => {
      if (escalate) clearTimeout(escalate);
      if (abandon) clearTimeout(abandon);
      if (groupWatch) clearTimeout(groupWatch);
      escalate = abandon = groupWatch = undefined;
    };

    const onAbort = () => {
      // Cancellation is latched HERE, on the signal itself, rather than on the child's `error` (PR
      // #228 review). Node emits that `error` only when it actually delivers the kill, so an abort
      // landing after the direct process has already exited — while a descendant still holds its
      // stdout and `close` is yet to fire — produces none at all, and the `close` below would then
      // settle a CANCELLED session as an ordinary one. On a formula with no verify step nothing
      // downstream consumes the signal, so the commit step would run and a cancelled ticket would
      // commit and update its bead. A real `error` still overwrites this placeholder: callers
      // discriminate cancellation by the rejection's shape, and both are `AbortError`s.
      aborting ??= abortError();
      killTree(child, "SIGTERM");
      const grace = abortGraceMs();
      escalate = setTimeout(() => killTree(child, "SIGKILL"), grace);
      escalate.unref?.();
      // The last resort, and a bounded one — for the pipes and for the group wait alike. SIGKILL
      // went to the whole GROUP, so anything still standing past this is unreapable rather than a
      // live writer, and waiting on it would wedge the run instead of protecting the tree.
      abandon = setTimeout(() => settle(() => reject(aborting ?? abortError())), grace * 2);
      abandon.unref?.();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // A signal already aborted before the spawn never fires `abort`, so escalate explicitly: Node
    // sends its one SIGTERM either way, and without this nothing would ever follow it up.
    if (opts.signal?.aborted) onAbort();

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
     * Every ending settles exactly once, and always releases the timers and the abort listener. The
     * once-flag matters because a cancelled session can still reach `close` after the abandon timer
     * gave up on it — and the loser must not re-run `finish()`.
     */
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      clearTermination();
      opts.signal?.removeEventListener("abort", onAbort);
      finish();
    };

    child.on("error", (err) => {
      // An abort's `error` is the SIGNAL, not the ending — hold it until the child has gone. A
      // spawn failure has no process to wait for and settles at once.
      const running =
        child.pid !== undefined && child.exitCode === null && child.signalCode === null;
      if (opts.signal?.aborted && running) {
        aborting = err;
        return;
      }
      settle(() => reject(err));
    });
    /**
     * Settle once the process GROUP is empty, not merely the direct child (PR #228 review). Claude
     * exiting proves nothing about the shell command it spawned: a descendant that traps the signal
     * — or that simply holds none of claude's pipes — lets `close` fire while it keeps writing the
     * worktree, and the ticket-timeout path verifies and commits that tree the instant this promise
     * settles. So the escalation is delivered NOW rather than waiting out its timer, and the
     * rejection waits for the group to actually go.
     *
     * Both forced endings come through here. A stalled session's group-wide SIGKILL is a DELIVERY,
     * not an exit — a tool process dies no more promptly for it than a cancelled one does — so the
     * watchdog path needs the same wait, and (having no timer of its own) arms the bound here.
     */
    const settleWhenGroupGone = (finish: () => void) => {
      if (settled) return;
      killTree(child, "SIGKILL");
      if (escalate) clearTimeout(escalate);
      escalate = undefined;
      // The wait must stay bounded: a group that cannot be reaped is unreapable rather than a live
      // writer, and holding for it would wedge the run instead of protecting the tree.
      if (!abandon) {
        abandon = setTimeout(() => settle(finish), abortGraceMs() * 2);
        abandon.unref?.();
      }
      const poll = () => {
        // `abandon` may have given up on this group already; without this the loop would outlive
        // the settled promise, polling a group nothing is waiting on for the process's lifetime.
        if (settled) return;
        if (!groupAlive(child)) {
          settle(finish);
          return;
        }
        groupWatch = setTimeout(poll, GROUP_EXIT_POLL_MS);
        groupWatch.unref?.();
      };
      poll();
    };

    child.on("close", (code) => {
      lines.flush();
      // A cancelled session keeps the abort's own rejection: callers discriminate cancellation by
      // it, and the signal-kill exit it leaves behind is no verdict on the session's work.
      if (aborting) {
        settleWhenGroupGone(() => reject(aborting as Error));
        return;
      }
      const finish = () => {
        const error = exitError({ code, stalled: watchdog.stalled, stallMs, stderr, stream });
        if (error) reject(error);
        else resolve(toClaudeResult(stream));
      };
      // A stalled session was killed the same group-wide way a cancelled one is, so it inherits the
      // same hazard: claude's `close` says nothing about the tool process still writing the tree.
      if (watchdog.stalled) settleWhenGroupGone(finish);
      else settle(finish);
    });
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
