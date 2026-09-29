/**
 * anton-091jr review round 2 (chatgpt-codex-connector): a round actionable ONLY via a non-thread
 * reason (here, a reviewer's CHANGES_REQUESTED summary with no inline comments) has no thread to
 * prove it was handled. A claude run that finishes successfully but says nothing about that reason
 * must NOT be recorded as "answered" — that would suppress a genuinely still-open PR at this
 * head+fingerprint forever. Drives the REAL handler + REAL runner + REAL bd/git against a temp repo
 * with a bare origin and a fake `claude`/`gh`, asserting directly on the settled job's own
 * `payloadJson` (what `recordReviewFixAnswered` writes) rather than a second sweep.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob, makeJobRunner } from "@/lib/testing/jobs";
import { beads, LABELS } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { makeReviewFixHandler, makeReviewFixPrHandler } from "./review-fix";
import { NON_THREAD_REPORT_ID } from "./review-fix-context";
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

function g(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

describeBd(
  "review-fix requires positive evidence before recording a no-thread round answered (real handler · real bd/git · fake claude/gh)",
  () => {
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
    let ghCommentLog: string;

    const runDispatch = () =>
      driveJob({
        db: tdb.db,
        clock,
        type: "review-fix",
        handler: makeReviewFixHandler,
        projectId,
        config: { leaseMs: 30_000 },
      });

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

    beforeAll(async () => {
      bdRepo = makeBdRepo({ bare: true, initialCommit: true });
      sandbox = bdRepo.dir;
      repo = bdRepo.repo;
      binDir = join(sandbox, "bin");
      mkdirSync(binDir);
      ghCommentLog = join(sandbox, "gh-comments.log");
      writeFileSync(ghCommentLog, "");

      epicId = await beads.create(repo, {
        title: "Ship feature X",
        type: "epic",
        description: "## Goal\nShip X.",
      });
      branch = `anton/${epicId}`;

      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "v1\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);
      g(repo, ["checkout", "-q", "main"]);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-7");

      // Fake gh: CHANGES_REQUESTED with a reviewer summary but NO inline threads at all — the round
      // is actionable, yet `threadsNeedingAttention` is empty, exactly the vacuous-success shape.
      // `pr comment` is recorded so the test can assert the sentinel's explanation actually reaches
      // the PR, not just the job's own payload. `FAKE_BASE_REF_OID`, when set, reports a `baseRefOid`
      // that a real `resolveCommitSha` against the fetched `origin/main` will never match — letting a
      // test force `refsSynced` false without touching the head half of the check (PR #338 review,
      // chatgpt-codex-connector, round 4).
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const fs=require('fs');
const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
  const base = process.env.FAKE_BASE_REF_OID ? {baseRefOid: process.env.FAKE_BASE_REF_OID} : {};
  console.log(JSON.stringify({number:7,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:process.env.FAKE_BRANCH,...base,url:'https://github.com/acme/repo/pull/7',reviews:[{author:{login:'alice'},state:'CHANGES_REQUESTED',body:'please double-check the rollout plan in the PR description'}],statusCheckRollup:[]}));
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='comment'){
  const body=a[a.indexOf('--body')+1];
  fs.appendFileSync(process.env.FAKE_GH_COMMENT_LOG, body+'\\n---\\n');
  process.exit(0);
}
if(a[0]==='repo'&&a[1]==='view'){console.log('acme/repo');process.exit(0);}
if(a[0]==='api'&&a[1]==='graphql'){
  const q=a.find(x=>x.startsWith('query='))||'';
  const empty={pageInfo:{hasNextPage:false,endCursor:null},nodes:[]};
  let pullRequest={};
  if(q.includes('reviewThreads(')) pullRequest={reviewThreads:empty};
  else if(q.includes('comments(first:100')) pullRequest={comments:empty};
  else if(q.includes('reviews(first:100')) pullRequest={reviews:empty};
  else if(q.includes('commits(last:1)')) pullRequest={commits:{nodes:[]}};
  console.log(JSON.stringify({data:{repository:{pullRequest}}}));
  process.exit(0);
}
process.exit(0);`,
      );

      restoreEnv = saveEnv([
        "ANTON_CLAUDE_BIN",
        "ANTON_GH_BIN",
        "ANTON_WORKTREES_ROOT",
        "ANTON_SESSIONS_ROOT",
        "FAKE_BRANCH",
        "FAKE_GH_COMMENT_LOG",
        "FAKE_BASE_REF_OID",
      ]);
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;
      process.env.FAKE_GH_COMMENT_LOG = ghCommentLog;

      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("does NOT record the round answered when claude pushes nothing and reports nothing", async () => {
      const silentClaude = writeBin(
        binDir,
        "claude-silent",
        `const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'result',subtype:'success',result:'looked at the rollout plan, nothing to change',is_error:false});
process.exit(0);`,
      );
      const prev = process.env.ANTON_CLAUDE_BIN;
      process.env.ANTON_CLAUDE_BIN = silentClaude;
      try {
        const fixes = await runSweep();
        expect(fixes).toHaveLength(1);
        const job = await getJob(tdb.db, fixes[0]);
        expect(job?.status).toBe("done");
        const payload = JSON.parse(job!.payloadJson);
        // No sentinel entry in claude's report → no positive evidence → never recorded as answered,
        // so a later sweep at the same head+fingerprint is NOT suppressed.
        expect(payload.answeredFingerprint).toBeUndefined();
      } finally {
        process.env.ANTON_CLAUDE_BIN = prev;
      }
    });

    it("DOES record the round answered when claude reports the non-thread sentinel outcome", async () => {
      const ackingClaude = writeBin(
        binDir,
        "claude-acking",
        `const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const report=JSON.stringify({threads:[{id:${JSON.stringify(NON_THREAD_REPORT_ID)},outcome:'left',reply:'rollout plan already covered in the description; no change needed'}]});
e({type:'result',subtype:'success',result:'looked at the rollout plan\\n\\n\`\`\`json\\n'+report+'\\n\`\`\`',is_error:false});
process.exit(0);`,
      );
      const prev = process.env.ANTON_CLAUDE_BIN;
      process.env.ANTON_CLAUDE_BIN = ackingClaude;
      try {
        const fixes = await runSweep();
        expect(fixes).toHaveLength(1);
        const job = await getJob(tdb.db, fixes[0]);
        expect(job?.status).toBe("done");
        const payload = JSON.parse(job!.payloadJson);
        expect(payload.answeredFingerprint).toBeDefined();
        // PR #338 review (@chatgpt-codex-connector): `refreshFixRoundsBody` never runs for an
        // unpushed round, so without publishing the sentinel's own reply as a PR comment, a "left"
        // outcome recorded as answered here would leave the reviewer with no explanation at all.
        const comments = readFileSync(ghCommentLog, "utf8");
        expect(comments).toContain("rollout plan already covered in the description");
      } finally {
        process.env.ANTON_CLAUDE_BIN = prev;
      }
    });

    it("does NOT record the round answered when publishing the sentinel comment fails", async () => {
      // Same acking claude as above, but `gh pr comment` fails transiently — the explanation never
      // reaches GitHub, so `answeredAllThreads` must not suppress this fingerprint+headSha (PR #338
      // review, @chatgpt-codex-connector: `publishUnpushedSentinel` used to swallow this failure via
      // `safe()` and let the round be recorded answered anyway).
      const ackingClaude = writeBin(
        binDir,
        "claude-acking-2",
        `const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const report=JSON.stringify({threads:[{id:${JSON.stringify(NON_THREAD_REPORT_ID)},outcome:'left',reply:'rollout plan already covered in the description; no change needed'}]});
e({type:'result',subtype:'success',result:'looked at the rollout plan\\n\\n\`\`\`json\\n'+report+'\\n\`\`\`',is_error:false});
process.exit(0);`,
      );
      const failingGh = writeBin(
        binDir,
        "gh-failing-comment",
        `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='comment'){process.stderr.write('transient network error\\n');process.exit(1);}
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:7,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/7',reviews:[{author:{login:'alice'},state:'CHANGES_REQUESTED',body:'please double-check the rollout plan in the PR description'}],statusCheckRollup:[]}));
  process.exit(0);
}
if(a[0]==='repo'&&a[1]==='view'){console.log('acme/repo');process.exit(0);}
if(a[0]==='api'&&a[1]==='graphql'){
  const q=a.find(x=>x.startsWith('query='))||'';
  const empty={pageInfo:{hasNextPage:false,endCursor:null},nodes:[]};
  let pullRequest={};
  if(q.includes('reviewThreads(')) pullRequest={reviewThreads:empty};
  else if(q.includes('comments(first:100')) pullRequest={comments:empty};
  else if(q.includes('reviews(first:100')) pullRequest={reviews:empty};
  else if(q.includes('commits(last:1)')) pullRequest={commits:{nodes:[]}};
  console.log(JSON.stringify({data:{repository:{pullRequest}}}));
  process.exit(0);
}
process.exit(0);`,
      );
      const prevClaude = process.env.ANTON_CLAUDE_BIN;
      const prevGh = process.env.ANTON_GH_BIN;
      process.env.ANTON_CLAUDE_BIN = ackingClaude;
      process.env.ANTON_GH_BIN = failingGh;
      try {
        const fixes = await runSweep();
        expect(fixes).toHaveLength(1);
        const job = await getJob(tdb.db, fixes[0]);
        expect(job?.status).toBe("done");
        const payload = JSON.parse(job!.payloadJson);
        expect(payload.answeredFingerprint).toBeUndefined();
      } finally {
        process.env.ANTON_CLAUDE_BIN = prevClaude;
        process.env.ANTON_GH_BIN = prevGh;
      }
    });

    it("does NOT record the round answered when the base ref never actually synced (refsSynced=false)", async () => {
      // Same acking claude as above, but GitHub reports a `baseRefOid` that a real fetch + resolve of
      // `origin/main` will never produce — simulating a `fetchOrigin` that landed the head fine but
      // silently failed for the base (PR #338 review round 3) or a base premerge that landed refs
      // matching GitHub but then failed to actually merge (round 4). Either way, `refsSynced` is
      // false, and a delivered `answeredAllThreads` outcome must not write `pr.headSha` back as
      // tested — that would let `parkedAtHead` suppress future feedback at a revision this attempt
      // never actually saw synced (PR #338 review, chatgpt-codex-connector, round 4).
      const ackingClaude = writeBin(
        binDir,
        "claude-acking-stale-base",
        `const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const report=JSON.stringify({threads:[{id:${JSON.stringify(NON_THREAD_REPORT_ID)},outcome:'left',reply:'rollout plan already covered in the description; no change needed'}]});
e({type:'result',subtype:'success',result:'looked at the rollout plan\\n\\n\`\`\`json\\n'+report+'\\n\`\`\`',is_error:false});
process.exit(0);`,
      );
      const prevClaude = process.env.ANTON_CLAUDE_BIN;
      process.env.ANTON_CLAUDE_BIN = ackingClaude;
      process.env.FAKE_BASE_REF_OID = "sha-base-never-fetched";
      try {
        const fixes = await runSweep();
        expect(fixes).toHaveLength(1);
        const job = await getJob(tdb.db, fixes[0]);
        expect(job?.status).toBe("done");
        const payload = JSON.parse(job!.payloadJson);
        expect(payload.answeredFingerprint).toBeUndefined();
      } finally {
        process.env.ANTON_CLAUDE_BIN = prevClaude;
        delete process.env.FAKE_BASE_REF_OID;
      }
    });
  },
);
