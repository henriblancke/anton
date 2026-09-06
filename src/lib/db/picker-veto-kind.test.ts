/**
 * The veto-kind backfill (drizzle/0030, for anton-gtcd).
 *
 * `picker_verdicts` recorded `✕ not now` and `Never` as one thing — a decline — so the record the
 * earned-autonomy floor reads could not tell an operator pacing their own week from an operator
 * disagreeing with the ranking. The new column splits them, and every row already on a machine has
 * to be given a meaning: an unclassified decline would count as neither, and a project would climb
 * or fall on a ledger whose history had quietly emptied.
 *
 * So this suite asserts the interpretation the migration commits to, stated in its own SQL — the
 * clue it reads for each row, and the one case where the two clues disagree: a `Never` that a later
 * `not-now` painted over, which the criterion still on the row recovers.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "./testing";
import * as schema from "./schema";
import { listPickerVerdicts } from "../picker-veto";

/**
 * Only the backfill half of the migration. `makeTestDb` applies every committed migration to an
 * empty database, so the ADD COLUMN has already run and re-running it would fail — what a project
 * upgrading into this release actually experiences is the UPDATE meeting rows that predate it.
 */
const BACKFILL = (() => {
  const sql = readFileSync(
    join(process.cwd(), "drizzle", "0030_picker_veto_kind.sql"),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => /^(--[^\n]*\n)*UPDATE/.test(s));
  // Asserted rather than assumed: a migration that grew a second write would leave this suite
  // testing half of it and reporting a pass.
  expect(sql).toHaveLength(1);
  return sql[0]!;
})();

const NOW = new Date(1_800_000_000_000);
const PROJECT = "p-verdicts";

let t: TestDb;

/** A verdict as it was stored BEFORE this release: classified by nothing but its affordance. */
function seedVerdict(row: {
  id: string;
  beadId: string;
  verdict: "accepted" | "declined";
  action: string;
  criterion?: string;
}): void {
  t.db
    .insert(schema.pickerVerdicts)
    .values({
      id: row.id,
      projectId: PROJECT,
      beadId: row.beadId,
      verdict: row.verdict,
      action: row.action,
      criterion: row.criterion ?? null,
      vetoKind: null,
      decidedAt: NOW,
    })
    .run();
}

/** Bead id → the meaning the row carries, as the read path reports it. */
async function kinds(): Promise<Map<string, string | undefined>> {
  const rows = await listPickerVerdicts(t.db, PROJECT, 100);
  return new Map(rows.map((r) => [r.beadId, r.vetoKind]));
}

beforeEach(() => {
  t = makeTestDb();
  t.db
    .insert(schema.projects)
    .values({ id: PROJECT, slug: "verdicts", name: "verdicts", repoPath: "/tmp/verdicts" })
    .run();
});
afterEach(() => t.close());

describe("drizzle/0030 — what the declines already on a machine meant", () => {
  it("reads `never` as disagreement and `not-now` as pacing", async () => {
    seedVerdict({ id: "v-1", beadId: "anton-paced", verdict: "declined", action: "not-now" });
    seedVerdict({ id: "v-2", beadId: "anton-refused", verdict: "declined", action: "never" });

    t.sqlite.exec(BACKFILL);

    expect(await kinds()).toEqual(
      new Map([
        ["anton-paced", "pacing"],
        ["anton-refused", "disagreement"],
      ]),
    );
  });

  it("recovers a Never a later `not-now` painted over, from the criterion it left behind", async () => {
    // A repeat veto overwrote `action` and KEPT the criterion, and only a `Never` ever writes one.
    // Read as pacing, the operator's judgment about the rule would vanish from the record — so where
    // the two clues disagree the row is read as disagreement, the reading that cannot invent consent.
    seedVerdict({
      id: "v-1",
      beadId: "anton-a",
      verdict: "declined",
      action: "not-now",
      criterion: "labels:domain",
    });

    t.sqlite.exec(BACKFILL);

    expect((await kinds()).get("anton-a")).toBe("disagreement");
  });

  it("classifies no veto on an accept — a release refuses nothing", async () => {
    seedVerdict({ id: "v-1", beadId: "anton-a", verdict: "accepted", action: "release" });

    t.sqlite.exec(BACKFILL);

    expect((await kinds()).get("anton-a")).toBeUndefined();
  });

  it("leaves a row already classified alone — the backfill is an upgrade, not a rewrite", async () => {
    // Re-running the migration is what an operator gets from a restore, a merge, or a hand-applied
    // .sql file, and it must not downgrade a disagreement the running code recorded.
    seedVerdict({ id: "v-1", beadId: "anton-a", verdict: "declined", action: "not-now" });
    t.db
      .update(schema.pickerVerdicts)
      .set({ vetoKind: "disagreement" })
      .where(eq(schema.pickerVerdicts.id, "v-1"))
      .run();

    t.sqlite.exec(BACKFILL);

    expect((await kinds()).get("anton-a")).toBe("disagreement");
  });
});
