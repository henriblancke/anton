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
import { formatHumanNote } from "../beads/notes";
import * as schema from "../db/schema";
import { getJob, park, resumeJob, type Clock } from "./queue";
import { createRun } from "../runs";
import { JobRunner } from "./runner";
import { makeExecuteEpicHandler } from "./execute-epic";
import { deriveStage } from "../ticket-view";
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

/**
 * Advance `origin/main` ahead of the sandbox repo's LOCAL main by committing to a throwaway clone
 * of the bare remote and pushing. Leaves the sandbox repo's own main untouched (stale) so a run
 * that fetches origin/main sees a newer tip. Returns the new commit's sha.
 */
function pushFreshBaseCommit(sandbox: string, bare: string, marker: string): string {
  const clone = mkdtempSync(join(sandbox, "fresh-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: clone, stdio: "ignore" });
  execFileSync("git", ["clone", "-q", bare, clone], { stdio: "ignore" });
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "anton-test"]);
  writeFileSync(join(clone, `${marker}.md`), `${marker}\n`);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", marker]);
  g(["push", "-q", "origin", "main"]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
}

/** The operator's steer on ticket one; asserted to reach that ticket's dispatch prompt. */
const HUMAN_NOTE = "STEER_MARKER_BFY4 — reuse the existing helper, do not add a new one";

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

    // Bare remote + working repo pushed to it. `-b main` pins the bare HEAD to refs/heads/main
    // so clones of this remote (e.g. pushFreshBaseCommit) check out main; otherwise hosts whose
    // default branch is `master` leave the clone on an unborn `master` and `git push origin main`
    // fails with "src refspec main does not match any".
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { stdio: "ignore" });
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

    // A human steer left on t1 between the gates (anton-bfy4) — the run must carry it into that
    // ticket's dispatch prompt, and only that ticket's.
    await beads.note(repo, t1, formatHumanNote(HUMAN_NOTE, "Henri Blancke", new Date(0)));

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

    // The human steer left on t1 reached ITS dispatch prompt (attributed, and only there) —
    // anton-bfy4's whole point: a note the executor reads when it picks the ticket up.
    expect(forTicket(t1).prompt).toContain("## Human notes on this ticket");
    expect(forTicket(t1).prompt).toContain(HUMAN_NOTE);
    expect(forTicket(t1).prompt).toContain("Henri Blancke");
    expect(forTicket(t2).prompt).not.toContain(HUMAN_NOTE);
  }, 60_000);

  it("runs a parentless bug as an epic-of-one → branch anton/<id> → its own PR → in-review (open, not closed)", async () => {
    // anton-cmz.1 + anton-cmz review: a standalone (parentless) bug is a run target. It executes as
    // a single-ticket run — its own branch + PR — but, exactly like an epic, the bead is NOT closed
    // when the PR opens. It stays OPEN + stage:in-review + PR ref until the PR MERGES (review-fix's
    // merge-finalize path closes it then). Closing it at PR-open would derive it as Done on the
    // board while the PR is still open and drop it out of review-fix's in-review sweep.
    const bugId = await beads.create(repo, {
      title: "Fix the flaky import",
      type: "bug",
      acceptance: "work file exists",
      description: "## Goal\nStop the flake.",
    });
    await beads.approve(repo, bugId);

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = successClaude;
    const jobId = await runner.enqueue({
      type: "execute-epic",
      projectId,
      payload: { projectId, epicBeadId: bugId },
    });
    await runner.tickOnce();
    await runner.whenIdle();

    // Job + run finalized.
    expect((await getJob(tdb.db, jobId))?.status).toBe("done");
    const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === bugId)!;
    expect(run.status).toBe("done");
    expect(run.branch).toBe(`anton/${bugId}`);
    expect(existsSync(run.worktreePath!)).toBe(false); // cleaned up after the run

    // Exactly one PR was opened for the branch. The bug itself is OPEN (not closed) and sits in
    // review: it carries its PR ref + stage:in-review, has dropped stage:implementing, and is still
    // claimed by the operator. Closing happens only when the PR merges.
    const bug = await beads.show(repo, bugId);
    expect(bug.status).not.toBe("closed");
    expect(bug.external_ref).toBe("gh-42");
    expect(bug.labels ?? []).toContain("stage:in-review");
    expect(bug.labels ?? []).not.toContain("stage:implementing");
    expect(deriveStage(bug)).toBe("in-review");
    expect(bug.assignee).toBe("test-operator");

    // The branch was pushed and carries a commit for the bug.
    const remoteBranches = execFileSync("git", ["-C", repo, "ls-remote", "--heads", "origin"], {
      encoding: "utf8",
    });
    expect(remoteBranches).toContain(`refs/heads/anton/${bugId}`);
    const log = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/anton/${bugId}`], {
      encoding: "utf8",
    });
    expect(log).toContain(`${bugId}:`);

    // Exactly one execute session for the single ticket.
    const sessions = (await tdb.db.select().from(schema.sessions)).filter(
      (s) => s.beadId === bugId,
    );
    expect(sessions).toHaveLength(1);
  }, 60_000);

  it("standalone PR-step failure: stays OPEN + in-review, then resumes at the PR step without re-running claude", async () => {
    // anton-cmz review (both threads): a standalone is never closed by execute-epic — it stays
    // OPEN + stage:in-review + PR ref until its PR merges. If push/`gh pr create` fails AFTER the
    // ticket work is committed, the bead must NOT land in Done (a false green) and the committed
    // work must NOT be redone on the next attempt. runTicket moves the bead to stage:in-review the
    // moment it commits, which serves both as the honest board state (in review, not Done) and as
    // the persisted resume marker: the retry skips the ticket loop and resumes at the PR step.
    const bugId = await beads.create(repo, {
      title: "PR step will fail",
      type: "bug",
      acceptance: "work file exists",
      description: "## Goal\nProve resume-at-PR.",
    });
    await beads.approve(repo, bugId);

    // Fake gh that fails outright — `gh pr create` (and `gh pr view`) exit non-zero, so
    // openPullRequest throws after the branch is pushed and the ticket work is committed.
    const failingGh = writeBin(binDir, "gh-fail", `console.error('gh boom');process.exit(1);`);
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = failingGh;

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
        payload: { projectId, epicBeadId: bugId },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      // Attempt 1: the run failed at the PR step.
      const run1 = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === bugId)!;
      expect(run1.status).toBe("failed");

      // The bead is NOT closed and carries no PR ref — it did not silently land in Done. Its
      // committed work moved it to in-review (the resume marker), so it reads as in review, not Done.
      const bug1 = await beads.show(repo, bugId);
      expect(bug1.status).not.toBe("closed");
      expect(bug1.external_ref ?? null).toBeNull();
      expect(deriveStage(bug1)).toBe("in-review");
      expect(bug1.labels ?? []).not.toContain("stage:implementing");
      const sessionsAfter1 = (await tdb.db.select().from(schema.sessions)).filter(
        (s) => s.beadId === bugId,
      );
      expect(sessionsAfter1).toHaveLength(1);

      // Resume with a working gh. The retry must skip the already-committed ticket (resume marker)
      // and pick up at the PR step — no second claude session, one PR opened.
      process.env.ANTON_GH_BIN = okGh;
      await park(tdb.db, clock, jobId, "test: simulate resume");
      expect(await resumeJob(tdb.db, clock, jobId)).toBe(true);
      await runner.tickOnce();
      await runner.whenIdle();

      // Attempt 2: the run finished and the PR opened onto the still-open, in-review bead. The
      // failed attempt-1 run row remains (findOpenRunForEpic ignores failed runs, so the resume
      // starts a fresh run), so assert a done run exists rather than picking one arbitrarily.
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      const runsForBug = (await tdb.db.select().from(schema.runs)).filter(
        (r) => r.epicBeadId === bugId,
      );
      expect(runsForBug.some((r) => r.status === "done")).toBe(true);
      const bug2 = await beads.show(repo, bugId);
      expect(bug2.status).not.toBe("closed"); // closes only when the PR merges
      expect(bug2.external_ref).toBe("gh-42");
      expect(deriveStage(bug2)).toBe("in-review");

      // Claude was NOT re-run: still exactly one execute session for the bug.
      const sessionsAfter2 = (await tdb.db.select().from(schema.sessions)).filter(
        (s) => s.beadId === bugId,
      );
      expect(sessionsAfter2).toHaveLength(1);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      process.env.ANTON_CLAUDE_BIN = successClaude;
      // Park so a later clock-advancing tick in another test can't re-dispatch this job.
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  }, 60_000);

  it("a retry after another run already opened the PR completes idempotently — no duplicate/empty PR", async () => {
    // anton-jz1 review: a losing machine's job parks on the winner's live run-lease (or a lost
    // publish race) and reschedules; when the winner finishes and clears its lease, the loser
    // retries. By then the epic is already in-review with its PR opened + external ref stamped, so
    // re-running would re-enter the PR step and create a duplicate/empty PR (or park on a `gh "a
    // pull request already exists"` failure). The handler must instead revalidate the target still
    // needs execution and, seeing the external ref, finish the attempt as done without touching gh.
    const bugId = await beads.create(repo, {
      title: "Covered by another run",
      type: "bug",
      acceptance: "work file exists",
      description: "## Goal\nProve idempotent completion.",
    });
    await beads.approve(repo, bugId);

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    // Attempt 1: a normal run carries the bug to in-review (PR opened, external ref stamped).
    process.env.ANTON_CLAUDE_BIN = successClaude;
    const job1 = await runner.enqueue({
      type: "execute-epic",
      projectId,
      payload: { projectId, epicBeadId: bugId },
    });
    await runner.tickOnce();
    await runner.whenIdle();
    expect((await getJob(tdb.db, job1))?.status).toBe("done");
    const covered = await beads.show(repo, bugId);
    expect(covered.external_ref).toBe("gh-42");
    const sessionsAfter1 = (await tdb.db.select().from(schema.sessions)).filter(
      (s) => s.beadId === bugId,
    );
    expect(sessionsAfter1).toHaveLength(1);

    // Attempt 2: a SECOND job for the same target (the losing machine's retry after the lease
    // cleared). Point gh at a binary that reports the PR OPEN (its real state — attempt 1 opened it)
    // so the revalidation short-circuits on a confirmed-live ref; `pr create` booms so a wrongful
    // fall-through to the PR step would throw and fail the job instead of short-circuiting.
    const openGh = writeBin(
      binDir,
      "gh-open-jz1",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.stdout.write(JSON.stringify({state:'OPEN',url:'https://github.com/acme/repo/pull/42',number:42})+'\\n');process.exit(0);}
if(a[0]==='pr'&&a[1]==='create'){console.error('gh boom: must not reach PR step');process.exit(1);}
process.exit(0);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = openGh;
    try {
      const job2 = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: bugId },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      // The retry completed (not failed/parked) without invoking gh: the external ref is unchanged
      // and no second claude session ran — the covered work was not redone.
      expect((await getJob(tdb.db, job2))?.status).toBe("done");
      const run2 = (await tdb.db.select().from(schema.runs))
        .filter((r) => r.epicBeadId === bugId)
        .find((r) => r.id !== undefined && r.status === "done" && r.worktreePath === null);
      expect(run2).toBeTruthy(); // the retry's run row settled done without ever warming a worktree
      const after2 = await beads.show(repo, bugId);
      expect(after2.external_ref).toBe("gh-42"); // not overwritten / re-opened
      const sessionsAfter2 = (await tdb.db.select().from(schema.sessions)).filter(
        (s) => s.beadId === bugId,
      );
      expect(sessionsAfter2).toHaveLength(1); // claude was NOT re-run
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }
  }, 60_000);

  it("clears its OWN leftover run-lease on the external-ref short-circuit (crash after PR, before cleanup)", async () => {
    // anton-jz1 review (thread PRRT_kwDOTWcq8c6SAdZu): a run that crashed AFTER stamping the external
    // ref but BEFORE its `finally` cleared the run-lease leaves an unexpired `run-lease:…:<runId>` on
    // the board. On resume, findOpenRunForEpic returns the SAME run row (same runId), so the target
    // still carries this run's own lease. The idempotent external-ref short-circuit returns before the
    // general lease-adoption step, so it must sweep that own lease itself — otherwise other machines
    // keep seeing the epic as live until the 15-minute TTL even though its PR is already open.
    const bugId = await beads.create(repo, {
      title: "Crashed after PR",
      type: "bug",
      acceptance: "work file exists",
      description: "## Goal\nProve the own-lease sweep on the idempotent path.",
    });
    await beads.approve(repo, bugId);

    // Simulate the crashed prior attempt: a still-"running" run row (so it resumes rather than
    // starting fresh), the external ref already stamped, and this run's own unexpired lease still on
    // the board — the exact "died between setExternalRef and finally" state.
    const runId = randomUUID();
    await createRun(tdb.db, clock, {
      id: runId,
      projectId,
      epicBeadId: bugId,
      branch: `anton/${bugId}`,
      status: "running",
    });
    const leaseExp = clock.now() + 15 * 60_000;
    await beads.publishRunLease(repo, bugId, leaseExp, [], runId);
    await beads.setExternalRef(repo, bugId, "gh-77");
    await beads.sync(repo); // land both on the remote so the handler's pull can't clobber them
    expect(beads.ownRunLeaseLabels(await beads.show(repo, bugId), runId)).toHaveLength(1);

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    // gh reports the PR OPEN — the real state after a crash that stamped the ref (the PR was opened
    // first) — so the short-circuit legitimately proves completion and finishes the attempt as done.
    // `pr create` booms: if the handler wrongly fell through to the PR step it would throw instead.
    const openGh = writeBin(
      binDir,
      "gh-open-lease",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.stdout.write(JSON.stringify({state:'OPEN',url:'https://github.com/acme/repo/pull/77',number:77})+'\\n');process.exit(0);}
if(a[0]==='pr'&&a[1]==='create'){console.error('gh boom: must not reach PR step');process.exit(1);}
process.exit(0);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = openGh;
    try {
      const job = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: bugId },
      });
      await runner.tickOnce();
      await runner.whenIdle();
      expect((await getJob(tdb.db, job))?.status).toBe("done");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }

    // The resumed run's row settled done, and its own lease was swept — no lingering run-lease keeps
    // the epic looking live to other machines. External ref untouched (not re-opened).
    const settled = (await tdb.db.select().from(schema.runs)).find((r) => r.id === runId);
    expect(settled?.status).toBe("done");
    const after = await beads.show(repo, bugId);
    expect(beads.runLeaseLabels(after)).toEqual([]);
    expect(after.external_ref).toBe("gh-77");
  }, 60_000);

  it("retries (does not false-complete) when a target's PR ref state can't be read", async () => {
    // anton-jz1 review (thread PRRT_kwDOTWcq8c6SBg3n): a set external_ref only proves completion when
    // its PR is confirmed OPEN or MERGED. An UNKNOWN state (gh down / unparseable ref) is proof of
    // nothing — treating it as done would strand a genuinely-closed epic that a retry could recover.
    // The handler must retry on unknown rather than mark the run done, leaving the ref intact. Unlike a
    // foreign lease (RunAlreadyLiveError, refunded forever), an unreadable ref is a COUNTING error: a
    // transient gh outage self-heals within the retry budget, a permanent one exhausts attempts and
    // parks for a human (PRRT_kwDOTWcq8c6SB5Ja) rather than retrying indefinitely.
    const bugId = await beads.create(repo, {
      title: "Unreadable PR state",
      type: "bug",
      acceptance: "work file exists",
      description: "## Goal\nProve unknown PR state parks instead of false-completing.",
    });
    await beads.approve(repo, bugId);
    await beads.setExternalRef(repo, bugId, "gh-88");
    await beads.sync(repo);

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    // gh fails outright → pullRequestState reports "unknown". The run must park, not short-circuit
    // to done; `pr create` would also boom, so a wrongful fall-through to the PR step can't pass.
    const failingGh = writeBin(binDir, "gh-unknown-jz1", `console.error('gh boom');process.exit(1);`);
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = failingGh;
    try {
      const job = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: bugId },
      });
      await runner.tickOnce();
      await runner.whenIdle();
      // Counting error → the job is rescheduled for retry (attempt spent), NOT done.
      expect((await getJob(tdb.db, job))?.status).not.toBe("done");
      // The run row settled as failed (a counting failure, not the parked run-live-elsewhere class),
      // and the ref is untouched. Repeated unreadable attempts exhaust the budget and park the job.
      const runsForBug = (await tdb.db.select().from(schema.runs)).filter(
        (r) => r.epicBeadId === bugId,
      );
      expect(runsForBug.some((r) => r.status === "failed")).toBe(true);
      expect(runsForBug.some((r) => r.status === "done")).toBe(false);
      expect((await beads.show(repo, bugId)).external_ref).toBe("gh-88");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }
  }, 60_000);

  it("restores an epic's stage:in-review on the external-ref short-circuit (crash after ref, before stage update)", async () => {
    // anton-jz1 review (thread PRRT_kwDOTWcq8c6SBg3m): an epic run that crashed AFTER setExternalRef
    // (step 5) but BEFORE the stage updates at the tail of step 5 leaves the epic on stage:implementing
    // with no stage:in-review. review-fix sweeps only stage:in-review targets, so a resume that
    // short-circuits to done must re-apply in-review (and drop implementing) or the PR is silently
    // dropped from automated review. Unlike a standalone (which gets in-review from runTicket on
    // commit), the epic acquires it only after the ref, so this window is epic-specific.
    const epicId = await beads.create(repo, {
      title: "Epic crashed before in-review",
      type: "epic",
      description: "## Goal\nProve in-review restoration on the epic short-circuit.",
    });
    const childRaw = execFileSync(
      "bd",
      ["create", "Only child", "--type", "task", "--parent", epicId, "--acceptance", "x", "--json"],
      { cwd: repo, encoding: "utf8" },
    );
    const childId = (() => {
      const p = JSON.parse(childRaw);
      const b = Array.isArray(p) ? p[0] : (p.issue ?? p);
      return b.id as string;
    })();
    await beads.approve(repo, epicId);

    // Simulate the crashed prior attempt: the child committed + closed, the PR ref stamped, and the
    // epic still on stage:implementing (step 2's tag) with in-review NEVER applied — plus a still
    // "running" run row so this resumes rather than starting fresh.
    await beads.close(repo, childId);
    await beads.tag(repo, epicId, ["stage:implementing"]);
    await beads.setExternalRef(repo, epicId, "gh-55");
    const runId = randomUUID();
    await createRun(tdb.db, clock, {
      id: runId,
      projectId,
      epicBeadId: epicId,
      branch: `anton/${epicId}`,
      status: "running",
    });
    await beads.sync(repo);

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    // gh reports the PR OPEN (its real state after the crash); `pr create` booms so a wrongful
    // fall-through to the PR step would throw instead of short-circuiting.
    const openGh = writeBin(
      binDir,
      "gh-open-epic-jz1",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.stdout.write(JSON.stringify({state:'OPEN',url:'https://github.com/acme/repo/pull/55',number:55})+'\\n');process.exit(0);}
if(a[0]==='pr'&&a[1]==='create'){console.error('gh boom: must not reach PR step');process.exit(1);}
process.exit(0);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = openGh;
    try {
      const job = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epicId },
      });
      await runner.tickOnce();
      await runner.whenIdle();
      expect((await getJob(tdb.db, job))?.status).toBe("done");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }

    // The short-circuit finished done AND repaired the board: the epic now carries stage:in-review,
    // has dropped stage:implementing, and reads as in-review so review-fix's sweep will pick it up.
    const epic = await beads.show(repo, epicId);
    expect(epic.labels ?? []).toContain("stage:in-review");
    expect(epic.labels ?? []).not.toContain("stage:implementing");
    expect(deriveStage(epic)).toBe("in-review");
    expect(epic.external_ref).toBe("gh-55");
  }, 60_000);

  it("recovers a target whose external-ref PR was CLOSED without merging — re-opens instead of a false-done short-circuit", async () => {
    // anton-jz1 review (thread PRRT_kwDOTWcq8c6SAsC0): when a PR is closed WITHOUT merging, review-fix
    // leaves the bead in-review with its external_ref intact so a Run/Force run can recover it. The
    // external-ref short-circuit must NOT treat that stale ref as proof another run finished: doing so
    // marks the new run done and returns before the PR step, stranding the bead on the dead PR. The
    // handler must instead check the PR state and, seeing it CLOSED, fall through and re-open the PR.
    const bugId = await beads.create(repo, {
      title: "PR closed without merging",
      type: "bug",
      acceptance: "work file exists",
      description: "## Goal\nProve stale-ref recovery.",
    });
    await beads.approve(repo, bugId);

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    // Attempt 1: a normal run carries the bug to in-review (PR opened at gh-42, external ref stamped).
    process.env.ANTON_CLAUDE_BIN = successClaude;
    const job1 = await runner.enqueue({
      type: "execute-epic",
      projectId,
      payload: { projectId, epicBeadId: bugId },
    });
    await runner.tickOnce();
    await runner.whenIdle();
    expect((await getJob(tdb.db, job1))?.status).toBe("done");
    expect((await beads.show(repo, bugId)).external_ref).toBe("gh-42");
    const sessionsAfter1 = (await tdb.db.select().from(schema.sessions)).filter(
      (s) => s.beadId === bugId,
    );
    expect(sessionsAfter1).toHaveLength(1);

    // Attempt 2: the operator Force-runs the recovery after the PR was closed unmerged. Point gh at a
    // fake that reports every PR CLOSED (so `pullRequestState` sees a stale ref and the PR-reuse check
    // finds nothing to reuse) and opens a fresh PR at gh-99 on `pr create`.
    const recoverGh = writeBin(
      binDir,
      "gh-recover-jz1",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.stdout.write(JSON.stringify({state:'CLOSED'})+'\\n');process.exit(0);}
if(a[0]==='pr'&&a[1]==='create'){process.stdout.write('https://github.com/acme/repo/pull/99\\n');process.exit(0);}
process.exit(0);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = recoverGh;
    try {
      const job2 = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: bugId },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      // The recovery run did NOT short-circuit: it re-opened the PR (external ref advanced to gh-99)
      // and finished done, rather than reporting a false completion on the dead gh-42.
      expect((await getJob(tdb.db, job2))?.status).toBe("done");
      expect((await beads.show(repo, bugId)).external_ref).toBe("gh-99");
      // The standalone target is stage:in-review from attempt 1, so its ticket is resume-skipped —
      // claude is not re-run; only the (agent-free) PR step executes on recovery.
      const sessionsAfter2 = (await tdb.db.select().from(schema.sessions)).filter(
        (s) => s.beadId === bugId,
      );
      expect(sessionsAfter2).toHaveLength(1);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }
  }, 60_000);

  it("parks a standalone target blocked by an open prerequisite (readiness gate at job start)", async () => {
    // anton-cmz review: a standalone's blockers aren't in the epic-graph rollup, so the runner
    // derives them from its own `blocks` edges. An open blocker must PARK the run (poison), not
    // execute — the same gate the approve route enforces, re-checked at lease time.
    const blocker = await beads.create(repo, { title: "Runner blocker", type: "task" });
    const dependent = await beads.create(repo, {
      title: "Runner dependent",
      type: "bug",
      acceptance: "x",
    });
    await beads.link(repo, dependent, blocker, "blocks");
    await beads.approve(repo, dependent);

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = successClaude;
    const jobId = await runner.enqueue({
      type: "execute-epic",
      projectId,
      payload: { projectId, epicBeadId: dependent },
    });
    await runner.tickOnce();
    await runner.whenIdle();

    // Poison-parked (blocked target refused), and the bead was never touched (not claimed/closed).
    expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
    const bead = await beads.show(repo, dependent);
    expect(bead.status).not.toBe("closed");
    expect(bead.assignee ?? null).toBeNull();
  }, 60_000);

  it("poison-parks a bead that was found but isn't runnable, with an honest (not 'not found') reason", async () => {
    // anton-cmz.1 AC3: a genuinely non-runnable target (here a non-work `chore` type) must poison
    // with a message that names WHY — the bead WAS found — instead of pretending it doesn't exist.
    const created = JSON.parse(
      execFileSync(
        "bd",
        ["create", "Not a run target", "--type", "chore", "--acceptance", "x", "--json"],
        { cwd: repo, encoding: "utf8" },
      ),
    );
    const choreId = (Array.isArray(created) ? created[0] : (created.issue ?? created)).id as string;
    await beads.approve(repo, choreId);

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = successClaude;
    const jobId = await runner.enqueue({
      type: "execute-epic",
      projectId,
      payload: { projectId, epicBeadId: choreId },
    });
    await runner.tickOnce();
    await runner.whenIdle();

    // Poison → job parked; the reason names the bead and the type, not "not found".
    const job = await getJob(tdb.db, jobId);
    expect(job?.status).toBe("parked");
    expect(job?.lastError).toContain(choreId);
    expect(job?.lastError).toMatch(/not runnable/i);
    expect(job?.lastError).not.toMatch(/not found/i);
    // Pre-flight gate: no run row created.
    expect(
      (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === choreId),
    ).toBeUndefined();
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

  it("resumes a transient mid-stream death in-session via claude --resume, completing in one tick (anton-juar)", async () => {
    // A standalone target whose FIRST claude invocation dies mid-stream transiently (emits the
    // system-init session id, then "Connection closed mid-response" on stderr, exit 1, NO result
    // event, NO file change). The driver surfaces a RecoverableClaudeError carrying the init session
    // id; runTicket resumes IN-SESSION with `claude --resume <id>` (no job reschedule), and the
    // second invocation succeeds + commits. Proves: the same session id is resumed (argv recorded),
    // the whole run completes in a single tick, and the session row persisted the Claude session id.
    const target = await beads.create(repo, {
      title: "Resilient recovery target",
      type: "task",
      description: "## Goal\nProve in-session resume.",
      acceptance: "work file exists",
    });
    await beads.approve(repo, target);

    const argvLog = join(sandbox, "resume-argv.jsonl");
    // Counting claude: invocation 1 dies transiently (mid-stream, no result); invocation 2+ succeed.
    // The counter lives in the worktree, shared across both invocations of the same runTicket loop.
    const resumeClaude = writeBin(
      binDir,
      "claude-resume",
      `const fs=require('fs');const path=require('path');
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
fs.appendFileSync(${JSON.stringify(argvLog)},JSON.stringify({resume:get('--resume')})+'\\n');
const counter=path.join(process.cwd(),'.resume-count');
let n=0;try{n=parseInt(fs.readFileSync(counter,'utf8'),10)||0;}catch(e){}
n+=1;fs.writeFileSync(counter,String(n));
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'s4'});
if(n===1){process.stderr.write('API Error: Connection closed mid-response\\n');process.exit(1);}
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+n+'\\n');
e({type:'assistant',message:{content:[{type:'text',text:'done'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'s4',num_turns:1,is_error:false});
process.exit(0);`,
    );

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = resumeClaude;
    try {
      const jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: target },
      });

      // A single tick completes: the transient death is recovered in-session, not by a job retry.
      await runner.tickOnce();
      await runner.whenIdle();

      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("done");
      // Leased exactly once (attempts=1) and never rescheduled: the transient death was recovered
      // in-session, so it consumed NO extra job-level retry (a fresh-restart path would have leased
      // a second time, attempts=2).
      expect(job?.attempts).toBe(1);

      // claude was invoked twice for the one ticket: the first died, the second (a resume) succeeded.
      const argv = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(argv).toHaveLength(2);
      expect(argv[0].resume).toBeUndefined(); // first spawn is fresh
      expect(argv[1].resume).toBe("s4"); // retry resumes the SAME captured session id

      // The Claude session id was persisted on the session row (from the init event on failure,
      // then confirmed by the successful result).
      const sessions = (await tdb.db.select().from(schema.sessions)).filter(
        (s) => s.beadId === target,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].claudeSessionId).toBe("s4");

      // The run finished and reached in-review with a PR — a normal successful standalone run.
      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === target)!;
      expect(run.status).toBe("done");
      expect((await beads.show(repo, target)).labels ?? []).toContain("stage:in-review");
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

  it("parks when the epic was taken over by another operator after the run was queued", async () => {
    // Soft-lock at the execution-claim (anton-i71 review): an approved-but-unstarted (backlog) epic
    // can be STOLEN — reassigned to another operator via the approve route — after its execute-epic
    // job was queued but before the runner leased it. The take-over suppresses the new owner's
    // enqueue on the assumption the reservation just moves, but the jobs table is machine-local, so
    // this stale job still sits on the ORIGINAL operator's instance. The runner must NOT run under
    // the new owner's reservation; it parks (poison, recoverable) and leaves the steal intact.
    const epic5 = await beads.create(repo, {
      title: "Feature V",
      type: "epic",
      description: "## Goal\nV",
    });
    await beads.approve(repo, epic5);
    const ticket5 = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "V ticket", "--type", "task", "--parent", epic5, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();
    // Another operator takes it over between enqueue and lease: a backlog reservation sets the
    // assignee without flipping status (bead stays open), exactly what the approve route's steal does.
    await beads.assign(repo, epic5, "thief-operator");

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = successClaude;
    const jobId = await runner.enqueue({
      type: "execute-epic",
      projectId,
      payload: { projectId, epicBeadId: epic5 },
    });
    await runner.tickOnce();
    await runner.whenIdle();

    // Poison → job parked; the reason names the epic and the operator that now owns it.
    const job = await getJob(tdb.db, jobId);
    expect(job?.status).toBe("parked");
    expect(job?.lastError).toContain(epic5);
    expect(job?.lastError).toContain("thief-operator");

    // The take-over is intact (not stolen back to us) and nothing ran under it: the epic never
    // reached in-review and its ticket was never closed under someone else's reservation.
    const epic = await beads.show(repo, epic5);
    expect(epic.assignee).toBe("thief-operator");
    expect(epic.labels ?? []).not.toContain("stage:in-review");
    expect((await beads.show(repo, ticket5)).status).not.toBe("closed");
  }, 60_000);

  it("parks an owned epic when the runner has no operator identity (anton-i71 review)", async () => {
    // Same soft-lock as the take-over above, but the runner can't resolve an operator at all
    // (no ANTON_OPERATOR, no global git user.name) — an older queued job on an unconfigured
    // instance. The no-operator path used to keep a best-effort `safe` claim, which swallows bd's
    // refusal to reassign a foreign bead and would run the epic under the new owner's reservation.
    // With no identity to assert AND an epic now owned by someone, the runner must PARK instead.
    const epic6 = await beads.create(repo, {
      title: "Feature W",
      type: "epic",
      description: "## Goal\nW",
    });
    await beads.approve(repo, epic6);
    const ticket6 = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "W ticket", "--type", "task", "--parent", epic6, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();
    // Another operator owns it before the lease, exactly as in the take-over case.
    await beads.assign(repo, epic6, "thief-operator");

    // Strip this runner of any operator identity: unset ANTON_OPERATOR, point git's global config
    // at /dev/null so `git config --global user.name` resolves nothing, AND unset $USER/$USERNAME
    // so resolveOperator's final osUser() rung misses too → resolveOperator() returns undefined.
    // Restored in `finally` so later tests keep the suite's test-operator.
    const savedOperator = process.env.ANTON_OPERATOR;
    const savedGitGlobal = process.env.GIT_CONFIG_GLOBAL;
    const savedUser = process.env.USER;
    const savedUsername = process.env.USERNAME;
    delete process.env.ANTON_OPERATOR;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    delete process.env.USER;
    delete process.env.USERNAME;
    resetOperatorCache();
    try {
      const runner = new JobRunner({
        db: tdb.db,
        clock,
        config: { maxConcurrent: 1, leaseMs: 30_000 },
      });
      runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

      process.env.ANTON_CLAUDE_BIN = successClaude;
      const jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epic6 },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      // Poison → job parked; the reason names the epic and the operator that now owns it.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toContain(epic6);
      expect(job?.lastError).toContain("thief-operator");

      // The owner's reservation is intact and nothing ran under it.
      const epic = await beads.show(repo, epic6);
      expect(epic.assignee).toBe("thief-operator");
      expect(epic.labels ?? []).not.toContain("stage:in-review");
      expect((await beads.show(repo, ticket6)).status).not.toBe("closed");
    } finally {
      if (savedOperator === undefined) delete process.env.ANTON_OPERATOR;
      else process.env.ANTON_OPERATOR = savedOperator;
      if (savedGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGitGlobal;
      if (savedUser === undefined) delete process.env.USER;
      else process.env.USER = savedUser;
      if (savedUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = savedUsername;
      resetOperatorCache();
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

  it("parks a run whose epic became blocked after approval, then completes it once unblocked", async () => {
    // TOCTOU gate (mirrors the approval route's 409): an epic can be approved + enqueued while
    // ready, then a cross-epic `blocks` edge appears (added or pulled via Dolt sync on a shared
    // board) before the queued job is leased. The handler re-checks readiness at job start and
    // PARKS a still-blocked epic instead of starting it out of sequence. Recoverable: closing the
    // blocker + resuming re-reads beads, passes the gate, and completes the epic.
    const dependent = await beads.create(repo, {
      title: "Dependent epic",
      type: "epic",
      description: "## Goal\nD",
    });
    await beads.approve(repo, dependent);
    const blocker = await beads.create(repo, { title: "Blocker epic", type: "epic" });
    const child = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "Dependent ticket", "--type", "task", "--parent", dependent, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();
    // Direct epic→epic block: `dependent` is blocked by `blocker` while `blocker` isn't done.
    await beads.link(repo, dependent, blocker, "blocks");

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    const jobId = await runner.enqueue({
      type: "execute-epic",
      projectId,
      payload: { projectId, epicBeadId: dependent },
    });
    await runner.tickOnce();
    await runner.whenIdle();

    // Poison → job parked immediately (no retry burn) with a reason naming the open blocker.
    const job = await getJob(tdb.db, jobId);
    expect(job?.status).toBe("parked");
    expect(job?.lastError).toContain(blocker);
    expect(job?.lastError).toMatch(/blocked by/i);

    // The gate is pre-flight — it runs before any run/claim/worktree work (like the not-approved
    // and no-tickets gates), so no run row is created and the epic's ticket is never claimed.
    expect(
      (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === dependent),
    ).toBeUndefined();
    const t = await beads.show(repo, child);
    expect(t.status).toBe("open");
    expect(t.assignee ?? null).toBeNull();

    // Close the blocker → it rolls up as done → resume → the dependent epic completes normally.
    await beads.close(repo, blocker);
    expect(await resumeJob(tdb.db, clock, jobId)).toBe(true);
    await runner.tickOnce();
    await runner.whenIdle();
    expect((await getJob(tdb.db, jobId))?.status).toBe("done");
    expect((await beads.show(repo, child)).status).toBe("closed");
    expect((await beads.show(repo, dependent)).labels ?? []).toContain("stage:in-review");
  }, 60_000);

  it("blocks a zero-diff ticket, halts the epic, and never closes or dispatches downstream (issue #46 root cause #1)", async () => {
    // A clean agent exit that leaves NO diff delivered nothing — the false-success in issue #46.
    // The run must NOT close the ticket: it blocks it (with an operator note, not a silent re-queue
    // to open), records the no-delivery reason, and halts the epic so downstream tickets are never
    // dispatched. This project has no verify gates so the zero-diff commit path is what's exercised
    // (a failing test gate is a different, already-covered failure). The "changes → committed →
    // closed" path stays green via the suite's first test.
    const noGateProjectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: noGateProjectId,
      slug: "sandbox-nogate",
      name: "sandbox-nogate",
      repoPath: repo,
      defaultBranch: "main",
      settingsJson: JSON.stringify({}), // no testCommand → no verify gates
    });

    const epicNd = await beads.create(repo, {
      title: "No-delivery epic",
      type: "epic",
      description: "## Goal\nND",
    });
    await beads.approve(repo, epicNd);
    const mkNd = (title: string) => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", title, "--type", "task", "--parent", epicNd, "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    };
    const nd1 = mkNd("ND ticket one");
    const nd2 = mkNd("ND ticket two");

    // A claude that exits cleanly (is_error:false) but makes NO change → zero diff → no delivery.
    // Logs each ticket it's invoked for so we can prove the epic halts before ticket two.
    const invLog = join(sandbox, "nodelivery-inv.jsonl");
    const noopClaude = writeBin(
      binDir,
      "claude-noop",
      `const fs=require('fs');
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
const prompt=get('-p')||'';const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(invLog)},(m?m[1]:'unknown')+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'snd'});
e({type:'assistant',message:{content:[{type:'text',text:'nothing to do'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'snd',num_turns:1,is_error:false});
process.exit(0);`,
    );

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    process.env.ANTON_CLAUDE_BIN = noopClaude;
    let jobId: string;
    try {
      jobId = await runner.enqueue({
        type: "execute-epic",
        projectId: noGateProjectId,
        payload: { projectId: noGateProjectId, epicBeadId: epicNd },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      // Poison → job parked immediately (no retry burn). The reason is recorded on the run row and
      // on the parked job's lastError — visible in the UI/logs.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toMatch(/no delivery/i);
      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epicNd)!;
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/no delivery/i);

      // Exactly one ticket was dispatched: the run halted on the no-delivery ticket rather than
      // proceeding to the next one.
      const invoked = readFileSync(invLog, "utf8").trim().split("\n").filter(Boolean);
      expect(invoked).toHaveLength(1);
      const blockedId = invoked[0];
      const skippedId = blockedId === nd1 ? nd2 : nd1;

      // The dispatched ticket is BLOCKED (not closed, not silently re-queued to open) and unclaimed.
      const blocked = await beads.show(repo, blockedId);
      expect(blocked.status).toBe("blocked");
      expect(blocked.assignee ?? null).toBeNull();
      expect(blocked.labels ?? []).not.toContain("stage:implementing");

      // The downstream ticket was never dispatched — still open, never claimed or closed.
      const skipped = await beads.show(repo, skippedId);
      expect(skipped.status).toBe("open");
      expect(skipped.assignee ?? null).toBeNull();

      // No PR was opened and the epic never advanced to in-review — nothing landed.
      const epic = await beads.show(repo, epicNd);
      expect(epic.external_ref ?? null).toBeNull();
      expect(epic.labels ?? []).not.toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  }, 60_000);

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
      `const fs=require('fs');const path=require('path');
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
const prompt=get('-p')||'';const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(invLog)},(m?m[1]:'unknown')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'partial '+Date.now()+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'ssb'});
e({type:'assistant',message:{content:[{type:'text',text:'made partial progress'}]}});
e({type:'result',subtype:'success',result:'Partial progress only.\\nANTON-RESULT: blocked — acceptance criteria contradict the existing API',session_id:'ssb',num_turns:1,is_error:false});
process.exit(0);`,
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
      expect(epic.external_ref ?? null).toBeNull();
      expect(epic.labels ?? []).not.toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);
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
  }, 60_000);

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
      expect(epic.external_ref ?? null).toBeNull();
      expect(epic.labels ?? []).not.toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  }, 90_000);
});
