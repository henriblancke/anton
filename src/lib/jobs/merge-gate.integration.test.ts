/**
 * End-to-end proof of anton-k0kj's acceptance, against REAL bd and the REAL gate-check + review-fix
 * handlers: the PR-merge wait is a `gh:pr` gate, and the three PR outcomes end in three different
 * places.
 *
 *   • MERGED   → bd closes the gate, gate-check hands the target to review-fix, the run finalizes.
 *   • CLOSED, not merged → the gate stays OPEN, nothing is dispatched, and the PR ref stays on the
 *     bead for the recovery run — which must still be startable, so the target's own merge gate must
 *     not read as a blocker.
 *   • UNREADABLE (gh fails) → the pass parks instead of advancing: nothing resolves, nothing is
 *     dispatched, and the job ends non-`done` so a human sees an unknown gate rather than a silent
 *     forever-wait.
 *
 * All three run in ONE gate-check pass over one repo, because that is how they occur in life — the
 * fake `gh` answers per PR number. It is on PATH (not just `ANTON_GH_BIN`): the verdict under test is
 * bd's, and bd spawns `gh` itself. Skipped without bd + git.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { makeJobRunner } from "@/lib/testing/jobs";
import { beads, LABELS } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { resetIssueSnapshots } from "../beads/snapshot";
import { epicStandaloneBlockers } from "../epic-graph";
import * as schema from "../db/schema";
import { createRun, getRunById } from "../runs";
import { getJob, systemClock, type JobRow } from "./queue";
import { makeGateCheckHandler } from "./gate-check";
import { makeReviewFixHandler } from "./review-fix";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";

const IN_REVIEW = LABELS.stage("in-review");

/** One in-review run target: a feature with a child ticket, a PR ref, and its merge gate armed. */
interface Target {
  epic: string;
  ticket: string;
  gate: string;
  branch: string;
}

