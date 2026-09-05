/**
 * The `already-shipped` repair, end to end (anton-5bpd / R5.4, R5.6) — REAL execute-epic handler,
 * REAL job runner, REAL bd and git, a fake claude that delivers nothing for one ticket and does the
 * work for the other.
 *
 * Four claims:
 *   • a VERIFIED claim retires the ticket as superseded — closed, pointing at the bead that shipped
 *     it, with anton's evidence in a note and the repair stamped on the bead;
 *   • THE EPIC CONTINUES: the run walks its remaining tickets, opens its one pull request and
 *     finishes `done`, instead of the poison park a zero-diff block earns today. The target says, in
 *     one place, what that PR therefore does not contain;
 *   • a claim that does NOT verify retires nothing: today's behaviour exactly — poison park, blocked
 *     bead — plus an account of the failed check;
 *   • a project that armed nothing (the shipped `shadow` default) writes no fix: the ticket blocks
 *     and parks the run as before, with a note saying what `apply` would have done.
 *
 * Deliberately its own sandbox, like the sibling repair suites: these cases seed extra beads and
 * settle epic children in ways the shared fixture's own assertions would collide with.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { beads } from "../beads/bd";
import { parseTicketNotes } from "../beads/notes";
import { indexBoard } from "../gardener/board-index";
import { repairFingerprint } from "../gardener/repair";
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
  createTicket,
  makeEpicRunner,
  enqueueEpicJob,
  tickToIdle,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";
import { insertProject } from "@/lib/testing/project";

describeBd("execute-epic e2e — the already-shipped repair (real handler · real bd/git · fake claude)", () => {
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let ctx: ExecuteEpicSandbox;
  let projectId: string;
  let shadowProjectId: string;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ repo, binDir, tdb, clock } = ctx);
    // No verify gates, so what the run stops on is the zero-diff delivery gate and nothing else.
    // ARMED at `apply`: retiring a ticket is an unattended settlement of the founder's work, and the
    // shipped policy is `shadow`, so a project that wants it has to say so (R5.3).
    projectId = insertProject(tdb.db, {
      slug: "sandbox-shipped",
      name: "sandbox-shipped",
      repoPath: repo,
      settingsJson: JSON.stringify({
        reviewEnabled: false,
        repairAutonomy: { "already-shipped": "apply" },
      }),
    });

    // The same repo through a project that armed NOTHING — what every project gets on upgrade.
    shadowProjectId = insertProject(tdb.db, {
      slug: "sandbox-shipped-shadow",
      name: "sandbox-shipped-shadow",
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

  /** A bead that already LANDED — the survivor a verified retirement points at. */
  async function seedShipper(title: string): Promise<string> {
    const id = createTicket(repo, { title });
    await beads.close(repo, id);
    return id;
  }

  /** An approved epic of two independent tickets: one to be retired, one that does real work. */
  async function seedEpic(title: string): Promise<{ epic: string; shipped: string; work: string }> {
    const epic = await beads.create(repo, {
      title,
      type: "epic",
      acceptance: "the feature ships",
      description: "## Goal\nShip it.",
    });
    await beads.approve(repo, epic);
    const shipped = createTicket(repo, { title: `${title} — already done`, parent: epic });
    const work = createTicket(repo, { title: `${title} — still to do`, parent: epic });
    return { epic, shipped, work };
  }

  /**
   * A claude that reports the classified block for ONE ticket and does ordinary work for every
   * other — the wire format `ANTON-RESULT: blocked — <class> — <reason>` (anton-ie05), with the
   * claim named exactly as the agent would name it.
   */
  function shippedClaude(name: string, blockedTicket: string, reason: string): string {
    return writeBin(
      binDir,
      name,
      fakeClaudeReadingStdin(`const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'sas'});
const mine=prompt.includes(${JSON.stringify(blockedTicket)});
if(!mine){fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+' '+Math.random()+'\\n');}
e({type:'assistant',message:{content:[{type:'text',text:mine?'nothing to do here':'done'}]}});
e({type:'result',subtype:'success',result:mine?'ANTON-RESULT: blocked — already-shipped — ${reason}':'ANTON-RESULT: delivered',session_id:'sas',num_turns:1,is_error:false});
process.exit(0);`),
    );
  }

  const systemNotes = (notes: unknown): string[] =>
    parseTicketNotes(notes)
      .filter((n) => n.source === "system")
      .map((n) => n.text);

  it("retires the verified ticket as superseded and CARRIES THE EPIC ON to its pull request", async () => {
    const shipper = await seedShipper("The bead that actually shipped this");
    const { epic, shipped, work } = await seedEpic("Already-shipped epic");
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = shippedClaude(
      "claude-shipped",
      shipped,
      `Already implemented by ${shipper}`,
    );
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: epic });
      expect(await tickToIdle(runner)).toBe(1);

      // NOT parked. A zero-diff block halts the epic today; a verified retirement lets the run walk
      // the rest of its tickets and open the feature's one PR.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("done");
      const runRow = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epic)!;
      expect(runRow.status).toBe("done");

      // The retired ticket: closed, pointing at what replaced it — the `supersedes` edge, not prose.
      const retired = await beads.show(repo, shipped);
      expect(retired.status).toBe("closed");
      expect(beads.isAbandoned(retired)).toBe(false);
      const board = await beads.list(repo, ["--status", "all"]);
      expect(indexBoard(board).recordsSupersedes(shipped, shipper)).toBe(true);

      // The EVIDENCE is on the bead, and it states the limit of what anton checked.
      const notes = systemNotes(retired.notes);
      const evidence = notes.find((t) => t.includes("verified the already-shipped claim"))!;
      expect(evidence).toBeDefined();
      expect(evidence).toContain(shipper);
      expect(evidence).toContain("acceptance criteria");

      // …and the STAMP beside it, so a repeat escalates rather than repairing again (R5.6).
      const stamp = (retired.labels ?? []).find((l) => l.startsWith("repair:already-shipped:"));
      expect(stamp).toContain(repairFingerprint(shipped, "already-shipped"));
      expect(retired.assignee ?? null).toBeNull();
      expect(retired.labels ?? []).not.toContain("stage:implementing");

      // The rest of the feature actually ran and landed.
      expect((await beads.show(repo, work)).status).toBe("closed");

      // The founder reads the TARGET at the merge gate, so it names what this PR does NOT carry.
      const target = await beads.show(repo, epic);
      const notice = systemNotes(target.notes).find((t) => t.includes("had already shipped"))!;
      expect(notice).toContain(shipped);
      expect(notice).toContain(shipper);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  it("retires NOTHING when the claim does not verify: today's park, with the failed check stated", async () => {
    // Named, on the board, and still OPEN with no PR — nothing there says its work landed.
    const notShipped = createTicket(repo, { title: "A bead that has NOT landed" });
    const { epic, shipped } = await seedEpic("Unverifiable claim epic");
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = shippedClaude(
      "claude-shipped-unverified",
      shipped,
      `Already implemented by ${notShipped}`,
    );
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: epic });
      expect(await tickToIdle(runner)).toBe(1);

      expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
      const blocked = await beads.show(repo, shipped);
      expect(blocked.status).toBe("blocked");
      expect((blocked.labels ?? []).some((l) => l.startsWith("repair:"))).toBe(false);

      const board = await beads.list(repo, ["--status", "all"]);
      expect(indexBoard(board).recordsSupersedes(shipped, notShipped)).toBe(false);

      const refusal = systemNotes(blocked.notes).find((t) =>
        t.includes("did not repair this as `already-shipped`"),
      )!;
      expect(refusal).toBeDefined();
      expect(refusal).toContain("nothing there says its work landed");
      expect(refusal.split("\n")).toHaveLength(1);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  it("writes NOTHING on a project that armed nothing — the shipped `shadow` default (R5.3)", async () => {
    const shipper = await seedShipper("The bead that shipped the shadowed one");
    const { epic, shipped } = await seedEpic("Unarmed already-shipped epic");
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = shippedClaude(
      "claude-shipped-shadow",
      shipped,
      `Already implemented by ${shipper}`,
    );
    try {
      const jobId = await enqueueEpicJob(runner, {
        projectId: shadowProjectId,
        epicBeadId: epic,
      });
      expect(await tickToIdle(runner)).toBe(1);

      // The block settles exactly as it did before auto-repair existed: poison park, blocked bead.
      expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
      const blocked = await beads.show(repo, shipped);
      expect(blocked.status).toBe("blocked");

      // Nothing was settled and nothing stamped — a shadow leaves the guard free, so arming the
      // class later still gets its one repair.
      const board = await beads.list(repo, ["--status", "all"]);
      expect(indexBoard(board).recordsSupersedes(shipped, shipper)).toBe(false);
      expect((blocked.labels ?? []).some((l) => l.startsWith("repair:"))).toBe(false);

      // But the record IS there: what `apply` would have written, in the repair's own words.
      const shadow = systemNotes(blocked.notes).find((t) =>
        t.includes("did not repair this as `already-shipped`"),
      )!;
      expect(shadow).toBeDefined();
      expect(shadow).toContain("`shadow`");
      expect(shadow).toContain(`bd supersede ${shipped} --with ${shipper}`);
      expect(shadow.split("\n")).toHaveLength(1);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });
});
