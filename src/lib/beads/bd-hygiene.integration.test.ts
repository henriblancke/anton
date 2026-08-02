/**
 * Real bd round-trip for the board-hygiene seam (anton-6qbc). The unit suite pins the argv and the
 * parse against recorded bytes; what only a live board can prove is that those bytes are still what
 * the installed bd emits, and that the two WRITE-class verbs really change the board:
 *
 *   - `epicCloseEligible` previews an eligible epic, then CLOSES it and bumps the board snapshot;
 *   - `recomputeBlocked` runs against a live Dolt-backed graph and reports its row count;
 *   - every report verb finds the finding it was seeded to find, and mutates nothing.
 *
 * The board is seeded once and each verb reads it, because a bd/Dolt spawn is the expensive part.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./bd";
import { issueSnapshotVersion, resetIssueSnapshots } from "./snapshot";

describeBd("bd hygiene verbs (real bd · the gardener's seam)", () => {
  let repoDir: BdRepo;
  let repo: string;
  /** The epic whose only child is closed — the one bead `epic close-eligible` may act on. */
  let eligibleEpic: string;
  /** An epic with an OPEN child: bd must leave it alone, and so must the sweep. */
  let openEpic: string;
  let openChild: string;
  /** A task with no acceptance criteria, named by a commit — the lint AND orphan finding. */
  let untemplated: string;
  /** Two beads with byte-identical content — the duplicate group. */
  let dupA: string;
  let dupB: string;
  /** Ids imported with a 2025 `updated_at`, so they are stale on any clock this runs on. */
  let staleOpen: string;
  let staleInProgress: string;

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
      deps: [`parent-child:${openEpic}`],
    });

    untemplated = await beads.create(repo, { title: "no acceptance here", type: "task" });
    dupA = await beads.create(repo, {
      title: "same title",
      type: "task",
      description: "identical body",
    });
    dupB = await beads.create(repo, {
      title: "same title",
      type: "task",
      description: "identical body",
    });

    // Staleness is a clock property, and bd rejects `--days 0` — so the only way to seed it is to
    // import beads that CARRY an old `updated_at`. `bd import` has no seam wrapper (nothing in
    // anton imports), so this shells bd directly; the invariant is about production code.
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

    // An orphan is a bead a COMMIT names while the bead is still open. bd matches the id inside a
    // conventional-commit scope (`fix(<id>): …`); a bare mention in prose is not enough.
    writeFileSync(join(repo, "work.txt"), "shipped\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", `fix(${untemplated}): work`], {
      cwd: repo,
      stdio: "ignore",
    });
  });

  afterAll(() => {
    resetIssueSnapshots();
    repoDir.cleanup();
  });

  const statusOf = async (id: string) => (await beads.show(repo, id)).status;

  it("lints the real board: the untemplated task is flagged, and the counters are bd's", async () => {
    const report = await beads.lintReport(repo);
    const flagged = report.violations.find((v) => v.id === untemplated);
    expect(flagged).toBeDefined();
    expect(flagged?.missing).toContain("## Acceptance Criteria");
    expect(report.issues).toBe(report.violations.length);
    // `warnings` counts warnings, not beads — so it can only ever be >= the bead count.
    expect(report.warnings).toBeGreaterThanOrEqual(report.issues);
  });

  it("lists stale beads per status", async () => {
    const open = await beads.staleList(repo, { status: "open" });
    const inProgress = await beads.staleList(repo, { status: "in_progress" });
    expect(open.map((b) => b.id)).toContain(staleOpen);
    expect(open.map((b) => b.id)).not.toContain(staleInProgress);
    expect(inProgress.map((b) => b.id)).toEqual([staleInProgress]);
    // Unscoped sweeps every non-closed status at once.
    const all = (await beads.staleList(repo)).map((b) => b.id);
    expect(all).toEqual(expect.arrayContaining([staleOpen, staleInProgress]));
  });

  it("finds the commit-referenced bead that is still open", async () => {
    const orphans = await beads.orphansList(repo);
    const found = orphans.find((o) => o.id === untemplated);
    expect(found).toBeDefined();
    expect(found?.status).toBe("open");
    expect(found?.latestCommitMessage).toContain(untemplated);
  });

  it("reports no dependency cycles — the only cycle answer a live bd can be made to give", async () => {
    // bd refuses to CREATE a blocking cycle at every write path (dep add with and without
    // --no-cycle-check, link, batch, and import, which skips the offending edge — measured on
    // 1.1.0 and 1.1.2), so an empty answer on a healthy board is the whole assertable surface.
    // A populated list can only come from a merge or a corrupted graph; see {@link DepCycle}.
    await beads.link(repo, dupA, dupB, "blocks");
    await expect(beads.link(repo, dupB, dupA, "blocks")).rejects.toThrow(/cycle/i);
    expect(await beads.depCycles(repo)).toEqual([]);
  });

  it("groups the two identical beads and names a merge target it does not merge", async () => {
    const groups = await beads.duplicateGroups(repo);
    const group = groups.find((g) => g.members.some((m) => m.id === dupA));
    expect(group).toBeDefined();
    expect(group?.members.map((m) => m.id).sort()).toEqual([dupA, dupB].sort());
    expect([dupA, dupB]).toContain(group?.target);
    expect(group?.members.filter((m) => m.isMergeTarget)).toHaveLength(1);
    // Reported, never applied: both beads are still open afterwards.
    expect([await statusOf(dupA), await statusOf(dupB)]).toEqual(["open", "open"]);
  });

  it("previews the eligible epic without closing anything", async () => {
    resetIssueSnapshots();
    const before = issueSnapshotVersion(repo);
    const sweep = await beads.epicCloseEligible(repo);
    expect(sweep.dryRun).toBe(true);
    expect(sweep.closed).toEqual([]);
    const candidate = sweep.eligible.find((c) => c.epic.id === eligibleEpic);
    expect(candidate).toMatchObject({ totalChildren: 1, closedChildren: 1, eligible: true });
    // bd's own eligibility rule: an epic with an open child is not a candidate.
    expect(sweep.eligible.map((c) => c.epic.id)).not.toContain(openEpic);
    expect(await statusOf(eligibleEpic)).toBe("open");
    expect(issueSnapshotVersion(repo)).toBe(before);
  });

  it("applying closes the eligible epic ONLY, and invalidates the board snapshot", async () => {
    const before = issueSnapshotVersion(repo);
    const sweep = await beads.epicCloseEligible(repo, { apply: true });
    expect(sweep.dryRun).toBe(false);
    expect(sweep.closed).toContain(eligibleEpic);
    expect(sweep.closed).not.toContain(openEpic);
    expect(await statusOf(eligibleEpic)).toBe("closed");
    expect(await statusOf(openEpic)).toBe("open");
    expect(await statusOf(openChild)).toBe("open");
    expect(issueSnapshotVersion(repo)).toBeGreaterThan(before);

    // Idempotent: a second pass has nothing left to close (bd answers a bare `[]` here).
    expect((await beads.epicCloseEligible(repo, { apply: true })).closed).toEqual([]);
  });

  it("recomputes is_blocked against the live graph and invalidates the board snapshot", async () => {
    const before = issueSnapshotVersion(repo);
    const corrected = await beads.recomputeBlocked(repo);
    expect(corrected).toBeGreaterThanOrEqual(0);
    expect(issueSnapshotVersion(repo)).toBeGreaterThan(before);
    // Idempotent on a consistent board: the repair pass corrects nothing the second time.
    expect(await beads.recomputeBlocked(repo)).toBe(0);
  });
});
