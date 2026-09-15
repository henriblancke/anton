/**
 * Host-wide verify-gate lock (anton-0oi). Covers the three properties the callers rely on: real
 * mutual exclusion, advisory (never-wedging) behavior under contention, and reclaim of a lock whose
 * owner died. Lock names are unique per test because the lock root is a real shared /tmp directory.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { withHostLock } from "./host-lock";

const LOCK_ROOT = join(tmpdir(), "anton-host-locks");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Markers used to scope the node:fs/promises interception below to exactly one test each, so the
// injected races never leak into the rest of the suite's real filesystem timing.
const { RESUME_MARKER, GATE_MARKER, FIRST_STAT_MARKER, WRITE_VANISH_MARKER, SUCCESSOR_TOKEN } = vi.hoisted(() => ({
  RESUME_MARKER: "test-resume-corrupt",
  GATE_MARKER: "test-gate-ownership",
  FIRST_STAT_MARKER: "test-first-snapshot-corrupt",
  WRITE_VANISH_MARKER: "test-write-vanish",
  SUCCESSOR_TOKEN: "11111111-1111-4111-8111-111111111111",
}));

// All races below hinge on a pause between two specific awaits inside host-lock.ts that real
// timing can't force deterministically (they'd need an actual 60s+ stall). Intercepting the fs
// call that sits at the seam lets the peer's race action run at exactly the right moment instead.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const statCalls = new Map<string, number>();
  const readFileCalls = new Map<string, number>();

  const installSuccessor = async (dir: string) => {
    await actual.rename(dir, `${dir}.retired-${SUCCESSOR_TOKEN}`);
    await actual.mkdir(dir);
    await actual.writeFile(
      `${dir}/owner.json`,
      JSON.stringify({ token: SUCCESSOR_TOKEN, pid: process.pid, heartbeatAt: Date.now(), label: "successor" }),
      "utf8",
    );
  };

  return {
    ...actual,
    // Fires on the 2nd stat(dir) for the resume-corrupt test — the identity re-check inside
    // write(), right after the first stat captured our own acquisition's mtime. Simulates a peer
    // fully reclaiming and re-acquiring `dir` in the gap.
    //
    // Fires on the 1st stat(dir) for the first-snapshot-corrupt test — the very capture of
    // `ourDirStat` right after our own mkdir(dir) resolved. Simulates a peer reclaiming `dir` and
    // re-acquiring it before this creator ever gets to observe its own, correct identity.
    stat: async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && (path.includes(RESUME_MARKER) || path.includes(FIRST_STAT_MARKER))) {
        const n = (statCalls.get(path) ?? 0) + 1;
        statCalls.set(path, n);
        const fireAt = path.includes(FIRST_STAT_MARKER) ? 1 : 2;
        if (n === fireAt) {
          await installSuccessor(path);
        }
      }
      // @ts-expect-error -- forwarding whatever arguments the caller passed
      return actual.stat(path, ...rest);
    },
    // Fires on the 2nd readFile(metaPath) for the gate-ownership test — reclaim()'s own
    // readHolder(), right after it captured its own gate's mtime. Simulates a peer reaping that
    // (apparently stale) gate and creating its own replacement in the gap.
    readFile: async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.includes(GATE_MARKER) && path.endsWith("owner.json")) {
        const n = (readFileCalls.get(path) ?? 0) + 1;
        readFileCalls.set(path, n);
        if (n === 2) {
          const dir = path.slice(0, -"/owner.json".length);
          const gate = `${dir}.reclaiming`;
          await actual.rm(gate, { recursive: true, force: true }).catch(() => {});
          await actual.mkdir(gate);
        }
      }
      // @ts-expect-error -- forwarding whatever arguments the caller passed
      return actual.readFile(path, ...rest);
    },
    // Fires on the metadata write for the write-vanish test — simulates `dir` being reclaimed out
    // from under a live acquisition in the gap write() itself introduces (after its own ownership
    // checks pass, before the write that publishes/refreshes metadata actually lands).
    writeFile: async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.includes(WRITE_VANISH_MARKER) && path.endsWith(".tmp")) {
        const dir = path.slice(0, path.indexOf("/owner.json."));
        await actual.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      // @ts-expect-error -- forwarding whatever arguments the caller passed
      return actual.writeFile(path, ...rest);
    },
  };
});

describe("withHostLock", () => {
  it("serializes concurrent holders of the same lock", async () => {
    const name = `test-mutex-${process.pid}`;
    let active = 0;
    let maxActive = 0;

    const section = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(50);
      active--;
    };

    await Promise.all([
      withHostLock(name, section),
      withHostLock(name, section),
      withHostLock(name, section),
    ]);

    // The whole point: never two at once.
    expect(maxActive).toBe(1);
  });

  it("does not serialize different lock names", async () => {
    let active = 0;
    let maxActive = 0;
    const section = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(50);
      active--;
    };

    await Promise.all([
      withHostLock(`test-a-${process.pid}`, section),
      withHostLock(`test-b-${process.pid}`, section),
    ]);

    expect(maxActive).toBe(2);
  });

  it("releases the lock when the section throws", async () => {
    const name = `test-throw-${process.pid}`;

    await expect(withHostLock(name, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    // A leaked lock would make this second acquire wait out its full budget instead of running now.
    let ran = false;
    await withHostLock(name, async () => {
      ran = true;
    }, { maxWaitMs: 200 });
    expect(ran).toBe(true);
  });

  it("runs anyway (advisory) when a live peer holds the lock past maxWaitMs", async () => {
    const name = `test-advisory-${process.pid}`;
    const order: string[] = [];

    // Holder keeps the lock well past the waiter's budget. The waiter must still run — a wedged
    // queue is worse than an unsynchronized gate.
    const holder = withHostLock(name, async () => {
      order.push("holder-start");
      await sleep(600);
      order.push("holder-end");
    });

    await sleep(50); // let the holder acquire first
    await withHostLock(name, async () => order.push("waiter"), { maxWaitMs: 100 });
    await holder;

    expect(order).toEqual(["holder-start", "waiter", "holder-end"]);
  });

  it("reclaims a lock whose owner process is gone", async () => {
    const name = `test-stale-${process.pid}`;
    const dir = join(LOCK_ROOT, name);
    await mkdir(dir, { recursive: true });
    // PID 2^22 is above the max on Linux and macOS, so it can never be a live process.
    await writeFile(
      join(dir, "owner.json"),
      JSON.stringify({ token: randomUUID(), pid: 4194304, heartbeatAt: Date.now(), label: "dead" }),
      "utf8",
    );

    let ran = false;
    // Short budget: this can only pass by reclaiming, not by waiting the holder out.
    await withHostLock(name, async () => {
      ran = true;
    }, { maxWaitMs: 200 });

    expect(ran).toBe(true);
  });

  it("reclaims an orphaned lock dir that never got its owner.json written", async () => {
    const name = `test-orphan-stale-${process.pid}`;
    const dir = join(LOCK_ROOT, name);
    // Models a process killed between `mkdir` and the metadata write: the dir exists, empty, with
    // no owner.json. Backdate its mtime past the stale window so it reads as an old orphan rather
    // than a peer that just started.
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    await utimes(dir, old, old);

    let ran = false;
    const start = Date.now();
    // Large budget: a genuine reclaim finishes almost instantly. A regression to the old
    // `holder?.token && retire(...)` short-circuit (which can never fire for a metadata-less
    // holder) would instead fall through to the advisory wait-out-the-budget path, which a small
    // maxWaitMs can't distinguish from success — so use a budget big enough that only a real
    // reclaim finishes inside it.
    await withHostLock(name, async () => {
      ran = true;
    }, { maxWaitMs: 5000 });
    const elapsedMs = Date.now() - start;

    expect(ran).toBe(true);
    expect(elapsedMs).toBeLessThan(1000);

    // The reclaim path retires the orphan to a token-specific tombstone before re-acquiring the
    // live path — a fingerprint the advisory fallback never produces, since it never touches `dir`.
    const siblings = await readdir(LOCK_ROOT);
    expect(siblings.some((entry) => entry.startsWith(`${name}.retired-`))).toBe(true);
  });

  it("does not steal a metadata-less lock dir still inside the stale window", async () => {
    const name = `test-orphan-fresh-${process.pid}`;
    const dir = join(LOCK_ROOT, name);
    // Same empty, metadata-less dir, but freshly created — a peer could be mid-write right now, so
    // it must be waited on rather than reclaimed.
    await mkdir(dir, { recursive: true });

    let ran = false;
    await withHostLock(name, async () => {
      ran = true;
    }, { maxWaitMs: 100 });

    // Advisory fallback still lets it run unlocked once the budget elapses, but the original dir
    // must still be standing at its live path — reclaimed dirs get renamed away by `retire`.
    expect(ran).toBe(true);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("does not let a second stale reclaimer remove the live path", async () => {
    const name = `test-reclaim-race-${process.pid}`;
    const dir = join(LOCK_ROOT, name);
    const oldToken = randomUUID();
    // The existing tombstone means another waiter already reclaimed this acquisition. Model the
    // race window by putting a successor at the live path while this delayed waiter still holds the
    // old metadata it read. Its token-specific rename must fail rather than moving the successor.
    await mkdir(`${dir}.retired-${oldToken}`, { recursive: true });
    await writeFile(join(`${dir}.retired-${oldToken}`, "owner.json"), "old", "utf8");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "owner.json"),
      JSON.stringify({ token: oldToken, pid: 4194304, heartbeatAt: Date.now(), label: "stale read" }),
      "utf8",
    );

    await withHostLock(name, async () => {}, { maxWaitMs: 25 });

    const stillLive = JSON.parse(await readFile(join(dir, "owner.json"), "utf8")) as { token: string };
    expect(stillLive.token).toBe(oldToken);
  });

  it("reaps an orphaned reclaiming gate left by a killed reclaimer", async () => {
    const name = `test-reclaim-gate-orphan-${process.pid}`;
    const dir = join(LOCK_ROOT, name);
    const gate = `${dir}.reclaiming`;
    // An orphaned holder dir, old enough to be reclaimable...
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    await utimes(dir, old, old);
    // ...but a `.reclaiming` gate left behind by an earlier reclaimer that was killed between its
    // own `mkdir(gate)` and the `finally`'s `rm(gate)`. Backdated past STALE_AFTER_MS so it reads
    // as abandoned too, rather than a live decision in progress.
    await mkdir(gate, { recursive: true });
    await utimes(gate, old, old);

    let ran = false;
    const start = Date.now();
    // Without reaping, `mkdir(gate)` keeps hitting EEXIST forever and reclaim() always returns
    // false, so this can only pass by waiting out the full advisory budget — use a budget large
    // enough that only an actual reclaim (one poll cycle to reap the gate, then a second to retire
    // the dir) finishes inside it.
    await withHostLock(name, async () => {
      ran = true;
    }, { maxWaitMs: 5000 });
    const elapsedMs = Date.now() - start;

    expect(ran).toBe(true);
    expect(elapsedMs).toBeLessThan(4000);
    const siblings = await readdir(LOCK_ROOT);
    expect(siblings.some((entry) => entry.startsWith(`${name}.retired-`))).toBe(true);
  });

  it("does not let two concurrent reclaimers of the same orphan both enter the section", async () => {
    const name = `test-reclaim-concurrent-${process.pid}`;
    const dir = join(LOCK_ROOT, name);
    // Same metadata-less orphan as the "never got its owner.json written" case, but this time two
    // peers race to reclaim it at once. Each used to mint its own random token and retire
    // independently — this reproduces that race directly rather than relying on real OS timing.
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    await utimes(dir, old, old);

    let active = 0;
    let maxActive = 0;
    const section = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      active--;
    };

    await Promise.all([
      withHostLock(name, section, { maxWaitMs: 5000 }),
      withHostLock(name, section, { maxWaitMs: 5000 }),
      withHostLock(name, section, { maxWaitMs: 5000 }),
    ]);

    expect(maxActive).toBe(1);
  });

  it("reports the holder to onWait only when contended", async () => {
    const name = `test-onwait-${process.pid}`;
    const uncontended: unknown[] = [];
    await withHostLock(name, async () => {}, { onWait: (h) => uncontended.push(h) });
    expect(uncontended).toEqual([]);

    const seen: (number | undefined)[] = [];
    const holder = withHostLock(name, () => sleep(300), { label: "holder" });
    await sleep(50);
    await withHostLock(name, async () => {}, {
      maxWaitMs: 100,
      onWait: (h) => seen.push(h?.pid),
    });
    await holder;

    expect(seen).toEqual([process.pid]);
  });

  it("does not let a resumed creator corrupt a successor's lock", async () => {
    const name = `${RESUME_MARKER}-${process.pid}`;
    const dir = join(LOCK_ROOT, name);

    // The injected stat() above fires between our own mkdir(dir) and our first metadata write,
    // simulating a peer fully reclaiming `dir` and re-acquiring it in that gap — the exact window
    // the finding describes as unprotected. This call must detect the swap and back off rather
    // than writing into (or later retiring) the successor's directory.
    let ran = false;
    await withHostLock(name, async () => {
      ran = true;
    });

    expect(ran).toBe(true); // advisory: still runs, just unlocked
    const successor = JSON.parse(await readFile(join(dir, "owner.json"), "utf8")) as { token: string };
    expect(successor.token).toBe(SUCCESSOR_TOKEN);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("does not let a creator whose very first identity snapshot was already wrong corrupt a successor's lock", async () => {
    const name = `${FIRST_STAT_MARKER}-${process.pid}`;
    const dir = join(LOCK_ROOT, name);

    // The injected stat() above fires on the FIRST stat(dir) call — the capture of `ourDirStat`
    // itself, right after our own mkdir(dir) resolved — simulating a peer fully reclaiming and
    // re-acquiring `dir` before this creator ever observes its own correct identity. Unlike the
    // "resumed creator" case above, inode comparison can never catch this: `ourDirStat` itself is
    // now the successor's inode, so every isOurDir() check would wrongly agree. Only the token
    // cross-check in write()/release can save the successor here.
    let ran = false;
    await withHostLock(name, async () => {
      ran = true;
    });

    expect(ran).toBe(true); // advisory: still runs, just unlocked
    const successor = JSON.parse(await readFile(join(dir, "owner.json"), "utf8")) as { token: string };
    expect(successor.token).toBe(SUCCESSOR_TOKEN);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("falls back to running unlocked when dir vanishes between the ownership checks and the metadata write", async () => {
    const name = `${WRITE_VANISH_MARKER}-${process.pid}`;

    // The injected writeFile() above fires on the initial metadata write and removes `dir` right
    // before the real write lands, simulating a reclaim in the narrow gap between write()'s
    // ownership checks (which both still pass, since nothing has raced yet at that point) and the
    // write syscall itself. write() must swallow the resulting ENOENT and fall back to running `fn`
    // unlocked rather than letting it escape withHostLock as a rejection.
    let ran = false;
    await expect(
      withHostLock(name, async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();

    expect(ran).toBe(true);
  });

  it("does not let a resumed reclaimer's cleanup remove a successor's reclaiming gate", async () => {
    const name = `${GATE_MARKER}-${process.pid}`;
    const dir = join(LOCK_ROOT, name);
    const gate = `${dir}.reclaiming`;
    // A metadata-less orphan old enough to be reclaimed, so the acquire loop drives straight into
    // reclaim(). The injected readFile() above fires on reclaim()'s own readHolder() call — right
    // after it captured its own gate's mtime — and simulates a peer reaping that gate as stale and
    // creating its own replacement in the gap.
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    await utimes(dir, old, old);

    let ran = false;
    await withHostLock(name, async () => {
      ran = true;
    }, { maxWaitMs: 5000 });

    expect(ran).toBe(true);
    // The reclaimer's own finally must not have deleted the successor's replacement gate by
    // pathname alone — it must still be standing.
    expect((await stat(gate)).isDirectory()).toBe(true);
  });
});
