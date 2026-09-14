/**
 * End-to-end proof of anton-ner.5's acceptance: when an epic's PR merges, the review-fix sweep
 * finalizes the epic — epic + remaining open tickets → done, `stage:in-review` cleared, merged
 * branch + worktree removed, run row finalized — and re-running is a no-op. A PR closed WITHOUT
 * merging leaves the epic untouched. Drives the REAL handler + REAL runner + REAL bd/git against a
 * temp repo, with a fake `gh` so PR state is deterministic. Skipped without bd + git.
 */
import { afterAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob, makeJobRunner } from "@/lib/testing/jobs";
import { beads, LABELS } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { makeReviewFixHandler, makeReviewFixPrHandler } from "./review-fix";
import { createRun, getRunById } from "../runs";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

function writeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

/** Point `gh pr view` at a PR in the given state (MERGED / CLOSED / OPEN). */
function ghForState(binDir: string, name: string, state: string): string {
  return writeBin(
    binDir,
    name,
    `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){console.log(JSON.stringify({number:7,state:'${state}',reviewDecision:null,mergeable:'MERGEABLE',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/7',reviews:[],statusCheckRollup:[]}));process.exit(0);}
if(a[0]==='repo'){console.log('acme/repo');process.exit(0);}
process.exit(0);`,
  );
}

