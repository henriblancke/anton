/**
 * End-to-end proof of the epic's acceptance criterion: "approved epics run autonomously →
 * worktree → PR → in-review." Drives the REAL execute-epic handler + REAL job runner + REAL bd
 * and git against a temp repo with a bare `origin`, using fake `claude` / `gh` binaries so the
 * pipeline is exercised deterministically without spending API quota. Skipped without bd + git.
 *
 * This is the "usage-limit & in-session resume" slice of `execute-epic.integration.test.ts` —
 * usage-limit parking + same-run resume, dead-claim release on a failed run, and in-session
 * transient-death resume — split out so it runs in parallel with its sibling
 * `execute-epic.*.integration.test.ts` files (anton-0oi).
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
  FakeClock,
  writeBin,
  createExecuteEpicSandbox,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

describeBd("execute-epic e2e — usage-limit & in-session resume (real handler · real bd/git · fake claude/gh)", () => {
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
  });

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
  });

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
  });
});
