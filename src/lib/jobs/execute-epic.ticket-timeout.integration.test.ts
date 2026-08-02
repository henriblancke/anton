/**
 * End-to-end proof of the PER-TICKET budget (anton-t1mo): a ticket that can't converge is stopped
 * on its own, and the feature it belongs to still ships.
 *
 * The failure this replaces: the only wall clock was per JOB, so a long feature was killed mid-
 * ticket the moment the job's budget ran out — the tickets behind it never ran at all, the aborted
 * ticket's half-written edits stayed in the worktree, and the NEXT attempt's commit swept them up
 * under the wrong ticket's name. Three properties, none of them visible to a unit test:
 *
 * 1. **A timed-out ticket is blocked alone.** It gets its own board state + note; every other
 *    ticket in the feature still runs, and the run still opens its PR.
 * 2. **Its partial work is rolled back.** What the agent left half-written never reaches the branch,
 *    so no later ticket can commit it as its own.
 * 3. **A feature where EVERY ticket times out parks.** Absorbing the timeouts is only honest while
 *    something landed; an empty PR is the false success the delivery gate already refuses.
 *
 * Drives the REAL handler + runner + bd/git with fake `claude`/`gh`. Skipped without bd + git.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, park } from "./queue";
import { resetOperatorCache } from "../operator";
import { describeBd } from "@/lib/testing/integration";
import {
  BASE_TIME_MS,
  resetPerCaseState,
  FakeClock,
  writeBin,
  fakeClaudeReadingStdin,
  createExecuteEpicSandbox,
  createTicket,
  makeEpicRunner,
  driveEpicRun,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

describeBd("execute-epic e2e — the per-ticket budget (real handler · real bd/git · fake claude/gh)", () => {
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

  /** Merge a settings patch into the sandbox project's settingsJson. */
  const patchSettings = async (patch: Record<string, unknown>) => {
    const proj = (
      await tdb.db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    )[0];
    const base = JSON.parse(proj.settingsJson ?? "{}") as Record<string, unknown>;
    await tdb.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ ...base, ...patch }) })
      .where(eq(schema.projects.id, projectId));
  };

  /** An approved epic with two independent tickets — enough for "one stalls, one ships". */
  const approvedEpic = async (title: string) => {
    const id = await beads.create(repo, {
      title,
      type: "epic",
      acceptance: "work file exists",
      description: `## Goal\n${title}`,
    });
    await beads.approve(repo, id);
    const one = createTicket(repo, { title: `${title} ticket one`, parent: id });
    const two = createTicket(repo, { title: `${title} ticket two`, parent: id });
    return { id, one, two };
  };

  /**
   * A claude that leaves half-written work in the tree and then never finishes — the shape of a
   * ticket that can't converge (an endpoint that never answers, a loop on a gate). `only` limits the
   * stall to the FIRST ticket dispatched; without it every ticket stalls.
   *
   * The partial file is deliberately named apart from the success path's `AGENT_WORK.md`: the
   * rollback assertion is that THIS file never reaches the branch while that one does.
   */
  const hangingClaude = (name: string, invLog: string, only: "first" | "always") =>
    writeBin(
      binDir,
      name,
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);
const id=m?m[1]:'unknown';
fs.appendFileSync(${JSON.stringify(invLog)},id+'\\n');
const nth=fs.readFileSync(${JSON.stringify(invLog)},'utf8').trim().split('\\n').filter(Boolean).length;
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(${only === "always" ? "true" : "nth===1"}){
  fs.appendFileSync(path.join(process.cwd(),'HALF_WRITTEN.md'),'partial '+id+'\\n');
  e({type:'system',subtype:'init',session_id:'hang'});
  setInterval(()=>{},1000); // never exits — only the ticket budget can stop it
  return;
}
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+id+'\\n');
e({type:'system',subtype:'init',session_id:'ok'});
e({type:'assistant',message:{content:[{type:'text',text:'implemented the ticket'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'ok',num_turns:1,is_error:false});
process.exit(0);`),
    );

  /** Every path in the run's branch at its tip. */
  const filesOnBranch = (branch: string): string[] =>
    execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", branch], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);

  it("blocks the ticket that ran out of time, rolls its work back, and ships the rest of the feature", async () => {
    const epic = await approvedEpic("Budgeted");
    const invLog = join(sandbox, "budget-inv.jsonl");
    const claude = hangingClaude("claude-hang-first", invLog, "first");

    // 15 minutes of fake wall clock — long enough that the SECOND (fast) ticket can never trip it
    // on a loaded box, short enough that the stalled first ticket is stopped inside the suite's
    // 60s budget. The stall is infinite, so the case measures the budget, not the agent.
    await patchSettings({ ticketTimeoutMinutes: 0.25 });

    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = claude;
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: epic.id });

      // BOTH tickets were dispatched — the stall did not end the feature.
      const invoked = readFileSync(invLog, "utf8").trim().split("\n").filter(Boolean);
      expect(invoked).toHaveLength(2);
      const [stalledId, shippedId] = invoked;

      // The job SUCCEEDED: a ticket that ran out of time is not a run failure.
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epic.id)!;
      expect(run.status).toBe("done");
      // …but the run says what it could not deliver, naming the ticket.
      expect(run.error).toMatch(/ran out of time/i);
      expect(run.error).toContain(stalledId);

      // The stalled ticket: blocked (never closed), unclaimed, no implementing label, and carrying
      // an operator note that says what happened and what to do about it.
      const stalled = await beads.show(repo, stalledId);
      expect(stalled.status).toBe("blocked");
      expect(stalled.assignee ?? null).toBeNull();
      expect(stalled.labels ?? []).not.toContain("stage:implementing");
      expect(JSON.stringify(stalled)).toMatch(/outlived its budget/i);

      // The other ticket ran to completion, exactly as it would have without the stall.
      expect((await beads.show(repo, shippedId)).status).toBe("closed");

      // The feature still reached a human: PR opened, target moved to in-review.
      const target = await beads.show(repo, epic.id);
      expect(beads.getPrRef(target) ?? null).not.toBeNull();
      expect(target.labels ?? []).toContain("stage:in-review");

      // ROLLBACK: the stalled ticket's half-written file is on no commit — only the ticket that
      // actually finished is on the branch. Without the rollback, `HALF_WRITTEN.md` would ride into
      // the next ticket's commit and into the PR, attributed to work that never happened.
      const files = filesOnBranch(run.branch!);
      expect(files).not.toContain("HALF_WRITTEN.md");
      expect(files).toContain("AGENT_WORK.md");

      // The reason is on the session log too, for anyone tailing or replaying the run.
      const session = (await tdb.db.select().from(schema.sessions)).find(
        (s) => s.beadId === stalledId,
      )!;
      expect(readFileSync(session.logPath!, "utf8")).toContain("[ticket-timeout]");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      await patchSettings({ ticketTimeoutMinutes: undefined });
    }
  });

  it("parks the run when EVERY ticket runs out of time — no empty PR", async () => {
    const epic = await approvedEpic("AllStalled");
    const invLog = join(sandbox, "all-stalled-inv.jsonl");
    const claude = hangingClaude("claude-hang-always", invLog, "always");

    // Both tickets stall, so the budget is spent twice — keep it short.
    await patchSettings({ ticketTimeoutMinutes: 0.1 });

    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = claude;
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: epic.id });

      // Nothing landed → poison park for a human, not a PR that delivers nothing.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toMatch(/every ticket .* ran out of time/i);

      const target = await beads.show(repo, epic.id);
      expect(beads.getPrRef(target) ?? null).toBeNull();
      expect(target.labels ?? []).not.toContain("stage:in-review");
      for (const t of [epic.one, epic.two]) {
        expect((await beads.show(repo, t)).status).toBe("blocked");
      }
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      await patchSettings({ ticketTimeoutMinutes: undefined });
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });
});
