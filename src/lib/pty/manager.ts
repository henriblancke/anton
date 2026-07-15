/**
 * Interactive claude pty session manager (anton-bm4.1). anton runs as a single long-lived Node
 * process (`next start`), so live pty processes live in this module-level singleton: spawn an
 * interactive `claude` in a project's repo, buffer its output for replay, fan it out to any number
 * of attached SSE streams, accept keystrokes/resizes back, and tear it down cleanly on exit or
 * explicit kill. Distinct from the headless driver (`claude -p`, one-shot, log-tailed): shaping is
 * a conversation, so it needs a real bidirectional terminal. See DESIGN.md §5.
 *
 * The core `PtyManager` is dependency-injected (spawn + lifecycle hook) so it unit-tests against a
 * fake pty with no native module; the exported `ptyManager` singleton wires it to real node-pty
 * (lazily `require`d so the native addon never loads at build/import time) and the sessions table.
 */
import { createRequire } from "node:module";

/** Minimal shape of a live pty we depend on — a subset of node-pty's `IPty`. */
export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Spawn a pty. Injected so tests supply a fake and the singleton supplies real node-pty. */
export type SpawnFn = (opts: {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}) => PtyLike;

/** An event fanned out to every attached listener of a session. */
export type PtyEvent =
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number; signal?: number };

export type PtyListener = (event: PtyEvent) => void;

export interface SpawnSessionInput {
  /** Caller-owned id — the same id used for the `sessions` row and the SSE routes. */
  sessionId: string;
  cwd: string;
  /** The binary to run (the claude bin for real sessions). */
  file: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

/** Live status of a session held by the manager. */
export type PtySessionStatus = "running" | "exited";

export interface AttachHandle {
  /** Buffered output emitted before this listener attached (repaints a reconnecting terminal). */
  replay: string;
  status: PtySessionStatus;
  /** Present once the pty has exited — lets a late attacher close immediately. */
  exit?: { exitCode: number; signal?: number };
  /** Stop receiving events. Idempotent. */
  detach: () => void;
}

export interface PtyManagerDeps {
  spawn: SpawnFn;
  /**
   * Persist terminal state when a pty exits (clean exit → "done", otherwise "failed"). Best-effort:
   * a rejected promise is swallowed so a telemetry hiccup never crashes the live process.
   */
  onExit?: (sessionId: string, status: "done" | "failed") => void | Promise<void>;
  /** ms an exited session lingers (for a final replay) before being reaped. Default 5 min. */
  reapMs?: number;
  /** Max buffered output chars retained per session for replay. Default 256K. */
  bufferLimit?: number;
  /** Injectable for deterministic reap tests. Defaults to global setTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => { unref?: () => void };
  clearTimeoutFn?: (handle: unknown) => void;
}

interface Session {
  id: string;
  pty: PtyLike;
  buffer: string;
  listeners: Set<PtyListener>;
  status: PtySessionStatus;
  exit?: { exitCode: number; signal?: number };
  reapHandle?: unknown;
}

const DEFAULT_BUFFER_LIMIT = 256 * 1024;
const DEFAULT_REAP_MS = 5 * 60 * 1000;

/** Keep only the trailing `limit` chars — a bounded replay window for reconnecting terminals. */
function appendBounded(buffer: string, data: string, limit: number): string {
  const combined = buffer + data;
  return combined.length > limit ? combined.slice(combined.length - limit) : combined;
}

export class PtyManager {
  private sessions = new Map<string, Session>();
  private readonly bufferLimit: number;
  private readonly reapMs: number;
  private readonly setTimeoutFn: NonNullable<PtyManagerDeps["setTimeoutFn"]>;
  private readonly clearTimeoutFn: NonNullable<PtyManagerDeps["clearTimeoutFn"]>;

  constructor(private readonly deps: PtyManagerDeps) {
    this.bufferLimit = deps.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
    this.reapMs = deps.reapMs ?? DEFAULT_REAP_MS;
    this.setTimeoutFn =
      deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms) as unknown as { unref?: () => void });
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Spawn a new interactive pty. Throws if `sessionId` is already live. Returns the id. */
  spawn(input: SpawnSessionInput): string {
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`pty session already exists: ${input.sessionId}`);
    }

    const pty = this.deps.spawn({
      file: input.file,
      args: input.args ?? [],
      cwd: input.cwd,
      env: input.env ?? process.env,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
    });

    const session: Session = {
      id: input.sessionId,
      pty,
      buffer: "",
      listeners: new Set(),
      status: "running",
    };
    this.sessions.set(input.sessionId, session);

    pty.onData((data) => {
      session.buffer = appendBounded(session.buffer, data, this.bufferLimit);
      for (const listener of session.listeners) listener({ type: "data", data });
    });

