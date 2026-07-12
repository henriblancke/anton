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
import { makeTestDb, type TestDb } from "../db/testing";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { JobRunner } from "./runner";
import { makeExecuteEpicHandler } from "./execute-epic";

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

    // beads: epic (approved) + two tickets under it.
    execFileSync("bd", ["init"], { cwd: repo, stdio: "ignore" });
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
      let job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("queued"); // rescheduled
      expect(job?.attempts).toBe(0); // quota attempt refunded
      const runsForEpic = await tdb.db.select().from(schema.runs);
      const run2 = runsForEpic.find((r) => r.epicBeadId === epic2)!;
      expect(run2.status).toBe("parked");
      expect(existsSync(run2.worktreePath!)).toBe(true); // worktree kept for resume
      expect((await beads.show(repo, ticket2)).status).not.toBe("closed");

      // Not due yet.
      expect(await runner.tickOnce()).toBe(0);

      // Advance past the reset window → resumes on the SAME run/worktree and completes.
      clock.set(resetSec * 1000 + 1);
      await runner.tickOnce();

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
});
