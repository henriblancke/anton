import { describe, expect, it, vi } from "vitest";
import { createDoltSync, getSyncStatus, type SyncRequest } from "./bd";
import { createSyncEngine, type SyncEngineDeps } from "./sync-engine";

const silentLog = { info: () => {}, error: () => {} };

/** A promisified-execFile-shaped failure: message + captured stdout/stderr. */
const execError = (out: { stdout?: string; stderr?: string }) =>
  Object.assign(new Error("Command failed: bd"), out);

/** Engine with manual time + injected sync; tests drive tick() directly (start() only loops it). */
function engineWith(overrides: Partial<SyncEngineDeps> & { sync: SyncEngineDeps["sync"] }) {
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
      sync: async (cwd) => {
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
      sync: async (cwd) => {
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
      sync: async (cwd) => {
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
      sync: (c) => {
        pulled.push(clock.now());
        return sync(c, "backstop" as SyncRequest);
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
      sync: async () => {
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
      sync: async (cwd) => {
        pulled.push(cwd);
        if (cwd === "/bad") throw new Error("boom");
      },
    });
    await engine.tick();
    expect(pulled.sort()).toEqual(["/bad", "/good"]);
  });

  it("backstop pushes on the beat when the repo is ahead, and retries until the push lands", async () => {
    // Real coalescer so the ahead-of-remote flag drives the backstop through injected exec.
    const cwd = `/engine-ahead-${Math.random()}`;
    let pushFails = true;
    const pushes: number[] = [];
    const sync = createDoltSync(async (_c, args) => {
      if (args[1] === "push") {
        pushes.push(1);
        if (pushFails) throw execError({ stderr: "Error: push failed: connection reset" });
      }
      return "";
    });
    // A write-nudged full pass whose push fails leaves the repo committed-but-unpushed (ahead).
    await sync(cwd, "full").catch(() => {});
    expect(pushes).toHaveLength(1);

    const { engine, clock } = engineWith({
      listProjects: () => projects(cwd),
      sync: (c) => sync(c, "backstop" as SyncRequest),
    });

    await engine.tick(); // ahead → backstop retries the push (still failing → beat backs off)
    expect(pushes).toHaveLength(2);

    pushFails = false;
    clock.advance(20_000); // clear the failure backoff so the beat is due again
    await engine.tick(); // still ahead → retries → lands this time
    expect(pushes).toHaveLength(3);
    expect(getSyncStatus(cwd).state).toBe("synced");

    clock.advance(10_000);
    await engine.tick(); // no longer ahead → pull-only, no further pushes
    expect(pushes).toHaveLength(3);
  });

  it("backstop reconciles once on the cold-start beat, then stays quiet for a repo that is not ahead", async () => {
    const cwd = `/engine-idle-${Math.random()}`;
    const pushes: string[] = [];
    const sync = createDoltSync(async (c, args) => {
      if (args[1] === "push") pushes.push(c);
      return "";
    });
    const { engine, clock } = engineWith({
      listProjects: () => projects(cwd),
      sync: (c) => sync(c, "backstop" as SyncRequest),
    });
    await engine.tick(); // cold start: one reconciling full pass (its push lands) — count can't survive a restart
    expect(pushes).toEqual([cwd]);
    clock.advance(10_000);
    await engine.tick(); // reconciled + not ahead → pull-only
    clock.advance(10_000);
    await engine.tick();
    expect(pushes).toEqual([cwd]); // no further pushes — idle stays quiet after the reconcile
    expect(getSyncStatus(cwd).state).toBe("synced");
  });

  it("start() is idempotent and stop() halts the loop", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const { engine } = engineWith({
      listProjects: () => {
        ticks += 1;
        return projects();
      },
      sync: async () => {},
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
