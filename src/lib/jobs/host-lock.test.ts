/**
 * Host-wide verify-gate lock (anton-0oi). Covers the three properties the callers rely on: real
 * mutual exclusion, advisory (never-wedging) behavior under contention, and reclaim of a lock whose
 * owner died. Lock names are unique per test because the lock root is a real shared /tmp directory.
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
      JSON.stringify({ pid: 4194304, heartbeatAt: Date.now(), label: "dead" }),
      "utf8",
    );

    let ran = false;
    // Short budget: this can only pass by reclaiming, not by waiting the holder out.
    await withHostLock(name, async () => {
      ran = true;
    }, { maxWaitMs: 200 });

    expect(ran).toBe(true);
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
