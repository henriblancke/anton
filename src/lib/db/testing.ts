/**
 * Test-only: build an isolated anton.db (in-memory or temp file) with the real schema applied,
 * so job-runner / persistence tests never touch the shared anton.db. Applies the committed
 * drizzle migration SQL directly (no drizzle-kit at test time).
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema";

/**
 * Apply every committed drizzle migration to a raw sqlite connection (in-memory or file-backed).
 * Shared by `makeTestDb` (in-memory) and `src/lib/testing/integration.ts`'s `makeFileDb` (temp
 * file) so both apply the exact same schema the exact same way — no duplicated SQL parsing.
 */
export function applyMigrationsTo(sqlite: Database.Database, opts: { before?: string } = {}): void {
  for (const file of migrationFiles()) {
    // `before` reconstructs the schema as it stood just before a migration, so a migration test can
    // seed the rows an upgrading machine already has and then apply the migration to them.
    if (file === opts.before) break;
    applyMigrationFile(sqlite, file);
  }
}

/** Every committed migration, in the filename order both the harness and the packaged runner apply. */
export function migrationFiles(): string[] {
  return readdirSync(join(process.cwd(), "drizzle"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Apply one committed migration by filename (e.g. `0030_burn_sample_project.sql`). */
export function applyMigrationFile(sqlite: Database.Database, file: string): void {
  const raw = readFileSync(join(process.cwd(), "drizzle", file), "utf8");
  // Drizzle separates statements with a `--> statement-breakpoint` marker line.
  const sql = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(";\n");
  sqlite.exec(sql);
}

export interface TestDb {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
  close: () => void;
}

/** A fresh, schema-loaded in-memory database for a single test file/suite. */
export function makeTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrationsTo(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}
