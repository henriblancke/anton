/**
 * anton-bm4.1: the interactive pty session manager. Exercised against a fake pty (no native module)
 * so the lifecycle is deterministic: spawn → buffer + fan-out → bidirectional write/resize → clean
 * teardown on exit and on explicit kill, plus replay for reconnecting attachers.
 */
import { describe, expect, it, vi } from "vitest";

import { PtyManager, type PtyEvent, type PtyLike, type SpawnFn } from "./manager";

/** A controllable in-memory pty: drives onData/onExit and records writes/resizes/kills. */
class FakePty implements PtyLike {
  readonly pid = 4242;
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  onData(cb: (data: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitCb = cb;
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }
  kill() {
    this.killed = true;
  }

  emit(data: string) {
    this.dataCb?.(data);
  }
  exit(exitCode: number, signal?: number) {
    this.exitCb?.({ exitCode, signal });
  }
}

function setup(deps: Partial<Parameters<typeof makeManager>[0]> = {}) {
  return makeManager(deps);
}

function makeManager(overrides: {
  onExit?: (id: string, status: "done" | "failed") => void;
  reapMs?: number;
  bufferLimit?: number;
} = {}) {
  const pty = new FakePty();
  const spawn: SpawnFn = vi.fn(() => pty);
  // Immediate, deterministic reap timer so post-exit reaping is testable without real time.
  const timers: Array<() => void> = [];
  const manager = new PtyManager({
    spawn,
    onExit: overrides.onExit,
    reapMs: overrides.reapMs ?? 1000,
    bufferLimit: overrides.bufferLimit,
    setTimeoutFn: (cb) => {
      timers.push(cb);
      return { unref: () => {} };
    },
    clearTimeoutFn: () => {},
  });
  return { manager, pty, spawn, runReapTimers: () => timers.splice(0).forEach((t) => t()) };
}

describe("PtyManager", () => {
  it("spawns a session and streams live output to an attached listener", () => {
    const { manager, pty, spawn } = setup();
    manager.spawn({ sessionId: "s1", file: "claude", args: ["-x"], cwd: "/repo" });

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ file: "claude", args: ["-x"], cwd: "/repo", cols: 80, rows: 24 }),
    );

    const events: PtyEvent[] = [];
    const attach = manager.attach("s1", (e) => events.push(e));
    expect(attach?.replay).toBe("");
    expect(attach?.status).toBe("running");

    pty.emit("hello ");
    pty.emit("world");
    expect(events).toEqual([
      { type: "data", data: "hello " },
      { type: "data", data: "world" },
    ]);
  });

  it("replays buffered output to a listener that attaches after data was emitted", () => {
    const { manager, pty } = setup();
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    pty.emit("line one\r\n");
    pty.emit("line two\r\n");

    const events: PtyEvent[] = [];
    const attach = manager.attach("s1", (e) => events.push(e));
    // Replay carries everything emitted before attach; the listener only sees *future* events.
    expect(attach?.replay).toBe("line one\r\nline two\r\n");
    expect(events).toEqual([]);

    pty.emit("line three\r\n");
    expect(events).toEqual([{ type: "data", data: "line three\r\n" }]);
  });

  it("fans output out to multiple attached listeners", () => {
    const { manager, pty } = setup();
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    const a: PtyEvent[] = [];
    const b: PtyEvent[] = [];
    manager.attach("s1", (e) => a.push(e));
    manager.attach("s1", (e) => b.push(e));
    pty.emit("x");
    expect(a).toEqual([{ type: "data", data: "x" }]);
    expect(b).toEqual([{ type: "data", data: "x" }]);
  });

  it("bounds the replay buffer to the configured limit", () => {
    const { manager, pty } = setup({ bufferLimit: 5 });
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    pty.emit("abcdefgh");
    const attach = manager.attach("s1", () => {});
    expect(attach?.replay).toBe("defgh");
  });

  it("writes keystrokes and resizes back to the pty (bidirectional)", () => {
    const { manager, pty } = setup();
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });

    expect(manager.write("s1", "ls\r")).toBe(true);
    expect(pty.writes).toEqual(["ls\r"]);

    expect(manager.resize("s1", 120, 40)).toBe(true);
    expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("rejects invalid resize geometry without touching the pty", () => {
    const { manager, pty } = setup();
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    expect(manager.resize("s1", 0, 40)).toBe(false);
    expect(manager.resize("s1", 80, Number.NaN)).toBe(false);
    expect(pty.resizes).toEqual([]);
  });

  it("marks status exited, notifies listeners, and persists on natural exit", () => {
    const onExit = vi.fn();
    const { manager, pty, runReapTimers } = setup({ onExit });
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    const events: PtyEvent[] = [];
    manager.attach("s1", (e) => events.push(e));

    pty.emit("bye\r\n");
    pty.exit(0);

    expect(events).toEqual([
      { type: "data", data: "bye\r\n" },
      { type: "exit", exitCode: 0, signal: undefined },
    ]);
    expect(onExit).toHaveBeenCalledWith("s1", "done");
    expect(manager.status("s1")).toBe("exited");

    // A late attacher still replays the final buffer and learns it exited.
    const late = manager.attach("s1", () => {});
    expect(late?.status).toBe("exited");
    expect(late?.replay).toBe("bye\r\n");
    expect(late?.exit).toEqual({ exitCode: 0, signal: undefined });

    // After the grace period the session is reaped.
    runReapTimers();
    expect(manager.has("s1")).toBe(false);
  });

  it("persists a non-zero exit as failed", () => {
    const onExit = vi.fn();
    const { manager, pty } = setup({ onExit });
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    pty.exit(1);
    expect(onExit).toHaveBeenCalledWith("s1", "failed");
  });

  it("write/resize on an exited session return false", () => {
    const { manager, pty } = setup();
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    pty.exit(0);
    expect(manager.write("s1", "x")).toBe(false);
    expect(manager.resize("s1", 80, 24)).toBe(false);
  });

  it("kill tears the session down cleanly, notifies listeners, and persists done", () => {
    const onExit = vi.fn();
    const { manager, pty } = setup({ onExit });
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    const events: PtyEvent[] = [];
    manager.attach("s1", (e) => events.push(e));

    expect(manager.kill("s1")).toBe(true);
    expect(pty.killed).toBe(true);
    expect(events).toEqual([{ type: "exit", exitCode: 0 }]);
    expect(onExit).toHaveBeenCalledWith("s1", "done");
    expect(manager.has("s1")).toBe(false);
    // Idempotent: killing/attaching a gone session is a no-op.
    expect(manager.kill("s1")).toBe(false);
    expect(manager.attach("s1", () => {})).toBeUndefined();
  });

  it("killAll tears down every live session", () => {
    const spawns: FakePty[] = [];
    const manager = new PtyManager({
      spawn: () => {
        const p = new FakePty();
        spawns.push(p);
        return p;
      },
      setTimeoutFn: () => ({ unref: () => {} }),
      clearTimeoutFn: () => {},
    });
    manager.spawn({ sessionId: "a", file: "claude", cwd: "/repo" });
    manager.spawn({ sessionId: "b", file: "claude", cwd: "/repo" });
    manager.killAll();
    expect(manager.has("a")).toBe(false);
    expect(manager.has("b")).toBe(false);
    expect(spawns.every((p) => p.killed)).toBe(true);
  });

  it("rejects a duplicate session id", () => {
    const { manager } = setup();
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    expect(() => manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" })).toThrow(
      /already exists/,
    );
  });

  it("detach stops a listener from receiving further events", () => {
    const { manager, pty } = setup();
    manager.spawn({ sessionId: "s1", file: "claude", cwd: "/repo" });
    const events: PtyEvent[] = [];
    const attach = manager.attach("s1", (e) => events.push(e));
    pty.emit("one");
    attach?.detach();
    pty.emit("two");
    expect(events).toEqual([{ type: "data", data: "one" }]);
  });
});
