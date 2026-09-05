/**
 * How the headless driver launches and controls the `claude` child (anton-kvag): which binary,
 * which argv, the off-argv prompt channels, and the two ways the process is stopped (cancellation
 * and the stall watchdog). Everything here is about the PROCESS; the stream it produces is
 * driver-events.ts and what its exit means is driver-exit.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Override the claude binary (tests point this at a fake stream-json emitter). */
export const CLAUDE_BIN_ENV = "ANTON_CLAUDE_BIN";

/** Override the SIGTERM→SIGKILL grace a cancelled session gets (tests shrink it). */
export const ABORT_GRACE_ENV = "ANTON_CLAUDE_ABORT_GRACE_MS";

/**
 * How long a cancelled session has to exit on SIGTERM before the group is killed outright. Long
 * enough for claude to finish the file write it is in the middle of and drop its own tools, short
 * enough that a trapped signal does not hold the run for a meaningful part of a ticket's budget.
 */
const DEFAULT_ABORT_GRACE_MS = 10_000;

export function abortGraceMs(): number {
  const raw = Number(process.env[ABORT_GRACE_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_ABORT_GRACE_MS;
}

/** The options that only shape argv — the session's own configuration, not this run's plumbing. */
export interface ClaudeCliOptions {
  /** --model; falls back to claude's default when omitted. */
  model?: string;
  /** --permission-mode; default "bypassPermissions" for unattended autonomy. */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Restrict tools (--allowedTools), optional. */
  allowedTools?: string[];
  /**
   * Hard-deny tools or command prefixes (--disallowedTools), e.g. `Bash(git:*)`. Deny rules are
   * evaluated ahead of `permissionMode`, so this still binds an unattended `bypassPermissions`
   * session — which is the only reason it is usable as a guard rather than a request.
   */
  disallowedTools?: string[];
  /**
   * Which settings files the session loads (`--setting-sources`). Omitted → Claude Code's default
   * of `user,project,local`.
   *
   * `project` and `local` are read from the working tree, which for a session judging that tree is
   * the tree's own configuration: `.claude/settings.json` is source-controlled and can register
   * hooks, and hooks run shell commands. Restricting a session to `user` leaves it configured only
   * by the operator's machine.
   */
  settingSources?: Array<"user" | "project" | "local">;
  /**
   * Resume an existing Claude session (`--resume <id>`) instead of starting fresh (anton-juar).
   * Set on a retry after a transient mid-stream death: the run continues with the full in-session
   * conversation, so `prompt` should be a brief continuation, not the whole ticket spec again.
   */
  resumeSessionId?: string;
}

/**
 * The binary to spawn. Refuses to spawn the real, billable `claude` under vitest: tests must point
 * `ANTON_CLAUDE_BIN` at a fake emitter; without it we'd otherwise launch a real bypassPermissions
 * session against a temp worktree (anton-lixu). Enforced structurally so a stub isn't left to each
 * test to remember.
 */
export function resolveClaudeBin(): string {
  const binOverride = process.env[CLAUDE_BIN_ENV];
  if (!binOverride && process.env.VITEST) {
    throw new Error(
      `runClaude refused to spawn the real 'claude' binary under vitest: set ${CLAUDE_BIN_ENV} to a fake stream-json emitter. ` +
        "This guard prevents a real, billable bypassPermissions session from launching in tests.",
    );
  }
  return binOverride ?? "claude";
}

/** A system-prompt temp file and its removal; `cleanup` is idempotent and never throws. */
export interface SystemPromptFile {
  /** Path to pass to --append-system-prompt-file, or undefined when there is no system prompt. */
  path?: string;
  cleanup: () => void;
}

/**
 * Write the composed system prompt to a temp file so it reaches claude off argv (anton-14tj) — `ps`
 * during an autonomous run must show neither bead nor contract text. The caller removes the file on
 * every path, so it survives neither a throw nor an abort.
 */
export function writeSystemPromptFile(text: string | undefined): SystemPromptFile {
  if (!text) return { cleanup: () => {} };

  const dir = mkdtempSync(join(tmpdir(), "anton-claude-sys-"));
  const path = join(dir, "system-prompt.txt");
  writeFileSync(path, text, "utf8");

  let removed = false;
  return {
    path,
    cleanup: () => {
      if (removed) return;
      removed = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a leaked temp file is harmless next to losing the real result/error.
      }
    },
  };
}

/** A repeatable flag's value, or undefined when the list is empty and the flag must be omitted. */
function joinList(values: readonly string[] | undefined): string | undefined {
  return values && values.length > 0 ? values.join(",") : undefined;
}

/**
 * The argv for one headless run. `-p` is the bare print-mode flag (no positional prompt) — the task
 * prompt arrives on stdin and the system prompt via a file, so neither is ever visible in `ps`.
 */
export function buildClaudeArgs(opts: ClaudeCliOptions, systemPromptFile?: string): string[] {
  // --permission-mode is always sent: unattended runs default to bypassPermissions rather than
  // inheriting whatever the session's settings would pick.
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--permission-mode", opts.permissionMode ?? "bypassPermissions",
  ];

  // In argv order; an undefined value omits the flag entirely.
  const optional: Array<[string, string | undefined]> = [
    ["--append-system-prompt-file", systemPromptFile],
    ["--model", opts.model],
    ["--allowedTools", joinList(opts.allowedTools)],
    ["--disallowedTools", joinList(opts.disallowedTools)],
    ["--setting-sources", joinList(opts.settingSources)],
  ];
  for (const [flag, value] of optional) {
    if (value) args.push(flag, value);
  }

  // Resume an interrupted session in-place (anton-juar) — continue the same conversation rather than
  // spawning fresh. Placed first so it reads clearly in the recorded argv; order is otherwise moot.
  // The continuation prompt is delivered on stdin exactly like a fresh run.
  if (opts.resumeSessionId) args.unshift("--resume", opts.resumeSessionId);

  return args;
}

