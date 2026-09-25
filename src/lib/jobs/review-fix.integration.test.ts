/**
 * End-to-end proof of anton-3t2.2's acceptance: "Actionable PR review comments/CI failures are
 * auto-resolved by claude and pushed." Drives the REAL review-fix handler + REAL runner + REAL
 * bd/git against a temp repo with a bare origin, using fake `claude`/`gh` so the flow is
 * deterministic without spending API quota or hitting GitHub. Skipped without bd + git.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { describeBd, makeBdRepo, saveEnv, withOperator, type BdRepo } from "@/lib/testing/integration";
import { driveJob, makeJobRunner } from "@/lib/testing/jobs";
import { beads, LABELS } from "../beads/bd";
import { selfBuildVersion } from "../build/drift";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";

// Records every `pushBranch` call's args while delegating to the real implementation — so a test
// can assert the resolved push budget (anton-n93lo) rode through `commitAndPushFix` without giving
// up the real git push the rest of this suite depends on.
const pushBranchCalls: unknown[][] = [];
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    pushBranch: (...args: Parameters<typeof actual.pushBranch>) => {
      pushBranchCalls.push(args);
      return actual.pushBranch(...args);
    },
  };
});

import { makeReviewFixHandler, makeReviewFixPrHandler } from "./review-fix";
import { createWorktree } from "../git/worktree";
import { resetOperatorCache } from "../operator";
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

describeBd("review-fix e2e (real handler · real bd/git · fake claude/gh)", () => {
  let bdRepo: BdRepo;
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: TestProjectDb;
  let clock: FakeClock;
  let projectId: string;
  let epicId: string;
  let branch: string;
  let restoreEnv: () => void;
  let hookLog: string;

  /** One dispatcher pass, driven to settlement. `epicBeadId` narrows it to a single target. */
  const runDispatch = (epicBeadId?: string) =>
    driveJob({
      db: tdb.db,
      clock,
      type: "review-fix",
      handler: makeReviewFixHandler,
      projectId,
      ...(epicBeadId === undefined ? {} : { payload: { projectId, epicBeadId } }),
      config: { leaseMs: 30_000 },
    });

  /**
   * A whole review-fix cycle: the scheduled DISPATCHER, then every per-PR job it fanned out, each
   * driven to settlement. Returns the fix jobs' ids — one per PR the dispatcher found work on — so
   * a test can assert both how many were dispatched and how each settled.
   */
  async function runSweep(epicBeadId?: string): Promise<string[]> {
    await runDispatch(epicBeadId);
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

  /** The single fix job a sweep dispatched, asserted to have settled `done`. */
  async function expectOneFix(fixes: string[]): Promise<void> {
    expect(fixes).toHaveLength(1);
    expect((await getJob(tdb.db, fixes[0]))?.status).toBe("done");
  }

  beforeAll(async () => {
    bdRepo = makeBdRepo({ bare: true, initialCommit: true });
    sandbox = bdRepo.dir;
    repo = bdRepo.repo;
    binDir = join(sandbox, "bin");
    mkdirSync(binDir);

    const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "ignore" });

    // beads: an in-review epic with a PR ref (as execute-epic would have left it).
    epicId = await beads.create(repo, {
      title: "Ship feature X",
      type: "epic",
      description: "## Goal\nShip X.",
    });
    branch = `anton/${epicId}`;
    // A feature branch pushed to origin (the PR branch review-fix will re-materialize + fix).
    g(["checkout", "-q", "-b", branch]);
    writeFileSync(join(repo, "feature.txt"), "v1\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feature work"]);
    g(["push", "-q", "-u", "origin", branch]);
    g(["checkout", "-q", "main"]);
    await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
    await beads.setPrRef(repo, epicId, "gh-7");

    // Fake claude: apply a fix in the worktree + dump its args so we can assert the prompt. Ends
    // with the per-thread json report anton parses to reply/resolve threads.
    const report = '{"threads":[{"id":"RT_1","outcome":"fixed","reply":"renamed foo to bar"}]}';
    const fakeClaude = writeBin(
      binDir,
      "claude",
      `const fs=require('fs');const path=require('path');
fs.writeFileSync(path.join(process.cwd(),'FIX.md'),'fixed '+Date.now());
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
// Prompt arrives on stdin, system prompt via --append-system-prompt-file — never on argv (anton-14tj).
const sysFile=get('--append-system-prompt-file');const append=sysFile?fs.readFileSync(sysFile,'utf8'):undefined;
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  if(process.env.ANTON_TEST_CLAUDE_ARGV) fs.appendFileSync(process.env.ANTON_TEST_CLAUDE_ARGV,JSON.stringify({prompt:stdin,append})+'\\n');
  e({type:'system',subtype:'init',session_id:'s'});
  e({type:'assistant',message:{content:[{type:'text',text:'resolved feedback'}]}});
  e({type:'result',subtype:'success',result:'done\\n\\n\`\`\`json\\n${report}\\n\`\`\`',session_id:'s',is_error:false});
  process.exit(0);
});`,
    );

    // Fake gh: pr view (CHANGES_REQUESTED + failing build), repo view, graphql review threads +
    // resolve mutation, thread replies, pr comment, re-request reviewers. Logs the notify calls so
    // the test can assert them.
    const fakeGh = writeBin(
      binDir,
      "gh",
      `const fs=require('fs');const a=process.argv.slice(2);const q=a.join(' ');
const log=m=>{if(process.env.FAKE_GH_LOG)fs.appendFileSync(process.env.FAKE_GH_LOG,m+'\\n');};
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:7,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/7',
    reviews:[{author:{login:'alice'},state:'CHANGES_REQUESTED',body:'rename foo to bar'}],
    statusCheckRollup:[{__typename:'CheckRun',name:'build',status:'COMPLETED',conclusion:'FAILURE'}]}));
  process.exit(0);
}
if(a[0]==='repo'&&a[1]==='view'){console.log('acme/repo');process.exit(0);}
if(a[0]==='api'&&a[1]==='graphql'){
  if(q.includes('resolveReviewThread')){log('resolve');console.log('{}');process.exit(0);}
  console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[
    {id:'RT_1',isResolved:false,isOutdated:false,path:'feature.txt',line:1,
     comments:{nodes:[{databaseId:100,author:{login:'alice'},body:'rename foo to bar here too'}]}}
  ]}}}}}));
  process.exit(0);
}
if(a.some(x=>String(x).includes('/replies'))){log('reply');console.log('{}');process.exit(0);}
if(a[0]==='pr'&&a[1]==='comment'){log('comment');process.exit(0);}
if(a[0]==='api'&&a.includes('--method')){log('rerequest');process.exit(0);}
process.exit(0);`,
    );

    restoreEnv = saveEnv([
      "ANTON_CLAUDE_BIN",
      "ANTON_GH_BIN",
      "ANTON_WORKTREES_ROOT",
      "ANTON_SESSIONS_ROOT",
      "ANTON_TEST_CLAUDE_ARGV",
      "FAKE_BRANCH",
      "FAKE_GH_LOG",
    ]);
    process.env.ANTON_CLAUDE_BIN = fakeClaude;
    process.env.ANTON_GH_BIN = fakeGh;
    process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
    process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
    process.env.ANTON_TEST_CLAUDE_ARGV = join(sandbox, "claude-argv.jsonl");
    process.env.FAKE_BRANCH = branch;
    process.env.FAKE_GH_LOG = join(sandbox, "gh.log");

    tdb = makeProjectDb({ repoPath: repo });
    clock = new FakeClock(1_700_000_000_000);
    projectId = tdb.projectId;

    // Review finding: a real pre-push hook, recording the branch checked out at ITS OWN cwd (git
    // sets this before invoking hooks) — the same thing a project's stale-working-tree gate reads.
    // Hooks live in the shared .git dir, so this fires identically whether `git push` runs from
    // `repo` (left on `main` the whole suite) or from a worktree checked out on the feature branch —
    // which is exactly what distinguishes a push run from the right place from one that isn't.
    hookLog = join(sandbox, "pre-push-hook.log");
    const hookPath = join(repo, ".git", "hooks", "pre-push");
    writeFileSync(hookPath, `#!/usr/bin/env sh\ngit rev-parse --abbrev-ref HEAD >> "${hookLog}"\n`);
    chmodSync(hookPath, 0o755);
  });

  afterAll(() => {
    tdb?.close();
    restoreEnv();
    bdRepo.cleanup();
  });

  it("resolves an actionable PR: claude fix → commit → push → thread reply/resolve + comment + re-request", async () => {
    // The poll dispatched exactly one per-PR job, and that job carried the whole fix.
    await expectOneFix(await runSweep());

    // claude was dispatched with a review-fix prompt naming the feedback + failing check.
    const invocations = readFileSync(join(sandbox, "claude-argv.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { prompt?: string; append?: string });
    expect(invocations).toHaveLength(1);
    expect(invocations[0].prompt).toContain("review feedback");
    expect(invocations[0].prompt).toContain("rename foo to bar");
    expect(invocations[0].prompt).toContain("build"); // failing check surfaced
    expect(invocations[0].prompt).toContain("thread RT_1"); // inline thread surfaced with its id
    expect(invocations[0].prompt).toContain("Reporting format"); // per-thread report requested
    expect(invocations[0].append).toContain("operating contract"); // locked base system prompt

    // The fix was committed on the branch and pushed to origin.
    const remoteLog = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/${branch}`], {
      encoding: "utf8",
    });
    expect(remoteLog).toContain("address review feedback");

    // Review finding: the push ran from the run's WORKTREE, not from `repo` — the base checkout,
    // which sat on `main` the whole test. A regression back to pushing `-C repo` would run this
    // real pre-push hook with `main` checked out instead of the feature branch: distinguishing
    // proof, not just "a commit reached origin" (which passed under the old, buggy call shape too).
    expect(readFileSync(hookLog, "utf8").trim()).toBe(branch);
    expect(
      execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
    ).toBe("main");

    // Notify calls fired: the fixed thread got a reply + was resolved, plus the PR-level comment
    // and the reviewer re-request.
    const ghLog = readFileSync(join(sandbox, "gh.log"), "utf8");
    expect(ghLog).toContain("reply");
    expect(ghLog).toContain("resolve");
    expect(ghLog).toContain("comment");
    expect(ghLog).toContain("rerequest");

    // The PR-fix phase lands a STAMPED ledger row (anton-234ja). This is the second of the two sites
    // PR #311 found the original plan would have missed — the job meters its own driver and never
    // reaches `dispatchClaude` — so the stamps are asserted end-to-end here, on what a real fix wrote.
    const ledger = await tdb.db.select().from(schema.claudeInvocations);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      beadId: epicId,
      step: "review-fix",
      // What the phase fold reads: this whole job IS the pr-fix phase.
      stepHandler: "review-fix",
    });
    // Digested from the system prompt this fix actually ran with — the one asserted above to carry
    // the operating contract. Recorded because that text is gone the moment a layer is edited.
    expect(ledger[0].promptDigest).toMatch(/^[0-9a-f]{12}$/);
    // That's the EXECUTION contract (agent + seed), not the review-fix REASONING contract itself —
    // that text rides in the user prompt asserted above ("review feedback"/"Reporting format"),
    // which `metered` never sees. No `reviewFixPrompt` override is configured, so the shipped
    // `review-fix` skill ran, and its own identity is what names it (PR #313 review).
    expect(ledger[0]).toMatchObject({ skillId: "review-fix", promptBodyDigest: null });
    expect(ledger[0].skillDigest).toMatch(/^[0-9a-f]{12}$/);
    // Resolved inside the meter from process state, so the job passes no version and still records one.
    expect(ledger[0].antonVersion).toBe(selfBuildVersion());

    // A review-fix session was recorded + finished.
    const sessions = await tdb.db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].kind).toBe("review-fix");
    expect(sessions[0].status).toBe("done");
    expect(sessions[0].beadId).toBe(epicId);

    // No pushTimeoutMinutes setting on this project — resolves to the 2-minute default, the same
    // one `pushBranch` itself falls back to (anton-n93lo): byte-identical to before this existed.
    expect(pushBranchCalls.at(-1)?.[3]).toBe(2 * 60_000);
    expect(pushBranchCalls.at(-1)?.[4]).toBeInstanceOf(AbortSignal);
  });

  it.runIf(process.platform !== "win32")(
    "pushes a fix that landed before its post-commit hook exceeded the commit budget",
    async () => {
      const hookStarted = join(sandbox, "review-fix-post-commit-started");
      const postCommit = join(repo, ".git", "hooks", "post-commit");
      writeFileSync(
        postCommit,
        `#!/usr/bin/env sh\ntouch ${JSON.stringify(hookStarted)}\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n`,
      );
      chmodSync(postCommit, 0o755);
      const restore = saveEnv(["ANTON_GIT_COMMIT_TIMEOUT_MS"]);
      process.env.ANTON_GIT_COMMIT_TIMEOUT_MS = "1000";
      try {
        await expectOneFix(await runSweep());

        expect(readFileSync(hookStarted, "utf8")).toBe("");
        const remoteLog = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/${branch}`], {
          encoding: "utf8",
        });
        expect(remoteLog).toContain("address review feedback");
        expect((await tdb.db.select().from(schema.sessions)).at(-1)?.status).toBe("done");
      } finally {
        restore();
        writeFileSync(postCommit, "#!/usr/bin/env sh\n");
        chmodSync(postCommit, 0o755);
      }
    },
  );

  it("uses the per-project reviewFixPrompt override when set (else the default file)", async () => {
    const marker = "RF_OVERRIDE_MARKER_QZX9";
    await tdb.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ reviewFixPrompt: `${marker}\nResolve it my way.` }) })
      .where(eq(schema.projects.id, projectId));
    try {
      await runSweep();

      const invocations = readFileSync(join(sandbox, "claude-argv.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { prompt?: string });
      const last = invocations[invocations.length - 1];
      expect(last.prompt).toContain(marker); // operator override reached claude
      expect(last.prompt).toContain("rename foo to bar"); // PR context still appended beneath it
      expect(last.prompt).not.toContain("Triage every finding"); // default file was NOT used
    } finally {
      await tdb.db
        .update(schema.projects)
        .set({ settingsJson: "{}" })
        .where(eq(schema.projects.id, projectId));
    }
  });

  it("threads the project's configured push timeout into the review fix's pushBranch call", async () => {
    await tdb.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ pushTimeoutMinutes: 7 }) })
      .where(eq(schema.projects.id, projectId));
    try {
      await runSweep();
      // Read from the run's PINNED settings snapshot (same rule claudeRouting(settings) follows),
      // not re-read mid-run — proven here by the resolved budget actually reaching pushBranch.
      expect(pushBranchCalls.at(-1)?.[3]).toBe(7 * 60_000);
      expect(pushBranchCalls.at(-1)?.[4]).toBeInstanceOf(AbortSignal);
    } finally {
      await tdb.db
        .update(schema.projects)
        .set({ settingsJson: "{}" })
        .where(eq(schema.projects.id, projectId));
    }
  });

  it("pushes an unpushed prior fix even when the new claude run produces no diff", async () => {
    // Simulate a crashed/failed-push retry: a commit exists locally on the branch but was never
    // pushed, and claude now produces NO new change. The job must still push the pending commit.
    // The branch is checked out in the first test's worktree, so commit there (not in the main repo).
    const wt = await createWorktree({ repoPath: repo, branch, warm: false });
    const gw = (args: string[]) => execFileSync("git", args, { cwd: wt.path, stdio: "ignore" });
    writeFileSync(join(wt.path, "prior-fix.txt"), "committed but never pushed\n");
    gw(["add", "-A"]);
    gw(["commit", "-q", "-m", `${epicId}: address review feedback (PR #7) [prior]`]);

    // A no-op claude (writes nothing → commitAll sees no changes).
    const noopClaude = writeBin(
      binDir,
      "claude-noop",
      `const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'result',subtype:'success',result:'nothing to change',is_error:false});
process.exit(0);`,
    );
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = noopClaude;
    try {
      await expectOneFix(await runSweep());

      // The previously-unpushed commit is now on origin.
      const remoteLog = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/${branch}`], {
        encoding: "utf8",
      });
      expect(remoteLog).toContain("[prior]");

      // Review finding: this path pushes via the `branchAheadOfRemote` fallback (no new commit this
      // run) rather than the `committed` branch the first test covers — same requirement, from the
      // worktree, not `repo`.
      expect(readFileSync(hookLog, "utf8").trim().split("\n").pop()).toBe(branch);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  it("is a no-op when the PR has nothing actionable (approved, checks green)", async () => {
    // Point gh at an 'approved & green' PR for this run.
    const greenGh = writeBin(
      binDir,
      "gh-green",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){console.log(JSON.stringify({number:7,state:'OPEN',reviewDecision:'APPROVED',headRefName:process.env.FAKE_BRANCH,url:'u',reviews:[],statusCheckRollup:[{__typename:'CheckRun',name:'build',status:'COMPLETED',conclusion:'SUCCESS'}]}));process.exit(0);}
if(a[0]==='repo'){console.log('acme/repo');process.exit(0);}
process.exit(0);`,
    );
    const prev = process.env.ANTON_GH_BIN;
    process.env.ANTON_GH_BIN = greenGh;
    const before = (await tdb.db.select().from(schema.sessions)).length;
    try {
      // Nothing actionable → the dispatcher fans out nothing at all, so no worktree, claude session
      // or verify gate is ever reached. The poll costs one board read and one `gh pr view`.
      expect(await runSweep()).toEqual([]);
      const after = await tdb.db.select().from(schema.sessions);
      expect(after.length).toBe(before);
    } finally {
      process.env.ANTON_GH_BIN = prev;
    }
  });

  // ── operator ownership (anton-zoh) ──
  //
  // These drive the REAL handler with a resolved operator identity (ANTON_OPERATOR) and a second
  // epic CLAIMED by a different operator, whose PR is MERGED. The unclaimed epic-1 the sweep also
  // visits is served an approved+green PR so it's a no-op and can't interfere.
  //
  // A gh that reports the given PR number MERGED and every other number approved+green.
  const mergedGhFor = (mergedNumber: number) =>
    writeBin(
      binDir,
      `gh-merged-${mergedNumber}`,
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
  const n=Number(a[2]);
  if(n===${mergedNumber}){console.log(JSON.stringify({number:n,state:'MERGED',headRefName:'anton/bob-'+n,url:'u',reviews:[],statusCheckRollup:[]}));process.exit(0);}
  console.log(JSON.stringify({number:n,state:'OPEN',reviewDecision:'APPROVED',headRefName:process.env.FAKE_BRANCH,url:'u',reviews:[],statusCheckRollup:[{__typename:'CheckRun',name:'build',status:'COMPLETED',conclusion:'SUCCESS'}]}));process.exit(0);
}
if(a[0]==='repo'){console.log('acme/repo');process.exit(0);}
process.exit(0);`,
    );

  async function actAs<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const restore = saveEnv(["ANTON_OPERATOR", "ANTON_GH_BIN"]);
    await withOperator(name);
    try {
      return await fn();
    } finally {
      restore();
      resetOperatorCache();
    }
  }

  it("does NOT finalize a MERGED epic claimed by another operator (ownership gate)", async () => {
    const bobEpic = await beads.create(repo, {
      title: "Bob's merged feature",
      type: "epic",
      description: "## Goal\nBob's.",
    });
    await beads.claim(repo, bobEpic, "bob");
    await beads.tag(repo, bobEpic, [LABELS.stage("in-review")]);
    await beads.setPrRef(repo, bobEpic, "gh-8");

    await actAs("alice", async () => {
      process.env.ANTON_GH_BIN = mergedGhFor(8);
      expect(await runSweep()).toEqual([]); // bob's target was never even dispatched
    });

    // Bob's epic was skipped entirely — finalizeMergedEpic (close + drop stage:in-review) never ran.
    const now = await beads.list(repo, ["--status", "all"]);
    const bob = now.find((b) => b.id === bobEpic);
    expect(bob?.status).not.toBe("closed");
    expect(bob?.labels?.includes(LABELS.stage("in-review"))).toBe(true);
  });

  it("a targeted epicBeadId finalizes another operator's MERGED epic (override wins)", async () => {
    const bobEpic = await beads.create(repo, {
      title: "Bob's targeted merged feature",
      type: "epic",
      description: "## Goal\nBob's targeted.",
    });
    await beads.claim(repo, bobEpic, "bob");
    await beads.tag(repo, bobEpic, [LABELS.stage("in-review")]);
    await beads.setPrRef(repo, bobEpic, "gh-9");

    await actAs("alice", async () => {
      process.env.ANTON_GH_BIN = mergedGhFor(9);
      // Explicit single-epic target bypasses the ownership filter — alice runs bob's epic.
      await expectOneFix(await runSweep(bobEpic));
    });

    // The override reached finalizeMergedEpic: bob's epic is closed and out of review.
    const now = await beads.list(repo, ["--status", "all"]);
    const bob = now.find((b) => b.id === bobEpic);
    expect(bob?.status).toBe("closed");
    expect(bob?.labels?.includes(LABELS.stage("in-review")) ?? false).toBe(false);
  });

  /**
   * anton-3jwh's whole point: two PRs in review are two jobs, so they fix CONCURRENTLY in their own
   * worktrees, and one that fails takes only itself down. Before the split a single sequential sweep
   * carried both — a failure on the first was caught and logged, but its time was still spent before
   * the second was touched, and one long fix held the slot for every PR behind it.
   */
  it("fixes two PRs concurrently in distinct worktrees, and one failure leaves the other alone", async () => {
    const otherEpic = await beads.create(repo, {
      title: "Second feature in review",
      type: "epic",
      description: "## Goal\nAlso in review.",
    });
    const otherBranch = `anton/${otherEpic}`;
    const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "ignore" });
    g(["checkout", "-q", "-b", otherBranch]);
    writeFileSync(join(repo, "other.txt"), "v1\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "other work"]);
    g(["push", "-q", "-u", "origin", otherBranch]);
    g(["checkout", "-q", "main"]);
    await beads.tag(repo, otherEpic, [LABELS.stage("in-review")]);
    await beads.setPrRef(repo, otherEpic, "gh-10");

    // Both PRs want changes; every other number (bob's leftover epic) is approved + green.
    const twoPrGh = writeBin(
      binDir,
      "gh-two-prs",
      `const a=process.argv.slice(2);
const branches={7:process.env.FAKE_BRANCH,10:process.env.FAKE_OTHER_BRANCH};
if(a[0]==='pr'&&a[1]==='view'){
  const n=Number(a[2]);
  if(branches[n]){console.log(JSON.stringify({number:n,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:branches[n],url:'u',reviews:[{author:{login:'alice'},state:'CHANGES_REQUESTED',body:'fix it'}],statusCheckRollup:[]}));process.exit(0);}
  console.log(JSON.stringify({number:n,state:'OPEN',reviewDecision:'APPROVED',headRefName:'x',url:'u',reviews:[],statusCheckRollup:[]}));process.exit(0);
}
if(a[0]==='repo'){console.log('acme/repo');process.exit(0);}
process.exit(0);`,
    );

    // claude succeeds in the first PR's worktree and fails in the second's, logging the cwd each ran
    // in so the test can prove the two never shared a checkout.
    const splitClaude = writeBin(
      binDir,
      "claude-split",
      `const fs=require('fs');const path=require('path');
fs.appendFileSync(process.env.FAKE_CWD_LOG,process.cwd()+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  if(process.cwd().includes(process.env.FAKE_FAILING_EPIC)){
    e({type:'result',subtype:'error',result:'could not resolve the feedback',is_error:true});
    process.exit(0);
  }
  fs.writeFileSync(path.join(process.cwd(),'CONCURRENT_FIX.md'),'fixed');
  e({type:'result',subtype:'success',result:'done',is_error:false});
  process.exit(0);
});`,
    );

    const restore = saveEnv([
      "ANTON_GH_BIN",
      "ANTON_CLAUDE_BIN",
      "FAKE_OTHER_BRANCH",
      "FAKE_FAILING_EPIC",
      "FAKE_CWD_LOG",
    ]);
    const cwdLog = join(sandbox, `cwds-${otherEpic}.log`);
    process.env.ANTON_GH_BIN = twoPrGh;
    process.env.ANTON_CLAUDE_BIN = splitClaude;
    process.env.FAKE_OTHER_BRANCH = otherBranch;
    process.env.FAKE_FAILING_EPIC = otherEpic;
    process.env.FAKE_CWD_LOG = cwdLog;
    writeFileSync(cwdLog, "");

    try {
      // One poll, two jobs — one per actionable PR.
      await runDispatch();
      const queued = await tdb.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.type, "review-fix-pr"), eq(schema.jobs.status, "queued")));
      expect(queued.map((j) => JSON.parse(j.payloadJson).epicBeadId).sort()).toEqual(
        [epicId, otherEpic].sort(),
      );

      // Both lease on ONE tick and run at the same time — that is the parallelism.
      const runner = makeJobRunner({
        db: tdb.db,
        clock,
        type: "review-fix-pr",
        handler: makeReviewFixPrHandler,
        config: { leaseMs: 30_000, maxConcurrent: 2, maxReviewFixConcurrent: 2, maxAttempts: 1 },
      });
      expect(await runner.tickOnce()).toBe(2);
      await runner.whenIdle();

      const byTarget = new Map(
        (await tdb.db.select().from(schema.jobs).where(eq(schema.jobs.type, "review-fix-pr"))).map(
          (j) => [JSON.parse(j.payloadJson).epicBeadId as string, j],
        ),
      );
      // The failure is scoped to its own job; the other PR's fix landed and was pushed.
      expect(byTarget.get(otherEpic)?.status).toBe("parked");
      expect(byTarget.get(epicId)?.status).toBe("done");
      const remoteLog = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/${branch}`], {
        encoding: "utf8",
      });
      expect(remoteLog).toContain("address review feedback");

      // Distinct worktree claims: each fix drove claude in its own checkout, never a shared one.
      const cwds = readFileSync(cwdLog, "utf8").trim().split("\n").filter(Boolean);
      expect(cwds).toHaveLength(2);
      expect(new Set(cwds).size).toBe(2);
    } finally {
      restore();
    }
  });

  /**
   * anton-bzm7s: a red gate re-dispatched every scheduled pass. Before this fix, `parked` sat
   * outside the dispatcher's dedupe entirely, so the scheduled 15-minute poll spent a fresh attempt
   * budget on the SAME doomed PR head every pass — 106 re-runs of one real PR in two days, each
   * re-running the whole lint/typecheck/build gate suite. Two dispatcher passes over a target whose
   * only job is parked at the current PR head must produce ONE job total, not two — and a THIRD pass,
   * after the PR head has moved, must admit a fresh attempt.
   */
  it("does not re-dispatch a target whose job is parked at the current PR head; admits one once the head moves", async () => {
    const parkEpic = await beads.create(repo, {
      title: "Feature stuck behind a red gate",
      type: "epic",
      description: "## Goal\nRed gate.",
    });
    const parkBranch = `anton/${parkEpic}`;
    const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "ignore" });
    g(["checkout", "-q", "-b", parkBranch]);
    writeFileSync(join(repo, "park.txt"), "v1\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "park work"]);
    g(["push", "-q", "-u", "origin", parkBranch]);
    g(["checkout", "-q", "main"]);
    await beads.tag(repo, parkEpic, [LABELS.stage("in-review")]);
    await beads.setPrRef(repo, parkEpic, "gh-11");

    // Always actionable (CHANGES_REQUESTED); the head SHA it reports comes from FAKE_PARK_HEAD, so
    // the test can move it like a real push would.
    const parkGh = writeBin(
      binDir,
      "gh-park-head",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){console.log(JSON.stringify({number:11,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:'${parkBranch}',headRefOid:process.env.FAKE_PARK_HEAD,url:'u',reviews:[{author:{login:'alice'},state:'CHANGES_REQUESTED',body:'fix it'}],statusCheckRollup:[]}));process.exit(0);}
if(a[0]==='repo'){console.log('acme/repo');process.exit(0);}
if(a[0]==='api'&&a[1]==='graphql'){console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));process.exit(0);}
process.exit(0);`,
    );

    const restore = saveEnv(["ANTON_GH_BIN", "FAKE_PARK_HEAD"]);
    process.env.ANTON_GH_BIN = parkGh;
    process.env.FAKE_PARK_HEAD = "sha-old";
    const jobsForParkEpic = () =>
      tdb.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.type, "review-fix-pr"))
        .all()
        .filter((j) => JSON.parse(j.payloadJson).epicBeadId === parkEpic);

    try {
      // Pass 1: nothing covers the target yet — one job is dispatched.
      await runDispatch(parkEpic);
      let jobs = jobsForParkEpic();
      expect(jobs).toHaveLength(1);
      const parkedId = jobs[0].id;

      // The gate parks it (anton-h0hwc's PoisonError path — simulated directly here since what
      // parks a job is out of this ticket's scope).
      tdb.db.update(schema.jobs).set({ status: "parked" }).where(eq(schema.jobs.id, parkedId)).run();

      // Pass 2: same PR head — the parked job suppresses a fresh enqueue. Still one job, still parked.
      await runDispatch(parkEpic);
      jobs = jobsForParkEpic();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(parkedId);
      expect(jobs[0].status).toBe("parked");

      // New commits land on the PR — the head moves. Pass 3 must admit the retry that could now
      // actually act on it.
      process.env.FAKE_PARK_HEAD = "sha-new";
      await runDispatch(parkEpic);
      jobs = jobsForParkEpic();
      expect(jobs).toHaveLength(2);
      expect(jobs.some((j) => j.status === "queued")).toBe(true);
    } finally {
      restore();
    }
  });
});
