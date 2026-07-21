/**
 * End-to-end proof of the epic's acceptance criterion: "approved epics run autonomously →
 * worktree → PR → in-review." Drives the REAL execute-epic handler + REAL job runner + REAL bd
 * and git against a temp repo with a bare `origin`, using fake `claude` / `gh` binaries so the
 * pipeline is exercised deterministically without spending API quota. Skipped without bd + git.
 *
 * This is the "recovery & readiness" slice of `execute-epic.integration.test.ts` — stale-PR
 * recovery, readiness/runnability gates at job start, and usage-limit resume with closed-ticket
 * skipping — split out so it runs in parallel with its sibling `execute-epic.*.integration.test.ts`
 * files (anton-0oi).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob } from "./queue";
import { JobRunner } from "./runner";
import { makeExecuteEpicHandler } from "./execute-epic";
import { resetOperatorCache } from "../operator";
import { describeBd } from "@/lib/testing/integration";
import {
  BASE_TIME_MS,
  FakeClock,
  writeBin,
  fakeClaudeReadingStdin,
  createExecuteEpicSandbox,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

describeBd("execute-epic e2e — recovery & readiness (real handler · real bd/git · fake claude/gh)", () => {
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
    await tdb.db.delete(schema.jobs);
  });

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
  });

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
  });

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
  });

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
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);const ticket=m?m[1]:'unknown';
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
process.exit(0);`),
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
  // Three full run phases (run → park → clock jump → resume → run) of real bd/git work; its
  // honest cost is ~60-90s, above the 60s the rest of this file uses (anton-0oi).
  });
});
