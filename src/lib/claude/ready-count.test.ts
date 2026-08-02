import { afterEach, describe, expect, it } from "vitest";

import { beads, type Bead } from "@/lib/beads/bd";
import { getReadyCountCached, readReadyCount, resetReadyCountCache } from "@/lib/claude/ready-count";
import { USAGE_CACHE_TTL_MS } from "@/lib/claude/usage";
import type { Project } from "@/lib/types";

const project = (slug: string, hasBeads = true): Project => ({
  id: slug,
  slug,
  name: slug,
  repoPath: `/repos/${slug}`,
  defaultBranch: "main",
  hasBeads,
  createdAt: 0,
});

const bead = (b: Partial<Bead>): Bead =>
  ({ id: "x", title: "x", status: "open", labels: ["approved"], ...b }) as Bead;

/**
 * A board whose raw ready count (5) is nothing like its claimable count (1): only `f1` is work
 * anton would pick up — `e1` is a container (its features run on their own), `t1..t3` are child
 * tickets of `f1` (executed inside its run), and `f2` never passed the human gate.
 */
const mixedBoard: Bead[] = [
  bead({ id: "e1", issue_type: "epic" }),
  bead({ id: "f1", issue_type: "feature", parent: "e1" }),
  bead({ id: "t1", issue_type: "task", parent: "f1" }),
  bead({ id: "t2", issue_type: "task", parent: "f1" }),
  bead({ id: "t3", issue_type: "task", parent: "f1" }),
  bead({ id: "f2", issue_type: "feature", labels: [] }), // unapproved
];

/** bd's own ready answer for {@link mixedBoard}: approved + unassigned, blocker-free. */
const mixedPool = mixedBoard.filter((b) => beads.isApproved(b));

const claimableOn =
  (board: Bead[], pool: Bead[]) =>
  (repoPath: string) =>
    beads.claimableTargets(repoPath, { ready: async () => pool, board: async () => board });

describe("readReadyCount", () => {
  it("counts the claimable set, not bd's raw ready pool", async () => {
    const count = await readReadyCount({
      projects: async () => [project("alpha")],
      claimable: claimableOn(mixedBoard, mixedPool),
    });

    expect(mixedPool).toHaveLength(5); // what the old raw-ready count would have shown
    expect(count).toBe(1);
  });

  it("sums claimable targets across beads projects and ignores the rest", async () => {
    const count = await readReadyCount({
      projects: async () => [project("alpha"), project("beta"), project("no-beads", false)],
      claimable: (repoPath) =>
        repoPath === "/repos/alpha"
          ? claimableOn(mixedBoard, mixedPool)(repoPath)
          : Promise.resolve([]),
    });

    expect(count).toBe(1);
  });

  it("skips a project whose read failed rather than zeroing the total", async () => {
    const count = await readReadyCount({
      projects: async () => [project("alpha"), project("broken")],
      claimable: (repoPath) => {
        if (repoPath === "/repos/broken") throw new Error("bd exploded");
        return claimableOn(mixedBoard, mixedPool)(repoPath);
      },
    });

    expect(count).toBe(1);
  });

  it("is unknown (null) when every read fails, so the nudge stays silent", async () => {
    const count = await readReadyCount({
      projects: async () => [project("alpha")],
      claimable: () => {
        throw new Error("bd exploded");
      },
    });

    expect(count).toBeNull();
  });

  it("is unknown (null) when no project has a beads DB", async () => {
    const count = await readReadyCount({
      projects: async () => [project("no-beads", false)],
      claimable: async () => {
        throw new Error("should not be read");
      },
    });

    expect(count).toBeNull();
  });
});

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
