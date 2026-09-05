/**
 * The incident itself, end to end (anton-rhrk / anton-0gm2) — a feature shaped with NO ordering at
 * all, dispatched once, finishing once.
 *
 * The sibling case in `execute-epic.dep-missing.integration.test.ts` pins the mechanism: one block
 * naming a ticket the run holds re-orders instead of parking. What is pinned HERE is the shape the
 * incident actually came in — a whole feature nobody drew edges for, where the ordering is
 * discovered ticket by ticket as the agents hit it, TWICE inside one run. The claim is the one the
 * incident disproved:
 *
 *   • the run finishes in ONE attempt — every ticket closed, one PR's worth of work, no second
 *     dispatch of the job and no resume;
 *   • the edges anton drew are on the board, and the run honoured them: each prerequisite ran
 *     before the ticket that named it, which is what "re-order" has to mean to be worth anything;
 *   • NOTHING is recorded as a failure — no failed or parked run row, no job error — so the
 *     consecutive-failure breaker does not advance. That is the whole incident: three runs parked
 *     on their own work in a row and disarmed autopilot, and the breaker is armed here at its
 *     harshest setting (one failure trips it) to prove this run gives it nothing to count.
 *
 * The outside-prerequisite path — a block naming work this run does not carry, which is a genuine
 * wait — is the dep-missing suite's, and nothing here asserts about it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { beads } from "../beads/bd";
import { parseTicketNotes } from "../beads/notes";
import { indexBoard } from "../gardener/board-index";
import { activeDisarm } from "../autopilot-disarm";
import * as schema_ from "../db/schema";
import { getJob } from "./queue";
import { checkFailureStreak } from "./picker-failure-breaker";
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
  enqueueEpicJob,
  tickToIdle,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";
import { insertProject } from "@/lib/testing/project";

/** What the fake claude records about the run as it goes — the dispatch story, in order. */
interface AgentLedger {
  /** Tickets that reported `dep-missing`, in the order they did. */
  blocked: string[];
  /** The sibling each of those named, positionally paired with {@link blocked}. */
  prereqs: string[];
  /** Every ticket that actually delivered, in dispatch order. */
  delivered: string[];
}

