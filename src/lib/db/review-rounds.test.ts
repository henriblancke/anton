/**
 * The per-round review record's migration (drizzle/0062_review_rounds.sql), asserted against the database that can
 * actually go wrong: an existing anton.db with a project and a settled run whose PR already merged —
 * exactly the row whose thread counts are unrecoverable.
 *
 * The table is purely additive, so what the migration must prove is that it applies to a POPULATED db
 * without disturbing it, that a row can be written the moment it lands, that the columns a round
 * cannot know are nullable (a round that is still open has no terminal PR state, and a NOT NULL there
 * would reject every row the write path produces), and that the counts default to zero so a round with
 * no threads of some kind still writes one row. The reverse recipe the header documents is run too,
 * since "reversible" is a claim about SQL that SQLite is entitled to reject.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrationFile, applyMigrationsTo } from "./testing";

const MIGRATION = "0062_review_rounds.sql";

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

/** An anton.db as it stood one release ago, with a project and a delivered run behind a merged PR. */
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite, { before: MIGRATION });
  sqlite
    .prepare("insert into projects (id, slug, name, repo_path) values (?, ?, ?, ?)")
    .run("proj-a", "a", "A", "/tmp/a");
  // The row this feature exists because of: it delivered, its PR merged, and however many review
  // threads that PR carried is already gone — GitHub reports the end state and no migration can
  // recover the counts.
  sqlite
    .prepare(
      `insert into runs (id, project_id, epic_bead_id, status, started_at, attempt_started_at, ended_at, updated_at)
       values (?, 'proj-a', 'anton-epic', 'done', 1000, 1000, 4600, 4600)`,
    )
    .run("run-a");
});

afterEach(() => sqlite.close());

