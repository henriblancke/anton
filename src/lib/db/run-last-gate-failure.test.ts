/**
 * The gate-failure migration (drizzle/0054, anton-vynb8), asserted against the database that could
 * go wrong: one that already holds runs from before the column existed.
 *
 * anton-gwn6g is why the executable-SQL assertion is here at all — a migration whose file carries no
 * statement fails `drizzle-kit migrate` outright and blocks every later migration on an upgrading
 * machine. So this applies the real file to a real pre-column db and reads the row back, rather than
 * trusting the schema the ORM would have built from scratch.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0054_run_last_gate_failure.sql";

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

/** An anton.db as it stood one release ago, with a run that predates the gate-failure column. */
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
    .run("proj-a", "a", "A", "/tmp/a");
  sqlite
    .prepare("insert into runs (id, project_id, epic_bead_id, status) values (?, ?, ?, ?)")
    .run("old-run", "proj-a", "anton-old", "failed");
});

afterEach(() => sqlite.close());

describe("drizzle/0054 — runs remember the gate that failed", () => {
  // The whole failure anton-gwn6g shipped: a comment-only migration that the runner rejects.
  it("carries an executable statement, not just a rationale comment", () => {
    const body = readFileSync(join(process.cwd(), "drizzle", MIGRATION), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();

    expect(body).not.toBe("");
    expect(body).toMatch(/^ALTER TABLE .runs. ADD .last_gate_failure. text;$/);
  });

  // Absent means "no recorded failure", which is also the first-attempt behaviour — so a row from
  // before the column reads exactly like a fresh run, and nothing invents a failure it can't know.
  it("leaves a pre-column row NULL rather than backfilling one", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const row = sqlite.prepare("select last_gate_failure from runs where id = 'old-run'").get() as {
      last_gate_failure: string | null;
    };
    expect(row.last_gate_failure).toBeNull();
  });

  // The upgraded database — not a freshly built one — is the one a resumed run writes to.
  it("stores and reads back a record on the existing database", () => {
    applyMigrationFile(sqlite, MIGRATION);
    const record = JSON.stringify({
      label: "test",
      command: "bun run test",
      code: 1,
      output: "FAIL src/lib/runs.test.ts",
      beadId: "anton-old",
    });
    sqlite.prepare("update runs set last_gate_failure = ? where id = 'old-run'").run(record);

    const row = sqlite.prepare("select last_gate_failure from runs where id = 'old-run'").get() as {
      last_gate_failure: string | null;
    };
    expect(JSON.parse(row.last_gate_failure!)).toMatchObject({ label: "test", code: 1 });
  });

  it("reverses with the recipe its header documents", () => {
    applyMigrationFile(sqlite, MIGRATION);
    expect(columnsOf(sqlite, "runs")).toContain("last_gate_failure");

    for (const statement of reverseStatements()) sqlite.exec(statement);

    expect(columnsOf(sqlite, "runs")).not.toContain("last_gate_failure");
    expect(sqlite.prepare("select count(*) as n from runs").get()).toEqual({ n: 1 });
  });
});
