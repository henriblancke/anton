/**
 * End-to-end proof of anton-3t2.2's acceptance: "Actionable PR review comments/CI failures are
 * auto-resolved by claude and pushed." Drives the REAL review-fix handler + REAL runner + REAL
 * bd/git against a temp repo with a bare origin, using fake `claude`/`gh` so the flow is
 * deterministic without spending API quota or hitting GitHub. Skipped without bd + git.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads, LABELS } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { JobRunner } from "./runner";
import { makeReviewFixHandler } from "./review-fix";
import { createWorktree } from "../git/worktree";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

const suite = has("bd") && has("git") ? describe : describe.skip;

suite("review-fix e2e (real handler · real bd/git · fake claude/gh)", () => {
  let sandbox: string;
  let repo: string;
  let bare: string;
  let binDir: string;
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;
  let epicId: string;
  let branch: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-rf-"));
    repo = join(sandbox, "repo");
    bare = join(sandbox, "remote.git");
    binDir = join(sandbox, "bin");
    mkdirSync(repo);
    mkdirSync(binDir);

    const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "ignore" });
    execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["remote", "add", "origin", bare]);
    g(["push", "-q", "-u", "origin", "main"]);

    // beads: an in-review epic with a PR ref (as execute-epic would have left it).
    execFileSync("bd", ["init"], { cwd: repo, stdio: "ignore" });
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
    await beads.setExternalRef(repo, epicId, "gh-7");

    // Fake claude: apply a fix in the worktree + dump its args so we can assert the prompt. Ends
    // with the per-thread json report anton parses to reply/resolve threads.
    const report = '{"threads":[{"id":"RT_1","outcome":"fixed","reply":"renamed foo to bar"}]}';
    const fakeClaude = writeBin(
      binDir,
      "claude",
      `const fs=require('fs');const path=require('path');
fs.writeFileSync(path.join(process.cwd(),'FIX.md'),'fixed '+Date.now());
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
if(process.env.ANTON_TEST_CLAUDE_ARGV) fs.appendFileSync(process.env.ANTON_TEST_CLAUDE_ARGV,JSON.stringify({prompt:get('-p'),append:get('--append-system-prompt')})+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'s'});
e({type:'assistant',message:{content:[{type:'text',text:'resolved feedback'}]}});
e({type:'result',subtype:'success',result:'done\\n\\n\`\`\`json\\n${report}\\n\`\`\`',session_id:'s',is_error:false});
process.exit(0);`,
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

    const set = (k: string, v: string) => {
      prevEnv[k] = process.env[k];
      process.env[k] = v;
    };
    set("ANTON_CLAUDE_BIN", fakeClaude);
    set("ANTON_GH_BIN", fakeGh);
    set("ANTON_WORKTREES_ROOT", join(sandbox, "worktrees"));
    set("ANTON_SESSIONS_ROOT", join(sandbox, "sessions"));
    set("ANTON_TEST_CLAUDE_ARGV", join(sandbox, "claude-argv.jsonl"));
    set("FAKE_BRANCH", branch);
    set("FAKE_GH_LOG", join(sandbox, "gh.log"));

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
  }, 60_000);

  afterAll(() => {
    tdb?.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("resolves an actionable PR: claude fix → commit → push → thread reply/resolve + comment + re-request", async () => {
    const runner = new JobRunner({ db: tdb.db, clock, config: { maxConcurrent: 1, leaseMs: 30_000 } });
    runner.registerHandler("review-fix", makeReviewFixHandler({ db: tdb.db, clock }));

    const jobId = await runner.enqueue({
      type: "review-fix",
      projectId,
      payload: { projectId },
    });
    expect(await runner.tickOnce()).toBe(1);

    // Job succeeded.
    expect((await getJob(tdb.db, jobId))?.status).toBe("done");

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

    // Notify calls fired: the fixed thread got a reply + was resolved, plus the PR-level comment
    // and the reviewer re-request.
    const ghLog = readFileSync(join(sandbox, "gh.log"), "utf8");
    expect(ghLog).toContain("reply");
    expect(ghLog).toContain("resolve");
    expect(ghLog).toContain("comment");
    expect(ghLog).toContain("rerequest");

    // A review-fix session was recorded + finished.
    const sessions = await tdb.db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].kind).toBe("review-fix");
    expect(sessions[0].status).toBe("done");
    expect(sessions[0].beadId).toBe(epicId);
  }, 60_000);

  it("uses the per-project reviewFixPrompt override when set (else the default file)", async () => {
    const marker = "RF_OVERRIDE_MARKER_QZX9";
    await tdb.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ reviewFixPrompt: `${marker}\nResolve it my way.` }) })
      .where(eq(schema.projects.id, projectId));
    try {
      const runner = new JobRunner({ db: tdb.db, clock, config: { maxConcurrent: 1, leaseMs: 30_000 } });
      runner.registerHandler("review-fix", makeReviewFixHandler({ db: tdb.db, clock }));
      await runner.enqueue({ type: "review-fix", projectId, payload: { projectId } });
      expect(await runner.tickOnce()).toBe(1);

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
  }, 60_000);

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
      const runner = new JobRunner({ db: tdb.db, clock, config: { maxConcurrent: 1, leaseMs: 30_000 } });
      runner.registerHandler("review-fix", makeReviewFixHandler({ db: tdb.db, clock }));
      const jobId = await runner.enqueue({ type: "review-fix", projectId, payload: { projectId } });
      expect(await runner.tickOnce()).toBe(1);
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // The previously-unpushed commit is now on origin.
      const remoteLog = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/${branch}`], {
        encoding: "utf8",
      });
      expect(remoteLog).toContain("[prior]");
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  }, 60_000);

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
      const runner = new JobRunner({ db: tdb.db, clock, config: { maxConcurrent: 1, leaseMs: 30_000 } });
      runner.registerHandler("review-fix", makeReviewFixHandler({ db: tdb.db, clock }));
      const jobId = await runner.enqueue({ type: "review-fix", projectId, payload: { projectId } });
      expect(await runner.tickOnce()).toBe(1);
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      // Nothing actionable → no worktree/claude/session work happened.
      const after = await tdb.db.select().from(schema.sessions);
      expect(after.length).toBe(before);
    } finally {
      process.env.ANTON_GH_BIN = prev;
    }
  }, 60_000);
});