describeBd("PR-merge gate e2e (real handlers · real bd/git · fake gh)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let tdb: TestProjectDb;
  let projectId: string;
  let restoreEnv: () => void;

  let merged: Target;
  let closed: Target;
  let unreadable: Target;
  let mergedRunId: string;

  const gateStatus = async (id: string) =>
    (await beads.gateList(repo, { all: true })).find((g) => g.id === id)?.status;

  const reviewFixJobs = async (): Promise<JobRow[]> =>
    tdb.db.select().from(schema.jobs).where(eq(schema.jobs.type, "review-fix"));

  const reviewFixTargets = async () =>
    (await reviewFixJobs()).map((j) => JSON.parse(j.payloadJson).epicBeadId as string);

  /** One gate-check pass. Returns the settled job row — an unreadable gate must leave it non-done. */
  async function runGateCheck(): Promise<JobRow | undefined> {
    const runner = makeJobRunner({
      db: tdb.db,
      clock: systemClock,
      type: "gate-check",
      handler: makeGateCheckHandler,
    });
    const jobId = await runner.enqueue({ type: "gate-check", projectId, payload: { projectId } });
    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();
    return getJob(tdb.db, jobId);
  }

  /** Drive whatever review-fix jobs gate-check queued. Returns how many ran. */
  async function drainReviewFix(): Promise<number> {
    const runner = makeJobRunner({
      db: tdb.db,
      clock: systemClock,
      type: "review-fix",
      handler: makeReviewFixHandler,
      config: { leaseMs: 60_000 },
    });
    const leased = await runner.tickOnce();
    await runner.whenIdle();
    return leased;
  }

  /**
   * An in-review run target with `pr` as its PR number and a `gh:pr` gate armed on it. A FEATURE,
   * not a legacy epic: bd refuses a gate edge onto an epic ("epics can only block other epics"), so
   * the gated shape only exists for the run targets the tier split actually produces.
   */
  async function makeTarget(title: string, pr: number): Promise<Target> {
    const epic = await beads.create(repo, {
      title,
      type: "feature",
      description: "## Goal\nx\n\n## Acceptance\n- [ ] x",
    });
    await beads.approve(repo, epic);
    const ticket = await beads.create(repo, {
      title: `${title} ticket`,
      type: "task",
      deps: [`parent-child:${epic}`],
    });
    const branch = `anton/${epic}`;
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", branch]);
    writeFileSync(join(repo, `${epic}.txt`), "work\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", `${epic}: work`]);
    execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);

    await beads.setStatus(repo, epic, "in_progress");
    await beads.tag(repo, epic, [IN_REVIEW]);
    await beads.setPrRef(repo, epic, `gh-${pr}`);
    const gate = await beads.gateCreate(repo, {
      blocks: epic,
      type: "gh:pr",
      awaitId: String(pr),
      reason: `${epic} is in review — waiting for PR #${pr} to merge`,
    });
    return { epic, ticket, gate, branch };
  }

  beforeAll(async () => {
    bdRepo = makeBdRepo({ initialCommit: true });
    repo = bdRepo.repo;
    const binDir = join(bdRepo.dir, "bin");
    mkdirSync(binDir, { recursive: true });

    merged = await makeTarget("Merged PR epic", 7);
    closed = await makeTarget("Closed-unmerged PR epic", 8);
    unreadable = await makeTarget("Unreadable PR epic", 9);

    // One fake `gh` for both consumers: bd's gate check (`--json state,title`) and anton's own
    // review-fix read (`--json number,state,…`). PR 9 fails hard — the unreadable case.
    const ghPath = join(binDir, "gh");
    writeFileSync(
      ghPath,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'repo') { console.log('acme/repo'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') {
  const n = Number(a[2]);
  if (n === 9) { console.error('gh: could not connect'); process.exit(1); }
  const state = n === 7 ? 'MERGED' : 'CLOSED';
  console.log(JSON.stringify({
    number: n, state, title: 'PR ' + n, reviewDecision: null, mergeable: 'MERGEABLE',
    headRefName: process.env['FAKE_BRANCH_' + n], url: 'https://github.com/acme/repo/pull/' + n,
    reviews: [], statusCheckRollup: [],
  }));
  process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(ghPath, 0o755);

    restoreEnv = saveEnv([
      "PATH",
      "ANTON_GH_BIN",
      "ANTON_WORKTREES_ROOT",
      "ANTON_SESSIONS_ROOT",
      "FAKE_BRANCH_7",
      "FAKE_BRANCH_8",
      "FAKE_BRANCH_9",
    ]);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    process.env.ANTON_GH_BIN = ghPath;
    process.env.ANTON_WORKTREES_ROOT = join(bdRepo.dir, "worktrees");
    process.env.ANTON_SESSIONS_ROOT = join(bdRepo.dir, "sessions");
    process.env.FAKE_BRANCH_7 = merged.branch;
    process.env.FAKE_BRANCH_8 = closed.branch;
    process.env.FAKE_BRANCH_9 = unreadable.branch;

    tdb = makeProjectDb({ repoPath: repo });
    projectId = tdb.projectId;
    // The merged target's run, still open — finalization must settle it.
    mergedRunId = randomUUID();
    await createRun(tdb.db, systemClock, {
      id: mergedRunId,
      projectId,
      epicBeadId: merged.epic,
      branch: merged.branch,
      status: "running",
    });

    resetIssueSnapshots();
  }, 120_000);

  afterAll(() => {
    tdb?.close();
    restoreEnv?.();
    bdRepo.cleanup();
  });

  it("merged → gate closes, review-fix is dispatched for that target, and the run finalizes", async () => {
    const job = await runGateCheck();
    // The unreadable gate makes the pass throw AFTER its work lands (gate-check's contract), so the
    // job is not `done` — but the merge below must have been handled regardless.
    expect(job?.status).not.toBe("done");

    expect(await gateStatus(merged.gate)).toBe("closed");
    expect(await reviewFixTargets()).toEqual([merged.epic]);

    expect(await drainReviewFix()).toBe(1);
    const epic = await beads.show(repo, merged.epic);
    expect(epic.status).toBe("closed");
    expect(epic.labels ?? []).not.toContain(IN_REVIEW);
    expect((await beads.show(repo, merged.ticket)).status).toBe("closed");
    expect((await getRunById(tdb.db, mergedRunId))?.status).toBe("done");
  }, 120_000);

  it("closed WITHOUT merging → gate stays open, nothing is dispatched, the PR ref is left for recovery", async () => {
    expect(await gateStatus(closed.gate)).toBe("open");
    expect(await reviewFixTargets()).not.toContain(closed.epic);

    const epic = await beads.show(repo, closed.epic);
    expect(epic.status).not.toBe("closed");
    expect(epic.labels ?? []).toContain(IN_REVIEW);
    expect(beads.getPrRef(epic)).toBe("gh-8"); // the ref a re-run recovers from
    expect((await beads.show(repo, closed.ticket)).status).not.toBe("closed");
  });

  it("a target's own merge gate never blocks it — the recovery run stays startable", async () => {
    // The trap this guards: a gh:pr gate on a closed-unmerged PR never resolves, so counting it as a
    // blocker would refuse the recovery run (approve 409s, execute-epic poisons) forever.
    const board = await loadAllIssues(repo);
    expect(epicStandaloneBlockers(board, closed.epic)).toEqual([]);
    expect(epicStandaloneBlockers(board, unreadable.epic)).toEqual([]);
  });

  it("unreadable PR state → parks rather than advancing", async () => {
    expect(await gateStatus(unreadable.gate)).toBe("open");
    expect(await reviewFixTargets()).not.toContain(unreadable.epic);
    expect((await beads.show(repo, unreadable.epic)).status).not.toBe("closed");
  });

  it("re-dispatch is idempotent — a finalized target is not handed to review-fix again", async () => {
    await runGateCheck();
    // The merged target closed and lost `stage:in-review`, so it drops out of the dispatch set; the
    // other two never entered it. Still exactly the one job from the first pass.
    expect(await reviewFixTargets()).toEqual([merged.epic]);
  }, 120_000);
});
