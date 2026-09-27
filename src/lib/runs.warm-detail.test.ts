/**
 * What `getRunDetail` hands the run detail view about warming (anton-rqwy8).
 *
 * The column is free text, so the read is where the view's vocabulary is actually enforced: a row
 * written by a newer build — or corrupted — must not put an unrecognized word on the page, and a
 * null must stay absent rather than becoming a fourth thing the view has to have a rule for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { applyMigrationsTo } from "./db/testing";

const PROJECT = "p1";
let workDir: string;
let getRunDetail: typeof import("./runs").getRunDetail;

interface Warm {
  warmOutcome?: string;
  warmCommand?: string;
  warmError?: string;
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "anton-runs-warm-test-"));
  const dbFile = join(workDir, "anton.db");
  process.env.ANTON_DB = dbFile;
  const setup = new Database(dbFile);
  applyMigrationsTo(setup);
  setup.close();

  // getDb() is lazy, so assigning ANTON_DB above is enough.
  const { getDb, schema } = await import("./db");
  ({ getRunDetail } = await import("./runs"));
  const db = getDb();
  await db.insert(schema.projects).values({
    id: PROJECT,
    slug: PROJECT,
    name: PROJECT,
    repoPath: "/tmp/p1",
  });

  const seed: [string, Warm][] = [
    ["failed", { warmOutcome: "failed", warmCommand: "bun install", warmError: "ENOTFOUND registry" }],
    ["ok", { warmOutcome: "ok", warmCommand: "bun install" }],
    ["skipped", { warmOutcome: "skipped" }],
    ["legacy", {}],
    ["unknown", { warmOutcome: "quantum", warmCommand: "bun install" }],
  ];
  for (const [id, warm] of seed) {
    await db.insert(schema.runs).values({
      id,
      projectId: PROJECT,
      epicBeadId: `anton-${id}`,
      status: "done",
      ...warm,
    });
  }
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("getRunDetail's warm fields", () => {
  it("carries the failure, its command, and what it said", async () => {
    expect(await getRunDetail(PROJECT, "failed")).toMatchObject({
      warmOutcome: "failed",
      warmCommand: "bun install",
      warmError: "ENOTFOUND registry",
    });
  });

  it("carries an ok outcome with its command, and no error", async () => {
    const run = await getRunDetail(PROJECT, "ok");
    expect(run?.warmOutcome).toBe("ok");
    expect(run?.warmCommand).toBe("bun install");
    expect(run?.warmError).toBeUndefined();
  });

  it("carries a skipped outcome with nothing attached", async () => {
    const run = await getRunDetail(PROJECT, "skipped");
    expect(run?.warmOutcome).toBe("skipped");
    expect(run?.warmCommand).toBeUndefined();
  });

  it("leaves a row predating the column with no outcome at all", async () => {
    const run = await getRunDetail(PROJECT, "legacy");
    expect(run?.warmOutcome).toBeUndefined();
    // Absent, not `skipped` — a warm that never ran must stay distinguishable from one that ran
    // and found nothing to do.
    expect(run).not.toHaveProperty("warmOutcome");
  });

  it("drops an outcome this build has no rule for, rather than rendering the raw word", async () => {
    const run = await getRunDetail(PROJECT, "unknown");
    expect(run?.warmOutcome).toBeUndefined();
    expect(run?.warmCommand).toBeUndefined();
  });
});
