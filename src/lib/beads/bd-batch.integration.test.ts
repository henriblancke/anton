/**
 * Real bd round-trip for the multi-bead transaction seam (anton-aijz). The property under test is
 * the one no unit test can assert — that `bd batch` is genuinely all-or-nothing against a live
 * Dolt-backed board:
 *
 *   - happy path: a whole unit (children + target) closes in one transaction;
 *   - induced failure mid-batch: every bead is left in its PRIOR state, none half-closed;
 *   - the abandon cascade: one unit settles atomically, and a failing cascade leaves the board's
 *     statuses untouched, still re-runnable;
 *   - the sequential fallback (`ANTON_BD_BATCH=0`) still applies every write.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { BD_BATCH_ENV, beads } from "./bd";

describeBd("bd batch (real bd · all-or-nothing)", () => {
  let repoDir: BdRepo;
  let repo: string;

  beforeAll(() => {
    repoDir = makeBdRepo();
    repo = repoDir.repo;
  });
  afterAll(() => repoDir.cleanup());
  beforeEach(() => {
    delete process.env[BD_BATCH_ENV];
  });

  /** A fresh epic + two children, so each case owns beads no other case has touched. */
  const seedUnit = async (label: string) => {
    const epic = await beads.create(repo, { title: `${label} epic`, type: "epic" });
    const a = await beads.create(repo, { title: `${label} a`, type: "task", deps: [`parent-child:${epic}`] });
    const b = await beads.create(repo, { title: `${label} b`, type: "task", deps: [`parent-child:${epic}`] });
    return { epic, a, b };
  };

  const statusOf = async (id: string) => (await beads.show(repo, id)).status;

  it("closes a whole unit in one transaction", async () => {
    const { epic, a, b } = await seedUnit("happy");

    await beads.batch(repo, [
      { op: "close", id: a },
      { op: "close", id: b },
      { op: "close", id: epic },
    ]);

    expect([await statusOf(a), await statusOf(b), await statusOf(epic)]).toEqual([
      "closed",
      "closed",
      "closed",
    ]);
  });

  it("leaves every bead in its prior state when an op mid-batch fails", async () => {
    const { epic, a, b } = await seedUnit("rollback");
    // A ticket already closed before the batch — its prior state is `closed`, and a rollback must
    // not reopen it any more than it may close the others.
    await beads.close(repo, b);

    await expect(
      beads.batch(repo, [
        { op: "close", id: a },
        { op: "close", id: "zzz-nosuchbead" }, // bd rejects the line → the whole batch rolls back
        { op: "close", id: epic },
      ]),
    ).rejects.toThrow(/zzz-nosuchbead/);

    expect([await statusOf(a), await statusOf(b), await statusOf(epic)]).toEqual([
      "open",
      "closed",
      "open",
    ]);
  });

  it("applies every write when the sequential fallback is selected by flag", async () => {
    const { epic, a, b } = await seedUnit("sequential");
    process.env[BD_BATCH_ENV] = "0";

    await beads.batch(repo, [
      { op: "close", id: a },
      { op: "close", id: b },
      { op: "close", id: epic },
    ]);

    expect([await statusOf(a), await statusOf(b), await statusOf(epic)]).toEqual([
      "closed",
      "closed",
      "closed",
    ]);
  });

  it("settles a whole abandon cascade — labels and closes — as one unit", async () => {
    const { epic, a, b } = await seedUnit("cascade");
    await beads.tag(repo, a, ["stage:implementing"]); // the killed run's leftover claim

    await beads.abandonAll(repo, [
      { id: a, reason: "parent epic abandoned" },
      { id: b, reason: "parent epic abandoned" },
      { id: epic, reason: "not worth building" },
    ]);

    for (const id of [a, b, epic]) {
      const bead = await beads.show(repo, id);
      expect(bead.status).toBe("closed");
      expect(beads.isAbandoned(bead)).toBe(true);
    }
    // The stage label is a claim on in-flight work; an abandoned bead has none.
    expect((await beads.show(repo, a)).labels ?? []).not.toContain("stage:implementing");
    expect(String((await beads.show(repo, epic)).close_reason)).toContain(
      "abandoned: not worth building",
    );
  });

  it("leaves a failing cascade open and re-runnable — no half-abandoned unit", async () => {
    const { epic, a, b } = await seedUnit("cascade-fail");

    await expect(
      beads.abandonAll(repo, [
        { id: a, reason: "parent epic abandoned" },
        { id: "zzz-nosuchbead", reason: "parent epic abandoned" },
        { id: epic, reason: "not worth building" },
      ]),
    ).rejects.toThrow(/zzz-nosuchbead/);

    // Nothing closed. Whichever phase the bad id trips — the label pass or the close transaction —
    // the unit is left OPEN rather than half-settled, so a re-run finds the same descendants
    // (openDescendants collects open beads) and finishes the job.
    expect([await statusOf(a), await statusOf(b), await statusOf(epic)]).toEqual([
      "open",
      "open",
      "open",
    ]);

    await beads.abandonAll(repo, [
      { id: a, reason: "parent epic abandoned" },
      { id: b, reason: "parent epic abandoned" },
      { id: epic, reason: "not worth building" },
    ]);
    expect([await statusOf(a), await statusOf(b), await statusOf(epic)]).toEqual([
      "closed",
      "closed",
      "closed",
    ]);
  });
});
