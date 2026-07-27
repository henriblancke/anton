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
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads, LABELS } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { JobRunner } from "./runner";
import { makeReviewFixHandler } from "./review-fix";
import { createRun, getRunById } from "../runs";

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
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;
  let epicId: string;
  let ticketA: string;
  let ticketB: string;
  let branch: string;
  let runId: string;
  let restoreEnv: () => void;

  const runSweep = async () => {
    const runner = new JobRunner({ db: tdb.db, clock, config: { maxConcurrent: 1, leaseMs: 30_000 } });
    runner.registerHandler("review-fix", makeReviewFixHandler({ db: tdb.db, clock }));
    const jobId = await runner.enqueue({ type: "review-fix", projectId, payload: { projectId } });
    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();
    return jobId;
  };

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

    tdb = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "sandbox",
      name: "sandbox",
      repoPath: repo,
      defaultBranch: "main",
    });
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

    const jobId = await runSweep();
    expect((await getJob(tdb.db, jobId))?.status).toBe("done");

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

    // Re-run: the epic is no longer in-review (stage cleared + closed), so the sweep is a no-op —
    // it completes cleanly and leaves the finalized state exactly as it was.
    const jobId = await runSweep();
    expect((await getJob(tdb.db, jobId))?.status).toBe("done");
    expect((await beads.show(repo, epicId)).status).toBe("closed");
    expect((await beads.show(repo, ticketA)).status).toBe("closed");
    expect((await getRunById(tdb.db, runId))?.status).toBe("done");
  });

  it("does NOT finalize a PR closed without merging", async () => {
    process.env.ANTON_GH_BIN = ghForState(binDir, "gh-closed", "CLOSED");

    const jobId = await runSweep();
    expect((await getJob(tdb.db, jobId))?.status).toBe("done");

    // Epic stays open and in-review; the run is untouched.
    const epic = await beads.show(repo, epicId);
    expect(epic.status).not.toBe("closed");
    expect(epic.labels ?? []).toContain(LABELS.stage("in-review"));
    expect(branchExists(branch)).toBe(true);
    expect((await getRunById(tdb.db, runId))?.status).toBe("running");
  });
});
