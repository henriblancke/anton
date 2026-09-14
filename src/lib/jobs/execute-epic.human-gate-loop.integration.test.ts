/**
 * End-to-end proof of anton-xcie's acceptance — *a run that parks on a human gate can be resumed
 * past it, not restarted* — and of anton-287p.3, which is that proof.
 *
 * The loop is built in two places and nothing exercised them together: execute-epic ARMS the gate
 * and parks the run (anton-287p.2/.4), gate-check RESUMES off the board (anton-286r). Each half has
 * its own suite and each passes alone; what nobody had run is the seam — that the gate one half
 * writes is the gate the other half finds, and that what comes back is the parked attempt rather
 * than a new one.
 *
 * One sandbox, both REAL handlers, real bd/git, fake claude/gh. Every case drives the whole loop:
 *
 *   needs-human → open `human` gate + parked run + parked job → a gate-check pass that resumes
 *   NOTHING (the wait is real, and anton never closes a human gate itself) → `bd gate resolve` →
 *   the next gate-check pass → the SAME run finishes the work.
 *
 * "The same" is asserted on IDENTITY, never on shape: one run row and one execute-epic job row for
 * the target, both still carrying the ids the parked attempt had, on the same branch, with the
 * resumed claude session hanging off both. A fresh dispatch is exactly what those assertions
 * exclude — it would leave two rows of each and start over on a new branch.
 *
 * The two cases differ only in WHO resolved the gate:
 *   1. through anton's own bd seam (`beads.gateResolve`);
 *   2. by a raw `bd gate resolve` subprocess — the command anton printed in the parked run's own
 *      error, lifted out of it verbatim and run the way the founder at a terminal, or another
 *      machine on the shared board, would. No anton code observes that resolve at all, which is the
 *      whole reason gate-check discovers resumes from a BOARD READ and not from a waiter list.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { beads, type Gate } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { resetIssueSnapshots } from "../beads/snapshot";
import * as schema from "../db/schema";
import { GATE_RESUMED_LABEL, makeGateCheckHandler } from "./gate-check";
import { getJob } from "./queue";
import { resetOperatorCache } from "../operator";
import { describeBd } from "@/lib/testing/integration";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
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
  tickToIdle,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";
import type { JobRunner } from "./runner";

describeBd("human-gate loop e2e — park → resolve → resume (real execute-epic + gate-check)", () => {
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let projectId: string;
  let successClaude: string;
  let ctx: ExecuteEpicSandbox;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ repo, binDir, tdb, clock, projectId, successClaude } = ctx);
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

  /** An approved FEATURE run target with one child ticket — the shape bd accepts a gate edge on. */
  const approvedFeature = async (title: string) => {
    const id = await beads.create(repo, {
      title,
      type: "feature",
      acceptance: "work file exists",
      description: `## Goal\n${title}`,
    });
    await beads.approve(repo, id);
    createTicket(repo, { title: `${title} ticket`, parent: id });
    return id;
  };

  /** A claude that leaves a diff behind and then ends its final message with an ask for a human. */
  const askingClaude = (name: string, ask: string) =>
    writeBin(
      binDir,
      name,
      fakeClaudeReadingStdin(`fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'partial '+Date.now()+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const text='I got as far as I could.\\n\\nANTON-RESULT: needs-human — '+${JSON.stringify(ask)};
e({type:'system',subtype:'init',session_id:'ask'});
e({type:'assistant',message:{content:[{type:'text',text}]}});
e({type:'result',subtype:'success',result:text,session_id:'ask',num_turns:1,is_error:false});
process.exit(0);`),
    );

  /** The open gates blocking `targetId`, read off the board's own `blocks` edges. */
  const gatesBlocking = async (targetId: string): Promise<Gate[]> => {
    const board = await loadAllIssues(repo);
    const blocking = new Set(
      (board.find((b) => b.id === targetId)?.dependencies ?? [])
        .filter((d) => d.type === "blocks")
        .map((d) => d.depends_on_id),
    );
    return (await beads.gateList(repo, { all: true })).filter((g) => blocking.has(g.id));
  };

  const runsFor = async (targetId: string) =>
    (await tdb.db.select().from(schema.runs)).filter((r) => r.epicBeadId === targetId);

  const epicJobsFor = async (targetId: string) =>
    (await tdb.db.select().from(schema.jobs).where(eq(schema.jobs.type, "execute-epic"))).filter(
      (j) => (JSON.parse(j.payloadJson) as { epicBeadId?: string }).epicBeadId === targetId,
    );

  /**
   * The claude ATTEMPTS on a run — its `execute` sessions. Filtered on kind because a delivered run
   * also carries the worktree-reaper's teardown session (anton-hrun.1), which records what the run
   * handed back rather than an attempt at the work.
   */
  const attemptsOfRun = async (runId: string) =>
    (await tdb.db.select().from(schema.sessions)).filter(
      (s) => s.runId === runId && s.kind === "execute",
    );

  /** One REAL gate-check pass over the sandbox project, on the same db + clock as the runs. */
  const gateCheckPass = () =>
    driveJob({
      db: tdb.db,
      clock,
      type: "gate-check",
      handler: makeGateCheckHandler,
      projectId,
      payload: { projectId },
    });

  /** What the parked attempt owned — every id the resume has to keep rather than replace. */
  interface ParkedRun {
    targetId: string;
    jobId: string;
    runId: string;
    branch: string | null;
    gateId: string;
    /** The run row's park reason, which carries the ask and the command that releases it. */
    error: string;
  }

  /**
   * Drive a target to a human-gate park and return what the resume must preserve. The park itself is
   * anton-287p.2's territory and is asserted only far enough to know the loop starts where it claims.
   */
  async function parkOnHumanGate(runner: JobRunner, title: string, ask: string): Promise<ParkedRun> {
    const targetId = await approvedFeature(title);
    process.env.ANTON_CLAUDE_BIN = askingClaude(`claude-ask-${title.replace(/\W+/g, "-")}`, ask);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }

    const gates = await gatesBlocking(targetId);
    expect(gates).toHaveLength(1);
    expect(gates[0].await_type).toBe("human");
    expect(gates[0].status).toBe("open");

    const runs = await runsFor(targetId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("parked");
    expect(runs[0].endedAt ?? null).toBeNull();
    expect(runs[0].branch).toBeTruthy(); // the branch the resume must continue on, not replace
    expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
    expect(await attemptsOfRun(runs[0].id)).toHaveLength(1); // the one attempt that hit the wall

    return {
      targetId,
      jobId,
      runId: runs[0].id,
      branch: runs[0].branch,
      gateId: gates[0].id,
      error: runs[0].error ?? "",
    };
  }

  /**
   * Assert the pass handed the parked attempt BACK rather than dispatching a new one, then let the
   * execute-epic runner finish it. This is the acceptance in one place: same job row, same run row,
   * same branch, a second session on that run, and the delivery the parked attempt never made —
   * every one of which a fresh dispatch would break.
   */
  async function expectResumedNotRestarted(runner: JobRunner, parked: ParkedRun): Promise<void> {
    // The gate is marked one-shot, so no later pass re-dispatches the same target (a resolved gate
    // stays on its bead forever).
    const gate = (await gatesBlocking(parked.targetId))[0];
    expect(gate.labels ?? []).toContain(GATE_RESUMED_LABEL);

    // The parked JOB is the one that came back — not a sibling enqueued beside it.
    const jobs = await epicJobsFor(parked.targetId);
    expect(jobs.map((j) => j.id)).toEqual([parked.jobId]);
    expect(jobs[0].status).toBe("queued");

    // The runner picks that job up and the handler continues the PARKED run row: one row, same id,
    // same branch, now finished. `findOpenRunForEpic` reusing it is what keeps the worktree/branch.
    expect(await tickToIdle(runner)).toBe(1);
    await expectJobStatus(tdb.db, parked.jobId, "done");

    const runs = await runsFor(parked.targetId);
    expect(runs.map((r) => r.id)).toEqual([parked.runId]);
    expect(runs[0].branch).toBe(parked.branch);
    expect(runs[0].status).toBe("done");

    // Two claude sessions hang off that ONE run row — the attempt that hit the wall and the one
    // that finished, on the same ticket. A restart would have opened its session against a new run.
    const sessions = await attemptsOfRun(parked.runId);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.beadId)).size).toBe(1);

    // …and the work actually landed: the target carries the PR the parked run never opened.
    expect(beads.getPrRef(await beads.show(repo, parked.targetId))).toBe("gh-42");
  }

  /**
   * Finish a delivered target off the board, as a merge would. Housekeeping with a sharp reason: the
   * suite shares one board across cases, and a finished run leaves an OPEN `gh:pr` merge wait, which
   * puts `gh` into the next case's EVALUATE phase (`checkScopes` would scope a `bd gate check --type
   * gh`) — its verdict on a PR that does not exist depends on whether the box has an authenticated
   * `gh`. Closing the target then keeps it out of the next pass's finalization path too. Best-effort:
   * this runs in a `finally`, and a cleanup failure must never mask the case's own.
   */
  async function settleMergeWait(targetId: string): Promise<void> {
    try {
      for (const gate of await gatesBlocking(targetId)) {
        if (beads.isMergeWaitGate(gate) && gate.status === "open") {
          await beads.gateResolve(repo, gate.id, "test cleanup: the PR merged");
        }
      }
      await beads.close(repo, targetId);
    } catch (e) {
      console.error(`[test] could not settle ${targetId}'s merge wait:`, e);
    }
    resetIssueSnapshots();
  }

  it("parks on the ask, resumes the SAME run when the gate is resolved, and finishes the work", async () => {
    const ask = "the sandbox Stripe key (STRIPE_SECRET_KEY_MARKER) is not something I can create";
    const runner = makeEpicRunner(ctx);
    const parked = await parkOnHumanGate(runner, "Needs a key", ask);
    try {
      // A pass while the ask is UNANSWERED must move nothing. anton never closes a human gate — the
      // wait is the founder's, and a pass that resumed here would turn the park into a busy loop.
      await gateCheckPass();
      expect((await gatesBlocking(parked.targetId))[0].status).toBe("open");
      expect((await getJob(tdb.db, parked.jobId))?.status).toBe("parked");
      expect((await runsFor(parked.targetId))[0].status).toBe("parked");

      // The founder answers. Nothing else about the board changes.
      await beads.gateResolve(repo, parked.gateId, "key provisioned");
      resetIssueSnapshots();

      await gateCheckPass();
      await expectResumedNotRestarted(runner, parked);
    } finally {
      await settleMergeWait(parked.targetId);
    }
  });

  it("resumes identically when the gate is resolved OUTSIDE anton — a plain `bd gate resolve`", async () => {
    // The resolve that has to work is the one no anton code takes part in: another machine on the
    // shared board, or the founder in a terminal. So the command is not composed here — it is lifted
    // out of the parked run's own error and run verbatim as a subprocess, which also proves the one
    // instruction anton hands the operator is the one that actually releases the run.
    const ask = "someone has to pick which of the two schemas MARKER_SCHEMA_PICK we keep";
    const runner = makeEpicRunner(ctx);
    const parked = await parkOnHumanGate(runner, "Needs a decision", ask);
    try {
      expect(parked.error).toContain(ask);
      const command = /`bd ([^`]+)`/.exec(parked.error)?.[1];
      expect(command, `no \`bd …\` command in the park reason: ${parked.error}`).toBeDefined();
      expect(command).toBe(`gate resolve ${parked.gateId}`);

      execFileSync("bd", command!.split(" "), { cwd: repo, stdio: "ignore" });
      resetIssueSnapshots();
      expect((await gatesBlocking(parked.targetId))[0].status).toBe("closed");

      // Discovery is the board, so a resolve anton never saw surfaces on the very next pass.
      await gateCheckPass();
      await expectResumedNotRestarted(runner, parked);
    } finally {
      await settleMergeWait(parked.targetId);
    }
  });
});