export function spawnClaude(
  bin: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal },
): ChildProcess {
  return spawn(bin, args, {
    cwd: opts.cwd,
    signal: opts.signal,
    // On POSIX, make Claude the leader of a new process group. The stall watchdog must terminate
    // the shell commands/tests Claude spawned too; killing only Claude leaves the actual hung
    // wait-loop orphaned and lets every retry add another copy.
    detached: process.platform !== "win32",
  });
}

/** Signal claude AND everything it spawned — the direct child handle is the fallback. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may not have formed if spawn failed; fall back to the direct child handle.
    }
  }
  child.kill(signal);
}

/**
 * Deliver the task prompt on stdin, then close it. The 'error' listener swallows EPIPE for the case
 * the child exits before the prompt is fully written (a large prompt outlives a child that died
 * early / never read stdin) — without it that write would surface as an unhandled error and fail an
 * otherwise-classified run (anton-14tj).
 */
export function writePrompt(child: ChildProcess, prompt: string): void {
  if (!child.stdin) return;
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
}

/**
 * Kills the child after a window with NO output at all (anton-0oi). Any byte on either stream is
 * liveness and rearms the timer; on expiry `stalled` latches BEFORE the kill, so the close handler
 * reports the hang instead of a bare "exited with code null".
 */
export interface StallWatchdog {
  /** True once the window elapsed and the child was killed as stalled. */
  readonly stalled: boolean;
  /** Restart the window — called on every byte of output. */
  arm(): void;
  /** Stop watching; the child has ended. */
  clear(): void;
}

export function createStallWatchdog(stallMs: number, onStall: () => void): StallWatchdog {
  let timer: NodeJS.Timeout | undefined;
  let stalled = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    get stalled() {
      return stalled;
    },
    arm() {
      clear();
      if (!Number.isFinite(stallMs) || stallMs <= 0) return; // 0/Infinity disables the watchdog
      timer = setTimeout(() => {
        stalled = true;
        onStall();
      }, stallMs);
      timer.unref?.();
    },
    clear,
  };
}
