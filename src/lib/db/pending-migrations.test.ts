/**
 * The schema-drift reader (anton-sm1l), over a temp database per case.
 *
 * Both bookkeepers are exercised against the REAL writers rather than hand-built tables: the source
 * path runs drizzle-orm's own migrator (the code `drizzle-kit migrate` drives), and the bundle path
 * runs `applyMigrations` out of `bin/anton.mjs`. That is the point of the ticket — the two tables
 * bookkeep differently, filename rows against a timestamp watermark — and a fixture asserting the
 * shape this reader happens to expect would pass while the real writers disagreed with it.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "../../../bin/anton.mjs";
import { committedMigrations, pendingMigrations } from "./pending-migrations";

interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  { name: "0000_first", sql: "CREATE TABLE first (id integer primary key);" },
  { name: "0001_second", sql: "CREATE TABLE second (id integer primary key);" },
  { name: "0002_third", sql: "CREATE TABLE third (id integer primary key);" },
];

/** A migration a later pull adds — what turns an up-to-date database into a pending one. */
const FOURTH: Migration = {
  name: "0003_fourth",
  sql: "CREATE TABLE fourth (id integer primary key);",
};

/**
 * A migration set on disk — `<dir>/*.sql` plus the `meta/_journal.json` both writers read.
 *
 * A purpose-built set rather than the repo's own 42, because every case here turns on some of the
 * set being unapplied, and expressing that against the real migrations would mean editing
 * bookkeeping rows by hand — which is the thing under test.
 */
function writeMigrations(dir: string, migrations: Migration[]): string {
  mkdirSync(join(dir, "meta"), { recursive: true });
  for (const { name, sql } of migrations) writeFileSync(join(dir, `${name}.sql`), sql);
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "6",
      dialect: "sqlite",
      // `when` is the watermark drizzle compares against, so it ascends with apply order.
      entries: migrations.map(({ name }, idx) => ({
        idx,
        version: "6",
        when: 1_000 + idx,
        tag: name,
        breakpoints: true,
      })),
    }),
  );
  return dir;
}

