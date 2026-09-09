/**
 * The spend-ledger migration (drizzle/0034), asserted against the database that can actually go
 * wrong: an existing anton.db with a project, a run and a job already in it.
 *
 * The table is purely additive, so what the migration must prove is that it applies to a POPULATED
 * db without disturbing it, that a row can be written the moment it lands, and that the nullable
 * dimension columns really are nullable — the passes outside the ticket pipeline have no run, no
 * ticket and no formula step to name, and a NOT NULL there would reject their spend outright. The
 * reverse recipe the header documents is run too, since "reversible" is a claim about SQL that
 * SQLite is entitled to reject.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0034_claude_invocations.sql";

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

/** An anton.db as it stood one release ago, with a project, a finished run and a job on it. */
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
    .run("proj-a", "a", "A", "/tmp/a");
  sqlite
    .prepare("insert into runs (id, project_id, epic_bead_id, status) values (?, ?, ?, 'done')")
    .run("run-a", "proj-a", "anton-epic");
  sqlite
    .prepare("insert into jobs (id, type, project_id, status) values (?, 'execute-epic', ?, 'done')")
    .run("job-a", "proj-a");
});

afterEach(() => sqlite.close());

describe("drizzle/0034 — the per-invocation spend ledger", () => {
  it("applies to a populated db and leaves every existing row untouched", () => {
    applyMigrationFile(sqlite, MIGRATION);

    expect(tables(sqlite)).toContain("claude_invocations");
    expect(sqlite.prepare("select count(*) as n from runs").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("select count(*) as n from jobs").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("select count(*) as n from claude_invocations").get()).toEqual({ n: 0 });
  });

  it("takes a full invocation row against the project and run already on the db", () => {
    applyMigrationFile(sqlite, MIGRATION);

    sqlite
      .prepare(
        `insert into claude_invocations
           (id, project_id, job_type, job_id, step, run_id, bead_id, claude_session_id,
            model_requested, model_reported, endpoint_host, input_tokens, output_tokens,
            thinking_tokens, cache_read_input_tokens, cache_creation_input_tokens,
            web_search_requests, num_turns, cost_usd, duration_ms, duration_api_ms, outcome)
         values (?, 'proj-a', 'execute-epic', 'job-a', 'implement', 'run-a', 'anton-77l9', 'sess-1',
                 'cc/claude-opus-5[1m]', 'claude-opus-5[1m]', 'gw.example.com',
                 438, 29177, 10732, 8471906, 175547, 0, 37, 6.724998, 4368913, 444789, 'ok')`,
      )
      .run("inv-1");

    const row = sqlite
      .prepare("select model_reported, input_tokens, cost_usd, recorded_at from claude_invocations")
      .get() as { model_reported: string; input_tokens: number; cost_usd: number; recorded_at: number };
    expect(row.model_reported).toBe("claude-opus-5[1m]");
    expect(row.input_tokens).toBe(438);
    expect(row.cost_usd).toBeCloseTo(6.724998, 6);
    // Defaulted by the schema, so a hand-written row is still timestamped.
    expect(row.recorded_at).toBeGreaterThan(0);
  });

  it("takes an invocation with no run, ticket, step or usage — a nightly pass's spend", () => {
    applyMigrationFile(sqlite, MIGRATION);

    sqlite
      .prepare(
        "insert into claude_invocations (id, project_id, job_type, outcome) values (?, ?, ?, 'ok')",
      )
      .run("inv-2", "proj-a", "product-master");

    const row = sqlite
      .prepare("select run_id, bead_id, step, model_reported, input_tokens from claude_invocations")
      .get() as Record<string, unknown>;
    // Unknown usage, recorded as unknown: null everywhere rather than a zero that reads as "spent
    // nothing", and the row exists rather than the invocation being lost.
    expect(row).toEqual({
      run_id: null,
      bead_id: null,
      step: null,
      model_reported: null,
      input_tokens: null,
    });
  });

  it("refuses a row that cannot say how the invocation ended", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // `outcome` is the one NOT NULL column: an invocation anton cannot say succeeded or failed is
    // not one it observed.
    expect(() =>
      sqlite.prepare("insert into claude_invocations (id, project_id) values ('x', 'proj-a')").run(),
    ).toThrow(/NOT NULL/i);
  });

  it("reverses with the recipe its header documents", () => {
    applyMigrationFile(sqlite, MIGRATION);
    expect(tables(sqlite)).toContain("claude_invocations");

    for (const statement of reverseStatements()) sqlite.exec(statement);

    expect(tables(sqlite)).not.toContain("claude_invocations");
    expect(sqlite.prepare("select count(*) as n from runs").get()).toEqual({ n: 1 });
  });
});
