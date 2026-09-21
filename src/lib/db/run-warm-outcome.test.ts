/**
 * The warm-outcome migration (drizzle/0048, anton-de17i), asserted against the database that could
 * go wrong: one already holding runs from before the column existed.
 *
 * Those rows must stay NULL. Null is what the schema reads as "warming was never attempted", and
 * the ticket forbids a backfill precisely so it stays distinguishable from `skipped` — a warm that
 * DID run and found nothing to do. A backfill that guessed either way would erase that difference
 * on every historical row. The reverse recipe the header documents is run too, since "reversible"
 * is a claim about SQL that SQLite is entitled to reject.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0048_run_warm_outcome.sql";

/** The reverse, read out of the migration's own header so the tested recipe is the documented one. */
function reverseStatements(): string[] {
  return readFileSync(join(process.cwd(), "drizzle", MIGRATION), "utf8")
    .split("\n")
    .flatMap((line) => (line.startsWith("--   ") ? [line.slice(5).trim()] : []));
}

function columnsOf(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

interface WarmRow {
  warm_outcome: string | null;
  warm_command: string | null;
  warm_error: string | null;
}

function warmRow(sqlite: Database.Database, id: string): WarmRow {
  return sqlite
    .prepare("select warm_outcome, warm_command, warm_error from runs where id = ?")
    .get(id) as WarmRow;
}

function insertRun(sqlite: Database.Database, id: string, warm: Partial<WarmRow> = {}): void {
  sqlite
    .prepare(
      "insert into runs (id, project_id, epic_bead_id, status, warm_outcome, warm_command, warm_error) " +
        "values (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      "proj-a",
      `anton-${id}`,
      "running",
      warm.warm_outcome ?? null,
      warm.warm_command ?? null,
      warm.warm_error ?? null,
    );
}

let sqlite: Database.Database;

/** An anton.db at 0047, with a run that predates the warm columns. */
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

describe("drizzle/0048 — runs gain a warm outcome", () => {
  it("applies to a DB at 0047 and leaves the pre-column row wholly NULL", () => {
    // Guard the premise: `before` must have stopped at 0047, or "applies at 0047" proves nothing.
    expect(columnsOf(sqlite, "runs")).toContain("prior_base_refresh_sha");
    expect(columnsOf(sqlite, "runs")).not.toContain("warm_outcome");

    applyMigrationFile(sqlite, MIGRATION);

    // Null across all three: "never attempted", never confusable with a warm that ran.
    expect(warmRow(sqlite, "old-run")).toEqual({
      warm_outcome: null,
      warm_command: null,
      warm_error: null,
    });
  });

  it("keeps each documented outcome distinguishable on its own row", () => {
    applyMigrationFile(sqlite, MIGRATION);

    insertRun(sqlite, "ok-run", { warm_outcome: "ok", warm_command: "bun install" });
    insertRun(sqlite, "failed-run", {
      warm_outcome: "failed",
      warm_command: "bun install",
      warm_error: "error: Could not resolve @tailwindcss/vite",
    });
    insertRun(sqlite, "skipped-run", { warm_outcome: "skipped" });
    insertRun(sqlite, "disabled-run", { warm_outcome: "disabled" });

    expect(warmRow(sqlite, "ok-run").warm_outcome).toBe("ok");
    expect(warmRow(sqlite, "failed-run")).toEqual({
      warm_outcome: "failed",
      warm_command: "bun install",
      warm_error: "error: Could not resolve @tailwindcss/vite",
    });
    expect(warmRow(sqlite, "skipped-run").warm_outcome).toBe("skipped");
    expect(warmRow(sqlite, "disabled-run").warm_outcome).toBe("disabled");

    // The distinction the no-backfill rule exists to protect: a warm that ran and did nothing is
    // not the same row shape as one that was never attempted.
    expect(warmRow(sqlite, "old-run").warm_outcome).toBeNull();
  });

  it("stores a stderr tail at the bound warming slices to", () => {
    applyMigrationFile(sqlite, MIGRATION);
    const tail = "x".repeat(2000);

    insertRun(sqlite, "noisy", { warm_outcome: "failed", warm_command: "pnpm install", warm_error: tail });

    expect(warmRow(sqlite, "noisy").warm_error).toHaveLength(2000);
  });

  it("reverses with the recipe its header documents", () => {
    applyMigrationFile(sqlite, MIGRATION);
    expect(columnsOf(sqlite, "runs")).toEqual(
      expect.arrayContaining(["warm_outcome", "warm_command", "warm_error"]),
    );

    for (const statement of reverseStatements()) sqlite.exec(statement);

    const columns = columnsOf(sqlite, "runs");
    for (const dropped of ["warm_outcome", "warm_command", "warm_error"]) {
      expect(columns).not.toContain(dropped);
    }
    expect(sqlite.prepare("select count(*) as n from runs").get()).toEqual({ n: 1 });
  });
});