describe("pendingMigrations", () => {
  let dir: string;
  let dbPath: string;
  let migrationsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anton-pending-migrations-"));
    dbPath = join(dir, "anton.db");
    migrationsDir = writeMigrations(join(dir, "drizzle"), MIGRATIONS);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Apply `migrations` the way a SOURCE checkout does — drizzle's own migrator, which records a
   * hash and the journal timestamp in `__drizzle_migrations`. Migrated from its own folder so a
   * case can apply a PREFIX of the set the reader is then pointed at.
   */
  function migrateSource(migrations: Migration[] = MIGRATIONS): void {
    const folder = writeMigrations(mkdtempSync(join(dir, "applied-")), migrations);
    const sqlite = new Database(dbPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: folder });
    } finally {
      sqlite.close();
    }
  }

  /**
   * Apply the set at `migrationsDir` the way a release BUNDLE does — `applyMigrations` from the
   * launcher, which records the FILENAME in `__anton_migrations`.
   *
   * It resolves `better-sqlite3` through the appRoot it is handed, so the fixture root needs the
   * `package.json` + `node_modules` a real install has; the symlink borrows this repo's.
   */
  function migrateBundle(): { ran: number; total: number } {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
    symlinkSync(join(process.cwd(), "node_modules"), join(dir, "node_modules"), "dir");
    return applyMigrations(dbPath, { appRoot: dir });
  }

  /** How many rows each bookkeeper holds — the asymmetry the reader has to bridge. */
  function bookkeeping(): { drizzle: number | null; anton: number | null } {
    const sqlite = new Database(dbPath, { readonly: true });
    const count = (table: string): number | null => {
      const present = sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!present) return null;
      return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    };
    try {
      return { drizzle: count("__drizzle_migrations"), anton: count("__anton_migrations") };
    } finally {
      sqlite.close();
    }
  }

  describe("the source path (drizzle-kit's __drizzle_migrations)", () => {
    it("reports clean once every migration is applied", () => {
      migrateSource();

      expect(bookkeeping()).toEqual({ drizzle: MIGRATIONS.length, anton: null });
      expect(pendingMigrations({ dbPath, migrationsDir })).toEqual([]);
    });

    it("names the migrations the database has not reached, in apply order", () => {
      migrateSource(MIGRATIONS.slice(0, 1));

      expect(pendingMigrations({ dbPath, migrationsDir })).toEqual([
        "0001_second.sql",
        "0002_third.sql",
      ]);
    });

    it("sees a migration a pull added after the database was brought up to date", () => {
      migrateSource();
      writeMigrations(migrationsDir, [...MIGRATIONS, FOURTH]);

      expect(pendingMigrations({ dbPath, migrationsDir })).toEqual(["0003_fourth.sql"]);
    });
  });

  describe("the bundle path (__anton_migrations)", () => {
    it("reports clean once every migration is applied", () => {
      expect(migrateBundle()).toEqual({ ran: MIGRATIONS.length, total: MIGRATIONS.length });

      // The bundle ships no drizzle-kit, so only its own filename table exists here.
      expect(bookkeeping()).toEqual({ drizzle: null, anton: MIGRATIONS.length });
      expect(pendingMigrations({ dbPath, migrationsDir })).toEqual([]);
    });

    it("sees a migration a pull added after the database was brought up to date", () => {
      migrateBundle();
      writeMigrations(migrationsDir, [...MIGRATIONS, FOURTH]);

      expect(pendingMigrations({ dbPath, migrationsDir })).toEqual(["0003_fourth.sql"]);
    });
  });

  /**
   * The exact failure the ticket was filed on. A source checkout that has ever had a bundle start
   * attempted against its database carries BOTH tables: the bundle writer creates
   * `__anton_migrations` before it discovers the schema is already there, so the filename table is
   * left present and EMPTY beside a full `__drizzle_migrations`. A reader consulting only the
   * bundle's table calls that fully-migrated database entirely pending.
   */
  describe("a database both writers have touched", () => {
    it("reads the drizzle rows even though the bundle's table is present and empty", () => {
      migrateSource();
      // The bundle writer fails on the tables drizzle already created — and leaves its own
      // bookkeeping table behind, empty, which is the state the real anton.db is in.
      expect(() => migrateBundle()).toThrow();

      expect(bookkeeping()).toEqual({ drizzle: MIGRATIONS.length, anton: 0 });
      expect(pendingMigrations({ dbPath, migrationsDir })).toEqual([]);
    });
  });

  describe("a read that cannot answer", () => {
    it("throws rather than reporting clean when the database does not exist yet", () => {
      // A first-run install before `anton setup`: an empty list here would read as a current
      // schema, and the check must never CREATE the database it is judging.
      expect(() => pendingMigrations({ dbPath, migrationsDir })).toThrow();
      expect(() => new Database(dbPath, { readonly: true, fileMustExist: true })).toThrow();
    });

    it("throws rather than reporting clean when the migrations cannot be read", () => {
      migrateSource();
      rmSync(migrationsDir, { recursive: true, force: true });

      expect(() => pendingMigrations({ dbPath, migrationsDir })).toThrow();
    });
  });

  it("reports every migration pending against a database no migration has touched", () => {
    // A real, reachable database with neither bookkeeping table in it.
    new Database(dbPath).close();

    expect(pendingMigrations({ dbPath, migrationsDir })).toEqual([
      "0000_first.sql",
      "0001_second.sql",
      "0002_third.sql",
    ]);
  });

  /**
   * A journal that does not name a file leaves the watermark unable to speak for it, so the
   * filename table has to — and on a bundle-only database it can.
   */
  it("still accounts for a bundle-applied migration the journal does not name", () => {
    migrateBundle();
    writeMigrations(migrationsDir, MIGRATIONS.slice(0, 2));

    expect(pendingMigrations({ dbPath, migrationsDir })).toEqual([]);
  });
});

describe("committedMigrations", () => {
  it("lists the repo's real migration set in apply order", () => {
    const files = committedMigrations(join(process.cwd(), "drizzle"));

    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    expect(files.every((file) => file.endsWith(".sql"))).toBe(true);
  });
});
