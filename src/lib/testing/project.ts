/**
 * Test-only: the project row every db-backed suite arranges around.
 *
 * `projects` is the FK root of the whole schema — jobs, runs, escalations and passes all hang off
 * it — so a suite that touches any of them must first insert one. Forty-odd suites hand-copied the
 * same `makeTestDb()` + `randomUUID()` + `insert(schema.projects)` block, which made a new
 * `projects` column forty identical edits and let the copies drift into subtly different projects.
 *
 * This lives beside `integration.ts` rather than inside it on purpose: `integration.ts` probes
 * `bd`/`git` with `execFileSync` at import time (for `describeBd`), a cost unit suites like
 * `picker-wip-hold.test.ts` should not pay just to reach this helper.
 *
 * Both helpers are synchronous — better-sqlite3 is — so a suite that seeded its project inside a
 * sync `beforeEach` does not have to become async to use them.
 */
import { randomUUID } from "node:crypto";
import * as schema from "@/lib/db/schema";
import { makeTestDb, type TestDb } from "@/lib/db/testing";

/** The insert shape of `schema.projects` — every column, all optional here. */
export type TestProjectRow = typeof schema.projects.$inferInsert;

/** A {@link makeTestDb} database that already holds one project row. */
export interface TestProjectDb extends TestDb {
  /** The id of the inserted project — the value job payloads and run rows are scoped by. */
  projectId: string;
}

/**
 * Insert one project row into an existing test db and return its id.
 *
 * Defaults mirror the block the suites inlined: a random id, the `sandbox` slug, and `main` as the
 * default branch. `repoPath` points at a path that need not exist — suites driving real `bd`/`git`
 * override it with their temp repo; unit suites never read it.
 */
export function insertProject(db: TestDb["db"], overrides: Partial<TestProjectRow> = {}): string {
  const row: TestProjectRow = {
    id: randomUUID(),
    slug: "sandbox",
    name: "sandbox",
    repoPath: "/tmp/sandbox",
    defaultBranch: "main",
    ...overrides,
  };
  db.insert(schema.projects).values(row).run();
  return row.id;
}

/** A fresh in-memory db with one project already in it — {@link makeTestDb} + {@link insertProject}. */
export function makeProjectDb(overrides: Partial<TestProjectRow> = {}): TestProjectDb {
  const tdb = makeTestDb();
  return { ...tdb, projectId: insertProject(tdb.db, overrides) };
}
