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
}

/** A fake child process: an EventEmitter carrying the two output streams and a no-op kill. */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { destroy: () => {} });
  stderr = Object.assign(new EventEmitter(), { destroy: () => {} });
  pid = 4242;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/**
 * Build a `spawn` replacement that records every invocation into `calls` and answers each with a
 * clean exit-0 and no output. Pair it with `vi.mock("node:child_process", …)`.
 */
export function makeFakeSpawn(calls: FakeSpawnCall[]) {
  return (file: string, args: string[] = [], options?: Record<string, unknown>) => {
    calls.push({ file, args, options });
    const child = new FakeChild();
    // Async, so listeners registered after the spawn call still see every event.
    setImmediate(() => {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  };
}
