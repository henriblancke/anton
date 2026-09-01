/**
 * End-to-end proof of anton-mv70's fourth criterion: a HUMAN-ONLY TICKET inside an otherwise
 * ordinary run becomes a gate at its own boundary — the run stops there instead of the agent
 * improvising around a credential, a purchase or a signature.
 *
 * This is the half no claimable-set exclusion can reach. The claimable thing is the FEATURE, and a
 * feature that is perfectly good agent work can carry one child only a person can do. Left
 * unhandled that child took one of two bad exits: with no agents allowlist persisted it dispatched
 * to the DEFAULT agent (`agent:human` resolves to no specialist prompt), and with any allowlist
 * persisted it read as a disabled bundled agent and poison-parked the WHOLE feature pointing at a
 * Settings toggle that cannot exist — killing its independent siblings with it.
 *
 * What must happen instead, and what this file pins: one open `human` gate on the ticket, the ready
 * siblings executed to the branch, the dependent tail held, and the run parked at that boundary
 * with no PR. Then the person's answer — do the work, close the ticket, resolve the gate — resumes
 * the run through the existing gate path and the single PR opens.
 *
 * The run target is a FEATURE: bd refuses a gate edge onto an epic, and the gate here sits on a
 * TICKET, which is what makes the partial hold expressible at all.
 *
 * Drives the REAL handler + runner + bd/git with fake `claude`/`gh`. Skipped without bd + git.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beads, gateReason, LABELS, type Gate } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import * as schema from "../db/schema";
import { getJob, park, resumeJob } from "./queue";
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
  tickToIdle,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

describeBd("execute-epic e2e — a human ticket inside a run (real handler · real bd/git)", () => {
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

  /** The open gates blocking `beadId`, read off the board's own `blocks` edges. */
  const gatesBlocking = async (beadId: string): Promise<Gate[]> => {
    const board = await loadAllIssues(repo);
    const blocking = new Set(
      (board.find((b) => b.id === beadId)?.dependencies ?? [])
        .filter((d) => d.type === "blocks")
        .map((d) => d.depends_on_id),
    );
    return (await beads.gateList(repo)).filter((g) => blocking.has(g.id));
  };

  /** A claude that records which ticket it was dispatched for, then leaves a diff. */
  const loggingClaude = (name: string, log: string) =>
    writeBin(
      binDir,
      name,
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(log)},(m?m[1]:'unknown')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'ht'});
e({type:'result',subtype:'success',result:'done',session_id:'ht',num_turns:1,is_error:false});
process.exit(0);`),
    );

  const dispatched = (log: string): string[] => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  const runFor = async (targetId: string) =>
    (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;

  const HUMAN_TITLE = "Sign the Stripe DPA in the dashboard";

  /**
   * The shape the hold has to tell apart: one sibling nothing holds, the human ticket, and a tail
   * that DEPENDS on it. Three tickets, not four — every extra child is another real bd/git/claude
   * round-trip, and these suites share one 150s ceiling.
   */
  const gatedFeature = async (title: string) => {
    const id = await beads.create(repo, {
      title,
      type: "feature",
      acceptance: "work file exists",
      description: `## Goal\n${title}`,
    });
    await beads.approve(repo, id);
    const ready = createTicket(repo, { title: `${title} — render the table`, parent: id });
    const human = createTicket(repo, {
      title: HUMAN_TITLE,
      parent: id,
      labels: [LABELS.agentHuman],
    });
    const dependent = createTicket(repo, { title: `${title} — wire the live key`, parent: id });
    await beads.link(repo, dependent, human, "blocks");
    return { id, ready, human, dependent };
  };

  it("gates the human ticket, runs its ready siblings, and parks at that boundary", async () => {
    const feature = await gatedFeature("Ship the billing page");

    const log = join(sandbox, "human-ticket-inv.jsonl");
    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = loggingClaude("claude-human-ticket", log);
    let jobId: string | undefined;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: feature.id });

      // EXACTLY ONE gate, on the TICKET (not the feature), `human`, open — and its reason names the
      // ticket and its ask, so the escalation row is actionable without opening the bead.
      const gates = await gatesBlocking(feature.human);
      expect(gates).toHaveLength(1);
      expect(gates[0].await_type).toBe("human");
      expect(gates[0].status).not.toBe("closed");
      expect(gateReason(gates[0])).toContain(`${feature.human} needs a human:`);
      expect(gateReason(gates[0])).toContain(HUMAN_TITLE);
      expect(gateReason(gates[0])).toContain(LABELS.agentHuman);
      // The FEATURE itself carries no gate — the hold is at the ticket's boundary, which is what
      // lets the siblings run at all.
      expect(await gatesBlocking(feature.id)).toHaveLength(0);

      // The ready sibling ran and committed; the human ticket and its dependent tail did not.
      const invoked = dispatched(log);
      expect(invoked).toContain(feature.ready);
      expect(invoked).not.toContain(feature.human);
      expect(invoked).not.toContain(feature.dependent);
      expect((await beads.show(repo, feature.ready)).status).toBe("closed");

      // Nothing about the human ticket may read as delivered: still open, and its run reservation
      // handed back.
      const heldHuman = await beads.show(repo, feature.human);
      expect(heldHuman.status).toBe("open");
      expect(heldHuman.assignee ?? null).toBeNull();
      expect((await beads.show(repo, feature.dependent)).status).toBe("open");

      // The run parked at the boundary — no PR, not in review — and its record says a PERSON is
      // what it waits on, naming the gate that releases it.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toContain(feature.human);
      expect(job?.lastError).toContain(feature.dependent);
      expect(job?.lastError).toContain(`bd gate resolve ${gates[0].id}`);
      expect((await runFor(feature.id)).status).toBe("parked");
      const parkedTarget = await beads.show(repo, feature.id);
      expect(beads.getPrRef(parkedTarget) ?? null).toBeNull();
      expect(parkedTarget.labels ?? []).not.toContain("stage:in-review");

      // RE-ENTRY adds no second wait. Two human gates is a wait resolving cannot end: the park names
      // one, and closing it leaves the ticket blocked by the other forever.
      expect(await resumeJob(tdb.db, clock, jobId)).toBe(true);
      await tickToIdle(runner);
      expect((await gatesBlocking(feature.human)).map((g) => g.id)).toEqual([gates[0].id]);
      // …and re-entry never re-dispatched the sibling it already committed.
      expect(dispatched(log).filter((id) => id === feature.ready)).toHaveLength(1);
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("resumes through the existing gate path once the person answers, and opens the one PR", async () => {
    const feature = await gatedFeature("Ship the invoices page");

    const log = join(sandbox, "human-ticket-resume-inv.jsonl");
    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = loggingClaude("claude-human-ticket-resume", log);
    let jobId: string | undefined;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: feature.id });
      const gate = (await gatesBlocking(feature.human))[0];
      expect(gate).toBeDefined();

      // A person cannot close the ticket themselves while the wait stands — bd refuses to close a
      // bead an open gate blocks — so the resolve IS the whole answer, exactly as the gate's own
      // reason says.
      await expect(beads.close(repo, feature.human)).rejects.toThrow(/blocked by open issues/);
      await beads.gateResolve(repo, gate.id, "signed — countersigned copy filed");
      expect(await resumeJob(tdb.db, clock, jobId)).toBe(true);
      await tickToIdle(runner);

      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      const invoked = dispatched(log);
      expect(invoked).toContain(feature.dependent);
      // anton closes the answered ticket and NEVER regenerates it. Without the close the resumed run
      // would find it open and still human and arm the same ask again — a loop no answer ends; and
      // a person's work leaves no commit, so the cross-machine resume check ("closed but nothing on
      // this branch") would otherwise reopen it and hand it to the default agent.
      expect(invoked).not.toContain(feature.human);
      expect((await beads.show(repo, feature.human)).status).toBe("closed");

      // The tail ran into the SAME branch and the single PR opened.
      const done = await beads.show(repo, feature.id);
      expect(done.labels ?? []).toContain("stage:in-review");
      expect(beads.getPrRef(done) ?? null).not.toBeNull();
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("parks before any dispatch when EVERY ticket is human work — no worktree, no agent", async () => {
    // The other side of the same rule. A feature that is entirely a person's to do has nothing for
    // an agent to start, so it must be refused pre-flight rather than opening a run that can only
    // deliver an empty diff. The park names the gates AND their asks — a wait on a person read as a
    // plain "blocked by g-…" is the one blocker no amount of waiting clears.
    const feature = await beads.create(repo, {
      title: "Stand up the vendor account",
      type: "feature",
      acceptance: "work file exists",
      description: "## Goal\nVendor",
    });
    await beads.approve(repo, feature);
    const buy = createTicket(repo, {
      title: "Buy the Business plan",
      parent: feature,
      labels: [LABELS.agentHuman],
    });
    const sign = createTicket(repo, {
      title: "Sign the order form",
      parent: feature,
      labels: [LABELS.agentHuman],
    });

    const log = join(sandbox, "all-human-inv.jsonl");
    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = loggingClaude("claude-all-human", log);
    let jobId: string | undefined;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: feature });

      // One gate each, on the tickets themselves.
      expect(await gatesBlocking(buy)).toHaveLength(1);
      expect(await gatesBlocking(sign)).toHaveLength(1);

      // No agent ran, and the tickets are untouched — no claim, no close, no PR.
      expect(dispatched(log)).toEqual([]);
      expect((await beads.show(repo, buy)).status).toBe("open");
      expect((await beads.show(repo, sign)).status).toBe("open");
      expect(beads.getPrRef(await beads.show(repo, feature)) ?? null).toBeNull();

      // Parked (poison, recoverable) with the ask in it, not a bare blocker id.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toMatch(/is a human gate, not work in flight/);
      expect(job?.lastError).toContain("Buy the Business plan");
      expect(job?.lastError).toContain("bd gate resolve");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });
});
