/**
 * Meter-attribution migration (drizzle/0038) preserves safely known Anthropic samples while
 * quarantining legacy gateway samples, and its follow-up index (0039) bounds routed-meter reads.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0038_quota_meter_history.sql";
const INDEX_MIGRATION = "0039_common_scarlet_spider.sql";
const BACKFILL_MIGRATION = "0040_legacy-quota-attempt-backfill.sql";

/** Read a migration's documented reverse recipe so its executable steps cannot drift from the header. */
function reverseStatements(migration: string = MIGRATION): string[] {
  return readFileSync(join(process.cwd(), "drizzle", migration), "utf8")
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
      "insert into jobs (id, type, project_id, status, spent_attempts, updated_at) values ('job', 'execute-epic', 'project', 'done', 2, unixepoch())",
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
  it("carries legacy unrouted history forward on the prior Anthropic approximation", () => {
    applyMigrationFile(sqlite, MIGRATION);
    applyMigrationFile(sqlite, BACKFILL_MIGRATION);

    expect(sqlite.prepare("select meter_key from burn_samples where id = 'sample'").get()).toEqual({
      meter_key: "anthropic",
    });
    expect(
      sqlite
        .prepare("select job_id, project_id, job_type, meter_key, count(*) as n from quota_attempts group by job_id, project_id, job_type, meter_key")
        .get(),
    ).toEqual({
      job_id: "job",
      project_id: "project",
      job_type: "execute-epic",
      meter_key: "anthropic",
      n: 2,
    });
  });

  it("fills only the legacy gap when a machine already wrote ledger attempts", () => {
    applyMigrationFile(sqlite, MIGRATION);
    sqlite
      .prepare("insert into quota_attempts (id, job_id, project_id, job_type, meter_key) values ('current', 'job', 'project', 'execute-epic', 'anthropic')")
      .run();

    applyMigrationFile(sqlite, BACKFILL_MIGRATION);

    expect(sqlite.prepare("select count(*) as n from quota_attempts").get()).toEqual({ n: 2 });
  });

  it("quarantines legacy gateway burn samples and does not backfill their attempts", () => {
    sqlite
      .prepare("update projects set settings_json = ? where id = 'project'")
      .run(JSON.stringify({ claudeBaseUrl: "https://router.example/v1", claudeAuthTokenEnv: "ROUTER_TOKEN" }));
    applyMigrationFile(sqlite, MIGRATION);
    applyMigrationFile(sqlite, BACKFILL_MIGRATION);

    expect(sqlite.prepare("select meter_key from burn_samples where id = 'sample'").get()).toEqual({
      meter_key: "unattributed",
    });
    expect(sqlite.prepare("select count(*) as n from quota_attempts").get()).toEqual({ n: 0 });
  });

  it("matches future burn samples to the schema's Anthropic default", () => {
    applyMigrationFile(sqlite, MIGRATION);
    sqlite
      .prepare("insert into burn_samples (id, job_type, project_id, session_delta, weekly_delta) values ('new', 'execute-epic', 'project', 1, 1)")
      .run();

    expect(sqlite.prepare("select meter_key from burn_samples where id = 'new'").get()).toEqual({
      meter_key: "anthropic",
    });
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

  it("indexes global meter-specific burn reads and reverses cleanly", () => {
    applyMigrationFile(sqlite, MIGRATION);
    applyMigrationFile(sqlite, INDEX_MIGRATION);

    const explain = (
      sqlite
        .prepare(
          "explain query plan select * from burn_samples where job_type = ? and meter_key = ? order by created_at desc limit 5",
        )
        .all("execute-epic", "anthropic") as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(" ");
    expect(explain).toContain("burn_samples_type_meter_created_idx");

    for (const statement of reverseStatements(INDEX_MIGRATION)) sqlite.exec(statement);
    expect(
      (sqlite.pragma("index_list(burn_samples)") as { name: string }[]).map((index) => index.name),
    ).not.toContain("burn_samples_type_meter_created_idx");
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