describeBd("review-fix merge finalization (real handler · real bd/git · fake gh)", () => {
  let bdRepo: BdRepo;
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: TestProjectDb;
  let clock: FakeClock;
  let projectId: string;
  let epicId: string;
  let ticketA: string;
  let ticketB: string;
  let branch: string;
  let runId: string;
  let restoreEnv: () => void;

  const runDispatch = () =>
    driveJob({
      db: tdb.db,
      clock,
      type: "review-fix",
      handler: makeReviewFixHandler,
      projectId,
      config: { leaseMs: 30_000 },
    });

  /** Every review-fix-pr row queued right now, by the target it names. */
  const queuedFixTargets = async () =>
    (
      await tdb.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.type, "review-fix-pr"), eq(schema.jobs.status, "queued")))
    ).map((j) => JSON.parse(j.payloadJson).epicBeadId as string);

  /**
   * A whole cycle: the DISPATCHER, then every per-PR job it fanned out. Finalization moved behind
   * that fan-out (anton-3jwh) — the poll only triages now — so a merge is finalized by the job it
   * dispatched, not by the poll itself. Returns the fix jobs' ids.
   */
  async function runSweep(): Promise<string[]> {
    await runDispatch();
    const queued = await tdb.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, "review-fix-pr"), eq(schema.jobs.status, "queued")));
    if (queued.length === 0) return [];

    const runner = makeJobRunner({
      db: tdb.db,
      clock,
      type: "review-fix-pr",
      handler: makeReviewFixPrHandler,
      config: { leaseMs: 30_000 },
    });
    while ((await runner.tickOnce()) > 0) await runner.whenIdle();
    return queued.map((q) => q.id);
  }

  const branchExists = (b: string) => {
    const out = execFileSync("git", ["-C", repo, "branch", "--list", b], { encoding: "utf8" });
    return out.trim().length > 0;
  };

  beforeEach(async () => {
    bdRepo = makeBdRepo({ bare: true, initialCommit: true });
    sandbox = bdRepo.dir;
    repo = bdRepo.repo;
    binDir = join(sandbox, "bin");
    mkdirSync(binDir);

    const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "ignore" });

    // beads: an in-review epic (in_progress + stage:in-review + PR ref) with two open child tickets,
    // exactly as execute-epic would have left it when it opened the PR.
    epicId = await beads.create(repo, { title: "Ship feature X", type: "epic", description: "## Goal\nShip X." });
    ticketA = await beads.create(repo, { title: "Ticket A", type: "task", deps: [`parent-child:${epicId}`] });
    ticketB = await beads.create(repo, { title: "Ticket B", type: "task", deps: [`parent-child:${epicId}`] });
    branch = `anton/${epicId}`;
    // A merged feature branch left behind locally (execute-epic removed the worktree at PR open).
    g(["checkout", "-q", "-b", branch]);
    writeFileSync(join(repo, "feature.txt"), "v1\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feature work"]);
    g(["checkout", "-q", "main"]);
    await beads.setStatus(repo, epicId, "in_progress");
    await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
    await beads.setPrRef(repo, epicId, "gh-7");

    restoreEnv = saveEnv(["ANTON_WORKTREES_ROOT", "ANTON_SESSIONS_ROOT", "FAKE_BRANCH"]);
    process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
    process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
    process.env.FAKE_BRANCH = branch;

    tdb = makeProjectDb({ repoPath: repo });
    clock = new FakeClock(1_700_000_000_000);
    projectId = tdb.projectId;
    // An open run for the epic (as if execute-epic parked/left it) so we can assert finalization.
    runId = randomUUID();
    await createRun(tdb.db, clock, {
      id: runId,
      projectId,
      epicBeadId: epicId,
      branch,
      status: "running",
    });
  });

  afterAll(() => {
    tdb?.close();
    restoreEnv();
    bdRepo.cleanup();
  });

  it("finalizes a merged PR: epic + tickets → done, stage cleared, branch + run cleaned up", async () => {
    process.env.ANTON_GH_BIN = ghForState(binDir, "gh-merged", "MERGED");

    const [fixJob, ...rest] = await runSweep();
    expect(rest).toEqual([]); // exactly one per-PR job carried the finalization
    expect((await getJob(tdb.db, fixJob))?.status).toBe("done");

    // Epic + both tickets are closed; stage:in-review is gone.
    expect((await beads.show(repo, epicId)).status).toBe("closed");
    expect((await beads.show(repo, ticketA)).status).toBe("closed");
    expect((await beads.show(repo, ticketB)).status).toBe("closed");
    expect((await beads.show(repo, epicId)).labels ?? []).not.toContain(LABELS.stage("in-review"));

    // The merged local branch is removed.
    expect(branchExists(branch)).toBe(false);

    // The run row is finalized.
    const run = await getRunById(tdb.db, runId);
    expect(run?.status).toBe("done");
    expect(run?.endedAt).toBeTruthy();
  });

  it("is idempotent — a second sweep after finalization changes nothing and does not error", async () => {
    process.env.ANTON_GH_BIN = ghForState(binDir, "gh-merged2", "MERGED");
    await runSweep();

    // Re-run: the epic is no longer in-review (stage cleared + closed), so the dispatcher finds
    // nothing to fan out and leaves the finalized state exactly as it was.
    expect(await runSweep()).toEqual([]);
    expect((await beads.show(repo, epicId)).status).toBe("closed");
    expect((await beads.show(repo, ticketA)).status).toBe("closed");
    expect((await getRunById(tdb.db, runId))?.status).toBe("done");
  });

  it("does NOT finalize a PR closed without merging", async () => {
    process.env.ANTON_GH_BIN = ghForState(binDir, "gh-closed", "CLOSED");

    // A closed-but-unmerged PR is not actionable either, so nothing is even dispatched.
    expect(await runSweep()).toEqual([]);

    // Epic stays open and in-review; the run is untouched.
    const epic = await beads.show(repo, epicId);
    expect(epic.status).not.toBe("closed");
    expect(epic.labels ?? []).toContain(LABELS.stage("in-review"));
    expect(branchExists(branch)).toBe(true);
    expect((await getRunById(tdb.db, runId))?.status).toBe("running");
  });

  /**
   * anton-5mjt: a merged target reaches finalization through a `review-fix-pr` job, and the
   * dispatcher's coalescing key stays clear. Its dedupe is settled-rows-do-not-cover, so gate-check
   * keeps re-dispatching until the finalize actually lands — a half-done one heals itself.
   */
  it("dispatches the merge onto review-fix-pr, once, and re-dispatches after a settled attempt", async () => {
    process.env.ANTON_GH_BIN = ghForState(binDir, "gh-merged3", "MERGED");

    await runDispatch();
    expect(await queuedFixTargets()).toEqual([epicId]);
    // A second pass over the same still-open target adds nothing — the live job covers it.
    await runDispatch();
    expect(await queuedFixTargets()).toEqual([epicId]);
    // And nothing landed on the dispatcher's own type, which is what would have swallowed the poll.
    const dispatcherRows = await tdb.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, "review-fix"));
    expect(dispatcherRows.every((j) => JSON.parse(j.payloadJson).epicBeadId === undefined)).toBe(true);

    // Settle the fix without it finalizing anything (a park is what a failed finalize leaves), and
    // the next pass dispatches again rather than treating the target as covered.
    await tdb.db
      .update(schema.jobs)
      .set({ status: "parked" })
      .where(eq(schema.jobs.type, "review-fix-pr"));
    await runDispatch();
    expect(await queuedFixTargets()).toEqual([epicId]);
  });
});