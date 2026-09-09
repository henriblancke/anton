/**
 * The `already-shipped` repair, end to end (anton-5bpd / R5.4, R5.6) — REAL execute-epic handler,
 * REAL job runner, REAL bd and git, a fake claude that delivers nothing for one ticket and does the
 * work for the other.
 *
 * Six claims:
 *   • a VERIFIED claim retires the ticket as superseded — closed, pointing at the bead that shipped
 *     it, with anton's evidence in a note and the repair stamped on the bead;
 *   • THE EPIC CONTINUES: the run walks its remaining tickets, opens its one pull request and
 *     finishes `done`, instead of the poison park a zero-diff block earns today. The target says, in
 *     one place, what that PR therefore does not contain;
 *   • a claim that does NOT verify retires nothing: today's behaviour exactly — poison park, blocked
 *     bead — plus an account of the failed check;
 *   • a project that armed nothing (the shipped `shadow` default) writes no fix: the ticket blocks
 *     and parks the run as before, with a note saying what `apply` would have done;
 *   • a RESUME of a run that retired a ticket leaves that ticket retired: a superseded bead is
 *     closed with no commit under its own id on the branch — the shape the cross-machine resume path
 *     reads as "regenerate it here" — so nothing may reopen or re-dispatch it;
 *   • an INTERRUPTED standalone retirement re-settles as the success it was: the terminal verdict is
 *     recovered from the bead's own repair stamp rather than from the ledger the crashed attempt
 *     held in memory — and only from ANTON's stamp, so a supersede a person wrote still parks.
 *
 * Deliberately its own sandbox, like the sibling repair suites: these cases seed extra beads and
 * settle epic children in ways the shared fixture's own assertions would collide with.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
  pushFreshBaseCommit,
  tickToIdle,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";
import { insertProject } from "@/lib/testing/project";

describeBd("execute-epic e2e — the already-shipped repair (real handler · real bd/git · fake claude)", () => {
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let ctx: ExecuteEpicSandbox;
  let projectId: string;
  let shadowProjectId: string;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ sandbox, repo, binDir, tdb, clock } = ctx);
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

  /**
   * A bead that already LANDED — the survivor a verified retirement points at: closed on the board,
   * AND named by a commit the run's base contains (PR #238 review). Closed alone is what an epic's
   * child looks like the moment its run commits, before the feature's PR merges, and the check
   * refuses that.
   */
  async function seedShipper(title: string): Promise<string> {
    const id = createTicket(repo, { title });
    await beads.close(repo, id);
    pushFreshBaseCommit(sandbox, ctx.bare, id);
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
e({type:'result',subtype:'success',result:mine?'ANTON-RESULT: blocked — already-shipped — '+${JSON.stringify(reason)}:'ANTON-RESULT: delivered',session_id:'sas',num_turns:1,is_error:false});
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
      // …and the `not-delivered` marker (PR #238 review): reopened while the PR is in review, the
      // ticket is an open child in no diff, and the marker is what keeps the merge from closing it.
      expect(beads.isNotDelivered(retired)).toBe(true);
      expect(retired.assignee ?? null).toBeNull();
      expect(retired.labels ?? []).not.toContain("stage:implementing");

      // The rest of the feature actually ran and landed.
      expect((await beads.show(repo, work)).status).toBe("closed");

      // The founder reads the TARGET at the merge gate, so it names what this PR does NOT carry.
      const target = await beads.show(repo, epic);
      const notice = systemNotes(target.notes).find((t) => t.includes("had already shipped"))!;
      expect(notice).toContain(shipped);
      expect(notice).toContain(shipper);
      // THIS run checked it, so the notice may say so — the half of the split that earns the claim.
      expect(notice).toContain("anton verified that against the repository");
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  it("parks by PROVENANCE when everything it could dispatch was retired — found beside verified", async () => {
    // One ticket the board ALREADY held as superseded when the run read it (a human's rescope, a
    // gardener dedup, an earlier attempt), one this run verifies and retires itself. Both end up
    // on the ledger, and the park must not put anton's verification behind the first (PR #238
    // review): this run checked nothing about it.
    const shipper = await seedShipper("The bead that shipped both");
    const { epic, shipped, work } = await seedEpic("All-retired epic");
    await beads.supersede(repo, work, shipper);
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = shippedClaude(
      "claude-shipped-all",
      shipped,
      `Already implemented by ${shipper}`,
    );
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: epic });
      expect(await tickToIdle(runner)).toBe(1);

      // Nothing is on the branch, so the run parks rather than open an empty pull request.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      const park = job?.lastError ?? "";
      expect(park).toContain(`every ticket under ${epic} that this run could dispatch was retired`);
      // THIS run verified the one it retired…
      expect(park).toContain(
        `already shipped, verified and closed as superseded (${shipped} → superseded by ${shipper})`,
      );
      // …and only FOUND the other, which it says in as many words.
      expect(park).toContain(
        `already settled as superseded on the board, which this run did not verify ` +
          `(${work} → superseded by ${shipper})`,
      );
      expect(park).not.toMatch(/had ALREADY SHIPPED/);

      // The retirement this run made is real: closed, pointing at the survivor, evidence on it.
      const retired = await beads.show(repo, shipped);
      expect(retired.status).toBe("closed");
      const board = await beads.list(repo, ["--status", "all"]);
      expect(indexBoard(board).recordsSupersedes(shipped, shipper)).toBe(true);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  // A STANDALONE target the run retired itself is FINISHED, not parked (PR #238 review). Every
  // remedy the epic-level park asks for is already done: the target is closed as superseded with
  // anton's evidence on it, nothing was committed, so there is no PR to open and no ticket left to
  // run. Parked, the row settles FAILED and the runner parks the job permanently — a successfully
  // retired target represented as a stuck execution, and one that counts against the breaker.
  it("finishes the run as DONE when the only ticket is a standalone target it retired", async () => {
    const shipper = await seedShipper("The bead that shipped the standalone one");
    const standalone = await beads.create(repo, {
      title: "Standalone already-shipped target",
      type: "bug",
      acceptance: "the fix is in the tree",
      description: "## Goal\nFix it.",
    });
    await beads.approve(repo, standalone);
    const runner = makeEpicRunner(ctx);
    const prevClaude = process.env.ANTON_CLAUDE_BIN;
    const prevGh = process.env.ANTON_GH_BIN;
    process.env.ANTON_CLAUDE_BIN = shippedClaude(
      "claude-shipped-standalone",
      standalone,
      `Already implemented by ${shipper}`,
    );
    // Any `gh pr create` here would be the bug: nothing was committed, so the run must reach its
    // finish without ever opening a pull request.
    const prCalls = join(sandbox, "standalone-pr-calls.txt");
    process.env.ANTON_GH_BIN = writeBin(
      binDir,
      "gh-standalone-retired",
      `const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){console.log('[]');process.exit(0);}
fs.appendFileSync(${JSON.stringify(prCalls)},a.join(' ')+'\\n');
console.log('https://github.com/acme/repo/pull/99');process.exit(0);`,
    );
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: standalone });
      expect(await tickToIdle(runner)).toBe(1);

      // The job and its run are DONE, not parked: nothing is left for a person to decide.
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      const runRow = (await tdb.db.select().from(schema.runs)).find(
        (r) => r.epicBeadId === standalone,
      )!;
      expect(runRow.status).toBe("done");
      expect(existsSync(prCalls)).toBe(false); // no pull request on an empty diff

      // The retirement itself is real: closed as superseded, pointing at the survivor.
      const retired = await beads.show(repo, standalone);
      expect(retired.status).toBe("closed");
      const board = await beads.list(repo, ["--status", "all"]);
      expect(indexBoard(board).recordsSupersedes(standalone, shipper)).toBe(true);

      // …and the row still says what happened, worded for a run that opened no PR.
      expect(runRow.error).toContain("had already shipped");
      expect(runRow.error).toContain("opened no pull request");
    } finally {
      process.env.ANTON_CLAUDE_BIN = prevClaude;
      process.env.ANTON_GH_BIN = prevGh;
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

  it("a RESUME leaves the retired ticket retired — never reopened, never re-dispatched", async () => {
    // A retired ticket is CLOSED with no commit under its own id on this branch (its work shipped
    // under the survivor's) — the same shape an abandoned bead has, and the one the cross-machine
    // resume path reads as "closed elsewhere, regenerate it here". Every ordinary park resumes into
    // that read; this one is a usage limit. Reopened and re-dispatched, the ticket's agent can only
    // report `already-shipped` again, into the repair's own loop guard: the bead ends up
    // open-then-blocked and the feature parks — the exact false stall the retirement exists to end.
    const shipper = await seedShipper("The bead that shipped the resumed one");
    const { epic, shipped, work } = await seedEpic("Resumed already-shipped epic");
    // The retirement has to land BEFORE the park, so the resume is the first attempt that reads a
    // superseded ticket off the board. A `blocks` edge INSIDE the run is ordering rather than a gate
    // (epic-graph's child readiness), so this fixes the dispatch order and nothing else.
    await beads.link(repo, work, shipped, "blocks");

    const resetSec = Math.floor(clock.now() / 1000) + 3600;
    const quotaMark = join(sandbox, "resume-quota-hit");
    const bodyDump = join(sandbox, "resume-pr-body.txt");
    // Retire the first ticket, then hit the usage limit on the second — once. The sentinel lives
    // OUTSIDE the worktree, which the resume reuses, so the second attempt does the work instead.
    const resumeClaude = writeBin(
      binDir,
      "claude-shipped-resume",
      fakeClaudeReadingStdin(`const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(prompt.includes(${JSON.stringify(shipped)})){
e({type:'system',subtype:'init',session_id:'sr1'});
e({type:'assistant',message:{content:[{type:'text',text:'nothing to do here'}]}});
e({type:'result',subtype:'success',result:'ANTON-RESULT: blocked — already-shipped — Already implemented by ${shipper}',session_id:'sr1',num_turns:1,is_error:false});
process.exit(0);}
if(!fs.existsSync(${JSON.stringify(quotaMark)})){
fs.writeFileSync(${JSON.stringify(quotaMark)},'1');
e({type:'result',subtype:'error',result:'Claude AI usage limit reached|${resetSec}',is_error:true});
process.exit(0);}
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+' '+Math.random()+'\\n');
e({type:'system',subtype:'init',session_id:'sr2'});
e({type:'assistant',message:{content:[{type:'text',text:'done'}]}});
e({type:'result',subtype:'success',result:'ANTON-RESULT: delivered',session_id:'sr2',num_turns:1,is_error:false});
process.exit(0);`),
    );
    // Capture the PR body: the retired ticket is in no diff, so it must be in no PR either.
    const bodyGh = writeBin(
      binDir,
      "gh-resume-body",
      `const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){console.log('[]');process.exit(0);}
const i=a.indexOf('--body');if(i>=0){fs.writeFileSync(${JSON.stringify(bodyDump)},a[i+1]);}
console.log('https://github.com/acme/repo/pull/42');process.exit(0);`,
    );

    const sessionsFor = async (id: string) =>
      (await tdb.db.select().from(schema.sessions)).filter((s) => s.beadId === id);
    const runner = makeEpicRunner(ctx, { quotaCooloffMs: 60_000 });
    const prevClaude = process.env.ANTON_CLAUDE_BIN;
    const prevGh = process.env.ANTON_GH_BIN;
    process.env.ANTON_CLAUDE_BIN = resumeClaude;
    process.env.ANTON_GH_BIN = bodyGh;
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: epic });

      // Attempt 1: the ticket is retired, then the usage limit parks the run mid-feature.
      await tickToIdle(runner);
      expect((await getJob(tdb.db, jobId))?.status).toBe("queued"); // rescheduled past the reset
      expect((await beads.show(repo, shipped)).status).toBe("closed");
      expect(await sessionsFor(shipped)).toHaveLength(1);

      // Attempt 2, past the reset window: the SAME run resumes and re-reads the board, where the
      // retired ticket now sits closed with nothing of its own on the branch.
      clock.set(resetSec * 1000 + 1);
      await tickToIdle(runner);
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      const retired = await beads.show(repo, shipped);
      expect(retired.status).toBe("closed"); // not reopened
      expect(retired.assignee ?? null).toBeNull();
      const board = await beads.list(repo, ["--status", "all"]);
      expect(indexBoard(board).recordsSupersedes(shipped, shipper)).toBe(true);
      expect(await sessionsFor(shipped)).toHaveLength(1); // not re-dispatched
      // …and so never repaired a second time into the loop guard that would block it.
      expect(
        (retired.labels ?? []).filter((l) => l.startsWith("repair:already-shipped:")),
      ).toHaveLength(1);

      // The rest of the feature shipped, and the PR speaks for exactly what its diff contains.
      expect((await beads.show(repo, work)).status).toBe("closed");
      const body = readFileSync(bodyDump, "utf8");
      expect(body).toContain(work);
      expect(body).not.toContain(shipped);

      // The retirement survives the resume in the one place the founder reads at the merge gate —
      // but worded for what THIS attempt actually knows (PR #238 review). Attempt 2 rebuilt its
      // ledger from the board, where the supersede was already recorded; it ran no check of its own,
      // so the notice says the ticket was already SETTLED rather than claiming anton verified it.
      // The verification is real — attempt 1 did it — and it lives on the bead, which is where the
      // notice points. The same sentence covers a human's `bd supersede` and a gardener dedup, which
      // anton never verified at all.
      const notes = systemNotes((await beads.show(repo, epic)).notes);
      const notice = notes.find((t) => t.includes("already settled as superseded"))!;
      expect(notice).toContain(shipped);
      expect(notice).toContain(shipper);
      expect(notice).toContain("anton did not verify those");
      expect(notes.some((t) => t.includes("anton verified that against the repository"))).toBe(
        false,
      );
    } finally {
      process.env.ANTON_CLAUDE_BIN = prevClaude;
      process.env.ANTON_GH_BIN = prevGh;
    }
  });
  // A standalone retirement is a SUCCESS, and it has to stay one across a restart (PR #238 review).
  // The terminal verdict is reached from the run's in-memory retirement ledger, so an interruption
  // between the supersede and the run row settling leaves the retirement on the board with nothing
  // in the next attempt's ledger to recognise it by. That attempt cannot reach the verdict anyway:
  // the target is closed and unassigned by then, so the claim gate refuses it first and the run
  // parks — a successfully retired target represented as a stuck execution, counted against the
  // consecutive-failure breaker, telling the operator to reopen a retirement anton made correctly.
  it("re-settles an interrupted standalone retirement as DONE instead of parking on the closed target", async () => {
    const shipper = await seedShipper("The bead that shipped the interrupted one");
    const standalone = await beads.create(repo, {
      title: "Interrupted already-shipped target",
      type: "bug",
      acceptance: "the fix is in the tree",
      description: "## Goal\nFix it.",
    });
    await beads.approve(repo, standalone);
    const runner = makeEpicRunner(ctx);
    const prevClaude = process.env.ANTON_CLAUDE_BIN;
    const prevGh = process.env.ANTON_GH_BIN;
    process.env.ANTON_CLAUDE_BIN = shippedClaude(
      "claude-shipped-interrupted",
      standalone,
      `Already implemented by ${shipper}`,
    );
    const prCalls = join(sandbox, "interrupted-pr-calls.txt");
    process.env.ANTON_GH_BIN = writeBin(
      binDir,
      "gh-interrupted-retired",
      `const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){console.log('[]');process.exit(0);}
fs.appendFileSync(${JSON.stringify(prCalls)},a.join(' ')+'\\n');
console.log('https://github.com/acme/repo/pull/98');process.exit(0);`,
    );
    try {
      // Attempt 1 retires the target and settles the run — the state a crash would have left on the
      // board, minus the row. Then the row is forced back to `running` and the job re-queued, which
      // is exactly what the next attempt finds after an interrupted one: the supersede landed, the
      // run never settled.
      await enqueueEpicJob(runner, { projectId, epicBeadId: standalone });
      expect(await tickToIdle(runner)).toBe(1);
      expect((await beads.show(repo, standalone)).status).toBe("closed");

      const firstRun = (await tdb.db.select().from(schema.runs)).find(
        (r) => r.epicBeadId === standalone,
      )!;
      await tdb.db
        .update(schema.runs)
        .set({ status: "running", endedAt: null, error: null })
        .where(eq(schema.runs.id, firstRun.id));

      const resumeJobId = await enqueueEpicJob(runner, { projectId, epicBeadId: standalone });
      expect(await tickToIdle(runner)).toBe(1);

      // The retry recognises the retirement it made itself and finishes: no park, no PR, no reopen.
      expect((await getJob(tdb.db, resumeJobId))?.status).toBe("done");
      const runs = (await tdb.db.select().from(schema.runs)).filter(
        (r) => r.epicBeadId === standalone,
      );
      expect(runs.every((r) => r.status === "done")).toBe(true);
      expect(existsSync(prCalls)).toBe(false);
      const settled = await beads.show(repo, standalone);
      expect(settled.status).toBe("closed"); // never reopened to be re-run
      const board = await beads.list(repo, ["--status", "all"]);
      expect(indexBoard(board).recordsSupersedes(standalone, shipper)).toBe(true);
      // …and the resumed row says what happened, in the words the uninterrupted run would use.
      const resumed = runs.find((r) => r.id !== firstRun.id) ?? runs[0]!;
      expect(resumed.error).toContain("had already shipped");
      expect(resumed.error).toContain("opened no pull request");
    } finally {
      process.env.ANTON_CLAUDE_BIN = prevClaude;
      process.env.ANTON_GH_BIN = prevGh;
    }
  });

  // The recovery is anton's OWN verified retirement only (PR #238 review). A human's `bd supersede`
  // of a target they decided against reads identically on the bead — closed, with a `supersedes`
  // edge — and finishing a run on it would report a settlement anton never performed as its own
  // success. Only the `already-shipped` repair stamp tells the two apart, so an unstamped supersede
  // falls through to the ordinary walk and parks for the person whose decision it was.
  it("does NOT claim a supersede anton never verified — an unstamped one still parks", async () => {
    const shipper = await seedShipper("The bead a person pointed the standalone one at");
    const standalone = await beads.create(repo, {
      title: "Human-superseded standalone target",
      type: "bug",
      acceptance: "the fix is in the tree",
      description: "## Goal\nFix it.",
    });
    await beads.approve(repo, standalone);
    // A person's decision: superseded on the board, with no repair stamp anywhere on it.
    await beads.supersede(repo, standalone, shipper);
    expect(
      ((await beads.show(repo, standalone)).labels ?? []).some((l) =>
        l.startsWith("repair:already-shipped:"),
      ),
    ).toBe(false);

    const runner = makeEpicRunner(ctx);
    const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: standalone });
    await tickToIdle(runner);

    // Parked for the person who made the call — never reported as a run anton finished.
    expect((await getJob(tdb.db, jobId))?.status).not.toBe("done");
    const runRow = (await tdb.db.select().from(schema.runs)).find(
      (r) => r.epicBeadId === standalone,
    );
    expect(runRow?.status).not.toBe("done");
  });
});
