/**
 * `runsByCause` (anton-olvlt): a project's failed/parked runs, each with its cause and settle
 * time, over seeded `runs` rows. The trend fold this feeds must only bucket, never reclassify —
 * so what this returns is the whole contract.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import { runsByCause } from "./failure-cause-read";

let t: TestDb;
const PROJECT = "p1";
const EPIC = "anton-abc";

beforeEach(async () => {
  t = makeTestDb();
  await t.db.insert(schema.projects).values({
    id: PROJECT,
    slug: "p1",
    name: "P1",
    repoPath: "/repo",
  });
});
afterEach(() => t.close());

interface SeedRun {
  id: string;
  status: string;
  updatedAt: number;
  error?: string | null;
  endedAt?: number;
  projectId?: string;
}

async function seed(run: SeedRun): Promise<void> {
  await t.db.insert(schema.runs).values({
    id: run.id,
    projectId: run.projectId ?? PROJECT,
    epicBeadId: EPIC,
    status: run.status,
    error: run.error ?? null,
    startedAt: new Date(run.updatedAt),
    endedAt: run.endedAt === undefined ? null : new Date(run.endedAt),
    updatedAt: new Date(run.updatedAt),
  });
}

const SETTLED = 1_800_000_000_000;
const sec = (ms: number) => Math.floor(ms / 1000);

describe("runsByCause", () => {
  it("returns each failed/parked run's cause", async () => {
    await seed({
      id: "gate",
      status: "failed",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      error: "lint gate failed for anton-8x1k (exit 1)",
    });
    await seed({
      id: "infra",
      status: "failed",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      error: "git push failed (exit 1): husky - pre-push hook exited with code 1 (error)",
    });
    await seed({
      id: "agent",
      status: "failed",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      error: "claude exited with code 1: I couldn't finish in time.",
    });
    await seed({
      id: "unknown",
      status: "failed",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      error: "TypeError: Cannot read properties of undefined",
    });

    const rows = await runsByCause(t.db, PROJECT, undefined);
    const byId = new Map(rows.map((r) => [r.runId, r.cause]));

    expect(byId.get("gate")).toBe("gate");
    expect(byId.get("infra")).toBe("infra");
    expect(byId.get("agent")).toBe("agent");
    expect(byId.get("unknown")).toBe("unknown");
  });

  it("classifies a quota park as quota, never as agent", async () => {
    await seed({
      id: "quota-park",
      status: "parked",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      // The literal marker `execute-epic-settle.ts` writes on a quota park — not one of the raw
      // Claude usage banners `classifyFailureCause`'s own regex matches.
      error: "usage-limit",
    });
    await seed({
      id: "quota-park-orphan",
      status: "parked",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      error: "usage-limit (orphan PR anton/anton-abc found on GitHub)",
    });

    const rows = await runsByCause(t.db, PROJECT, undefined);
    const byId = new Map(rows.map((r) => [r.runId, r.cause]));

    expect(byId.get("quota-park")).toBe("quota");
    expect(byId.get("quota-park-orphan")).toBe("quota");
    expect(byId.get("quota-park")).not.toBe("agent");
  });

  it("classifies a board-unreachable park as infra, never as unknown", async () => {
    await seed({
      id: "board-park",
      status: "parked",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      // The literal marker `execute-epic-settle.ts` writes on a board outage during lease publish
      // — not matched by `classifyFailureCause`'s own patterns.
      error: "board-unreachable",
    });
    await seed({
      id: "board-park-orphan",
      status: "parked",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      error: "board-unreachable (orphan PR anton/anton-abc found on GitHub)",
    });

    const rows = await runsByCause(t.db, PROJECT, undefined);
    const byId = new Map(rows.map((r) => [r.runId, r.cause]));

    expect(byId.get("board-park")).toBe("infra");
    expect(byId.get("board-park-orphan")).toBe("infra");
    expect(byId.get("board-park")).not.toBe("unknown");
  });

  it("places an old row with no endedAt using updatedAt", async () => {
    await seed({ id: "legacy", status: "failed", updatedAt: SETTLED, error: "gate failed" });

    const rows = await runsByCause(t.db, PROJECT, undefined);

    expect(rows).toEqual([{ runId: "legacy", cause: "gate", settledAt: sec(SETTLED) }]);
  });

  it("excludes runs that never settled failed or parked", async () => {
    await seed({ id: "queued", status: "queued", updatedAt: SETTLED });
    await seed({ id: "running", status: "running", updatedAt: SETTLED });
    await seed({ id: "done", status: "done", updatedAt: SETTLED, endedAt: SETTLED });

    expect(await runsByCause(t.db, PROJECT, undefined)).toEqual([]);
  });

  it("excludes runs from another project", async () => {
    await t.db.insert(schema.projects).values({
      id: "p2",
      slug: "p2",
      name: "P2",
      repoPath: "/repo2",
    });
    await seed({ id: "other", status: "failed", updatedAt: SETTLED, endedAt: SETTLED, projectId: "p2" });

    expect(await runsByCause(t.db, PROJECT, undefined)).toEqual([]);
  });

  it("excludes a run settled before the window", async () => {
    await seed({ id: "before", status: "failed", updatedAt: SETTLED, endedAt: SETTLED });
    await seed({
      id: "after",
      status: "failed",
      updatedAt: SETTLED + 3_600_000,
      endedAt: SETTLED + 3_600_000,
    });

    const rows = await runsByCause(t.db, PROJECT, new Date(SETTLED + 1_000));

    expect(rows.map((r) => r.runId)).toEqual(["after"]);
  });

  it("excludes a row that settled before the window even when a later write bumped updatedAt", async () => {
    // Mirrors execute-epic-claim.ts writing baseForkSha/attempts onto a row well after it settled:
    // endedAt stays in the past, but updatedAt alone would clear an `updatedAt >= since` prefilter.
    await seed({
      id: "stale-touch",
      status: "failed",
      endedAt: SETTLED,
      updatedAt: SETTLED + 3_600_000,
    });

    const rows = await runsByCause(t.db, PROJECT, new Date(SETTLED + 1_000));

    expect(rows).toEqual([]);
  });
});
