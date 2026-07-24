/**
 * End-to-end proof of the epic's acceptance criterion: "approved epics run autonomously →
 * worktree → PR → in-review." Drives the REAL execute-epic handler + REAL job runner + REAL bd
 * and git against a temp repo with a bare `origin`, using fake `claude` / `gh` binaries so the
 * pipeline is exercised deterministically without spending API quota. Skipped without bd + git.
 *
 * This is the "base tip & abandon" slice of `execute-epic.integration.test.ts` — the agent
 * self-reported `blocked` cross-check, fresh-base branching off a newer `origin/<base>` tip, base
 * stability across a resume, abandoned-ticket skipping, and a mid-run operator abandon — split
 * out so it runs in parallel with its sibling `execute-epic.*.integration.test.ts` files
 * (anton-0oi).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, park } from "./queue";
import { JobRunner } from "./runner";
import { makeExecuteEpicHandler } from "./execute-epic";
import { resetOperatorCache } from "../operator";
import { describeBd } from "@/lib/testing/integration";
import {
  BASE_TIME_MS,
  resetPerCaseState,
  FakeClock,
  writeBin,
  fakeClaudeReadingStdin,
  pushFreshBaseCommit,
  createExecuteEpicSandbox,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

describeBd("execute-epic e2e — base tip & abandon (real handler · real bd/git · fake claude/gh)", () => {
  let sandbox: string;
  let repo: string;
  let bare: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let projectId: string;
  let successClaude: string;
  let ctx: ExecuteEpicSandbox;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ sandbox, repo, bare, binDir, tdb, clock, projectId, successClaude } = ctx);
  });

  afterAll(() => {
    ctx?.restoreEnv();
    resetOperatorCache();
    ctx?.cleanup();
  });

  beforeEach(async () => {
    clock.set(BASE_TIME_MS);
    await resetPerCaseState(tdb);
  });

  it("blocks + surfaces a ticket the agent self-reported ANTON-RESULT: blocked, even with a commit (anton-j5i8)", async () => {
    // The agent committed partial work but ended with `ANTON-RESULT: blocked — <reason>`: it is
    // telling us the ticket is not done. The harness must honor that honest signal — block the
    // ticket for a human (not close it on the partial change), record the parsed outcome on the
    // session log, and halt the epic — corroborating the delivery-evidence gate rather than
    // trusting the commit alone.
    const epicSb = await beads.create(repo, {
      title: "Self-blocked epic",
      type: "epic",
      description: "## Goal\nSB",
    });
    await beads.approve(repo, epicSb);
    const mkSb = (title: string) => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", title, "--type", "task", "--parent", epicSb, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    };
    const sb1 = mkSb("SB ticket one");
    const sb2 = mkSb("SB ticket two");

    // A claude that DOES change the tree (so a commit lands + the AGENT_WORK.md test gate passes)
    // but self-reports `blocked` in its final result — the exact "committed but declared incomplete"
    // contradiction the cross-check must surface. Logs each ticket so we can prove the epic halts.
    const invLog = join(sandbox, "selfblocked-inv.jsonl");
    const blockedClaude = writeBin(
      binDir,
      "claude-selfblocked",
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(invLog)},(m?m[1]:'unknown')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'partial '+Date.now()+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'ssb'});
e({type:'assistant',message:{content:[{type:'text',text:'made partial progress'}]}});
e({type:'result',subtype:'success',result:'Partial progress only.\\nANTON-RESULT: blocked — acceptance criteria contradict the existing API',session_id:'ssb',num_turns:1,is_error:false});
process.exit(0);`),
    );

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = blockedClaude;
    let jobId: string;
    try {
      jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epicSb },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      // Poison → job parked (no retry burn); the reason names the self-reported block and is
      // recorded on the run row + the parked job's lastError.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toMatch(/self-reported blocked/i);
      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epicSb)!;
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/self-reported blocked/i);

      // Exactly one ticket dispatched — the epic halted on the blocked ticket.
      const invoked = readFileSync(invLog, "utf8").trim().split("\n").filter(Boolean);
      expect(invoked).toHaveLength(1);
      const blockedId = invoked[0];
      const skippedId = blockedId === sb1 ? sb2 : sb1;

      // Ticket state reflects the block: BLOCKED (not closed), unclaimed, no implementing label,
      // with an operator note that names the agent's self-report.
      const blocked = await beads.show(repo, blockedId);
      expect(blocked.status).toBe("blocked");
      expect(blocked.assignee ?? null).toBeNull();
      expect(blocked.labels ?? []).not.toContain("stage:implementing");

      // The parsed outcome was recorded on the session log (surfaced for tailing/replay).
      const session = (await tdb.db.select().from(schema.sessions)).find(
        (s) => s.beadId === blockedId,
      )!;
      const log = readFileSync(session.logPath!, "utf8");
      expect(log).toContain("[anton-result] blocked — acceptance criteria contradict");
      expect(log).toContain("[agent-blocked]");

      // Downstream ticket never dispatched; no PR; epic never advanced to in-review.
      const skipped = await beads.show(repo, skippedId);
      expect(skipped.status).toBe("open");
      const epic = await beads.show(repo, epicSb);
      expect(beads.getPrRef(epic) ?? null).toBeNull();
      expect(epic.labels ?? []).not.toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("branches a fresh run off the newer origin/<base> tip (anton-x3o)", async () => {
    // A run whose LOCAL base is stale must start at the remote tip: resolveFreshBase fetches
    // origin/main before createWorktree, so the worktree branches off origin/main, not the local
    // (behind) main. Advance origin/main behind the sandbox repo's back, then run and assert the
    // fresh commit is an ancestor of the run's pushed branch.
    const epic6 = await beads.create(repo, {
      title: "Feature FreshBase",
      type: "epic",
      description: "## Goal\nFresh",
    });
    await beads.approve(repo, epic6);
    const t6 = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "Fresh ticket", "--type", "task", "--parent", epic6, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();

    // Push a commit to origin/main WITHOUT updating the sandbox repo's local main.
    const freshSha = pushFreshBaseCommit(sandbox, bare, "FRESH_BASE");
    // The sandbox repo's local main does NOT contain it yet (proves "stale local base").
    expect(
      execFileSync("git", ["-C", repo, "log", "--oneline", "main"], { encoding: "utf8" }),
    ).not.toContain("FRESH_BASE");

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    const jobId = await runner.enqueue({
      type: "execute-epic",
      projectId,
      payload: { projectId, epicBeadId: epic6 },
    });
    await runner.tickOnce();
    await runner.whenIdle();
    expect((await getJob(tdb.db, jobId))?.status).toBe("done");
    expect((await beads.show(repo, t6)).status).toBe("closed");

    // The run's branch descends from origin's newer commit — the worktree was cut off origin/main.
    execFileSync("git", ["-C", repo, "fetch", "-q", "origin"], { stdio: "ignore" });
    const isAncestor = (() => {
      try {
        execFileSync(
          "git",
          ["-C", repo, "merge-base", "--is-ancestor", freshSha, `origin/anton/${epic6}`],
          { stdio: "ignore" },
        );
        return true;
      } catch {
        return false;
      }
    })();
    expect(isAncestor).toBe(true);
  });

  it("does not rebase an existing worktree onto a newer base on resume (anton-x3o)", async () => {
    // AC3: resume reuses the existing worktree as-is. Even if origin/main advances between the
    // park and the resume, createWorktree short-circuits to the existing worktree and its base is
    // NOT moved mid-run — the run's branch must not pick up the post-park commit.
    const epic7 = await beads.create(repo, {
      title: "Feature ResumeStable",
      type: "epic",
      description: "## Goal\nStable",
    });
    await beads.approve(repo, epic7);
    const t7 = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "Stable ticket", "--type", "task", "--parent", epic7, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();

    const resetSec = Math.floor(clock.now() / 1000) + 3600;
    const quotaClaude = writeBin(
      binDir,
      "claude-quota-stable",
      `const fs=require('fs');const path=require('path');
const sentinel=path.join(process.cwd(),'.quota-hit-stable');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(!fs.existsSync(sentinel)){
  fs.writeFileSync(sentinel,'1');
  e({type:'result',subtype:'error',result:'Claude AI usage limit reached|${resetSec}',is_error:true});
  process.exit(0);
}
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work-stable '+Date.now()+'\\n');
e({type:'system',subtype:'init',session_id:'ss'});
e({type:'assistant',message:{content:[{type:'text',text:'done'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'ss',num_turns:1,is_error:false});
process.exit(0);`,
    );

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000, quotaCooloffMs: 60_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = quotaClaude;
    try {
      const jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epic7 },
      });

      // First tick → usage limit → run parked, worktree created off whatever origin/main was.
      await runner.tickOnce();
      await runner.whenIdle();
      const run7 = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epic7)!;
      expect(run7.status).toBe("parked");
      expect(existsSync(run7.worktreePath!)).toBe(true);

      // Origin/main advances AFTER the worktree exists — resume must not fold this into the run.
      const postParkSha = pushFreshBaseCommit(sandbox, bare, "POST_PARK");

      // Advance past the reset window → resume completes on the SAME worktree.
      clock.set(resetSec * 1000 + 1);
      await runner.tickOnce();
      await runner.whenIdle();
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      expect((await beads.show(repo, t7)).status).toBe("closed");

      // The post-park commit is NOT an ancestor of the run branch — the worktree wasn't rebased.
      execFileSync("git", ["-C", repo, "fetch", "-q", "origin"], { stdio: "ignore" });
      const foldedIn = (() => {
        try {
          execFileSync(
            "git",
            ["-C", repo, "merge-base", "--is-ancestor", postParkSha, `origin/anton/${epic7}`],
            { stdio: "ignore" },
          );
          return true;
        } catch {
          return false;
        }
      })();
      expect(foldedIn).toBe(false);
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  // Three full run phases (run → park → clock jump → resume → run) of real bd/git work; its
  // honest cost is ~60-90s, above the 60s the rest of this file uses (anton-0oi).
  });

  it("skips an abandoned ticket instead of reopening it, and ships the rest of the epic (anton-6xj0)", async () => {
    // An abandoned bead is CLOSED with no commit on the branch — the exact shape the cross-machine
    // resume path reads as "closed elsewhere, regenerate it here". Without the abandon check the run
    // would reopen it and re-run the agent on work a human explicitly killed. It must be dropped
    // from the run entirely: never dispatched, never reopened, and absent from the PR body.
    const epicAb = await beads.create(repo, {
      title: "Epic with an abandoned ticket",
      type: "epic",
      description: "## Goal\nAB",
    });
    await beads.approve(repo, epicAb);
    const mk = (title: string) => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", title, "--type", "task", "--parent", epicAb, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    };
    const keep = mk("Ticket that ships");
    const drop = mk("Ticket the operator killed");
    await beads.abandon(repo, drop, "not worth building");

    // Capture the PR body `gh pr create` is invoked with, to prove the abandoned ticket isn't listed.
    const bodyDump = join(sandbox, "abandon-pr-body.txt");
    const bodyGh = writeBin(
      binDir,
      "gh-body",
      `const fs=require('fs');const a=process.argv.slice(2);
const i=a.indexOf('--body');if(i>=0){fs.writeFileSync(${JSON.stringify(bodyDump)},a[i+1]);}
console.log('https://github.com/acme/repo/pull/42');process.exit(0);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = bodyGh;

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = successClaude;
    let jobId: string;
    try {
      jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epicAb },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // The abandoned ticket is untouched: still closed, still labelled, never claimed or dispatched.
      const dropped = await beads.show(repo, drop);
      expect(dropped.status).toBe("closed");
      expect(beads.isAbandoned(dropped)).toBe(true);
      const droppedSessions = (await tdb.db.select().from(schema.sessions)).filter(
        (s) => s.beadId === drop,
      );
      expect(droppedSessions).toHaveLength(0);

      // The live ticket shipped, and only its commit is on the branch.
      expect((await beads.show(repo, keep)).status).toBe("closed");
      const log = execFileSync(
        "git",
        ["-C", repo, "log", "--oneline", `origin/anton/${epicAb}`],
        { encoding: "utf8" },
      );
      expect(log).toContain(`${keep}:`);
      expect(log).not.toContain(`${drop}:`);

      // The PR advertises only the work it actually contains.
      const body = readFileSync(bodyDump, "utf8");
      expect(body).toContain(keep);
      expect(body).not.toContain(drop);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("a mid-run abandon kills the job and exits with no delivery — not a park, not a false success (anton-6xj0)", async () => {
    // The operator abandons a ticket while its agent is running: cancel the job first (stopping the
    // agent), then record the outcome — the order abandonTicket uses. The run must end with the
    // ticket closed + abandoned (never reopened into the ready pool, never blocked with a
    // "nothing was delivered" note), nothing shipped, and the job terminal as `cancelled` — the
    // runner's park/retry path must not fire on an operator's own decision.
    const epicKill = await beads.create(repo, {
      title: "Epic abandoned mid-flight",
      type: "epic",
      description: "## Goal\nKILL",
    });
    await beads.approve(repo, epicKill);
    const p = JSON.parse(
      execFileSync(
        "bd",
        ["create", "Long-running ticket", "--type", "task", "--parent", epicKill, "--acceptance", "x", "--json"],
        { cwd: repo, encoding: "utf8" },
      ),
    );
    const tk = ((Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string);

    // A claude that announces it started, then hangs until it is killed.
    const startedMarker = join(sandbox, "abandon-started");
    const slowClaude = writeBin(
      binDir,
      "claude-slow",
      `const fs=require('fs');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'skill'});
fs.writeFileSync(${JSON.stringify(startedMarker)},'1');
setTimeout(()=>process.exit(0),60000);`,
    );

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 60_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = slowClaude;
    try {
      const jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epicKill },
      });
      void runner.tickOnce();
      // Wait for the agent to actually be in flight — abandoning before dispatch would prove nothing.
      const deadline = Date.now() + 40_000;
      while (!existsSync(startedMarker) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(startedMarker)).toBe(true);

      expect(await runner.cancel(jobId)).toBe(true);
      await beads.abandon(repo, tk, "changed our minds mid-flight");
      await runner.whenIdle();

      // Terminal as cancelled — NOT parked, NOT done: an abandon is neither a failure needing a
      // human nor a delivery.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("cancelled");

      // The ticket keeps the outcome the operator gave it.
      const bead = await beads.show(repo, tk);
      expect(bead.status).toBe("closed");
      expect(beads.isAbandoned(bead)).toBe(true);
      expect(bead.labels ?? []).not.toContain("stage:implementing");
      expect(bead.notes ?? "").not.toMatch(/nothing was delivered/i);

      // Nothing shipped: no PR ref, and the epic never advanced to in-review.
      const epic = await beads.show(repo, epicKill);
      expect(beads.getPrRef(epic) ?? null).toBeNull();
      expect(epic.labels ?? []).not.toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  });
});
