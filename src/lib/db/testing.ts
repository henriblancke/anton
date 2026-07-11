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

/** Apply every committed drizzle migration to a raw sqlite connection. */
function applyMigrations(sqlite: Database.Database): void {
  const dir = join(process.cwd(), "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    // Drizzle separates statements with a `--> statement-breakpoint` marker line.
    const sql = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(";\n");
    sqlite.exec(sql);
  }
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
  applyMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}
