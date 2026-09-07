/**
 * The spent-attempts migration (drizzle/0032, PR #248 review), asserted against the only database
 * that can go wrong: one that already holds jobs with attempts on them.
 *
 * Before the column existed the spend estimate charged `attempts`, so on an upgrading machine that
 * column is the whole record of what the current week cost. A default of zero would reset every
 * project's meter on upgrade and let each spend its share a second time — the migration must carry
 * the old figure over. The reverse recipe the header documents is run too, since "reversible" is a
 * claim about SQL that SQLite is entitled to reject.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0032_jobs_spent_attempts.sql";

/** The reverse, read out of the migration's own header so the tested recipe is the documented one. */
function reverseStatements(): string[] {
  return readFileSync(join(process.cwd(), "drizzle", MIGRATION), "utf8")
    .split("\n")
    .flatMap((line) => (line.startsWith("--   ") ? [line.slice(5).trim()] : []));
}

function columnsOf(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

let sqlite: Database.Database;

/** An anton.db as it stood one release ago, with jobs at every stage of their retry budget. */
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
    .run("proj-a", "a", "A", "/tmp/a");
  const insert = sqlite.prepare(
    "insert into jobs (id, type, project_id, status, attempts) values (?, 'execute-epic', 'proj-a', ?, ?)",
  );
  insert.run("parked", "parked", 3);
  insert.run("done", "done", 1);
  insert.run("queued", "queued", 0);
});

afterEach(() => sqlite.close());

describe("drizzle/0032 — jobs gain spent attempts", () => {
  it("carries each row's attempts over as its spend, so the week's meter survives the upgrade", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const rows = sqlite
      .prepare("select id, attempts, spent_attempts from jobs order by id")
      .all() as { id: string; attempts: number; spent_attempts: number }[];
    expect(rows).toEqual([
      { id: "done", attempts: 1, spent_attempts: 1 },
      { id: "parked", attempts: 3, spent_attempts: 3 },
      { id: "queued", attempts: 0, spent_attempts: 0 },
    ]);
  });

  it("defaults a row inserted after the upgrade to zero spend", () => {
    applyMigrationFile(sqlite, MIGRATION);
    sqlite
      .prepare("insert into jobs (id, type, project_id) values ('fresh', 'execute-epic', 'proj-a')")
      .run();

    const row = sqlite.prepare("select spent_attempts from jobs where id = 'fresh'").get() as {
      spent_attempts: number;
    };
    expect(row.spent_attempts).toBe(0);
  });

  it("reverses with the recipe its header documents", () => {
    applyMigrationFile(sqlite, MIGRATION);
    expect(columnsOf(sqlite, "jobs")).toContain("spent_attempts");

    for (const statement of reverseStatements()) sqlite.exec(statement);

    expect(columnsOf(sqlite, "jobs")).not.toContain("spent_attempts");
    expect(sqlite.prepare("select count(*) as n from jobs").get()).toEqual({ n: 3 });
  });
});
