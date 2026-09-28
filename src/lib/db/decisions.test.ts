/**
 * The decision log's migration (drizzle/0059), asserted against the database that can actually go
 * wrong: an existing anton.db with a project and a run already on it.
 *
 * The table is purely additive, so what the migration must prove is that it applies to a POPULATED db
 * without disturbing it, that a row can be written the moment it lands, and — the load-bearing part —
 * that the SETTLE columns really are nullable. A decision is recorded long before the operator answers
 * it, so a NOT NULL on `operator_answer`/`settled_at` would reject the row that OPENS every pair, and
 * shadow mode would record nothing at all. The reverse recipe the header documents is run too, since
 * "reversible" is a claim about SQL that SQLite is entitled to reject.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0059_decisions.sql";

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

/** An anton.db as it stood one release ago, with a project and a settled run on it. */
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
       values ('run-a', 'proj-a', 'anton-epic', 'done', 1000, 1600, 1600)`,
    )
    .run();
});

afterEach(() => sqlite.close());

describe("drizzle/0059 — the decision log", () => {
  it("applies to a populated db and leaves every existing row untouched", () => {
    applyMigrationFile(sqlite, MIGRATION);

    expect(tables(sqlite)).toContain("decisions");
    expect(sqlite.prepare("select count(*) as n from projects").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("select status, ended_at from runs").get()).toEqual({
      status: "done",
      ended_at: 1600,
    });
  });

  it("backfills nothing — nothing was decided before the log existed", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // Deliberately empty. An empty log reads as "not measured" and reports zero samples, never as a
    // point whose operator disagreed with it.
    expect(sqlite.prepare("select count(*) as n from decisions").get()).toEqual({ n: 0 });
  });

  it("takes an UNSETTLED decision — no operator answer, no outcome, no settle stamp", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // The row that opens every pair, and the state most rows are in at any moment. A NOT NULL on any
    // settle column would reject it outright, and shadow mode would record nothing at all.
    sqlite
      .prepare(
        `insert into decisions (id, project_id, point, mode, decided_by, answer, confidence, input_hash, acted)
         values (?, 'proj-a', 'review-nit', 'shadow', 'model', '"fix"', 0.91, 'abc123', 0)`,
      )
      .run("dec-1");

    expect(
      sqlite
        .prepare(
          "select operator_answer, operator_action, outcome, settled_at, reason from decisions",
        )
        .get(),
    ).toEqual({
      operator_answer: null,
      operator_action: null,
      outcome: null,
      settled_at: null,
      reason: null,
    });
    // Defaulted by the schema, so a hand-written row is still timestamped.
    const decidedAt = sqlite.prepare("select decided_at from decisions").get() as {
      decided_at: number;
    };
    expect(Number(decidedAt.decided_at)).toBeGreaterThan(0);
  });

  it("takes the settle half written later against the same row", () => {
    applyMigrationFile(sqlite, MIGRATION);
    sqlite
      .prepare(
        `insert into decisions (id, point, mode, decided_by, answer, confidence, input_hash, acted)
         values ('dec-1', 'review-nit', 'shadow', 'model', '"fix"', 0.91, 'abc123', 0)`,
      )
      .run();

    sqlite
      .prepare(
        `update decisions set operator_answer = '"fix"', operator_action = 'fix',
         outcome = 'merged', settled_at = 9000 where id = 'dec-1'`,
      )
      .run();

    expect(
      sqlite
        .prepare("select answer, operator_answer, operator_action, outcome, settled_at from decisions")
        .get(),
    ).toEqual({
      answer: '"fix"',
      operator_answer: '"fix"',
      operator_action: "fix",
      outcome: "merged",
      settled_at: 9000,
    });
  });

  it("takes an answerless decision — a fallback to a human answered nothing", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // `answer` must be nullable: `off` mode and every fallback produce no answer at all, and a row
    // inventing one would be counted as evidence about the point's judgment.
    sqlite
      .prepare(
        `insert into decisions (id, point, mode, decided_by, confidence, input_hash, acted, reason)
         values ('dec-2', 'review-nit', 'shadow', 'fallback', 0, 'abc123', 0, 'model call failed')`,
      )
      .run();

    expect(sqlite.prepare("select answer, reason from decisions").get()).toEqual({
      answer: null,
      reason: "model call failed",
    });
  });

  it("refuses a row that cannot say which point, mode, confidence or input it decided on", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // A decision anton cannot attribute to a point, place in a mode, or tie to an input is not a
    // decision it can measure — so those columns are NOT NULL.
    expect(() =>
      sqlite.prepare("insert into decisions (id, mode) values ('x', 'shadow')").run(),
    ).toThrow(/NOT NULL/i);
    expect(() =>
      sqlite.prepare("insert into decisions (id, point) values ('y', 'review-nit')").run(),
    ).toThrow(/NOT NULL/i);
    expect(() =>
      sqlite
        .prepare(
          `insert into decisions (id, point, mode, decided_by, confidence, acted)
           values ('z', 'review-nit', 'shadow', 'model', 0.5, 0)`,
        )
        .run(),
    ).toThrow(/NOT NULL/i);
  });

  it("takes a decision with no project — a point can be asked outside one", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // `project_id` is deliberately not an FK and not required: the write is best-effort, and a
    // reference the writer cannot satisfy must not reject a row about a decision that happened.
    sqlite
      .prepare(
        `insert into decisions (id, project_id, point, mode, decided_by, confidence, input_hash, acted)
         values ('dec-3', 'gone', 'review-nit', 'shadow', 'fallback', 0, 'abc123', 0)`,
      )
      .run();

    expect(sqlite.prepare("select project_id from decisions").get()).toEqual({ project_id: "gone" });
  });

  it("indexes one point's decisions newest-first — the only read the table has", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const plan = sqlite
      .prepare(
        "explain query plan select * from decisions where point = ? order by decided_at desc",
      )
      .all("review-nit") as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/decisions_point_idx/);
  });

  it("reverses with the recipe its header documents", () => {
    applyMigrationFile(sqlite, MIGRATION);
    expect(tables(sqlite)).toContain("decisions");

    for (const statement of reverseStatements()) sqlite.exec(statement);

    expect(tables(sqlite)).not.toContain("decisions");
    expect(sqlite.prepare("select count(*) as n from runs").get()).toEqual({ n: 1 });
  });
});
