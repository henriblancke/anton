/**
 * Which committed migrations a database has NOT applied (anton-sm1l) — the schema half of "is anton
 * running its own latest code", and the one gap a build-identity comparison cannot see: a pull moves
 * the code and the migration files together, so a process can be running the newest build against a
 * schema that build has outgrown.
 *
 * Two writers bookkeep the same migration set in two different tables, and a reader that knows only
 * one of them is confidently wrong. A source checkout runs `drizzle-kit migrate`, which records a
 * hash and the journal timestamp per migration in `__drizzle_migrations`; a release bundle applies
 * the committed SQL in-process instead (bin/anton.mjs — no drizzle-kit devDep ships) and records the
 * FILENAME in `__anton_migrations`. Both tables routinely exist in one database, and on a source
 * checkout the bundle's is present and EMPTY — so reading that one alone reports every migration
 * pending.
 *
 * So a migration counts as applied when EITHER bookkeeper accounts for it, and is pending only when
 * neither does.
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** drizzle-kit's bookkeeping: `hash` + the journal `when`, one row per migration it applied. */
const DRIZZLE_TABLE = "__drizzle_migrations";

/** The bundle's bookkeeping (bin/anton.mjs): one row per migration FILE it applied. */
const ANTON_TABLE = "__anton_migrations";

/** Every committed migration, in the filename order both writers apply them in. */
export function committedMigrations(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/**
 * The committed migrations `dbPath` has no record of, in apply order — empty when the schema is
 * current. Throws when either side cannot be read (a missing database, an unreadable migrations
 * directory): a caller must be able to tell "nothing is pending" from "could not tell", and this
 * returning an empty list for both would collapse exactly that distinction.
 *
 * Opened read-only: a freshness check must never be the thing that creates the database it is
 * judging — better-sqlite3 creates the file by default, which would turn "no schema yet" into a
 * silent empty one — and `fileMustExist` is what makes that absence reach the caller as the error it is.
 */
export function pendingMigrations({
  dbPath,
  migrationsDir,
}: {
  dbPath: string;
  migrationsDir: string;
}): string[] {
  const committed = committedMigrations(migrationsDir);
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const applied = appliedMigrations(sqlite, migrationsDir, committed);
    return committed.filter((file) => !applied.has(file));
  } finally {
    sqlite.close();
  }
}

/** Which of `committed` either bookkeeper accounts for — the union, for the reason above. */
function appliedMigrations(
  sqlite: Database.Database,
  migrationsDir: string,
  committed: string[],
): Set<string> {
  const applied = new Set<string>();

  if (hasTable(sqlite, ANTON_TABLE)) {
    for (const row of sqlite.prepare(`SELECT name FROM ${ANTON_TABLE}`).all() as { name: unknown }[]) {
      if (typeof row.name === "string") applied.add(row.name);
    }
  }

  const watermark = hasTable(sqlite, DRIZZLE_TABLE) ? drizzleWatermark(sqlite) : null;
  if (watermark !== null) {
    const stamps = journalStamps(migrationsDir);
    for (const file of committed) {
      const when = stamps.get(file);
      if (when !== undefined && when <= watermark) applied.add(file);
    }
  }

  return applied;
}

function hasTable(sqlite: Database.Database, name: string): boolean {
  return (
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * The newest journal timestamp `drizzle-kit migrate` has recorded, or null when it has recorded
 * nothing (an empty table, or rows carrying no usable timestamp).
 *
 * Drizzle's own migrator reads exactly this one value and applies every journal entry stamped LATER
 * than it (drizzle-orm/sqlite-core `SQLiteSyncDialect.migrate`), so standing on the same watermark
 * answers the only question that matters here — would a migrate run anything — and cannot disagree
 * with the tool that will run it.
 *
 * Matching each file's sha256 against the recorded hashes would be stricter and wrong: an applied
 * migration whose file was later reformatted would read pending forever, since no migrate would ever
 * re-run it to clear the claim.
 */
function drizzleWatermark(sqlite: Database.Database): number | null {
  const row = sqlite.prepare(`SELECT MAX(created_at) AS watermark FROM ${DRIZZLE_TABLE}`).get() as
    | { watermark: unknown }
    | undefined;
  const watermark = Number(row?.watermark);
  return row?.watermark === null || row?.watermark === undefined || !Number.isFinite(watermark)
    ? null
    : watermark;
}

/** The subset of drizzle's journal this read needs: which file each recorded timestamp belongs to. */
interface Journal {
  entries?: { tag?: unknown; when?: unknown }[];
}

/**
 * Filename → the timestamp drizzle-kit stamps it with, for the files the journal names.
 *
 * Absent or unreadable is not an error: the journal is only how the WATERMARK is mapped back onto
 * files, and the filename table can still account for every one of them. A file the journal does not
 * name is left for that table to claim — drizzle would never apply it either, since its migrator
 * walks the journal rather than the directory.
 */
function journalStamps(migrationsDir: string): Map<string, number> {
  const stamps = new Map<string, number>();
  try {
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as Journal;
    for (const entry of journal.entries ?? []) {
      if (typeof entry?.tag === "string" && typeof entry?.when === "number") {
        stamps.set(`${entry.tag}.sql`, entry.when);
      }
    }
  } catch {
    return stamps;
  }
  return stamps;
}
