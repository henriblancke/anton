/**
 * End-to-end proof of anton-8h4b: a step whose work an EARLIER commit of the same run already did
 * settles as `satisfied` (anton-6l0q / anton-nuft) — closed, but never presented as having delivered
 * a commit of its own.
 *
 * Two things have to be true of that close, and both are pinned here. The BEAD records how it was
 * settled — the satisfying commit, by full sha, on the machine-note channel — so a reader later
 * tells it apart from a step that produced its own commit. And the PR BODY attributes the step to
 * that commit instead of listing it among the deliveries, including on a run where every step after
 * the first was satisfied: one PR still opens, and it reads truthfully.
 *
 * Drives the REAL handler + runner + bd/git with fake `claude`/`gh`. The fake claude implements the
 * first ticket it meets and, for every later one, finds that work already committed in the worktree
 * and reports `satisfied` naming HEAD — exactly what an honest agent does in that spot. Skipped
 * without bd + git.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beads, LABELS } from "../beads/bd";
import { parseTicketNotes } from "../beads/notes";
import { latestSatisfiedRecord } from "../beads/satisfied-note";
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

describeBd("execute-epic e2e — a satisfied step is attributed to the commit that did the work (real handler · real bd/git)", () => {
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

  /**
   * A claude that does the work ONCE. The first dispatch leaves the diff and reports `delivered`;
   * every later dispatch finds that file already committed in the worktree, changes nothing, and
   * reports `satisfied` naming the abbreviated HEAD it read off the branch — the commit anton made
   * for the first ticket. Each dispatch's ticket id and outcome go to `log`.
   */
  const onceClaude = (name: string, log: string) =>
    writeBin(
      binDir,
      name,
      fakeClaudeReadingStdin(`const cp=require('child_process');
const m=prompt.match(/Ticket: (\\S+)/);const id=m?m[1]:'unknown';
const work=path.join(process.cwd(),'AGENT_WORK.md');
let text;
if(fs.existsSync(work)){
  const head=cp.execSync('git rev-parse --short HEAD',{cwd:process.cwd(),encoding:'utf8'}).trim();
  text='The branch already carries this change.\\n\\nANTON-RESULT: satisfied — '+head+' — the first step\\'s commit already meets every criterion here';
}else{
  fs.writeFileSync(work,'work\\n');
  text='Implemented.\\n\\nANTON-RESULT: delivered';
}
fs.appendFileSync(${JSON.stringify(log)},id+' '+(text.includes('satisfied')?'satisfied':'delivered')+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'sat'});
e({type:'assistant',message:{content:[{type:'text',text}]}});
e({type:'result',subtype:'success',result:text,session_id:'sat',num_turns:1,is_error:false});
process.exit(0);`),
    );

  /** A `gh` that dumps the `--body` it was handed; reports no open PR, like the fixture's default. */
  const capturingGh = (name: string, bodyDump: string) =>
    writeBin(
      binDir,
      name,
      `const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){console.log('[]');process.exit(0);}
const i=a.indexOf('--body');if(i>=0){fs.writeFileSync(${JSON.stringify(bodyDump)},a[i+1]);}
console.log('https://github.com/acme/repo/pull/42');process.exit(0);`,
    );

  const dispatched = (log: string): Map<string, string> =>
    new Map(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ") as [string, string]),
    );

  /** The commit anton made for `ticketId` on the run's branch, full sha and subject. */
  const commitFor = (branch: string, ticketId: string) => {
    const [sha, subject] = execFileSync(
      "git",
      ["log", branch, "--format=%H%n%s", "-1", "--grep", `^${ticketId}:`],
      { cwd: repo, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    return { sha: sha!, subject: subject! };
  };

  it("closes the satisfied steps on the first step's commit, records it on each bead, and opens one truthful PR", async () => {
    const featureId = await beads.create(repo, {
      title: "One change that covers three steps",
      type: "feature",
      acceptance: "work file exists",
      description: "## Goal\nOne coherent change satisfies every step.",
    });
    await beads.approve(repo, featureId);
    const first = createTicket(repo, {
      title: "Add the work file",
      parent: featureId,
      acceptance: "work file exists",
    });
    const second = createTicket(repo, {
      title: "Make the work file readable",
      parent: featureId,
      acceptance: "work file exists",
    });
    const third = createTicket(repo, {
      title: "Ship the work file",
      parent: featureId,
      acceptance: "work file exists",
    });
    // Ordered so the run walks them first → second → third: the first does the work, the rest find it.
    await beads.link(repo, second, first, "blocks");
    await beads.link(repo, third, second, "blocks");

    const log = join(sandbox, "satisfied-dispatch.log");
    const bodyDump = join(sandbox, "satisfied-pr-body.txt");
    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = onceClaude("claude-satisfied", log);
    const prevGh = process.env.ANTON_GH_BIN;
    process.env.ANTON_GH_BIN = capturingGh("gh-satisfied", bodyDump);
    try {
      const jobId = await driveEpicRun(runner, { projectId, epicBeadId: featureId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // The run walked every step; only the first left a diff.
      const outcomes = dispatched(log);
      expect(outcomes.get(first)).toBe("delivered");
      expect(outcomes.get(second)).toBe("satisfied");
      expect(outcomes.get(third)).toBe("satisfied");

      // The branch carries exactly ONE ticket commit — the first's. Nothing was committed under the
      // satisfied steps' names, and no marker was minted to pretend otherwise.
      const branch = `anton/${featureId}`;
      const firstCommit = commitFor(branch, first);
      expect(firstCommit.subject).toBe(`${first}: Add the work file`);
      const subjects = execFileSync("git", ["log", branch, "--format=%s"], { cwd: repo, encoding: "utf8" });
      expect(subjects).not.toContain(second);
      expect(subjects).not.toContain(third);

      // Every step is closed — the gate settled the satisfied ones on the branch's evidence — and
      // none is marked undelivered: their acceptance IS in this PR.
      for (const id of [first, second, third]) {
        const bead = await beads.show(repo, id);
        expect(bead.status).toBe("closed");
        expect(bead.labels ?? []).not.toContain(LABELS.notDelivered);
      }

      // THE RECORD: each satisfied bead says how it was settled — the satisfying commit by FULL sha,
      // on the run's branch — as a machine note a reader parses back. The first step, which
      // committed its own work, carries no such record: that is what tells the two apart later.
      for (const id of [second, third]) {
        const bead = await beads.show(repo, id);
        const record = latestSatisfiedRecord(bead.notes);
        expect(record).toBeDefined();
        expect(record?.commit).toBe(firstCommit.sha);
        expect(record?.branch).toBe(branch);
        const machine = parseTicketNotes(bead.notes).filter((n) => n.source === "system");
        const note = machine.find((n) => n.text.startsWith("anton: satisfied by"));
        expect(note?.text).toContain(`"${first}: Add the work file"`);
        expect(note?.text).toContain("no commit of its own");
        expect(note?.text).toContain("the first step's commit already meets every criterion here");
      }
      expect(latestSatisfiedRecord((await beads.show(repo, first)).notes)).toBeUndefined();

      // THE PR BODY: one PR, whose delivered list holds only the step that committed, and whose
      // satisfied steps are attributed to that commit rather than listed as deliveries of their own.
      const body = readFileSync(bodyDump, "utf8");
      const [deliveries, attributions] = body.split("Satisfied by earlier commits of this run");
      expect(attributions).toBeDefined();
      expect(deliveries).toContain(`- ${first} — Add the work file`);
      expect(deliveries).not.toContain(second);
      expect(deliveries).not.toContain(third);
      const short = firstCommit.sha.slice(0, 7);
      expect(attributions).toContain(
        `- ${second} — Make the work file readable — by ${short} "${first}: Add the work file"`,
      );
      expect(attributions).toContain(
        `- ${third} — Ship the work file — by ${short} "${first}: Add the work file"`,
      );
      // Each satisfied step is named exactly once in the whole body.
      expect(body.match(new RegExp(second, "g"))).toHaveLength(1);
      expect(body.match(new RegExp(third, "g"))).toHaveLength(1);

      // The feature moved into review behind that one PR.
      const feature = await beads.show(repo, featureId);
      expect(beads.getPrRef(feature) ?? null).not.toBeNull();
      expect(feature.labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      process.env.ANTON_GH_BIN = prevGh;
    }
  });
});
