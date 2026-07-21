/**
 * End-to-end proof of the epic's acceptance criterion: "approved epics run autonomously →
 * worktree → PR → in-review." Drives the REAL execute-epic handler + REAL job runner + REAL bd
 * and git against a temp repo with a bare `origin`, using fake `claude` / `gh` binaries so the
 * pipeline is exercised deterministically without spending API quota. Skipped without bd + git.
 *
 * This is the "lifecycle" slice of `execute-epic.integration.test.ts` — the base happy-path run,
 * the standalone (epic-of-one) variant, and PR-step resume/idempotency cases — split out so it
 * runs in parallel with its sibling `execute-epic.*.integration.test.ts` files (anton-0oi).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, park, resumeJob } from "./queue";
import { createRun } from "../runs";
import { JobRunner } from "./runner";
import { makeExecuteEpicHandler } from "./execute-epic";
import { deriveStage } from "../ticket-view";
import { resetOperatorCache } from "../operator";
import { describeBd } from "@/lib/testing/integration";
import {
  BASE_TIME_MS,
  HUMAN_NOTE,
  FakeClock,
  writeBin,
  createExecuteEpicSandbox,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

describeBd("execute-epic e2e — lifecycle (real handler · real bd/git · fake claude/gh)", () => {
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let projectId: string;
  let epicId: string;
  let t1: string;
  let t2: string;
  let successClaude: string;
  let ctx: ExecuteEpicSandbox;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ sandbox, repo, binDir, tdb, clock, projectId, epicId, t1, t2, successClaude } = ctx);
  });

  afterAll(() => {
    ctx?.restoreEnv();
    resetOperatorCache();
    ctx?.cleanup();
  });

  // These cases share one DB and one clock (the sandbox + bd repo are expensive to build per test),
  // so without a reset they leak into each other (anton-0oi). Two concrete leaks this closes:
  // a case that jumps the clock past a usage-limit reset leaves it there, which retroactively makes
  // every earlier retry-pending job *due*; and with `maxConcurrent: 1` the next `tickOnce()` then
  // leases one of those leftovers instead of the job the case just enqueued, so its own job sits at
  // `queued` and the assertions read the wrong state.
  beforeEach(async () => {
    clock.set(BASE_TIME_MS);
    await tdb.db.delete(schema.jobs);
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
      .map((l) => JSON.parse(l) as { prompt?: string; append?: string; argv?: string[] });
    const forTicket = (id: string) => invocations.find((v) => v.prompt?.includes(id))!;

    for (const id of [t1, t2]) {
      const inv = forTicket(id);
      // The task prompt arrived on stdin, the system prompt via --append-system-prompt-file.
      expect(inv.append).toContain("operating contract"); // locked base
      expect(inv.append).toContain("bd remember"); // learnings requirement
      expect(inv.append).toContain("SEED_MARKER_QZX"); // operator seed layered in
      // Neither the ticket prompt nor the composed system prompt is on argv — the whole point of
      // anton-14tj is that `ps` reveals no bead/contract text. The system prompt reaches claude by
      // file path, not inline (`--append-system-prompt` is never used).
      const joinedArgv = (inv.argv ?? []).join(" ");
      expect(joinedArgv).not.toContain(id); // no ticket id / prompt body on the command line
      expect(joinedArgv).not.toContain("operating contract"); // no system-prompt body on argv
      expect(inv.argv ?? []).not.toContain("--append-system-prompt");
      expect(inv.argv ?? []).toContain("--append-system-prompt-file");
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
  });

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
  });

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
      // The failed attempt was requeued for retry (queued, future runAt), not left running — so this
      // park must be asserted, not fire-and-forget. It silently no-oped before anton-0oi, which made
      // the resumeJob below return false and wedged every later case in this file.
      expect(await park(tdb.db, clock, jobId, "test: simulate resume")).toBe(true);
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
  });

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
  });

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
  });

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
  });

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
  });
});
