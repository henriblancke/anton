import { describe, expect, it, vi } from "vitest";
import { createDoltSync, getSyncStatus, type SyncMode } from "./bd";
import { createSyncEngine, type SyncEngineDeps } from "./sync-engine";

const silentLog = { info: () => {}, error: () => {} };

/** Engine with manual time + injected pull; tests drive tick() directly (start() only loops it). */
function engineWith(overrides: Partial<SyncEngineDeps> & { pull: SyncEngineDeps["pull"] }) {
  let now = 0;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const engine = createSyncEngine({
    heartbeatMs: 10_000,
    notWiredRecheckMs: 60_000,
    maxBackoffMs: 60_000,
    log: silentLog,
    now: clock.now,
    ...overrides,
  });
  return { engine, clock };
}

const projects = (...paths: string[]) =>
  Promise.resolve(paths.map((repoPath) => ({ repoPath, hasBeads: true })));

describe("createSyncEngine", () => {
  it("pulls every registered beads project on a tick", async () => {
    const pulled: string[] = [];
    const { engine } = engineWith({
      listProjects: () => projects("/a", "/b"),
      pull: async (cwd) => {
        pulled.push(cwd);
      },
    });
    await engine.tick();
    expect(pulled.sort()).toEqual(["/a", "/b"]);
  });

  it("skips projects without a beads workspace", async () => {
    const pulled: string[] = [];
    const { engine } = engineWith({
      listProjects: () =>
        Promise.resolve([
          { repoPath: "/beads", hasBeads: true },
          { repoPath: "/plain", hasBeads: false },
        ]),
      pull: async (cwd) => {
        pulled.push(cwd);
      },
    });
    await engine.tick();
    expect(pulled).toEqual(["/beads"]);
  });

  it("does not re-pull a project before its heartbeat is due", async () => {
    const pulled: string[] = [];
    const { engine, clock } = engineWith({
      listProjects: () => projects("/a"),
      pull: async (cwd) => {
        pulled.push(cwd);
      },
    });
    await engine.tick();
    await engine.tick(); // not due yet
    expect(pulled).toEqual(["/a"]);
    clock.advance(10_000);
    await engine.tick();
    expect(pulled).toEqual(["/a", "/a"]);
  });

  it("a not-wired project drops to the slow recheck cadence and recovers to full rate", async () => {
    // Real coalescer so the status registry drives the cadence decision.
    let wired = false;
    const cwd = `/engine-unwired-${Math.random()}`;
    const sync = createDoltSync(async () => {
      if (!wired) {
        throw Object.assign(new Error("bd"), { stderr: "No remote is configured — skipping.\n" });
      }
      return "";
    });
    const pulled: number[] = [];
    const { engine, clock } = engineWith({
      listProjects: () => projects(cwd),
      pull: (c) => {
        pulled.push(clock.now());
        return sync(c, "pull" as SyncMode);
      },
    });

    await engine.tick();
    expect(getSyncStatus(cwd).state).toBe("not-wired");
    clock.advance(10_000);
    await engine.tick(); // heartbeat cadence — not due (slow recheck is 60s)
    expect(pulled).toHaveLength(1);
    clock.advance(50_000);
    await engine.tick(); // 60s elapsed — recheck fires
    expect(pulled).toHaveLength(2);

    wired = true;
    clock.advance(60_000);
    await engine.tick();
    expect(getSyncStatus(cwd).state).toBe("synced");
    clock.advance(10_000);
    await engine.tick(); // back to full-rate heartbeats
    expect(pulled).toHaveLength(4);
  });

  it("a failing project backs off (doubling, capped) instead of tight-retrying", async () => {
    const pulled: number[] = [];
    const { engine, clock } = engineWith({
      listProjects: () => projects("/flaky"),
      pull: async () => {
        pulled.push(clock.now());
        throw new Error("connection reset");
      },
    });
    await engine.tick(); // t=0 → backoff 20s
    clock.advance(10_000);
    await engine.tick(); // t=10s — not due
    expect(pulled).toHaveLength(1);
    clock.advance(10_000);
    await engine.tick(); // t=20s — due → backoff 40s
    expect(pulled).toHaveLength(2);
    clock.advance(40_000);
    await engine.tick(); // t=60s — due → backoff capped at 60s
    expect(pulled).toHaveLength(3);
  });

  it("one project's failure doesn't starve the others", async () => {
    const pulled: string[] = [];
    const { engine } = engineWith({
      listProjects: () => projects("/bad", "/good"),
      pull: async (cwd) => {
        pulled.push(cwd);
        if (cwd === "/bad") throw new Error("boom");
      },
    });
    await engine.tick();
    expect(pulled.sort()).toEqual(["/bad", "/good"]);
  });

  it("start() is idempotent and stop() halts the loop", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const { engine } = engineWith({
      listProjects: () => {
        ticks += 1;
        return projects();
      },
      pull: async () => {},
    });
    engine.start();
    engine.start(); // no double loop
    expect(ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    engine.stop();
    expect(ticks).toBe(1);
    vi.useRealTimers();
  });
});
