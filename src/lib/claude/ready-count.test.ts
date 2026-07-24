import { afterEach, describe, expect, it } from "vitest";

import { getReadyCountCached, resetReadyCountCache } from "@/lib/claude/ready-count";
import { USAGE_CACHE_TTL_MS } from "@/lib/claude/usage";

describe("getReadyCountCached", () => {
  afterEach(() => {
    resetReadyCountCache();
  });

  it("serves the cached count within the TTL, reading only once", async () => {
    let calls = 0;
    const reader = async () => {
      calls += 1;
      return 2;
    };
    let clock = 1_000;
    const now = () => clock;

    expect(await getReadyCountCached(reader, now)).toBe(2);
    clock += USAGE_CACHE_TTL_MS - 1;
    expect(await getReadyCountCached(reader, now)).toBe(2);
    expect(calls).toBe(1);
  });

  it("re-reads once the TTL elapses", async () => {
    let calls = 0;
    const reader = async () => {
      calls += 1;
      return calls;
    };
    let clock = 1_000;
    const now = () => clock;

    expect(await getReadyCountCached(reader, now)).toBe(1);
    clock += USAGE_CACHE_TTL_MS;
    expect(await getReadyCountCached(reader, now)).toBe(2);
  });

  it("caches a null (unknown) read so a broken queue does not hammer bd", async () => {
    let calls = 0;
    const reader = async () => {
      calls += 1;
      return null;
    };
    const now = () => 1_000;

    expect(await getReadyCountCached(reader, now)).toBeNull();
    expect(await getReadyCountCached(reader, now)).toBeNull();
    expect(calls).toBe(1);
  });

  it("dedupes concurrent cold-cache callers into a single read", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = async () => {
      calls += 1;
      await gate;
      return 1;
    };
    const now = () => 1_000;

    const first = getReadyCountCached(reader, now);
    const second = getReadyCountCached(reader, now);
    release();

    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(calls).toBe(1);
  });
});
