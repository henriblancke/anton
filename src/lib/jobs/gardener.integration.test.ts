/**
 * End-to-end proof of the gardener patrol's acceptance (anton-3nv7): the REAL handler, driven by a
 * REAL JobRunner, against REAL bd on a seeded fixture board. Skipped without bd/git.
 *
 * The unit suite pins the pass's shape with bd stubbed; only a live board can prove the two claims
 * that actually matter to a founder:
 *
 *   1. the epic whose children are all closed IS closed, and its report says so; and
 *   2. NOTHING ELSE ON THE BOARD MOVED. The patrol sees stale beads, duplicates and orphans, and is
 *      entitled to act on none of them — so the board is snapshotted before and after and compared
 *      bead by bead. That assertion is the whole safety case for arming this job.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import { beads } from "../beads/bd";
import { resetIssueSnapshots } from "../beads/snapshot";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { getHygieneReportForJob, type HygieneReport } from "../hygiene";
import { makeGardenerHandler } from "./gardener";
import type { Clock } from "./queue";

describeBd("gardener patrol e2e (real handler · real bd)", () => {
  let repoDir: BdRepo;
  let repo: string;
  let tdb: TestDb;
  let projectId: string;
  const clock: Clock = { now: () => 1_700_000_000_000 };
  const nudge = vi.fn();

  /** The epic whose only child is closed — the one bead the patrol may act on. */
  let eligibleEpic: string;
  /** An epic with an OPEN child: bd leaves it alone, and so must the patrol. */
  let openEpic: string;
  let openChild: string;
  /** A task with no acceptance criteria, named by a commit — the lint AND orphan finding. */
  let untemplated: string;
  /** Two beads with byte-identical content — the duplicate group, reported and never merged. */
  let dupA: string;
  let dupB: string;
  /** Imported with a 2025 `updated_at`, so they are stale on any clock this runs on. */
  let staleOpen: string;
  let staleInProgress: string;

  /** id → status for every bead on the board — the "nothing else moved" comparison. */
  const boardStatuses = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await beads.list(repo, ["--status", "all"])).map((b) => [b.id, b.status ?? ""]),
    );

  let before: Record<string, string>;
  let report: HygieneReport | undefined;

  beforeAll(async () => {
    repoDir = makeBdRepo();
    repo = repoDir.repo;

    eligibleEpic = await beads.create(repo, { title: "done epic", type: "epic" });
    const closedChild = await beads.create(repo, {
      title: "child one",
      type: "task",
      acceptance: "- [ ] a",
      deps: [`parent-child:${eligibleEpic}`],
    });
    await beads.close(repo, closedChild);

    openEpic = await beads.create(repo, { title: "still working", type: "epic" });
    openChild = await beads.create(repo, {
      title: "open child",
      type: "task",
      acceptance: "- [ ] a",
      deps: [`parent-child:${openEpic}`],
    });

    untemplated = await beads.create(repo, { title: "no acceptance here", type: "task" });
    dupA = await beads.create(repo, { title: "same title", type: "task", description: "identical body" });
    dupB = await beads.create(repo, { title: "same title", type: "task", description: "identical body" });

    // Staleness is a clock property and bd rejects `--days 0`, so the only way to seed it is to
    // import beads carrying an old `updated_at` (mirrors bd-hygiene.integration.test.ts).
    const prefix = untemplated.slice(0, untemplated.lastIndexOf("-"));
    staleOpen = `${prefix}-old1`;
    staleInProgress = `${prefix}-old2`;
    const jsonl = join(repoDir.dir, "stale.jsonl");
    writeFileSync(
      jsonl,
      [
        JSON.stringify({
          _type: "issue",
          id: staleOpen,
          title: "forgotten open bead",
          status: "open",
          issue_type: "task",
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-02T00:00:00Z",
        }),
        JSON.stringify({
          _type: "issue",
          id: staleInProgress,
          title: "abandoned in progress",
          status: "in_progress",
          issue_type: "task",
          assignee: "someone",
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-03T00:00:00Z",
        }),
        "",
      ].join("\n"),
    );
    execFileSync("bd", ["import", jsonl], { cwd: repo, stdio: "ignore" });

    // An orphan is a bead a COMMIT names while the bead is still open; bd matches the id inside a
    // conventional-commit scope.
    writeFileSync(join(repo, "work.txt"), "shipped\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", `fix(${untemplated}): work`], {
      cwd: repo,
      stdio: "ignore",
    });

    tdb = makeTestDb();
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "sandbox",
      name: "sandbox",
      repoPath: repo,
      defaultBranch: "main",
    });

    before = await boardStatuses();
    const jobId = await driveJob({
      db: tdb.db,
      clock,
      type: "gardener",
      handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge }),
      projectId,
    });
    await expectJobStatus(tdb.db, jobId, "done");
    report = await getHygieneReportForJob(tdb.db, jobId);
  }, 120_000);

  afterAll(() => {
    resetIssueSnapshots();
    tdb?.close();
    repoDir.cleanup();
  });

  it("closes the eligible epic and records it as the pass's action", async () => {
    expect(report?.actions.closedEpics).toContain(eligibleEpic);
    expect(report?.actions.rowsRecomputed).toBeGreaterThanOrEqual(0);
    expect((await beads.show(repo, eligibleEpic)).status).toBe("closed");
  });

  it("reports the seeded lint, stale and orphan findings", () => {
    const keys = report?.findings.map((f) => f.key) ?? [];
    expect(keys).toContain(`lint:${untemplated}`);
    expect(keys).toContain(`stale-open:${staleOpen}`);
    expect(keys).toContain(`stale-in-progress:${staleInProgress}`);
    expect(keys).toContain(`orphan:${untemplated}`);
    // The duplicate group is REPORTED — never merged (asserted below, both beads still open).
    expect(keys).toContain(`duplicate:${[dupA, dupB].sort().join("+")}`);
    // The summary counts agree with the findings they summarize.
    expect(report?.counts.lint).toBe(report?.findings.filter((f) => f.kind === "lint").length);
    expect(report?.counts.duplicate).toBe(1);
  });

  it("mutates NOTHING else: the eligible epic is the board's only change", async () => {
    const after = await boardStatuses();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [id, status] of Object.entries(after)) {
      expect({ id, status }).toEqual({
        id,
        status: id === eligibleEpic ? "closed" : before[id],
      });
    }
    // Named explicitly, because these are exactly the beads a "helpful" patrol would touch.
    expect(after[openEpic]).toBe("open");
    expect(after[openChild]).toBe("open");
    expect(after[dupA]).toBe("open");
    expect(after[dupB]).toBe("open");
    expect(after[staleInProgress]).toBe("in_progress");
  });

  it("nudges the sync coalescer, because it wrote to the board", () => {
    expect(nudge).toHaveBeenCalledWith({ id: projectId, repoPath: repo });
  });
});
