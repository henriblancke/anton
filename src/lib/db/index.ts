import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { join } from "node:path";
import * as schema from "./schema";

let _db: BetterSQLite3Database<typeof schema> | null = null;

/**
 * Lazily open anton.db on first use — never at module import. Opening at import races
 * `next build`'s parallel workers on the same file (SQLITE_BUSY). Lazy + busy_timeout avoids it.
 */
export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;
  const dbPath = process.env.ANTON_DB ?? join(process.cwd(), "anton.db");
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  _db = drizzle(sqlite, { schema });
  return _db;
}

export { schema };
