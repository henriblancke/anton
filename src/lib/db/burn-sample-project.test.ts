/**
 * The burn-sample project attribution migration (drizzle/0030, for anton-wj3d), asserted against the
 * only database that can go wrong: one that already holds burn samples.
 *
 * A machine upgrading into this release carries a history of samples that genuinely do not know
 * which project spent them. The migration must leave those rows readable and unattributed — a
 * backfilled guess would poison the very per-project averages the quota shares are enforced from —
 * so this suite reconstructs the pre-migration schema, seeds it, migrates, and checks both halves:
 * the old rows survive as NULL, and per-project reads skip them while the global per-type average
 * still counts them.
 *
 * It also runs the reverse recipe the migration documents, because "reversible" is a claim about SQL
 * that SQLite is entitled to reject (a column under an index cannot be dropped).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";
import * as schema from "./schema";
import { getBurnAverage, getProjectBurnAverage, TIER_SEEDS } from "../burn";

const MIGRATION = "0030_burn_sample_project.sql";

/**
 * The reverse, read out of the migration's own header so the documented recipe cannot drift from the
 * one that is tested: every `--` comment line indented three spaces is a statement of the undo.
 */
function reverseStatements(): string[] {
  return readFileSync(join(process.cwd(), "drizzle", MIGRATION), "utf8")
    .split("\n")
    .flatMap((line) => (line.startsWith("--   ") ? [line.slice(5).trim()] : []));
}

function columnsOf(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

let sqlite: Database.Database;

/** An anton.db as it stood one release ago: every migration applied EXCEPT the one under test. */
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
    .run("proj-a", "a", "A", "/tmp/a");
  // Five samples is a full window, so the type reads as measured rather than seeded — the state an
  // upgrading machine is actually in, and the one where misattribution would do real damage.
  for (let i = 0; i < 5; i++) {
    sqlite
      .prepare(
        "insert into burn_samples (id, job_type, session_delta, weekly_delta, created_at) values (?, ?, ?, ?, ?)",
      )
      .run(`old-${i}`, "execute-epic", 30, 4, 1_700_000_000 + i);
  }
});

afterEach(() => sqlite.close());

describe("drizzle/0030 — burn samples gain a project", () => {
  it("leaves historical rows in place, unattributed", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const rows = sqlite
      .prepare("select id, project_id, session_delta from burn_samples order by id")
      .all() as { id: string; project_id: string | null; session_delta: number }[];
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.project_id === null)).toBe(true);
    expect(rows.every((r) => r.session_delta === 30)).toBe(true);
  });

  it("excludes unattributed rows from per-project math, not from the global average", async () => {
    applyMigrationFile(sqlite, MIGRATION);
    const db = drizzle(sqlite, { schema });

    // The pre-migration burn is real and still worth averaging globally — it just belongs to nobody.
    const global = await getBurnAverage(db, "execute-epic");
    expect(global.seeded).toBe(false);
    expect(global.sessionAvg).toBe(30);

    // Charging those 30% samples to a project that may never have spent them is exactly the
    // misattribution the nullable column exists to prevent: the project reads as unmeasured.
    const perProject = await getProjectBurnAverage(db, "proj-a", "execute-epic");
    expect(perProject.sampleCount).toBe(0);
    expect(perProject.seeded).toBe(true);
    expect(perProject.sessionAvg).toBe(TIER_SEEDS.L.sessionPct);
  });

  it("indexes the per-project read without dropping the global one", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const indexes = (sqlite.pragma("index_list(burn_samples)") as { name: string }[]).map(
      (i) => i.name,
    );
    expect(indexes).toContain("burn_samples_project_type_created_idx");
    // The per-type rolling average is still read globally for cost estimates.
    expect(indexes).toContain("burn_samples_type_created_idx");

    const plan = sqlite
      .prepare(
        "select * from burn_samples where project_id = ? and job_type = ? order by created_at desc limit 5",
      )
      .all("proj-a", "execute-epic");
    expect(plan).toEqual([]);
    const explain = (
      sqlite
        .prepare(
          "explain query plan select * from burn_samples where project_id = ? and job_type = ? order by created_at desc limit 5",
        )
        .all("proj-a", "execute-epic") as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(" ");
    expect(explain).toContain("burn_samples_project_type_created_idx");
  });

  it("reverses cleanly, back to the pre-migration shape with its rows intact", () => {
    const before = columnsOf(sqlite, "burn_samples");
    applyMigrationFile(sqlite, MIGRATION);
    expect(columnsOf(sqlite, "burn_samples")).toContain("project_id");

    const undo = reverseStatements();
    expect(undo).not.toEqual([]); // the header must actually document a reverse
    for (const statement of undo) sqlite.exec(statement);

    expect(columnsOf(sqlite, "burn_samples")).toEqual(before);
    expect(
      (sqlite.prepare("select count(*) as n from burn_samples").get() as { n: number }).n,
    ).toBe(5);
  });
});