describeBd("execute-epic e2e — a feature shaped with no ordering, run once (anton-rhrk)", () => {
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let ctx: ExecuteEpicSandbox;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ repo, binDir, tdb, clock } = ctx);
    // ARMED at `apply` for `dep-missing` (R5.3 ships `shadow`), and the failure breaker set to its
    // harshest: ONE failure disarms this project. Nothing about this run may reach it.
    projectId = insertProject(tdb.db, {
      slug: "sandbox-unordered",
      name: "sandbox-unordered",
      repoPath: repo,
      settingsJson: JSON.stringify({
        reviewEnabled: false,
        repairAutonomy: { "dep-missing": "apply" },
        autopilotFailureStreak: 1,
      }),
    });
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

  /** Does the board record `blocker` as a direct blocker of `target`? */
  async function edgeExists(target: string, blocker: string): Promise<boolean> {
    const board = await beads.list(repo, ["--status", "all"]);
    return indexBoard(board).recordsBlocker(target, blocker);
  }

  /**
   * A claude that DISCOVERS the ordering the shaper never wrote down.
   *
   * The rule is stated over the run's own dispatch order rather than over fixed ids, because which
   * child bd hands back first is not something this test may depend on: a ticket reports
   * `dep-missing` naming a sibling that has not run yet, unless it has already blocked once (the
   * repair's one-per-bead-per-class guard) or is itself the prerequisite somebody else named. Every
   * other dispatch delivers. That yields exactly two blocks in whatever order bd chooses — and
   * never a chain, which is a different shape than the one this case is about.
   */
  function discoveringClaude(name: string, ids: string[], ledgerPath: string): string {
    return writeBin(
      binDir,
      name,
      fakeClaudeReadingStdin(`const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'suf'});
const ids=${JSON.stringify(ids)};
const ledgerPath=${JSON.stringify(ledgerPath)};
const mine=(prompt.match(/Ticket: (\\S+)/)||[])[1];
const led=fs.existsSync(ledgerPath)?JSON.parse(fs.readFileSync(ledgerPath,'utf8')):{blocked:[],prereqs:[],delivered:[]};
const save=()=>fs.writeFileSync(ledgerPath,JSON.stringify(led));
const deliver=()=>{
  led.delivered.push(mine);save();
  fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+mine+' '+Date.now()+'\\n');
  e({type:'result',subtype:'success',result:'done',session_id:'suf',num_turns:1,is_error:false});
  process.exit(0);
};
const prereq=ids.filter(id=>id!==mine&&!led.prereqs.includes(id)&&!led.delivered.includes(id)).pop();
if(!mine||led.blocked.includes(mine)||led.prereqs.includes(mine)||!prereq)deliver();
led.blocked.push(mine);led.prereqs.push(prereq);save();
e({type:'result',subtype:'success',result:'ANTON-RESULT: blocked — dep-missing — the schema '+prereq+' adds has to land before this can be wired up',session_id:'suf',num_turns:1,is_error:false});
process.exit(0);`),
    );
  }

  it("finishes in one attempt, drawing the edges as it goes, with no failure to count", async () => {
    const feature = await beads.create(repo, {
      title: "The reporting feature",
      type: "feature",
      acceptance: "it renders",
      description: "## Goal\nShip reporting.\n\n## Acceptance\nIt renders.",
    });
    await beads.approve(repo, feature);
    // Three tickets, no `blocks` edge anywhere — the board as an un-ordered shaping leaves it. Two
    // real orderings exist in the work; only the agents know about them.
    const ids = [
      "Wire the reports page up",
      "Expose the reports API",
      "Add the reports schema",
    ].map((title) => createTicket(repo, { title, parent: feature }));

    const ledgerPath = join(ctx.sandbox, "unordered-ledger.json");
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = discoveringClaude("claude-unordered", ids, ledgerPath);
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: feature });
      expect(await tickToIdle(runner)).toBe(1);

      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as AgentLedger;
      // The run really did hit the incident twice — two agents stopped on an ordering the board did
      // not carry. Without this the rest of the case could pass on a run that never blocked at all.
      expect(ledger.blocked).toHaveLength(2);

      // ONE attempt. The job was leased once and finished; nothing was retried, parked or resumed.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("done");
      expect(job?.attempts).toBe(1);
      expect(job?.lastError ?? null).toBeNull();

      // One run row, done, with no error on it — and no OTHER row: a park and its resume would show
      // up here as the second half of a story this run is not supposed to have.
      const runRows = await tdb.db.select().from(schema_.runs);
      expect(runRows).toHaveLength(1);
      expect(runRows[0].status).toBe("done");
      expect(runRows[0].error ?? null).toBeNull();

      // The whole feature shipped: every ticket dispatched exactly once beyond the block it
      // reported, and every one of them closed.
      expect(ledger.delivered).toHaveLength(ids.length);
      expect(new Set(ledger.delivered)).toEqual(new Set(ids));
      for (const id of ids) expect((await beads.show(repo, id)).status).toBe("closed");

      for (const [i, blocked] of ledger.blocked.entries()) {
        const prereq = ledger.prereqs[i];
        // The ordering anton drew is on the board — the same edge a park would have recorded.
        expect(await edgeExists(blocked, prereq)).toBe(true);

        // …and the run OBEYED it rather than merely writing it down: the prerequisite was
        // dispatched and delivered before the ticket that named it came back round.
        expect(ledger.delivered.indexOf(prereq)).toBeLessThan(ledger.delivered.indexOf(blocked));

        // The bead says what happened, so a re-order is as legible after the fact as a park was.
        const notes = parseTicketNotes((await beads.show(repo, blocked)).notes)
          .filter((n) => n.source === "system")
          .map((n) => n.text);
        const account = notes.find((t) => t.includes("re-ordered, not parked"));
        expect(account).toBeDefined();
        expect(account).toContain(prereq);
      }

      // THE INCIDENT'S OWN MEASURE. The breaker is armed at a threshold of one, and it still has
      // nothing to latch on: no failed or parked run means no streak, so autopilot stays armed
      // where three parked runs in a row disarmed it.
      const board = await beads.list(repo, ["--status", "all"]);
      expect(await checkFailureStreak(tdb.db, clock, { projectId, board })).toBeUndefined();
      expect(await activeDisarm(tdb.db, projectId)).toBeUndefined();
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });
});
