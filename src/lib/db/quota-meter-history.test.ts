/**
 * Meter-attribution migration (drizzle/0038): old burn rows were captured before projects could
 * route quota through a gateway, while future attempt rows need an immutable meter ledger. The
 * upgrade must preserve the former as the Anthropic default without inventing router history.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0038_quota_meter_history.sql";

/** Read the documented reverse recipe so its executable steps cannot drift from the header. */
function reverseStatements(): string[] {
  return readFileSync(join(process.cwd(), "drizzle", MIGRATION), "utf8")
    .split("\n")
    .flatMap((line) => (line.startsWith("--   ") ? [line.slice(5).trim()] : []));
}

function columnsOf(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
}

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values ('project', 'project', 'Project', '/tmp/project')")
    .run();
  sqlite
    .prepare(
      "insert into jobs (id, type, project_id, status) values ('job', 'execute-epic', 'project', 'done')",
    )
    .run();
  sqlite
    .prepare(
      "insert into burn_samples (id, job_type, project_id, session_delta, weekly_delta) values ('sample', 'execute-epic', 'project', 20, 3)",
    )
    .run();
});

afterEach(() => sqlite.close());

describe("drizzle/0038 — quota meter history", () => {
  it("backfills historical burn samples to Anthropic without inventing attempt history", () => {
    applyMigrationFile(sqlite, MIGRATION);

    expect(sqlite.prepare("select meter_key from burn_samples where id = 'sample'").get()).toEqual({
      meter_key: "anthropic",
    });
    expect(sqlite.prepare("select count(*) as n from quota_attempts").get()).toEqual({ n: 0 });
  });

  it("creates the indexed append-only ledger for future meter-attributed attempts", () => {
    applyMigrationFile(sqlite, MIGRATION);
    sqlite
      .prepare(
        "insert into quota_attempts (id, job_id, project_id, job_type, meter_key, created_at) values ('attempt', 'job', 'project', 'execute-epic', 'router:https://router.example/api/usage/connection', 1700000000)",
      )
      .run();

    expect(sqlite.prepare("select meter_key from quota_attempts where id = 'attempt'").get()).toEqual({
      meter_key: "router:https://router.example/api/usage/connection",
    });
    const indexes = (sqlite.pragma("index_list(quota_attempts)") as { name: string }[]).map(
      (index) => index.name,
    );
    expect(indexes).toContain("quota_attempts_meter_created_project_idx");
  });

  it("reverses with the documented recipe while preserving the pre-migration rows", () => {
    const beforeBurnColumns = columnsOf(sqlite, "burn_samples");
    applyMigrationFile(sqlite, MIGRATION);

    const undo = reverseStatements();
    expect(undo).not.toEqual([]);
    for (const statement of undo) sqlite.exec(statement);

    expect(columnsOf(sqlite, "burn_samples")).toEqual(beforeBurnColumns);
    expect(sqlite.prepare("select count(*) as n from burn_samples").get()).toEqual({ n: 1 });
    expect(columnsOf(sqlite, "quota_attempts")).toEqual([]);
    const jobIndexes = (sqlite.pragma("index_list(jobs)") as { name: string }[]).map(
      (index) => index.name,
    );
    expect(jobIndexes).toContain("jobs_updated_project_idx");
  });
});
