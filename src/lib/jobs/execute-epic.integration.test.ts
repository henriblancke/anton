/**
 * End-to-end proof of the epic's acceptance criterion: "approved epics run autonomously →
 * worktree → PR → in-review." Drives the REAL execute-epic handler + REAL job runner + REAL bd
 * and git against a temp repo with a bare `origin`, using fake `claude` / `gh` binaries so the
 * pipeline is exercised deterministically without spending API quota. Skipped without bd + git.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, park, resumeJob, type Clock } from "./queue";
import { JobRunner } from "./runner";
import { makeExecuteEpicHandler } from "./execute-epic";
import { resetOperatorCache } from "../operator";

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
  set(t: number) {
    this.t = t;
  }
}

/** Write an executable node script and return its path. */
function writeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

const suite = has("bd") && has("git") ? describe : describe.skip;

suite("execute-epic e2e (real handler · real bd/git · fake claude/gh)", () => {
  let sandbox: string;
  let repo: string;
  let bare: string;
  let binDir: string;
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;
  let epicId: string;
  let t1: string;
  let t2: string;
  let successClaude: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-e2e-"));
    repo = join(sandbox, "repo");
    bare = join(sandbox, "remote.git");
    binDir = join(sandbox, "bin");
    mkdirSync(repo);
    mkdirSync(binDir);

    const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "ignore" });

    // Bare remote + working repo pushed to it.
    execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["remote", "add", "origin", bare]);
    g(["push", "-q", "-u", "origin", "main"]);

    // beads: epic (approved) + two tickets under it. The git `origin` doubles as the Dolt
    // remote (as `anton setup` wires it), so the run's explicit beads.sync is exercised too.
    // --skip-hooks: bd's own pre-commit hook (bd export) deadlocks against bd init's exclusive
    // embedded-Dolt lock in a pristine repo. anton never relies on bd hooks — sync is explicit.
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });
    execFileSync("bd", ["dolt", "remote", "add", "origin", bare], { cwd: repo, stdio: "ignore" });
    // anton-managed config: disable bd's own auto-push — anton owns push cadence (see CONFIG_KEYS).
    execFileSync("bd", ["config", "set", "dolt.auto-push", "false"], { cwd: repo, stdio: "ignore" });
    epicId = await beads.create(repo, {
      title: "Ship feature X",
      type: "epic",
      description: "## Goal\nShip X.\n\n## Acceptance\nWorks.",
    });
    await beads.approve(repo, epicId);

    // Two tickets under the epic; t1 carries an agent tag to exercise agent-prompt loading.
    const c1 = execFileSync(
      "bd",
      ["create", "Ticket one", "--type", "task", "--parent", epicId, "--labels", "agent:nextjs", "--acceptance", "work file exists", "--json"],
      { cwd: repo, encoding: "utf8" },
    );
    const c2 = execFileSync(
      "bd",
      ["create", "Ticket two", "--type", "task", "--parent", epicId, "--acceptance", "work file exists", "--json"],
      { cwd: repo, encoding: "utf8" },
    );
    const idOf = (raw: string): string => {
      const p = JSON.parse(raw);
      const b = Array.isArray(p) ? p[0] : (p.issue ?? p);
      return b.id as string;
    };
    t1 = idOf(c1);
    t2 = idOf(c2);

    // Fake claude: make a change in the worktree, dump its -p / --append-system-prompt args (so
    // the test can assert the composed system prompt reached it), emit valid stream-json, succeed.
    const fakeClaude = writeBin(
      binDir,
      "claude",
      `const fs=require('fs');const path=require('path');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+' '+Math.random()+'\\n');
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
const dump=process.env.ANTON_TEST_CLAUDE_ARGV;
if(dump){fs.appendFileSync(dump,JSON.stringify({prompt:get('-p'),append:get('--append-system-prompt')})+'\\n');}
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'s'});
e({type:'assistant',message:{content:[{type:'text',text:'implemented the ticket'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'s',num_turns:1,total_cost_usd:0.01,is_error:false});
process.exit(0);`,
    );
    successClaude = fakeClaude;
    // Fake gh: echo a PR url.
    const fakeGh = writeBin(binDir, "gh", `console.log('https://github.com/acme/repo/pull/42');process.exit(0);`);

    // Env overrides scoped to this suite.
    const set = (k: string, v: string) => {
      prevEnv[k] = process.env[k];
      process.env[k] = v;
    };
    set("ANTON_CLAUDE_BIN", fakeClaude);
    set("ANTON_GH_BIN", fakeGh);
    set("ANTON_WORKTREES_ROOT", join(sandbox, "worktrees"));
    set("ANTON_SESSIONS_ROOT", join(sandbox, "sessions"));
    set("ANTON_TEST_CLAUDE_ARGV", join(sandbox, "claude-argv.jsonl"));
    set("ANTON_OPERATOR", "test-operator"); // claims must land on the human operator
    resetOperatorCache();

    // Test DB + project row.
    tdb = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "sandbox",
      name: "sandbox",
      repoPath: repo,
      defaultBranch: "main",
      // testCommand asserts claude ran before tests → proves ordering claude→tests.
      // seedPrompt asserts the operator seed layers into the composed system prompt.
      settingsJson: JSON.stringify({
        testCommand: "test -f AGENT_WORK.md",
        seedPrompt: "SEED_MARKER_QZX — prefer server components in this repo.",
      }),
    });
  }, 60_000);

  afterAll(() => {
    tdb?.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetOperatorCache();
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("runs an approved epic autonomously → worktree → per-ticket commits → PR → in-review", async () => {
    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    const jobId = await runner.enqueue({
      type: "execute-epic",
      projectId,
      payload: { projectId, epicBeadId: epicId },
    });

    const processed = await runner.tickOnce();
    await runner.whenIdle();
    expect(processed).toBe(1);

    // Job succeeded.
    const job = await getJob(tdb.db, jobId);
    expect(job?.status).toBe("done");

    // Run row recorded + finalized + worktree cleaned up.
    const runs = await tdb.db.select().from(schema.runs);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.status).toBe("done");
    expect(run.branch).toBe(`anton/${epicId}`);
    expect(run.worktreePath).toBeTruthy();
    expect(existsSync(run.worktreePath!)).toBe(false); // removed after the run

    // Both tickets closed in beads.
    const board = await beads.list(repo, ["--status", "all"]);
    const bt1 = board.find((b) => b.id === t1);
    const bt2 = board.find((b) => b.id === t2);
    expect(bt1?.status).toBe("closed");
    expect(bt2?.status).toBe("closed");

    // Epic → in-review: PR ref + stage label.
    const epic = await beads.show(repo, epicId);
    expect(epic.external_ref).toBe("gh-42");
    expect(epic.labels ?? []).toContain("stage:in-review");

    // The run CLAIMED the epic + each ticket for the human operator (assignee set, not just
    // in_progress) so the board shows who owns in-flight work — anton-ner.1 / anton-live-sync R6.
    expect(epic.assignee).toBe("test-operator");
    expect(bt1?.assignee).toBe("test-operator");
    expect(bt2?.assignee).toBe("test-operator");

    // The branch was actually pushed to origin, and carries per-ticket commits.
    const remoteBranches = execFileSync("git", ["-C", repo, "ls-remote", "--heads", "origin"], {
      encoding: "utf8",
    });
    expect(remoteBranches).toContain(`refs/heads/anton/${epicId}`);
    const log = execFileSync(
      "git",
      ["-C", repo, "log", "--oneline", `origin/anton/${epicId}`],
      { encoding: "utf8" },
    );
    expect(log).toContain(`${t1}:`);
    expect(log).toContain(`${t2}:`);

    // The run's bd writes (claims, closes, stage labels) were pushed to the Dolt remote
    // explicitly by beads.sync — refs/dolt/data exists on origin without any git hook firing.
    const allRefs = execFileSync("git", ["-C", repo, "ls-remote", "origin"], { encoding: "utf8" });
    expect(allRefs).toContain("refs/dolt/data");

    // Two execute sessions recorded + logged.
    const sessions = await tdb.db.select().from(schema.sessions);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.status === "done" && s.kind === "execute")).toBe(true);
    for (const s of sessions) {
      expect(existsSync(s.logPath!)).toBe(true);
      expect(readFileSync(s.logPath!, "utf8")).toContain("[result]");
    }

    // Composed system prompt reached claude for BOTH tickets: locked base + operator seed on
    // every invocation, and the agent layer only for the agent-tagged ticket (t1: agent:nextjs).
    const argvDump = join(sandbox, "claude-argv.jsonl");
    const invocations = readFileSync(argvDump, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { prompt?: string; append?: string });
    const forTicket = (id: string) => invocations.find((v) => v.prompt?.includes(id))!;

    for (const id of [t1, t2]) {
      const inv = forTicket(id);
      expect(inv.append).toContain("operating contract"); // locked base
      expect(inv.append).toContain("bd remember"); // learnings requirement
      expect(inv.append).toContain("SEED_MARKER_QZX"); // operator seed layered in
    }
    // Agent layer present only where an agent:tag exists.
    expect(forTicket(t1).append).toContain("Specialist guidance (agent)");
    expect(forTicket(t2).append).not.toContain("Specialist guidance (agent)");
  }, 60_000);

  it("parks on a usage limit, then resumes the SAME run/worktree past the reset window", async () => {
    // A fresh approved epic with one ticket.
    const epic2 = await beads.create(repo, {
      title: "Feature Y",
      type: "epic",
      description: "## Goal\nY",
    });
    await beads.approve(repo, epic2);
    const ticket2 = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "Only ticket", "--type", "task", "--parent", epic2, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();

    const resetSec = Math.floor(clock.now() / 1000) + 3600;
    // Quota-then-success: first invocation hits the usage limit; once a sentinel exists in the
    // (reused) worktree, subsequent invocations succeed — proving resume + worktree reuse.
    const quotaClaude = writeBin(
      binDir,
      "claude-quota",
      `const fs=require('fs');const path=require('path');
const sentinel=path.join(process.cwd(),'.quota-hit');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(!fs.existsSync(sentinel)){
  fs.writeFileSync(sentinel,'1');
  e({type:'result',subtype:'error',result:'Claude AI usage limit reached|${resetSec}',is_error:true});
  process.exit(0);
}
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work2 '+Date.now()+'\\n');
e({type:'system',subtype:'init',session_id:'s2'});
e({type:'assistant',message:{content:[{type:'text',text:'done'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'s2',num_turns:1,is_error:false});
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
        payload: { projectId, epicBeadId: epic2 },
      });

      // First tick → usage limit → job parked (rescheduled), run parked, ticket still open.
      await runner.tickOnce();
      await runner.whenIdle();
      let job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("queued"); // rescheduled
      expect(job?.attempts).toBe(0); // quota attempt refunded
      const runsForEpic = await tdb.db.select().from(schema.runs);
      const run2 = runsForEpic.find((r) => r.epicBeadId === epic2)!;
      expect(run2.status).toBe("parked");
      expect(existsSync(run2.worktreePath!)).toBe(true); // worktree kept for resume
      // The ticket was claimed before the session ran: visible in-flight state on the board,
      // assigned to the human operator. A usage-limit park keeps the claim (the run resumes).
      const claimed = await beads.show(repo, ticket2);
      expect(claimed.status).toBe("in_progress");
      expect(claimed.assignee).toBe("test-operator");
      expect(claimed.labels ?? []).toContain("stage:implementing");

      // Not due yet.
      expect(await runner.tickOnce()).toBe(0);

      // Advance past the reset window → resumes on the SAME run/worktree and completes.
      clock.set(resetSec * 1000 + 1);
      await runner.tickOnce();
      await runner.whenIdle();

      job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("done");
      const after = await tdb.db.select().from(schema.runs);
      const run2b = after.filter((r) => r.epicBeadId === epic2);
      expect(run2b).toHaveLength(1); // resumed, not duplicated
      expect(run2b[0].id).toBe(run2.id);
      expect(run2b[0].status).toBe("done");
      expect((await beads.show(repo, ticket2)).status).toBe("closed");
      expect((await beads.show(repo, epic2)).labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  }, 60_000);

  it("releases a dead session's claim: a failed ticket run leaves the ticket unclaimed", async () => {
    const epic3 = await beads.create(repo, {
      title: "Feature Z",
      type: "epic",
      description: "## Goal\nZ",
    });
    await beads.approve(repo, epic3);
    const ticket3 = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "Doomed ticket", "--type", "task", "--parent", epic3, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();

    // Fake claude that fails outright (non-quota) before committing anything.
    const failingClaude = writeBin(
      binDir,
      "claude-fail",
      `const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'sf'});
e({type:'result',subtype:'error',result:'boom — claude fell over',is_error:true});
process.exit(0);`,
    );

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = failingClaude;
    let jobId: string;
    try {
      jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epic3 },
      });
      await runner.tickOnce();
      await runner.whenIdle(); // let the failed run settle (reschedule) before we park it below

      // R10: no bead left looking claimed by a dead session — status back to open, unassigned,
      // stage label removed. (No work was committed, so it returns to the ready pool.)
      const released = await beads.show(repo, ticket3);
      expect(released.status).toBe("open");
      expect(released.assignee ?? null).toBeNull();
      expect(released.labels ?? []).not.toContain("stage:implementing");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      // A failed run reschedules the job with backoff; park it so a later test's clock-advancing
      // tick can't re-dispatch this doomed epic (the test DB is shared across the describe block).
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  }, 60_000);

  it("resumes past a usage limit skipping already-closed tickets and reusing the worktree", async () => {
    // anton-ner.2 AC5: a two-ticket epic where the first ticket closes, then the second hits the
    // usage limit. After the reset window the run resumes on the SAME worktree, skips the closed
    // ticket (claude is NOT re-invoked for it), finishes the second, and opens the PR.
    const epic3 = await beads.create(repo, {
      title: "Feature Z",
      type: "epic",
      description: "## Goal\nZ",
    });
    await beads.approve(repo, epic3);
    const mkTicket = (title: string) => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", title, "--type", "task", "--parent", epic3, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    };
    const ta = mkTicket("Ticket A");
    const tb = mkTicket("Ticket B");

    const resetSec = Math.floor(clock.now() / 1000) + 3600;
    const invLog = join(sandbox, "inv-log.jsonl");
    // Counting claude: the 2nd invocation over the run's lifetime hits the usage limit; every other
    // invocation succeeds. The counter lives in the worktree, so it only survives into the resume
    // if the worktree is reused — completing at all proves reuse. Each invocation logs its ticket
    // id, so we can assert the already-closed ticket is not re-invoked after the reset.
    const countingClaude = writeBin(
      binDir,
      "claude-count",
      `const fs=require('fs');const path=require('path');
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
const prompt=get('-p')||'';const m=prompt.match(/Ticket: (\\S+)/);const ticket=m?m[1]:'unknown';
const log=${JSON.stringify(invLog)};fs.appendFileSync(log,ticket+'\\n');
const counter=path.join(process.cwd(),'.inv-count');
let n=0;try{n=parseInt(fs.readFileSync(counter,'utf8'),10)||0;}catch(e){}
n+=1;fs.writeFileSync(counter,String(n));
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(n===2){e({type:'result',subtype:'error_during_execution',result:'Claude AI usage limit reached|${resetSec}',is_error:true});process.exit(0);}
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+ticket+' '+n+'\\n');
e({type:'system',subtype:'init',session_id:'s3'});
e({type:'assistant',message:{content:[{type:'text',text:'done'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'s3',num_turns:1,is_error:false});
process.exit(0);`,
    );

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000, quotaCooloffMs: 60_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = countingClaude;
    try {
      const jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epic3 },
      });

      // First tick: one ticket succeeds + closes, the next hits the usage limit → job rescheduled
      // (quota attempt refunded), run parked, worktree kept.
      await runner.tickOnce();
      await runner.whenIdle();
      let job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("queued");
      expect(job?.attempts).toBe(0);
      const run3 = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epic3)!;
      expect(run3.status).toBe("parked");
      expect(existsSync(run3.worktreePath!)).toBe(true);

      // Exactly one ticket closed before the park; the other is still open.
      const statusAtPark = {
        [ta]: (await beads.show(repo, ta)).status,
        [tb]: (await beads.show(repo, tb)).status,
      };
      const closedAtPark = [ta, tb].filter((id) => statusAtPark[id] === "closed");
      expect(closedAtPark).toHaveLength(1);
      const closedFirst = closedAtPark[0];
      const pending = closedFirst === ta ? tb : ta;

      // Both tickets were invoked exactly once so far (the second one quota'd).
      const before = readFileSync(invLog, "utf8").trim().split("\n");
      expect(before.filter((t) => t === closedFirst)).toHaveLength(1);
      expect(before.filter((t) => t === pending)).toHaveLength(1);

      // Not due yet.
      expect(await runner.tickOnce()).toBe(0);

      // Advance past the reset window → resumes on the SAME run/worktree and completes.
      clock.set(resetSec * 1000 + 1);
      await runner.tickOnce();
      await runner.whenIdle();

      job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("done");
      const run3b = (await tdb.db.select().from(schema.runs)).filter((r) => r.epicBeadId === epic3);
      expect(run3b).toHaveLength(1); // resumed, not duplicated
      expect(run3b[0].id).toBe(run3.id);
      expect(run3b[0].worktreePath).toBe(run3.worktreePath); // same worktree reused
      expect(run3b[0].status).toBe("done");

      // Both tickets closed; the already-closed ticket was SKIPPED on resume (invoked once total),
      // while the previously-quota'd ticket was invoked twice (quota + resumed success).
      expect((await beads.show(repo, ta)).status).toBe("closed");
      expect((await beads.show(repo, tb)).status).toBe("closed");
      const after = readFileSync(invLog, "utf8").trim().split("\n");
      expect(after).toHaveLength(3);
      expect(after.filter((t) => t === closedFirst)).toHaveLength(1); // not re-invoked
      expect(after.filter((t) => t === pending)).toHaveLength(2);
      expect((await beads.show(repo, epic3)).labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  }, 60_000);

  it("hard-gates on a ticket claimed by another operator: aborts without stealing the claim", async () => {
    // Shared-backlog safety: on a shared board a ticket may already be claimed by ANOTHER operator
    // (e.g. picked up after a heartbeat pull). The run must not run Claude on a ticket it doesn't
    // own, and must not clear the real owner's claim on the failure path. The ticket claim is a hard
    // gate — a conflict aborts the run (run → failed, no PR) and leaves the foreign claim intact.
    const epic4 = await beads.create(repo, {
      title: "Feature W",
      type: "epic",
      description: "## Goal\nW",
    });
    await beads.approve(repo, epic4);
    const owned = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "Foreign ticket", "--type", "task", "--parent", epic4, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();
    // Another operator claims it before our run (bd's --claim fails for a different actor).
    execFileSync("bd", ["update", owned, "--claim"], {
      cwd: repo,
      env: { ...process.env, BEADS_ACTOR: "other-operator" },
      stdio: "ignore",
    });

    // A claude that logs every ticket it's invoked for — so we can prove it's NEVER run on `owned`.
    const invLog = join(sandbox, "gate-inv.jsonl");
    const loggingClaude = writeBin(
      binDir,
      "claude-gate",
      `const fs=require('fs');const path=require('path');
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
const prompt=get('-p')||'';const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(invLog)},(m?m[1]:'unknown')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'result',subtype:'success',result:'done',session_id:'sg',num_turns:1,is_error:false});
process.exit(0);`,
    );

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = loggingClaude;
    let jobId: string;
    try {
      jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epic4 },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      // Run failed (no partial PR); the epic never advanced to in-review.
      const run4 = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epic4)!;
      expect(run4.status).toBe("failed");
      expect((await beads.show(repo, epic4)).labels ?? []).not.toContain("stage:in-review");

      // The foreign operator's claim is intact — we neither ran Claude on it nor cleared it.
      const t = await beads.show(repo, owned);
      expect(t.assignee).toBe("other-operator");
      expect(t.status).toBe("in_progress");
      const invoked = existsSync(invLog) ? readFileSync(invLog, "utf8") : "";
      expect(invoked).not.toContain(owned);
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      // A failed run reschedules the job with backoff; park it so a later clock-advancing tick
      // can't re-dispatch this epic (the test DB is shared across the describe block).
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  }, 60_000);

  it("parks a run whose ticket needs a disabled agent, and completes it once re-enabled (anton-dm7)", async () => {
    // Dispatch honors the active-agents allowlist: a ticket labeled with a disabled agent must
    // NOT run with the default agent — the run parks with a clear reason before any claim or
    // claude work. Parking is recoverable: enabling the agent + resuming completes the epic.
    const epic5 = await beads.create(repo, {
      title: "Feature V",
      type: "epic",
      description: "## Goal\nV",
    });
    await beads.approve(repo, epic5);
    const gated = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "Gated ticket", "--type", "task", "--parent", epic5, "--labels", "agent:nextjs", "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();

    // A claude that logs every ticket it's invoked for — proves it NEVER runs while gated.
    const invLog = join(sandbox, "allowlist-inv.jsonl");
    const loggingClaude = writeBin(
      binDir,
      "claude-allowlist",
      `const fs=require('fs');const path=require('path');
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
const prompt=get('-p')||'';const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(invLog)},(m?m[1]:'unknown')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'result',subtype:'success',result:'done',session_id:'sa',num_turns:1,is_error:false});
process.exit(0);`,
    );

    const [proj] = await tdb.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    const baseSettings = JSON.parse(proj.settingsJson) as Record<string, unknown>;
    const setAgents = (agents: string[] | undefined) =>
      tdb.db
        .update(schema.projects)
        .set({ settingsJson: JSON.stringify({ ...baseSettings, agents }) })
        .where(eq(schema.projects.id, projectId));

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = loggingClaude;
    try {
      // Allowlist excludes nextjs → the agent:nextjs ticket is gated.
      await setAgents(["fastapi"]);
      const jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epic5 },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      // Poison → job parked immediately (no retry burn) with a reason naming ticket + agent.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toContain(gated);
      expect(job?.lastError).toContain("agent:nextjs");

      // Run failed with the same clear reason; claude never invoked; the ticket was never
      // claimed (the check runs before any claim/worktree work) — still open + unassigned.
      const run5 = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epic5)!;
      expect(run5.status).toBe("failed");
      expect(run5.error).toContain("agent:nextjs");
      expect(existsSync(invLog) ? readFileSync(invLog, "utf8") : "").not.toContain(gated);
      const t = await beads.show(repo, gated);
      expect(t.status).toBe("open");
      expect(t.assignee ?? null).toBeNull();

      // Operator enables the agent → resume → the same epic completes normally.
      await setAgents(["fastapi", "nextjs"]);
      expect(await resumeJob(tdb.db, clock, jobId)).toBe(true);
      await runner.tickOnce();
      await runner.whenIdle();
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      expect((await beads.show(repo, gated)).status).toBe("closed");
      expect((await beads.show(repo, epic5)).labels ?? []).toContain("stage:in-review");
      expect(readFileSync(invLog, "utf8")).toContain(gated);
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      await tdb.db
        .update(schema.projects)
        .set({ settingsJson: JSON.stringify(baseSettings) })
        .where(eq(schema.projects.id, projectId));
    }
  }, 60_000);
});
