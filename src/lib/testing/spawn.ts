/**
 * Test-only: a minimal `child_process.spawn` stand-in for argv-level unit tests — suites that assert
 * WHICH command a wrapper invoked, with no real subprocess involved.
 *
 * Only what the callers under test actually touch is implemented: `stdout`/`stderr` as emitters, a
 * `pid`, a no-op `kill`, and an `exit` → `close` pair on the next tick (in that order, as Node emits
 * them). A wrapper that settles on `exit` plus a bounded stdio drain — bd.ts does, deliberately
 * (anton-jfjw.1) — still settles immediately here, because `close` follows.
 *
 * Suites that need real process semantics (reaping, hangs, signals) must drive a real script instead;
 * see beads/bd-timeout.test.ts.
 */
import { EventEmitter } from "node:events";

export interface FakeSpawnCall {
  file: string;
  args: string[];
  options: Record<string, unknown> | undefined;
  /** Everything the caller wrote to the child's stdin — undefined when it never wrote any. */
  stdin?: string;
}

/** A fake child process: an EventEmitter carrying the three stdio streams and a no-op kill. */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { destroy: () => {} });
  stderr = Object.assign(new EventEmitter(), { destroy: () => {} });
  /** Records what the caller piped in (`bd batch` reads its commands from stdin) onto its call. */
  stdin: EventEmitter & { write(c?: unknown): boolean; end(c?: unknown): void; destroy(): void };
  pid = 4242;
  killed = false;

  constructor(call: FakeSpawnCall) {
    super();
    const record = (chunk?: unknown) => {
      if (chunk === undefined) return;
      call.stdin = (call.stdin ?? "") + String(chunk);
    };
    this.stdin = Object.assign(new EventEmitter(), {
      write: (c?: unknown) => (record(c), true),
      end: record,
      destroy: () => {},
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/** What a faked invocation answers with. Every field is optional — the default is a clean exit-0. */
export interface FakeSpawnReply {
  code?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Build a `spawn` replacement that records every invocation into `calls` and answers each with a
 * clean exit-0 and no output. Pair it with `vi.mock("node:child_process", …)`.
 *
 * `respond` overrides that answer per call — the seam for suites that need a wrapper's FAILURE
 * path (a non-zero exit plus the stderr the wrapper matches on), not just its argv.
 */
export function makeFakeSpawn(
  calls: FakeSpawnCall[],
  respond?: (call: FakeSpawnCall) => FakeSpawnReply | undefined,
) {
  return (file: string, args: string[] = [], options?: Record<string, unknown>) => {
    const call: FakeSpawnCall = { file, args, options };
    calls.push(call);
    const child = new FakeChild(call);
    // Resolved at spawn time, not at emit time: a suite that rearms `respond` between cases must
    // not have that land on a child already in flight.
    const { code = 0, stdout, stderr } = respond?.(call) ?? {};
    // Async, so listeners registered after the spawn call still see every event.
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("exit", code, null);
      child.emit("close", code, null);
    });
    return child;
  };
}
