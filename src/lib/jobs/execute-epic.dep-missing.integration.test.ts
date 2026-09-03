/**
 * The `dep-missing` repair, end to end (anton-qg4h / R5.4) — REAL execute-epic handler, REAL job
 * runner, REAL bd and git, a fake claude that delivers nothing and reports the class.
 *
 * Three claims:
 *   • a block whose reason names a bead ON THE BOARD draws the `blocks` edge nobody drew, stamps the
 *     repair with the agent's own reason, and PARKS the target — no retry, because the work cannot
 *     start until the blocker lands;
 *   • the blocker becomes SELECTABLE and the blocked target does not — the whole point of drawing the
 *     edge is that the queue moves on to the thing that was in the way;
 *   • a prerequisite that resolves to NOTHING escalates: no edge, no stamp, today's poison park, and
 *     an account on the bead of why anton refused. The repair records ordering; it never files work.
 *
 * The target is a STANDALONE (parentless) task rather than an epic child, because that is the shape
 * the claimable set answers directly: both ends of the new edge are run targets, so "the blocker is
 * selectable and the target is not" is one `beads.claimableTargets` read rather than an inference.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { beads } from "../beads/bd";
import { parseTicketNotes } from "../beads/notes";
import { indexBoard } from "../gardener/board-index";
import { repairFingerprint } from "../gardener/repair";
import { revertPrereqEdge } from "../gardener/repair-dep-missing";
import * as schema from "../db/schema";
import { getJob } from "./queue";
import { resetOperatorCache } from "../operator";
import { describeBd } from "@/lib/testing/integration";
import {
  BASE_TIME_MS,
  resetPerCaseState,
  FakeClock,
  writeBin,
  fakeClaudeReadingStdin,
  createExecuteEpicSandbox,
  makeEpicRunner,
  enqueueEpicJob,
  tickToIdle,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";
import { insertProject } from "@/lib/testing/project";

describeBd("execute-epic e2e — the dep-missing repair (real handler · real bd/git · fake claude)", () => {
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let ctx: ExecuteEpicSandbox;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ repo, binDir, tdb, clock } = ctx);
    // No verify gates, so what the run stops on is the zero-diff delivery gate and nothing else.
    projectId = insertProject(tdb.db, {
      slug: "sandbox-depmissing",
      name: "sandbox-depmissing",
      repoPath: repo,
      settingsJson: JSON.stringify({ reviewEnabled: false }),
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

  /** An approved, parentless run target — one end of the ordering, whichever end. */
  async function seedTarget(title: string): Promise<string> {
    const id = await beads.create(repo, {
      title,
      type: "task",
      acceptance: "the work lands",
      description: `## Goal\n${title}.\n\n## Context\nnothing moved here.`,
    });
    await beads.approve(repo, id);
    return id;
  }

  /**
   * A claude that changes nothing and reports the classified block, naming `prereq` in its reason —
   * exactly the wire format `ANTON-RESULT: blocked — <class> — <reason>` (anton-ie05).
   */
  function blockedOnClaude(name: string, prereq: string): string {
    const reason = `dep-missing — the schema ${prereq} adds has to land before this can be wired up`;
    return writeBin(
      binDir,
      name,
      fakeClaudeReadingStdin(`const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'sdm'});
e({type:'assistant',message:{content:[{type:'text',text:'nothing I can do until that lands'}]}});
e({type:'result',subtype:'success',result:'ANTON-RESULT: blocked — ${reason}',session_id:'sdm',num_turns:1,is_error:false});
process.exit(0);`),
    );
  }

  /** Does the board record `blocker` as a direct blocker of `target`? */
  async function edgeExists(target: string, blocker: string): Promise<boolean> {
    const board = await beads.list(repo, ["--status", "all"]);
    return indexBoard(board).recordsBlocker(target, blocker);
  }

  const claimableIds = async (): Promise<string[]> =>
    (await beads.claimableTargets(repo)).map((t) => t.bead.id);

  it("draws the edge, parks the target, and leaves the blocker selectable", async () => {
    const prereq = await seedTarget("The schema migration");
    const target = await seedTarget("Wire the reports page up");
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = blockedOnClaude("claude-depmissing", prereq);
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: target });
      expect(await tickToIdle(runner)).toBe(1);

      // PARKED, not retried: the ordering anton just recorded is a wait, and no attempt against
      // this bead can shorten it. The park names the blocker, so run-health reads it as a
      // blocked-by stall rather than a permanent failure.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toContain(`is blocked by ${prereq}`);
      expect(job?.lastError).toContain("anton drew that edge itself");

      // The run row parks too — the resume after the blocker lands continues in this same row.
      const runRow = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === target)!;
      expect(runRow.status).toBe("parked");

      // The edge itself, in the direction bd reads as "the prerequisite blocks the target".
      expect(await edgeExists(target, prereq)).toBe(true);

      // Recorded as a repair: the stamp is the loop guard, the note carries the agent's reason.
      const parked = await beads.show(repo, target);
      const stamp = (parked.labels ?? []).find((l) => l.startsWith("repair:dep-missing:"));
      expect(stamp).toContain(repairFingerprint(target, "dep-missing"));
      const notes = parseTicketNotes(parked.notes)
        .filter((n) => n.source === "system")
        .map((n) => n.text);
      const record = notes.find((t) => t.includes("anton: repaired"))!;
      expect(record).toContain("the schema");
      expect(record).toContain(prereq);

      // Left claimable in STATUS — the edge is what holds it, and a `blocked` bead could never be
      // re-claimed by the resume that follows the blocker landing.
      expect(parked.status).toBe("open");
      expect(parked.assignee ?? null).toBeNull();
      expect(parked.labels ?? []).not.toContain("stage:implementing");

      // …and the queue has moved on to the thing that was in the way: the blocker is selectable,
      // the blocked target is not.
      const claimable = await claimableIds();
      expect(claimable).toContain(prereq);
      expect(claimable).not.toContain(target);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  it("refuses a prerequisite that resolves to no bead: it escalates, on the record", async () => {
    const target = await seedTarget("Wire the exports page up");
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    // A bead id nobody filed. The repair records ordering between beads that exist; it never
    // creates the missing work, so there is nothing here for it to point at.
    process.env.ANTON_CLAUDE_BIN = blockedOnClaude("claude-depghost", "anton-ghost");
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: target });
      expect(await tickToIdle(runner)).toBe(1);

      // Today's behaviour, untouched: poison park on the block's own reason, blocked bead, no edge,
      // no stamp. The one thing that is new is the account of WHY anton did not repair it.
      expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
      const blocked = await beads.show(repo, target);
      expect(blocked.status).toBe("blocked");
      expect((blocked.labels ?? []).some((l) => l.startsWith("repair:"))).toBe(false);
      expect(await edgeExists(target, "anton-ghost")).toBe(false);
      expect((await beads.list(repo, ["--status", "all"])).some((b) => b.id === "anton-ghost")).toBe(
        false,
      );

      const notes = parseTicketNotes(blocked.notes)
        .filter((n) => n.source === "system")
        .map((n) => n.text);
      const refusal = notes.find((t) => t.includes("did not repair this as `dep-missing`"))!;
      expect(refusal).toBeDefined();
      expect(refusal).toContain("holds no such bead");
      expect(refusal.split("\n")).toHaveLength(1);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  it("the edge is reversible — bd takes it back and the target is selectable again", async () => {
    const prereq = await seedTarget("The other schema migration");
    const target = await seedTarget("Wire the settings page up");

    // The edge exactly as the repair writes it, then bd's own undo of that write.
    await beads.link(repo, target, prereq, "blocks");
    expect(await edgeExists(target, prereq)).toBe(true);
    expect(await claimableIds()).not.toContain(target);

    await revertPrereqEdge(repo, target, prereq, "the operator says the ordering is wrong");

    expect(await edgeExists(target, prereq)).toBe(false);
    expect(await claimableIds()).toContain(target);
    const reversed = await beads.show(repo, target);
    const notes = parseTicketNotes(reversed.notes)
      .filter((n) => n.source === "system")
      .map((n) => n.text);
    expect(notes.some((t) => t.includes("removed the `dep-missing` repair's blocks edge"))).toBe(
      true,
    );
  });
});
