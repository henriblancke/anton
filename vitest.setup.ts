/**
 * Global test setup — the database guard.
 *
 * `getDb()` resolves `process.env.ANTON_DB ?? <cwd>/anton.db`, and better-sqlite3 CREATES the file
 * when it is missing. So any code path a suite forgets to stub silently opens a real database: the
 * developer's live anton.db locally (a test then reads whatever last night's job wrote — an
 * assertion on it passes or fails by machine state), and a fresh, schema-less file on a CI runner
 * (every query fails with `no such table`, which callers that degrade gracefully turn into log
 * noise on an otherwise green run).
 *
 * This runs before every test FILE and points ANTON_DB at a private temp directory, so the worst a
 * missed stub can do is create an empty database nothing else shares. It is deliberately
 * unconditional — honouring an inherited ANTON_DB would let `ANTON_DB=./anton.db bun run test`
 * write to the real thing, which is the accident being closed off. Suites that want a real schema
 * still set ANTON_DB themselves (see `src/lib/testing/integration.ts`); assigning it inside the
 * test file wins over this, since `getDb()` is lazy and reads the variable on first use.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "anton-vitest-db-"));
process.env.ANTON_DB = join(dir, "anton.db");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
