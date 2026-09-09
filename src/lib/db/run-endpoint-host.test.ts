/**
 * The endpoint-host migration (drizzle/0034, anton-oom5), asserted against the database that could
 * go wrong: one that already holds runs from before the column existed.
 *
 * Those rows must stay NULL — the ticket forbids a backfill precisely so an old row and an unrouted
 * new row (which records the Anthropic default explicitly) are never confusable. The reverse recipe
 * the header documents is run too, since "reversible" is a claim about SQL that SQLite is entitled
 * to reject.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0034_run_endpoint_host.sql";

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

/** An anton.db as it stood one release ago, with a run that predates the endpoint column. */
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
    .run("proj-a", "a", "A", "/tmp/a");
  sqlite
    .prepare("insert into runs (id, project_id, epic_bead_id, status) values (?, ?, ?, ?)")
    .run("old-run", "proj-a", "anton-old", "done");
});

afterEach(() => sqlite.close());

describe("drizzle/0034 — runs gain endpoint host", () => {
  it("leaves a pre-column row NULL, so it is not confusable with an unrouted new row", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const row = sqlite.prepare("select endpoint_host from runs where id = 'old-run'").get() as {
      endpoint_host: string | null;
    };
    expect(row.endpoint_host).toBeNull();
  });

  it("stores the host a new row records", () => {
    applyMigrationFile(sqlite, MIGRATION);
    sqlite
      .prepare(
        "insert into runs (id, project_id, epic_bead_id, status, endpoint_host) values (?, ?, ?, ?, ?)",
      )
      .run("fresh", "proj-a", "anton-new", "running", "api.anthropic.com");

    const row = sqlite.prepare("select endpoint_host from runs where id = 'fresh'").get() as {
      endpoint_host: string | null;
    };
    expect(row.endpoint_host).toBe("api.anthropic.com");
  });

  it("reverses with the recipe its header documents", () => {
    applyMigrationFile(sqlite, MIGRATION);
    expect(columnsOf(sqlite, "runs")).toContain("endpoint_host");

    for (const statement of reverseStatements()) sqlite.exec(statement);

    expect(columnsOf(sqlite, "runs")).not.toContain("endpoint_host");
    expect(sqlite.prepare("select count(*) as n from runs").get()).toEqual({ n: 1 });
  });
});
