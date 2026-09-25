/**
 * The per-attempt record's migration (drizzle/0054), asserted against the database that can actually
 * go wrong: an existing anton.db with a project and a run — including a run that already SETTLED
 * after resuming, which is exactly the row whose earlier intervals are unrecoverable.
 *
 * The table is purely additive, so what the migration must prove is that it applies to a POPULATED db
 * without disturbing it, that a row can be written the moment it lands, and that the columns a
 * mid-flight attempt leaves empty really are nullable — an attempt that has not ended yet has no end
 * and no outcome, and a NOT NULL there would reject the row that OPENS every attempt. The reverse
 * recipe the header documents is run too, since "reversible" is a claim about SQL that SQLite is
 * entitled to reject.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0054_run_attempts.sql";

/** The reverse, read out of the migration's own header so the tested recipe is the documented one. */
function reverseStatements(): string[] {
  return readFileSync(join(process.cwd(), "drizzle", MIGRATION), "utf8")
    .split("\n")
    .flatMap((line) => (line.startsWith("--   ") ? [line.slice(5).trim()] : []));
}

function tables(sqlite: Database.Database): string[] {
  return (
    sqlite.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
  ).map((t) => t.name);
}

let sqlite: Database.Database;

/** An anton.db as it stood one release ago, with a project and a run that resumed before settling. */
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
    .run("proj-a", "a", "A", "/tmp/a");
  // The row this whole feature exists because of: it started at 1000, was resumed at 4000 (so
  // `attempt_started_at` no longer says 1000), and ended at 4600. Its first attempt's interval is
  // already gone, and no migration can bring it back.
  sqlite
    .prepare(
      `insert into runs (id, project_id, epic_bead_id, status, started_at, attempt_started_at, ended_at, updated_at)
       values (?, 'proj-a', 'anton-epic', 'done', 1000, 4000, 4600, 4600)`,
    )
    .run("run-a");
});

afterEach(() => sqlite.close());

describe("drizzle/0055 — the per-attempt run record", () => {
  it("applies to a populated db and leaves every existing row untouched", () => {
    applyMigrationFile(sqlite, MIGRATION);

    expect(tables(sqlite)).toContain("run_attempts");
    expect(sqlite.prepare("select count(*) as n from projects").get()).toEqual({ n: 1 });
    // `attempt_started_at` still says what it said — this migration adds a record beside that column
    // and never redefines it, which is what keeps the repair weigher's reader correct.
    expect(
      sqlite.prepare("select started_at, attempt_started_at, ended_at from runs").get(),
    ).toEqual({ started_at: 1000, attempt_started_at: 4000, ended_at: 4600 });
  });

  it("backfills nothing — the settled run's earlier intervals are gone, not zero", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // Deliberately empty. The alternative — synthesizing one row from `attempt_started_at` — would
    // manufacture a wall figure equal to the LAST attempt's duration for every legacy run, which is
    // the exact wrong number this record exists to stop anyone reporting.
    expect(sqlite.prepare("select count(*) as n from run_attempts").get()).toEqual({ n: 0 });
  });

  it("takes an attempt row against the run already on the db", () => {
    applyMigrationFile(sqlite, MIGRATION);

    sqlite
      .prepare(
        `insert into run_attempts (id, run_id, project_id, attempt, started_at, ended_at, outcome)
         values (?, 'run-a', 'proj-a', 2, 4000, 4600, 'done')`,
      )
      .run("att-2");

    const row = sqlite
      .prepare("select attempt, started_at, ended_at, outcome, recorded_at from run_attempts")
      .get() as Record<string, number | string>;
    expect(row.attempt).toBe(2);
    expect(row.ended_at).toBe(4600);
    expect(row.outcome).toBe("done");
    // Defaulted by the schema, so a hand-written row is still timestamped.
    expect(Number(row.recorded_at)).toBeGreaterThan(0);
  });

  it("takes a still-OPEN attempt — no end, no outcome", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // The row that opens every attempt. A NOT NULL on either column would reject it outright, and
    // nothing would ever record an interval at all.
    sqlite
      .prepare(
        "insert into run_attempts (id, run_id, attempt, started_at) values (?, 'run-a', 1, 1000)",
      )
      .run("att-1");

    expect(
      sqlite.prepare("select ended_at, outcome, project_id from run_attempts").get(),
    ).toEqual({ ended_at: null, outcome: null, project_id: null });
  });

  it("refuses a row that cannot say which run or when it began", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // `run_id`, `attempt` and `started_at` are the NOT NULL columns: an attempt anton cannot place on
    // a run, order within it, or date is not an interval it observed.
    expect(() =>
      sqlite.prepare("insert into run_attempts (id, attempt) values ('x', 1)").run(),
    ).toThrow(/NOT NULL/i);
    expect(() =>
      sqlite.prepare("insert into run_attempts (id, run_id) values ('y', 'run-a')").run(),
    ).toThrow(/NOT NULL/i);
  });

  it("indexes one run's attempts in order — the only read the table has", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const plan = sqlite
      .prepare(
        "explain query plan select * from run_attempts where run_id = ? order by attempt",
      )
      .all("run-a") as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/run_attempts_run_idx/);
  });

  it("reverses with the recipe its header documents", () => {
    applyMigrationFile(sqlite, MIGRATION);
    expect(tables(sqlite)).toContain("run_attempts");

    for (const statement of reverseStatements()) sqlite.exec(statement);

    expect(tables(sqlite)).not.toContain("run_attempts");
    expect(sqlite.prepare("select count(*) as n from runs").get()).toEqual({ n: 1 });
  });
});
