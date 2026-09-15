/**
 * Host-wide verify-gate lock (anton-0oi). Covers the three properties the callers rely on: real
 * mutual exclusion, advisory (never-wedging) behavior under contention, and reclaim of a lock whose
 * owner died. Lock names are unique per test because the lock root is a real shared /tmp directory.
 */
import { describe, expect, it } from "vitest";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { withHostLock } from "./host-lock";

const LOCK_ROOT = join(tmpdir(), "anton-host-locks");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
});
