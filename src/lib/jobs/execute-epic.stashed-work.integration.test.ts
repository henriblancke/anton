/**
 * End-to-end proof of anton-wjfkn: an agent that STASHES its work and YIELDS its turn is never
 * settled as a zero-diff no-delivery, and its work is neither lost nor misreported.
 *
 * The incident this replays (2026-09-27, fati run 46dc05f7, ticket fati-8sme): the agent implemented
 * the ticket, hit a coverage floor, ran `git stash -u` to measure the baseline, kicked that
 * measurement off in the background and scheduled a wakeup. anton saw a session that exited 0 over an
 * empty working tree and settled it as `[no-delivery]` — ticket blocked for "nothing landed", epic
 * halted, worktree force-removed as a failed run's residue. The +171 lines of passing work survived
 * only as `stash@{0}` in the shared repository, which no note, bead or run row named.
 *
 * Nothing smaller than this can make the claim. The unit suite
 * (`execute-epic-ticket.stashed-work.test.ts`) proves the gate refuses and the note reads right; only
 * the real handler over real git proves the three things that actually cost the work:
 *
 * 1. **The ticket is not settled `no-delivery`.** It parks on its own class, and the park names the
 *    stash sha — the one durable pointer to the change.
 * 2. **The stashed diff is RESTORED.** anton applies it back into the worktree and leaves the entry on
 *    the stack, so the work exists in two places rather than none.
 * 3. **The worktree SURVIVES the teardown.** A failed run's release is `--force`; over this stop it
 *    would delete the restored copy and point the recovery instruction at nothing.
 *
 * Drives the REAL handler + runner + bd/git with a fake `claude` that stashes and yields exactly as
 * that agent did. Skipped without bd + git.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beads } from "../beads/bd";
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
  driveEpicRun,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

describeBd(
  "execute-epic e2e — a stashing, yielding agent is not zero-diff no-delivery (real handler · real bd/git)",
  () => {
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

    /**
     * The incident's agent, scripted: implement the ticket, then `git stash -u` the result to measure a
     * baseline, kick the measurement off in the background, and end the turn on a `ScheduleWakeup`
     * with no `ANTON-RESULT` at all.
     *
     * `stash -u` is what the real agent ran and what makes this hard: it takes the untracked file too,
     * so the tree it leaves is byte-identical to a ticket that did nothing.
     */
    const stashingClaude = (name: string) =>
      writeBin(
        binDir,
        name,
        fakeClaudeReadingStdin(`const cp=require('child_process');
const g=args=>cp.execFileSync('git',args,{cwd:process.cwd(),encoding:'utf8'});
// The work: a real diff this ticket is owed, tracked edit and new file alike.
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'the agent\\'s work\\n');
fs.writeFileSync(path.join(process.cwd(),'COVERAGE_FLOOR.md'),'171 lines of it\\n');
// …then set it aside to measure a baseline, exactly as the fati-8sme agent did.
g(['stash','push','-u','-m','measuring the coverage baseline']);
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'stash'});
// The final message arms a wakeup and says nothing else — no ANTON-RESULT line anywhere.
e({type:'assistant',message:{content:[
  {type:'text',text:'Coverage is 94.61 vs the 94.7 floor. Measuring the baseline, back in 20 minutes.'},
  {type:'tool_use',name:'Bash',input:{command:'bun run test:coverage',run_in_background:true}},
  {type:'tool_use',name:'ScheduleWakeup',input:{delaySeconds:1200}},
]}});
e({type:'result',subtype:'success',result:'Measuring the baseline, back in 20 minutes.',session_id:'stash',num_turns:4,is_error:false});
process.exit(0);`),
      );

    /** Merge `patch` into the sandbox project's settings for one case. */
    const patchSettings = async (patch: Record<string, unknown>) => {
      const [proj] = await tdb.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId));
      const base = JSON.parse(proj.settingsJson ?? "{}") as Record<string, unknown>;
      await tdb.db
        .update(schema.projects)
        .set({ settingsJson: JSON.stringify({ ...base, ...patch }) })
        .where(eq(schema.projects.id, projectId));
    };

    /** Every stash entry the repository holds, newest first, as `<sha> <subject>`. */
    const stashList = () =>
      execFileSync("git", ["-C", repo, "stash", "list", "--format=%H %gs"], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);

    it("parks naming the stash, restores the diff, and keeps the worktree", async () => {
      const featureId = await beads.create(repo, {
        title: "A ticket whose agent stashes and yields",
        type: "feature",
        acceptance: "work file exists",
        description: "## Goal\nImplement it without stashing.",
      });
      await beads.approve(repo, featureId);
      const ticketId = createTicket(repo, {
        title: "Raise coverage past the floor",
        parent: featureId,
        acceptance: "work file exists",
      });

      const runner = makeEpicRunner(ctx);
      process.env.ANTON_CLAUDE_BIN = stashingClaude("claude-stashing");
      try {
        const jobId = await driveEpicRun(runner, { projectId, epicBeadId: featureId });

        // ── 1. NOT settled as no-delivery ──────────────────────────────────────────────────────
        // The park is poison either way, so the status alone proves nothing; what matters is WHICH
        // stop it is. A zero-diff park tells the operator nothing landed and to implement the ticket.
        const job = await getJob(tdb.db, jobId);
        expect(job?.status).toBe("parked");
        expect(job?.lastError).not.toMatch(/zero diff/i);
        expect(job?.lastError).not.toMatch(/left no changes to commit/i);
        // It is reported as the yielded turn it is — the agent never finished, so no gate's verdict on
        // the tree was ever the right answer.
        expect(job?.lastError).toMatch(/ENDED ITS TURN/);
        expect(job?.lastError).toMatch(/ScheduleWakeup/);
        expect(job?.lastError).toMatch(/FOREGROUND/);

        // ── 2. the stash is NAMED, by sha, where an operator will find it ──────────────────────
        // One entry, still on the stack: the durable copy outlives the worktree, so it is never
        // dropped. Its sha is the only pointer to the work, so the park and the bead both carry it.
        const stashes = stashList();
        expect(stashes).toHaveLength(1);
        const stashSha = stashes[0].split(" ")[0];
        expect(stashes[0]).toContain("measuring the coverage baseline");
        expect(job?.lastError).toContain(stashSha);

        const ticket = await beads.show(repo, ticketId);
        // Blocked for a human — nothing was verified or committed — but the note sends them to the
        // work rather than to a keyboard, which is the whole difference from the incident.
        expect(ticket.status).toBe("blocked");
        const noteText = JSON.stringify(ticket);
        expect(noteText).toContain(stashSha);
        expect(noteText).toMatch(/Do NOT re-implement it from scratch/);
        expect(noteText).not.toMatch(/zero diff/i);

        // ── 3. the diff is RESTORED and the worktree SURVIVES ──────────────────────────────────
        const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === featureId)!;
        const worktree = run.worktreePath!;
        // The checkout the recovery instruction points at still exists: a failed run's release is
        // `--force`, and over this stop it would delete the restored copy. The incident's run had it
        // removed mid-flight.
        expect(existsSync(worktree)).toBe(true);
        // Both halves of the `-u` stash are back — the tracked edit and the untracked file. A restore
        // that brought back only one would be a partial recovery reported as a whole one.
        expect(readFileSync(join(worktree, "AGENT_WORK.md"), "utf8")).toContain("the agent's work");
        expect(readFileSync(join(worktree, "COVERAGE_FLOOR.md"), "utf8")).toContain("171 lines of it");

        // Nothing was committed and no PR opened: the work is real but unverified, so presenting it
        // as a delivery would be the false success this whole gate exists to refuse.
        expect(beads.getPrRef(await beads.show(repo, featureId)) ?? null).toBeNull();
        const subjects = execFileSync(
          "git",
          ["-C", repo, "log", `anton/${featureId}`, "--format=%s"],
          { encoding: "utf8" },
        );
        expect(subjects).not.toContain(`${ticketId}:`);
      } finally {
        process.env.ANTON_CLAUDE_BIN = successClaude;
      }
    });

    /**
     * The same set-aside tree reaching the DELIVERY GATE rather than the yield check — the second,
     * independent way the incident's tree could have been misread.
     *
     * An agent that stashes and then signs off properly walks the whole ticket phase: the commit step
     * finds an empty index and an unmoved HEAD and reports a zero diff, and before this feature the
     * gate turned that into `no-delivery`. The self-report is `delivered`, which is the FALSE SUCCESS
     * the gate exists to catch — and it still is, but the reason must name the stash, because the tree
     * being empty was never the truth about the work.
     */
    it("refuses the zero-diff block at the delivery gate when the tree is merely set aside", async () => {
      const featureId = await beads.create(repo, {
        title: "A ticket whose agent stashes but signs off",
        type: "feature",
        acceptance: "work file exists",
        description: "## Goal\nImplement it without stashing.",
      });
      await beads.approve(repo, featureId);
      const ticketId = createTicket(repo, {
        title: "Stash the work, then report delivered",
        parent: featureId,
        acceptance: "work file exists",
      });

      // Stashes exactly as above, but ends with a proper `ANTON-RESULT` — so nothing short-circuits
      // the walk and the tree reaches `step:commit` and the gate behind it.
      const claude = writeBin(
        binDir,
        "claude-stash-signed",
        fakeClaudeReadingStdin(`const cp=require('child_process');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'signed-off work\\n');
cp.execFileSync('git',['stash','push','-u','-m','set aside before signing off'],{cwd:process.cwd()});
const text='Implemented it.\\n\\nANTON-RESULT: delivered';
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'signed'});
e({type:'assistant',message:{content:[{type:'text',text}]}});
e({type:'result',subtype:'success',result:text,session_id:'signed',num_turns:2,is_error:false});
process.exit(0);`),
      );

      // The sandbox's `tests` gate is `test -f AGENT_WORK.md`, which the stash itself makes fail — so
      // the run would stop at `step:verify` and never reach the gate this case is about. Dropped for
      // this case only; the gate's own coverage is elsewhere.
      await patchSettings({ testCommand: undefined });
      const runner = makeEpicRunner(ctx);
      process.env.ANTON_CLAUDE_BIN = claude;
      try {
        const jobId = await driveEpicRun(runner, { projectId, epicBeadId: featureId });
        const job = await getJob(tdb.db, jobId);

        expect(job?.status).toBe("parked");
        // The gate refused the ZERO-DIFF reading: the tree was set aside, not empty.
        expect(job?.lastError).toMatch(/work is STASHED, not absent/);
        expect(job?.lastError).not.toMatch(/left no changes to commit \(zero diff\)/);
        // The false `delivered` claim is still called out — that half of the gate is unchanged.
        expect(job?.lastError).toMatch(/ANTON-RESULT: delivered/);

        // The stash is named and still on the stack, and the restored work is in the kept worktree.
        const stashes = stashList();
        const mine = stashes.find((line) => line.includes("set aside before signing off"))!;
        expect(mine).toBeDefined();
        const stashSha = mine.split(" ")[0];
        expect(job?.lastError).toContain(stashSha);

        const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === featureId)!;
        expect(existsSync(run.worktreePath!)).toBe(true);
        expect(readFileSync(join(run.worktreePath!, "AGENT_WORK.md"), "utf8")).toContain(
          "signed-off work",
        );

        const ticket = await beads.show(repo, ticketId);
        expect(ticket.status).toBe("blocked");
        expect(JSON.stringify(ticket)).toContain(stashSha);
      } finally {
        process.env.ANTON_CLAUDE_BIN = successClaude;
        await patchSettings({ testCommand: "test -f AGENT_WORK.md" });
      }
    });
  },
);
