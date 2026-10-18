/**
 * The watermark's migration (drizzle/0064_viewer_marks.sql), asserted against the database that can
 * actually go wrong: an existing anton.db with a project and a settled run.
 *
 * The table is purely additive, so what the migration must prove is that it applies to a POPULATED
 * db without disturbing it, that the composite key admits one row per viewer per project and
 * refuses a second, that the project foreign key holds, and that a project with no row stays
 * absent — a backfill to `now` here would mark every upgrading project's whole history as seen. The
 * reverse recipe the header documents is run too, since "reversible" is a claim SQLite may reject.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0064_viewer_marks.sql";

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

/** An anton.db as it stood one release ago, with a project and a delivered run. */
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
    .run("proj-a", "a", "A", "/tmp/a");
  sqlite
    .prepare(
      `insert into runs (id, project_id, epic_bead_id, status, started_at, ended_at, updated_at)
       values (?, 'proj-a', 'anton-epic', 'done', 1000, 4600, 4600)`,
    )
    .run("run-a");
});

afterEach(() => sqlite.close());

describe("drizzle/0064 — the viewer watermark", () => {
  it("applies to a populated db and leaves every existing row untouched", () => {
    applyMigrationFile(sqlite, MIGRATION);

    expect(tables(sqlite)).toContain("viewer_marks");
    expect(sqlite.prepare("select count(*) as n from projects").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("select count(*) as n from runs").get()).toEqual({ n: 1 });
  });

  it("leaves an upgrading project with NO mark, rather than backfilling it as seen", () => {
    applyMigrationFile(sqlite, MIGRATION);

    expect(sqlite.prepare("select count(*) as n from viewer_marks").get()).toEqual({ n: 0 });
  });

  it("accepts a mark the moment it lands, defaulting updated_at", () => {
    applyMigrationFile(sqlite, MIGRATION);

    sqlite
      .prepare("insert into viewer_marks (viewer_id, project_id, seen_at) values (?, ?, ?)")
      .run("default", "proj-a", 4600);

    const row = sqlite
      .prepare("select viewer_id, project_id, seen_at, updated_at from viewer_marks")
      .get() as Record<string, unknown>;
    expect(row.viewer_id).toBe("default");
    expect(row.seen_at).toBe(4600);
    expect(row.updated_at).toEqual(expect.any(Number));
  });

  it("keys on (viewer, project): one row per pair, independent rows per viewer and per project", () => {
    applyMigrationFile(sqlite, MIGRATION);
    sqlite
      .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
      .run("proj-b", "b", "B", "/tmp/b");
    const insert = sqlite.prepare(
      "insert into viewer_marks (viewer_id, project_id, seen_at) values (?, ?, ?)",
    );

    insert.run("default", "proj-a", 100);
    insert.run("other", "proj-a", 200);
    insert.run("default", "proj-b", 300);

    expect(() => insert.run("default", "proj-a", 400)).toThrow(/UNIQUE|PRIMARY/i);
    expect(sqlite.prepare("select count(*) as n from viewer_marks").get()).toEqual({ n: 3 });
  });

  it("refuses a mark for a project that does not exist", () => {
    applyMigrationFile(sqlite, MIGRATION);

    expect(() =>
      sqlite
        .prepare("insert into viewer_marks (viewer_id, project_id, seen_at) values (?, ?, ?)")
        .run("default", "ghost", 100),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("reverses with the recipe its own header documents", () => {
    applyMigrationFile(sqlite, MIGRATION);
    const statements = reverseStatements();
    expect(statements).toEqual(["DROP TABLE `viewer_marks`;"]);

    for (const statement of statements) sqlite.exec(statement);

    expect(tables(sqlite)).not.toContain("viewer_marks");
    expect(sqlite.prepare("select count(*) as n from projects").get()).toEqual({ n: 1 });
  });
});