    pty.onExit(({ exitCode, signal }) => {
      if (session.status === "exited") return;
      session.status = "exited";
      session.exit = { exitCode, signal };
      for (const listener of session.listeners) listener({ type: "exit", exitCode, signal });
      this.persistExit(session.id, exitCode === 0 ? "done" : "failed");
      // Linger briefly so a reconnecting terminal can still replay + observe the exit, then reap.
      const handle = this.setTimeoutFn(() => this.sessions.delete(session.id), this.reapMs);
      handle.unref?.();
      session.reapHandle = handle;
    });

    return input.sessionId;
  }

  /** Best-effort terminal-state persistence — never let a telemetry failure escape a pty callback. */
  private persistExit(id: string, status: "done" | "failed"): void {
    try {
      void Promise.resolve(this.deps.onExit?.(id, status)).catch(() => {});
    } catch {
      // onExit threw synchronously — swallow; the live process must not crash over telemetry.
    }
  }

  /** True while the manager holds this session (running or lingering post-exit). */
  has(id: string): boolean {
    return this.sessions.has(id);
  }

  status(id: string): PtySessionStatus | undefined {
    return this.sessions.get(id)?.status;
  }

  /**
   * Subscribe to a session's output. Returns the buffered replay + current status so the caller can
   * repaint and, if the pty already exited, close immediately. `undefined` if no such session.
   */
  attach(id: string, listener: PtyListener): AttachHandle | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.listeners.add(listener);
    return {
      replay: session.buffer,
      status: session.status,
      exit: session.exit,
      detach: () => {
        session.listeners.delete(listener);
      },
    };
  }

  /** Write bytes to a running pty's stdin. Returns false if the session is gone or exited. */
  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.status !== "running") return false;
    session.pty.write(data);
    return true;
  }

  /** Resize a running pty. Returns false if the session is gone or exited. */
  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session || session.status !== "running") return false;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return false;
    session.pty.resize(Math.floor(cols), Math.floor(rows));
    return true;
  }

  /**
   * Tear a session down: kill the pty (if still running) and drop it immediately. Notifies attached
   * listeners of the exit so their streams close. Returns false if there was no such session.
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.reapHandle) this.clearTimeoutFn(session.reapHandle);
    if (session.status === "running") {
      // An intentional teardown is a clean end: kill the pty, notify listeners, and persist "done".
      // (The pty's own async onExit then early-returns, since status is already "exited".)
      try {
        session.pty.kill();
      } catch {
        // Already dead — fall through to cleanup.
      }
      session.status = "exited";
      for (const listener of session.listeners) listener({ type: "exit", exitCode: 0 });
      this.persistExit(id, "done");
    }
    this.sessions.delete(id);
    return true;
  }

  /** Kill every live session — used on server shutdown so no claude pty is orphaned. */
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

// ── Default singleton, wired to real node-pty + the sessions table ────────────────────────────

/** Override the claude binary (matches the headless driver's env). */
export const CLAUDE_BIN_ENV = "ANTON_CLAUDE_BIN";

let _nodePtySpawn: SpawnFn | null = null;

/** Lazily `require` node-pty (a native addon) only when a session is actually spawned. */
function realSpawn(opts: Parameters<SpawnFn>[0]): PtyLike {
  if (!_nodePtySpawn) {
    const require = createRequire(import.meta.url);
    const nodePty = require("node-pty") as {
      spawn: (
        file: string,
        args: string[],
        options: { name: string; cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
      ) => PtyLike;
    };
    _nodePtySpawn = ({ file, args, cwd, env, cols, rows }) =>
      nodePty.spawn(file, args, { name: "xterm-256color", cwd, env, cols, rows });
  }
  return _nodePtySpawn(opts);
}

let _ptyManager: PtyManager | null = null;

/**
 * The process-wide interactive pty manager. Persists each session's terminal state to the sessions
 * table on exit (best-effort) and is torn down on server shutdown. API routes create the `sessions`
 * row themselves before spawning, so this only owns the live pty + the exit-status write.
 */
export function getPtyManager(): PtyManager {
  if (_ptyManager) return _ptyManager;
  _ptyManager = new PtyManager({
    spawn: realSpawn,
    onExit: async (sessionId, status) => {
      const { getDb } = await import("../db");
      const { endSession } = await import("../sessions");
      const { systemClock } = await import("../jobs/queue");
      await endSession(getDb(), systemClock, sessionId, status);
    },
  });

  // Kill any live pty on shutdown so no claude process is orphaned. `exit` allows only sync work;
  // pty.kill is sync, so this is safe. Registered once, guarded against duplicate handlers.
  if (!process.env.ANTON_PTY_NO_EXIT_HANDLER) {
    const manager = _ptyManager;
    process.once("exit", () => manager.killAll());
  }

  return _ptyManager;
}
