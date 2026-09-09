/**
 * End-to-end proof of anton-ag76: the RESUME skip rule reads sibling attribution.
 *
 * A ticket whose work landed under a SIBLING's commit carries no `<id>:` subject of its own, so the
 * only thing on the branch that speaks for it is that commit's {@link SATISFIES_TRAILER}. Before
 * this, the resume read "closed on the board, nothing here subjected `<id>:`" as the cross-machine
 * shape (anton-jz1 / anton-5slr) — reopening the ticket and dispatching an agent into a guaranteed
 * zero diff, which the no-delivery gate then blocks as undelivered work.
 *
 * Three propositions, and the middle one is the whole point of pinning them together — the widening
 * must not cost the cross-machine reasoning it was carved out of:
 *   1. a sibling-satisfied ticket is SKIPPED, stays closed, and is attributed in the PR body to the
 *      commit that did its work rather than listed among the deliveries — and, since that commit
 *      was published to the base before the run, to the BASE rather than to this run (PR #258
 *      review): the reviewer is never sent looking for a sha this diff does not contain;
 *   2. a ticket nothing on this branch claims is dispatched exactly as before;
 *   3. a ticket closed on the board with neither a subject nor a trailer anywhere on this branch is
 *      still REGENERATED — the commit lives only in another machine's unpushed worktree.
 *
 * A fourth case (PR #258 review) closes the loop between the two halves of the mechanism: rather
 * than synthesizing the branch, it lets a FIRST run settle a ticket as `satisfied` and stop before
 * its pull request opens, then resumes — the shape a real interruption takes. The trailer the resume
 * reads has to be one the production close wrote, or the resume regenerates the ticket into the very
 * zero diff the other three cases prove it avoids.
 *
 * Drives the REAL handler + runner + bd/git with fake `claude`/`gh`. The branch state the first
 * three cases resume from is synthesized on `origin/main` (which the run's worktree branches off) —
 * the sibling's commit is written with the real {@link commitMarker}, so the trailers under test are
 * the ones anton writes. Skipped without bd + git.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beads } from "../beads/bd";
import { commitMarker } from "../git/ops";
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

describeBd("execute-epic e2e — a resume credits a ticket to the sibling commit that satisfied it (real handler · real bd/git)", () => {
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

  /** A claude that logs the ticket it was dispatched for, does the work, and reports `delivered`. */
  const loggingClaude = (name: string, log: string) =>
    writeBin(
      binDir,
      name,
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);const id=m?m[1]:'unknown';
fs.appendFileSync(${JSON.stringify(log)},id+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+id+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'sib'});
e({type:'assistant',message:{content:[{type:'text',text:'implemented the ticket'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'sib',num_turns:1,is_error:false});
process.exit(0);`),
    );

  /**
   * A claude that does the work ONCE and, on every later dispatch, finds it already committed,
   * changes nothing and reports `satisfied` naming the abbreviated HEAD it read off the branch —
   * exactly what an honest agent does in that spot. Each dispatch's ticket id and outcome go to `log`.
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
  text='The branch already carries this change.\\n\\nANTON-RESULT: satisfied — '+head+' — the sibling commit already meets every criterion here';
}else{
  fs.writeFileSync(work,'work\\n');
  text='Implemented.\\n\\nANTON-RESULT: delivered';
}
fs.appendFileSync(${JSON.stringify(log)},id+' '+(text.includes('satisfied')?'satisfied':'delivered')+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'sib2'});
e({type:'assistant',message:{content:[{type:'text',text}]}});
e({type:'result',subtype:'success',result:text,session_id:'sib2',num_turns:1,is_error:false});
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

  const dispatched = (log: string): string[] =>
    readFileSync(log, "utf8").trim().split("\n").filter(Boolean);

  /** Publish `origin/main` at the sandbox repo's local main — the base every run's worktree cuts from. */
  const publishBase = () =>
    execFileSync("git", ["-C", repo, "push", "-q", "origin", "main"], { stdio: "ignore" });

  /** The commit on `branch` whose subject names `ticketId`, full sha and subject. */
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

  /** The commit on `branch` whose subject is exactly `subject`, full sha and subject. */
  const commitForSubject = (branch: string, subject: string) => {
    const [sha, found] = execFileSync(
      "git",
      ["log", branch, "--format=%H%n%s", "-1", "--fixed-strings", "--grep", subject],
      { cwd: repo, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    return { sha: sha!, subject: found! };
  };

  const subjectsOn = (branch: string): string =>
    execFileSync("git", ["log", branch, "--format=%s"], { cwd: repo, encoding: "utf8" });

  const sessionsFor = async (beadId: string) =>
    (await tdb.db.select().from(schema.sessions)).filter((s) => s.beadId === beadId);

  it("skips the sibling-satisfied ticket, leaves it closed, and still dispatches the one nothing claims", async () => {
    const featureId = await beads.create(repo, {
      title: "One commit covered two of these",
      type: "feature",
      acceptance: "work file exists",
      description: "## Goal\nProve the resume reads sibling attribution.",
    });
    await beads.approve(repo, featureId);
    const doer = createTicket(repo, {
      title: "Ticket whose commit did the work",
      parent: featureId,
      acceptance: "work file exists",
    });
    const satisfied = createTicket(repo, {
      title: "Ticket that commit also satisfied",
      parent: featureId,
      acceptance: "work file exists",
    });
    const untouched = createTicket(repo, {
      title: "Ticket nothing on the branch claims",
      parent: featureId,
      acceptance: "work file exists",
    });

    // The branch as a resume finds it: the prior attempt committed under `doer`'s name and recorded
    // that the same work met `satisfied`'s acceptance in full, and closed BOTH beads. Written with
    // the real marker writer, and published to the base this run's worktree branches off.
    await commitMarker(
      repo,
      `${doer}: Ticket whose commit did the work\n\nThe same change met the sibling's acceptance.`,
      { satisfies: [satisfied] },
    );
    publishBase();
    await beads.close(repo, doer);
    await beads.close(repo, satisfied);

    const log = join(sandbox, "sibling-dispatch.log");
    const bodyDump = join(sandbox, "sibling-pr-body.txt");
    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = loggingClaude("claude-sibling", log);
    const prevGh = process.env.ANTON_GH_BIN;
    process.env.ANTON_GH_BIN = capturingGh("gh-sibling", bodyDump);
    try {
      const jobId = await driveEpicRun(runner, { projectId, epicBeadId: featureId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // Exactly ONE agent ran: the ticket nothing on this branch speaks for. The sibling-satisfied
      // one was never dispatched — no session, no zero diff to be blocked for.
      expect(dispatched(log)).toEqual([untouched]);
      expect(await sessionsFor(satisfied)).toHaveLength(0);
      expect(await sessionsFor(untouched)).toHaveLength(1);

      // The operator's close SURVIVED the resume: the skip is a skip, not a reopen-and-re-run.
      expect((await beads.show(repo, satisfied)).status).toBe("closed");
      expect((await beads.show(repo, doer)).status).toBe("closed");
      expect((await beads.show(repo, untouched)).status).toBe("closed");

      // Nothing was committed under the satisfied ticket's name — which is exactly why the branch
      // alone could not see it before, and why the PR body has to say who did.
      const branch = `anton/${featureId}`;
      expect(subjectsOn(branch)).not.toContain(satisfied);
      const by = commitFor(branch, doer);

      const body = readFileSync(bodyDump, "utf8");
      // The commit was published to `origin/main` before the run, so it is BASE history — the body
      // must attribute it to the base rather than to a commit of this run's diff (PR #258 review).
      const [deliveries, attributions] = body.split(
        "Already satisfied by commits in the base, not by this run (not in this diff):",
      );
      expect(attributions).toBeDefined();
      expect(body).not.toContain("Satisfied by earlier commits of this run");
      expect(attributions).toContain(
        `- ${satisfied} — Ticket that commit also satisfied — by ${by.sha.slice(0, 7)} "${by.subject}"`,
      );
      // …and it is attributed INSTEAD of being listed as a delivery of its own: a reader matching
      // tickets to commits would otherwise go looking for one that does not exist.
      expect(deliveries).not.toContain(satisfied);
      expect(body.match(new RegExp(satisfied, "g"))).toHaveLength(1);
      expect(deliveries).toContain(`- ${untouched} — Ticket nothing on the branch claims`);

      const feature = await beads.show(repo, featureId);
      expect(beads.getPrRef(feature) ?? null).not.toBeNull();
      expect(feature.labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      process.env.ANTON_GH_BIN = prevGh;
    }
  });

  it("still regenerates a closed ticket NO commit on this branch claims (the cross-machine case)", async () => {
    // anton-5slr / anton-jz1, unchanged by the widening: board state propagates cross-machine via
    // `bd sync`, but a run branch is pushed only at the PR step — so a ticket another machine closed
    // and then parked on has its commit solely in that machine's never-pushed worktree. This branch
    // carries neither a `<id>:` subject nor a trailer claiming it, so the work is regenerated here
    // rather than skipped into a pull request that would be missing it.
    const featureId = await beads.create(repo, {
      title: "Closed elsewhere, committed nowhere here",
      type: "feature",
      acceptance: "work file exists",
      description: "## Goal\nProve the cross-machine resume still regenerates.",
    });
    await beads.approve(repo, featureId);
    const elsewhere = createTicket(repo, {
      title: "Ticket closed on another machine",
      parent: featureId,
      acceptance: "work file exists",
    });

    // A decoy: the branch DOES carry attribution trailers, so the read runs and answers "nothing
    // here" rather than the case passing because there was nothing to read. The claimed id is this
    // ticket's own with a suffix, which also pins the match as EXACT — a subtask satisfying
    // something says nothing about its parent.
    await commitMarker(repo, "unrelated: someone else's work", { satisfies: [`${elsewhere}.9`] });
    publishBase();
    await beads.close(repo, elsewhere);

    const log = join(sandbox, "cross-machine-dispatch.log");
    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = loggingClaude("claude-cross-machine", log);
    try {
      const jobId = await driveEpicRun(runner, { projectId, epicBeadId: featureId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // The agent RAN, and its work is on this branch under the ticket's own name.
      expect(dispatched(log)).toEqual([elsewhere]);
      expect(subjectsOn(`anton/${featureId}`)).toContain(`${elsewhere}:`);
      expect((await beads.show(repo, elsewhere)).status).toBe("closed");
      expect((await beads.show(repo, featureId)).labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  });

  it("carries a real satisfied close across an interruption — first run settles it, the resume skips it (PR #258 review)", async () => {
    // The two halves of the mechanism, joined. Nothing here is synthesized: a first run settles the
    // second ticket as `satisfied` on the first's commit, closes it, and then DIES at the PR step —
    // the shape a park or a crash takes, before the epic's single pull request ever opens. The
    // resume finds that ticket closed on the board with no commit under its name, which is the exact
    // cross-machine shape it must NOT read this as: only the trailer the close wrote tells the two
    // apart, so without it the resume reopens the ticket and dispatches an agent into a zero diff.
    const featureId = await beads.create(repo, {
      title: "One commit covers both, across a resume",
      type: "feature",
      acceptance: "work file exists",
      description: "## Goal\nProve the satisfied close survives an interruption.",
    });
    await beads.approve(repo, featureId);
    const doer = createTicket(repo, {
      title: "Ticket that does the work",
      parent: featureId,
      acceptance: "work file exists",
    });
    const satisfied = createTicket(repo, {
      title: "Ticket the same commit satisfies",
      parent: featureId,
      acceptance: "work file exists",
    });
    // Ordered so the run walks doer → satisfied: the first leaves the diff, the second finds it.
    await beads.link(repo, satisfied, doer, "blocks");

    const log = join(sandbox, "interrupted-dispatch.log");
    const bodyDump = join(sandbox, "interrupted-pr-body.txt");
    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = onceClaude("claude-interrupted", log);
    const prevGh = process.env.ANTON_GH_BIN;
    // Attempt 1: gh fails outright, so the run dies at the PR step with both tickets settled.
    process.env.ANTON_GH_BIN = writeBin(binDir, "gh-interrupted", `console.error('gh boom');process.exit(1);`);
    let jobId: string | undefined;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: featureId });
      expect((await getJob(tdb.db, jobId))?.status).not.toBe("done");

      // Both tickets settled: the first delivered, the second satisfied on its commit — and BOTH are
      // closed, which is what makes the resume's read the dangerous one.
      expect(dispatched(log)).toEqual([`${doer} delivered`, `${satisfied} satisfied`]);
      expect((await beads.show(repo, doer)).status).toBe("closed");
      expect((await beads.show(repo, satisfied)).status).toBe("closed");

      // Attempt 2: same branch, working gh. The satisfied ticket is NOT re-dispatched — the trailer
      // its own close wrote is what the resume reads, so no second session and no zero diff.
      process.env.ANTON_GH_BIN = capturingGh("gh-interrupted-ok", bodyDump);
      expect(await park(tdb.db, clock, jobId, "test: simulate an interruption")).toBe(true);
      expect(await resumeJob(tdb.db, clock, jobId)).toBe(true);
      await tickToIdle(runner);

      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      // Unchanged: the resume dispatched no agent at all.
      expect(dispatched(log)).toEqual([`${doer} delivered`, `${satisfied} satisfied`]);
      expect(await sessionsFor(satisfied)).toHaveLength(1);
      expect((await beads.show(repo, satisfied)).status).toBe("closed");

      // The branch still carries no commit under the satisfied ticket's name — the marker claims it
      // in a trailer, whose subject is where a reviewer reads which commit did the work.
      const branch = `anton/${featureId}`;
      expect(subjectsOn(branch)).not.toContain(`${satisfied}:`);
      const work = commitFor(branch, doer);
      const marker = commitForSubject(branch, `anton: ${satisfied} satisfied by ${work.sha}`);
      expect(subjectsOn(branch)).toContain(`anton: ${satisfied} satisfied by ${work.sha}`);

      // …and the pull request attributes it to that marker instead of listing it as a delivery.
      const body = readFileSync(bodyDump, "utf8");
      const [deliveries, attributions] = body.split("Satisfied by earlier commits of this run");
      // Branch-ADDED, unlike the first case: this run made the marker itself, so the diff carries it
      // and the body says so rather than crediting the base (PR #258 review).
      expect(body).not.toContain("not by this run");
      // The body cites the MARKER (which is what the branch read found) — and its subject names the
      // commit that actually did the work, so a reviewer is never left hunting for a diff.
      expect(attributions).toContain(
        `- ${satisfied} — Ticket the same commit satisfies — by ` +
          `${marker.sha.slice(0, 7)} "anton: ${satisfied} satisfied by ${work.sha}"`,
      );
      expect(deliveries).toContain(`- ${doer} — Ticket that does the work`);
      expect(deliveries).not.toContain(satisfied);
      // Exactly ONE marker for this ticket — the resume added none of its own, and the one the
      // first run wrote credits the doer's commit rather than any marker beside it.
      expect(subjectsOn(branch).match(new RegExp(`^anton: ${satisfied} `, "gm")) ?? []).toHaveLength(1);
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      process.env.ANTON_GH_BIN = prevGh;
      // Park so a later clock-advancing tick in another suite can't re-dispatch this job.
      if (jobId) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });
});
