/**
 * End-to-end proof of the epic's acceptance criterion: "approved epics run autonomously →
 * worktree → PR → in-review." Drives the REAL execute-epic handler + REAL job runner + REAL bd
 * and git against a temp repo with a bare `origin`, using fake `claude` / `gh` binaries so the
 * pipeline is exercised deterministically without spending API quota. Skipped without bd + git.
 *
 * This is the "claims & gating" slice of `execute-epic.integration.test.ts` — foreign-claim /
 * takeover / no-operator-identity soft locks, the disabled-agent allowlist gate, the
 * approval-time blocker TOCTOU gate, and the zero-diff no-delivery gate — split out so it runs
 * in parallel with its sibling `execute-epic.*.integration.test.ts` files (anton-0oi).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, park, resumeJob } from "./queue";
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
  createExecuteEpicSandbox,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

describeBd("execute-epic e2e — claims & gating (real handler · real bd/git · fake claude/gh)", () => {
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let projectId: string;
  let successClaude: string;
  let ctx: ExecuteEpicSandbox;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ sandbox, repo, binDir, tdb, clock, projectId, successClaude } = ctx);
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
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(invLog)},(m?m[1]:'unknown')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'result',subtype:'success',result:'done',session_id:'sg',num_turns:1,is_error:false});
process.exit(0);`),
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
  });

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
  });

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
  });

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
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(invLog)},(m?m[1]:'unknown')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'result',subtype:'success',result:'done',session_id:'sa',num_turns:1,is_error:false});
process.exit(0);`),
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
  });

  it("never gates the project's own .claude/agents — a user agent runs despite the allowlist (anton-dvo.1 reversal)", async () => {
    // The allowlist gates anton's bundled specialists only. A ticket labeled with a user agent
    // (a `.claude/agents/<id>.md` in the project checkout) must run even when the allowlist omits
    // it — the operator brought that agent deliberately. This proves execute-epic resolves the
    // user-agent set from discoverAgents(repo) and exempts it from the gate.
    mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "agents", "prompt-engineer.md"),
      "---\nname: prompt-engineer\ndescription: user agent\n---\nBe a great prompt engineer.\n",
    );

    const epicU = await beads.create(repo, {
      title: "Feature U",
      type: "epic",
      description: "## Goal\nU",
    });
    await beads.approve(repo, epicU);
    const userTicket = (() => {
      const p = JSON.parse(
        execFileSync(
          "bd",
          ["create", "User-agent ticket", "--type", "task", "--parent", epicU, "--labels", "agent:prompt-engineer", "--acceptance", "x", "--json"],
          { cwd: repo, encoding: "utf8" },
        ),
      );
      return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
    })();

    const [proj] = await tdb.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    const baseSettings = JSON.parse(proj.settingsJson) as Record<string, unknown>;

    const runner = new JobRunner({
      db: tdb.db,
      clock,
      config: { maxConcurrent: 1, leaseMs: 30_000 },
    });
    runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db: tdb.db, clock }));

    try {
      // Allowlist lists only a bundled agent → prompt-engineer is NOT in it, but it's a user agent,
      // so the gate must let it through rather than park.
      await tdb.db
        .update(schema.projects)
        .set({ settingsJson: JSON.stringify({ ...baseSettings, agents: ["fastapi"] }) })
        .where(eq(schema.projects.id, projectId));

      const jobId = await runner.enqueue({
        type: "execute-epic",
        projectId,
        payload: { projectId, epicBeadId: epicU },
      });
      await runner.tickOnce();
      await runner.whenIdle();

      // Not parked — the epic completed: job done, ticket closed, epic moved to in-review.
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      expect((await beads.show(repo, userTicket)).status).toBe("closed");
      expect((await beads.show(repo, epicU)).labels ?? []).toContain("stage:in-review");
    } finally {
      rmSync(join(repo, ".claude", "agents", "prompt-engineer.md"), { force: true });
      await tdb.db
        .update(schema.projects)
        .set({ settingsJson: JSON.stringify(baseSettings) })
        .where(eq(schema.projects.id, projectId));
    }
  });

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
  });

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
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(invLog)},(m?m[1]:'unknown')+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'snd'});
e({type:'assistant',message:{content:[{type:'text',text:'nothing to do'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'snd',num_turns:1,is_error:false});
process.exit(0);`),
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
  });
});
