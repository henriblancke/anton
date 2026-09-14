/**
 * The schedules `auto_armed` backfill migration (drizzle/0039, for anton-g81s), asserted against the
 * one shape it can get wrong: a `run-health` row an operator explicitly enabled and then, before
 * this upgrade, deliberately disabled again.
 *
 * `enabled = false` alone can't tell that row apart from the untouched legacy opt-out default (PR
 * #277 review) — both read identically at migration time. `last_run_at` can: it is only ever
 * stamped while a row is `enabled` (the scheduler and "Run now" both refuse a disabled row), so a
 * disabled row that has fired before proves an operator enabled it at some point, and its current
 * `enabled = false` is their own later choice, not the default. This suite reconstructs both
 * pre-migration shapes and checks the migration tells them apart.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0039_schedules_auto_armed.sql";

let sqlite: Database.Database;

function seedSchedule(o: { id: string; enabled: 0 | 1; lastRunAt: number | null }) {
  sqlite
    .prepare(
      "insert into schedules (id, project_id, type, cron, enabled, last_run_at) values (?, ?, ?, ?, ?, ?)",
    )
    .run(o.id, "proj-a", "run-health", "0 * * * *", o.enabled, o.lastRunAt);
}

function autoArmedOf(id: string): number {
  return (
    sqlite.prepare("select auto_armed as v from schedules where id = ?").get(id) as { v: number }
  ).v;
}

/** An anton.db as it stood one release ago: every migration applied EXCEPT the one under test. */
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
    .run("proj-a", "a", "A", "/tmp/a");
});

afterEach(() => sqlite.close());

describe("drizzle/0039 — schedules gain auto_armed", () => {
  it("marks an enabled row armed", () => {
    seedSchedule({ id: "s-enabled", enabled: 1, lastRunAt: null });
    applyMigrationFile(sqlite, MIGRATION);
    expect(autoArmedOf("s-enabled")).toBe(1);
  });

  it("leaves a disabled row that has never fired eligible for the one-time arm", () => {
    // The untouched legacy opt-out default: never enabled, so never run.
    seedSchedule({ id: "s-untouched", enabled: 0, lastRunAt: null });
    applyMigrationFile(sqlite, MIGRATION);
    expect(autoArmedOf("s-untouched")).toBe(0);
  });

  it("preserves a pre-upgrade operator disable — a disabled row that has fired before", () => {
    // Proves the operator enabled it at some point (only an enabled row ever fires), then disabled
    // it again before this upgrade. The one-time arm must not override that deliberate choice.
    seedSchedule({ id: "s-disabled-after-run", enabled: 0, lastRunAt: 1_700_000_000 });
    applyMigrationFile(sqlite, MIGRATION);
    expect(autoArmedOf("s-disabled-after-run")).toBe(1);
  });
});
