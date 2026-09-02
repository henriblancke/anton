/**
 * The drizzle journal, which is what decides whether an EXISTING anton.db gets a new table.
 *
 * `drizzle-kit migrate` does not diff the schema and does not track migrations individually: it
 * reads the last applied `created_at` and runs every migration whose journal `when` is greater
 * (`Number(lastDbMigration.created_at) < migration.folderMillis`, drizzle-orm's sqlite dialect).
 * A journal entry stamped EARLIER than the one before it is therefore skipped in silence — the
 * migrator reports success, the table never appears, and the failure only surfaces later as
 * "no such table" on a machine that upgraded rather than started fresh.
 *
 * Nothing else catches it: the test harness (`testing.ts`) and the packaged runner both apply the
 * .sql files in FILENAME order and never read `when`. So this suite guards the ordering directly.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const DRIZZLE_DIR = join(process.cwd(), "drizzle");
const journal: { entries: JournalEntry[] } = JSON.parse(
  readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
);

describe("drizzle journal", () => {
  it("stamps every migration later than the one before it", () => {
    // One pass, so `i` stays the JOURNAL index: a filter-then-map would renumber it and the report
    // would name an unrelated migration as the predecessor.
    const inversions = journal.entries.flatMap((entry, i) =>
      i > 0 && entry.when <= journal.entries[i - 1]!.when
        ? [`${entry.tag} (when=${entry.when}) <= ${journal.entries[i - 1]!.tag}`]
        : [],
    );

    // Named rather than counted: the fix is to restamp the offending entry, and the report has to
    // say which one.
    expect(inversions).toEqual([]);
  });

  it("orders the journal the way the .sql files are named", () => {
    // The two orders are the same schema on a fresh DB and DIFFERENT schemas on an upgraded one —
    // filename order is what the test harness and the packaged runner apply, `when` order is what
    // drizzle-kit applies. They must not disagree.
    const files = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => f.replace(/\.sql$/, ""));

    expect(journal.entries.map((e) => e.tag)).toEqual(files);
    expect(journal.entries.map((e) => e.idx)).toEqual(files.map((_, i) => i));
  });
});
