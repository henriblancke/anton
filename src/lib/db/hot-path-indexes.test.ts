import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0046_lush_magma.sql";

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
      "insert into jobs (id, type, project_id, status, run_at, lease_expires_at, updated_at) values (?, 'execute-epic', 'project', ?, ?, ?, ?)",
    )
    .run("queued", "queued", 100, null, 100);
  sqlite
    .prepare(
      "insert into jobs (id, type, project_id, status, run_at, lease_expires_at, updated_at) values (?, 'execute-epic', 'project', ?, ?, ?, ?)",
    )
    .run("running", "running", 100, 100, 101);
  sqlite
    .prepare(
      "insert into runs (id, project_id, epic_bead_id, status, updated_at) values ('run', 'project', 'epic', 'parked', 100)",
    )
    .run();
  sqlite
    .prepare(
      "insert into sessions (id, project_id, run_id, kind, started_at) values ('session', 'project', 'run', 'execute', 100)",
    )
    .run();
});

afterEach(() => sqlite.close());

function plan(sql: string, ...params: unknown[]): string {
  return (sqlite.prepare(`explain query plan ${sql}`).all(...params) as { detail: string }[])
    .map((row) => row.detail)
    .join(" ");
}

describe("drizzle/0046 — SQLite hot-path indexes", () => {
  it("creates indexes that SQLite selects for the runner and operational-history reads", () => {
    applyMigrationFile(sqlite, MIGRATION);

    expect(plan("select id from jobs where status = ? and run_at <= ? order by run_at limit 1", "queued", 100)).toContain(
      "jobs_status_run_at_idx",
    );
    expect(plan("select id from jobs where status = ? and lease_expires_at <= ?", "running", 100)).toContain(
      "jobs_status_lease_expires_at_idx",
    );
    const leaseDuePlan = plan(
      "select id from jobs where (status = ? and run_at <= ?) or (status = ? and lease_expires_at <= ?) order by run_at limit 1",
      "queued",
      100,
      "running",
      100,
    );
    expect(leaseDuePlan).toContain("jobs_status_run_at_idx");
    expect(leaseDuePlan).toContain("jobs_status_lease_expires_at_idx");
    expect(plan("select id from jobs where project_id = 'project' order by updated_at desc limit 1"))
      .toContain("jobs_project_updated_idx");
    expect(
      plan(
        "select id from runs where project_id = ? and epic_bead_id = ? and status in (?, ?, ?) order by updated_at desc limit 1",
        "project",
        "epic",
        "queued",
        "running",
        "parked",
      ),
    ).toContain("runs_project_epic_updated_idx");
    expect(plan("select id from sessions where run_id = 'run' order by started_at desc"))
      .toContain("sessions_run_started_idx");
  });
});