describe("drizzle/0062 — the per-round review record", () => {
  it("applies to a populated db and leaves every existing row untouched", () => {
    applyMigrationFile(sqlite, MIGRATION);

    expect(tables(sqlite)).toContain("review_rounds");
    expect(sqlite.prepare("select count(*) as n from projects").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("select status, ended_at from runs").get()).toEqual({
      status: "done",
      ended_at: 4600,
    });
  });

  it("backfills nothing — the merged PR's threads are gone, not zero", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // Deliberately empty. Synthesizing a row from the settled run would report every legacy PR as
    // having carried no review threads, which is the exact wrong number this record exists to stop
    // anyone reporting.
    expect(sqlite.prepare("select count(*) as n from review_rounds").get()).toEqual({ n: 0 });
  });

  it("takes a round against the project already on the db", () => {
    applyMigrationFile(sqlite, MIGRATION);

    sqlite
      .prepare(
        `insert into review_rounds
           (id, project_id, bead_id, job_id, pr_number, round,
            threads_seen, threads_unresolved, threads_outdated, threads_actionable,
            outcomes_fixed, outcomes_left, outcomes_needs_human, by_author_json)
         values (?, 'proj-a', 'anton-epic', 'job-1', 331, 1, 5, 3, 1, 3, 2, 1, 0, ?)`,
      )
      .run("rr-1", JSON.stringify({ "claude[bot]": 2, henri: 1 }));

    const row = sqlite
      .prepare(
        `select pr_number, round, threads_seen, threads_unresolved, threads_outdated,
                threads_actionable, outcomes_fixed, outcomes_left, outcomes_needs_human,
                by_author_json, recorded_at
         from review_rounds`,
      )
      .get() as Record<string, number | string>;
    expect(row.pr_number).toBe(331);
    expect(row.threads_seen).toBe(5);
    expect(row.threads_actionable).toBe(3);
    expect(row.outcomes_fixed).toBe(2);
    // The per-reviewer split — the whole reason the record is worth keeping: a bot's volume and a
    // human's are distinguishable.
    expect(JSON.parse(String(row.by_author_json))).toEqual({ "claude[bot]": 2, henri: 1 });
    // Defaulted by the schema, so a hand-written row is still timestamped.
    expect(Number(row.recorded_at)).toBeGreaterThan(0);
  });

  it("takes a round whose PR has not ended — no terminal state", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // The row EVERY round writes: the PR is still open, so its fate is unknown. A NOT NULL on either
    // column would reject it outright and nothing would ever be recorded at all.
    sqlite
      .prepare("insert into review_rounds (id, pr_number, round) values (?, 331, 1)")
      .run("rr-open");

    expect(
      sqlite
        .prepare("select pr_state, pr_state_at, project_id, bead_id, job_id from review_rounds")
        .get(),
    ).toEqual({ pr_state: null, pr_state_at: null, project_id: null, bead_id: null, job_id: null });
  });

  it("defaults every count to zero, so a round with nothing to count still writes one row", () => {
    applyMigrationFile(sqlite, MIGRATION);

    sqlite
      .prepare("insert into review_rounds (id, pr_number, round) values (?, 331, 1)")
      .run("rr-zero");

    // A CI-only or merge-conflict round dispatches claude over no inline threads at all. It is still a
    // round, and the zeros say so — distinct from the no-row a polling tick leaves.
    expect(
      sqlite
        .prepare(
          `select threads_seen, threads_unresolved, threads_outdated, threads_actionable,
                  outcomes_fixed, outcomes_left, outcomes_needs_human, by_author_json
           from review_rounds`,
        )
        .get(),
    ).toEqual({
      threads_seen: 0,
      threads_unresolved: 0,
      threads_outdated: 0,
      threads_actionable: 0,
      outcomes_fixed: 0,
      outcomes_left: 0,
      outcomes_needs_human: 0,
      by_author_json: "{}",
    });
  });

  it("takes finalize's terminal stamp across a PR's rows", () => {
    applyMigrationFile(sqlite, MIGRATION);

    for (const [id, round] of [
      ["rr-1", 1],
      ["rr-2", 2],
    ] as const) {
      sqlite
        .prepare(
          "insert into review_rounds (id, project_id, pr_number, round) values (?, 'proj-a', 331, ?)",
        )
        .run(id, round);
    }

    // The one write that is not append-only, and the reason `pr_state` lives here rather than in a
    // second table keyed by PR: a round cannot know its PR's fate while it is running.
    sqlite
      .prepare(
        "update review_rounds set pr_state = 'merged', pr_state_at = 5000 where project_id = ? and pr_number = ?",
      )
      .run("proj-a", 331);

    expect(
      sqlite.prepare("select pr_state, pr_state_at from review_rounds order by round").all(),
    ).toEqual([
      { pr_state: "merged", pr_state_at: 5000 },
      { pr_state: "merged", pr_state_at: 5000 },
    ]);
  });

  it("refuses a row that cannot say which PR or which round", () => {
    applyMigrationFile(sqlite, MIGRATION);

    // `pr_number` and `round` are the NOT NULL columns beside the id: a round anton cannot place on a
    // PR, or order within it, is not review it observed. Everything else is nullable on purpose — the
    // write is best-effort and must not reject a row about review that really happened.
    expect(() =>
      sqlite.prepare("insert into review_rounds (id, round) values ('x', 1)").run(),
    ).toThrow(/NOT NULL/i);
    expect(() =>
      sqlite.prepare("insert into review_rounds (id, pr_number) values ('y', 331)").run(),
    ).toThrow(/NOT NULL/i);
  });

  it("indexes one project's rounds over a window — the read the trend fold starts from", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const plan = sqlite
      .prepare(
        "explain query plan select * from review_rounds where project_id = ? and recorded_at >= ?",
      )
      .all("proj-a", 0) as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/review_rounds_project_idx/);
  });

  it("indexes one PR's rounds — the ordinal derivation and finalize's stamp", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const plan = sqlite
      .prepare(
        "explain query plan select * from review_rounds where project_id = ? and pr_number = ? order by round",
      )
      .all("proj-a", 331) as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/review_rounds_pr_idx/);
  });

  it("indexes the feature roll-up's bead scope", () => {
    applyMigrationFile(sqlite, MIGRATION);

    const plan = sqlite
      .prepare("explain query plan select * from review_rounds where bead_id in (?, ?)")
      .all("anton-epic", "anton-1pjo0") as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/review_rounds_bead_idx/);
  });

  it("reverses with the recipe its header documents", () => {
    applyMigrationFile(sqlite, MIGRATION);
    expect(tables(sqlite)).toContain("review_rounds");

    for (const statement of reverseStatements()) sqlite.exec(statement);

    expect(tables(sqlite)).not.toContain("review_rounds");
    expect(sqlite.prepare("select count(*) as n from runs").get()).toEqual({ n: 1 });
  });
});
