/**
 * End-to-end proof of the pre-PR self-review gate as execute-epic runs it (anton-omum): with review
 * enabled a run reviews its own diff, fixes what blocks, and opens a PR whose branch already carries
 * those fixes; with it disabled the gate never runs at all. Unresolved BLOCKING findings park the run
 * with no PR; ADVISORY ones ride into the PR body. Every round's score lands on the board.
 *
 * The "review gate" slice of `execute-epic.integration.test.ts`, split out to run in parallel with
 * its siblings (anton-0oi). Drives the REAL handler + runner + bd/git with fake `claude`/`gh`; the
 * fake claude answers implementation, review, and fix dispatches differently, reading each round's
 * scripted report from a file so a case can script convergence, a stall, or a broken protocol.
 * Skipped without bd + git.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beads } from "../beads/bd";
import { worktreePathFor } from "../git/worktree";
import * as schema from "../db/schema";
import { getJob, park } from "./queue";
import { resetOperatorCache } from "../operator";
import { REVIEW_SCORE_KIND } from "./review-score";
import { describeBd } from "@/lib/testing/integration";
import {
  BASE_TIME_MS,
  resetPerCaseState,
  FakeClock,
  writeBin,
  fakeClaudeReadingStdin,
  createExecuteEpicSandbox,
  makeEpicRunner,
  driveEpicRun,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

/** One scripted review report — or `null` for a reviewer that never speaks the protocol. */
type ScriptedReport =
  | null
  | {
      score: number;
      rationale?: string;
      /** `unknown` so a case can script a BROKEN findings list, not just a well-formed one. */
      findings: { severity: "blocking" | "advisory"; location: string; note: string }[] | unknown;
    };

describeBd("execute-epic e2e — pre-PR self-review gate (real handler · real bd/git · fake claude/gh)", () => {
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let projectId: string;
  let ctx: ExecuteEpicSandbox;
  /** Fake claude that answers implement / review / fix dispatches; reviews follow `script(...)`. */
  let reviewClaude: string;
  let reportsPath: string;
  let counterPath: string;
  let invocationsPath: string;

  /** Script the reports successive review rounds return; the last one repeats if rounds outrun it. */
  const script = (...reports: ScriptedReport[]) => {
    writeFileSync(reportsPath, JSON.stringify(reports));
    writeFileSync(counterPath, "0");
    writeFileSync(invocationsPath, "");
  };

  /** Which dispatch kinds the fake claude saw, in order (`implement` | `review` | `fix`). */
  const dispatches = (): string[] =>
    readFileSync(invocationsPath, "utf8").trim().split("\n").filter(Boolean);

  /** An approved epic-of-one whose run this suite drives. */
  const approvedTarget = async (title: string): Promise<string> => {
    const id = await beads.create(repo, {
      title,
      type: "bug",
      acceptance: "work file exists",
      description: `## Goal\n${title}`,
    });
    await beads.approve(repo, id);
    return id;
  };

  /** Turn the self-review gate on/off for the sandbox project (the fixture ships it off). */
  const setReviewEnabled = async (enabled: boolean, extra: Record<string, unknown> = {}) => {
    const proj = (await tdb.db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0];
    const base = JSON.parse(proj.settingsJson ?? "{}") as Record<string, unknown>;
    await tdb.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ ...base, ...extra, reviewEnabled: enabled }) })
      .where(eq(schema.projects.id, projectId));
  };

  /**
   * A `gh` that dumps the `--body` it was invoked with. Non-JSON on `pr view` (like the fixture's
   * default fake), so the reuse probe finds no existing PR and `pr create` actually runs.
   */
  const capturingGh = (name: string, bodyDump: string) =>
    writeBin(
      binDir,
      name,
      `const fs=require('fs');const a=process.argv.slice(2);
const i=a.indexOf('--body');if(i>=0){fs.writeFileSync(${JSON.stringify(bodyDump)},a[i+1]);}
console.log('https://github.com/acme/repo/pull/42');process.exit(0);`,
    );

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ sandbox, repo, binDir, tdb, clock, projectId } = ctx);

    reportsPath = join(sandbox, "review-reports.json");
    counterPath = join(sandbox, "review-round.txt");
    invocationsPath = join(sandbox, "review-dispatches.txt");

    // One fake claude for all three dispatch kinds. It tells them apart by the prompt it is handed
    // — the same protocol markers anton's own prompts define — so a case scripts only the reports.
    reviewClaude = writeBin(
      binDir,
      "claude-review",
      fakeClaudeReadingStdin(`const isReview=prompt.includes('## Reporting format (required)');
const isFix=prompt.includes('## Fix the review findings');
const kind=isReview?'review':isFix?'fix':'implement';
fs.appendFileSync(process.env.ANTON_TEST_REVIEW_DISPATCHES,kind+'\\n');
let text='done';
if(isReview){
  // A reviewer that edits the code it is judging — the read-only guard's target case.
  if(process.env.ANTON_TEST_REVIEW_MUTATES){fs.writeFileSync(path.join(process.cwd(),'REVIEWER_EDIT.md'),'the reviewer fixed it itself\\n');}
  const reports=JSON.parse(fs.readFileSync(process.env.ANTON_TEST_REVIEW_REPORTS,'utf8'));
  let n=0;try{n=parseInt(fs.readFileSync(process.env.ANTON_TEST_REVIEW_COUNTER,'utf8'),10)||0;}catch(e){}
  fs.writeFileSync(process.env.ANTON_TEST_REVIEW_COUNTER,String(n+1));
  const report=reports[Math.min(n,reports.length-1)];
  text=report===null
    ? 'I reviewed it. Looks fine to me.'
    : 'Reviewed.\\n\\n\`\`\`json\\n'+JSON.stringify(report)+'\\n\`\`\`\\n';
}else if(isFix){
  fs.appendFileSync(path.join(process.cwd(),'REVIEW_FIX.md'),'fixed round '+Date.now()+'\\n');
  text='resolved the findings';
}else{
  fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+'\\n');
}
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'s'});
e({type:'assistant',message:{content:[{type:'text',text}]}});
e({type:'result',subtype:'success',result:text,session_id:'s',num_turns:1,total_cost_usd:0.01,is_error:false});
process.exit(0);`),
    );
    process.env.ANTON_TEST_REVIEW_REPORTS = reportsPath;
    process.env.ANTON_TEST_REVIEW_COUNTER = counterPath;
    process.env.ANTON_TEST_REVIEW_DISPATCHES = invocationsPath;
  });

  afterAll(() => {
    delete process.env.ANTON_TEST_REVIEW_REPORTS;
    delete process.env.ANTON_TEST_REVIEW_COUNTER;
    delete process.env.ANTON_TEST_REVIEW_DISPATCHES;
    ctx?.restoreEnv();
    resetOperatorCache();
    ctx?.cleanup();
  });

  beforeEach(async () => {
    clock.set(BASE_TIME_MS);
    await resetPerCaseState(tdb);
    process.env.ANTON_CLAUDE_BIN = reviewClaude;
    script({ score: 9, rationale: "clean", findings: [] });
  });

  /** The score payloads anton appended to a bead, oldest first. */
  const scoreComments = (id: string): Record<string, unknown>[] => {
    const raw = execFileSync("bd", ["comments", id, "--json"], { cwd: repo, encoding: "utf8" });
    const parsed = JSON.parse(raw) as unknown;
    const rows = (Array.isArray(parsed) ? parsed : ((parsed as { comments?: unknown[] }).comments ?? [])) as {
      text?: string;
      content?: string;
      body?: string;
    }[];
    return rows
      .map((c) => c.text ?? c.content ?? c.body ?? "")
      .map((text) => /```json\s*\n([\s\S]*?)```/.exec(text)?.[1])
      .filter((json): json is string => !!json)
      .map((json) => JSON.parse(json) as Record<string, unknown>)
      .filter((payload) => payload.kind === REVIEW_SCORE_KIND);
  };

  it("reviews, fixes what blocks, and opens the PR with the fix already on the branch", async () => {
    // The whole point of the gate: the founder's merge gate sees code a fresh reviewer has already
    // read AND that carries the repairs it asked for — so the fix commits must be on the branch the
    // PR is opened from, not a follow-up push.
    await setReviewEnabled(true);
    script(
      {
        score: 5,
        rationale: "missing a guard",
        findings: [{ severity: "blocking", location: "src/x.ts:3", note: "guard the null case" }],
      },
      { score: 9, rationale: "guard added", findings: [] },
    );
    const targetId = await approvedTarget("Reviewed run");

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // review → fix → review, in that order, all AFTER the implementation dispatch.
      expect(dispatches()).toEqual(["implement", "review", "fix", "review"]);

      // Each review ran as its own recorded session, and never as a resume of the implementer's.
      const sessions = (await tdb.db.select().from(schema.sessions)).filter((s) => s.beadId === targetId);
      expect(sessions.filter((s) => s.kind === "review")).toHaveLength(2);
      expect(sessions.filter((s) => s.kind === "review-fix")).toHaveLength(1);

      // The PR opened, and the branch it was opened from carries the fix commit.
      const target = await beads.show(repo, targetId);
      expect(beads.getPrRef(target)).toBe("gh-42");
      const log = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/anton/${targetId}`], {
        encoding: "utf8",
      });
      expect(log).toContain(`${targetId}: address self-review findings (round 1)`);

      // Every round is on the BOARD (append-only comments), latest score as a state label.
      expect(scoreComments(targetId)).toMatchObject([
        { round: 1, score: 5, blocking: 1, advisory: 0, verdict: "fixed" },
        { round: 2, score: 9, blocking: 0, advisory: 0, verdict: "clean" },
      ]);
      expect(target.labels ?? []).toContain("review-score:9");
      expect((target.labels ?? []).filter((l) => l.startsWith("review-score:"))).toHaveLength(1);
    } finally {
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("skips the gate entirely when the project turned review off", async () => {
    await setReviewEnabled(false);
    const targetId = await approvedTarget("Unreviewed run");

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // No reviewer ran, nothing was scored, and the PR still opened.
      expect(dispatches()).toEqual(["implement"]);
      expect(scoreComments(targetId)).toEqual([]);
      const target = await beads.show(repo, targetId);
      expect((target.labels ?? []).some((l) => l.startsWith("review-score:"))).toBe(false);
      expect(beads.getPrRef(target)).toBe("gh-42");
    } finally {
      await setReviewEnabled(true);
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("ships unresolved ADVISORY findings in the PR body instead of parking on them", async () => {
    // Advisory findings are real improvements that don't invalidate the work; the founder must see
    // them where the merge decision is made, and the run must proceed regardless.
    await setReviewEnabled(true);
    script({
      score: 8,
      rationale: "solid, two nits",
      findings: [
        { severity: "advisory", location: "src/a.ts:10", note: "extract the duplicated mapper" },
        { severity: "advisory", location: "(general)", note: "the new helper deserves a doc line" },
      ],
    });
    const targetId = await approvedTarget("Advisory run");

    const bodyDump = join(sandbox, "advisory-pr-body.txt");
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = capturingGh("gh-advisory", bodyDump);

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // Advisory never dispatches a fix: one review, no repair, straight to the PR.
      expect(dispatches()).toEqual(["implement", "review"]);
      const body = readFileSync(bodyDump, "utf8");
      expect(body).toContain("Unresolved review findings (2, advisory)");
      expect(body).toContain("extract the duplicated mapper");
      expect(body).toContain("the new helper deserves a doc line");
      expect(beads.getPrRef(await beads.show(repo, targetId))).toBe("gh-42");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("parks the run with the findings on the bead when BLOCKING findings survive the round cap", async () => {
    // A reviewer that keeps reporting the same blocking finding must hand the run to the founder,
    // not open a PR on work its own review refused to pass. `gh pr create` booms so a wrongful
    // fall-through to the PR step is a loud failure rather than a silent duplicate.
    await setReviewEnabled(true);
    script({
      score: 3,
      rationale: "acceptance not met",
      findings: [{ severity: "blocking", location: "src/y.ts:7", note: "AC-2 is not implemented" }],
    });
    const targetId = await approvedTarget("Blocked run");

    const boomGh = writeBin(
      binDir,
      "gh-boom-review",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.exit(1);}
console.error('gh boom: no PR may be opened for an unresolved review');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      // Poison → parked for a human immediately, same path as a no-delivery ticket.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toMatch(/self-review/i);
      // The RUN row says parked too, with no end time: this is a run waiting on the founder to
      // resolve the findings and resume it, not one that crashed.
      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;
      expect(run.status).toBe("parked");
      expect(run.endedAt ?? null).toBeNull();
      expect(run.error).toMatch(/did not pass its pre-PR self-review/);

      // The cap bounded the loop: two reviews, one fix in between — not an endless grind.
      expect(dispatches()).toEqual(["implement", "review", "fix", "review"]);

      // No PR, and the board says why.
      const target = await beads.show(repo, targetId);
      expect(beads.getPrRef(target) ?? null).toBeNull();
      expect(target.notes ?? "").toContain("AC-2 is not implemented");
      expect(scoreComments(targetId)).toMatchObject([
        { round: 1, score: 3, blocking: 1, verdict: "fixed" },
        { round: 2, score: 3, blocking: 1, verdict: "unresolved" },
      ]);
      expect(target.labels ?? []).toContain("review-score:3");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("parks when the reviewer never reports — silence is not a clean review", async () => {
    await setReviewEnabled(true);
    script(null);
    const targetId = await approvedTarget("Silent reviewer run");

    const boomGh = writeBin(
      binDir,
      "gh-boom-silent",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.exit(1);}
console.error('gh boom: no PR may be opened on an unreported review');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
      const target = await beads.show(repo, targetId);
      expect(beads.getPrRef(target) ?? null).toBeNull();
      expect(target.notes ?? "").toMatch(/never reported a valid score/i);
      // The round is still recorded — a violation is a data point, not a missing one — but a run
      // with no valid score never gets a score label.
      expect(scoreComments(targetId)).toMatchObject([{ round: 1, verdict: "protocol-violation" }]);
      expect((target.labels ?? []).some((l) => l.startsWith("review-score:"))).toBe(false);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("parks when the findings list is unreadable — a valid score does not vouch for a mangled report", async () => {
    // The shape that must never reach a PR: a good score whose findings anton could not parse. It
    // reads as "nothing blocking" only because the blocking finding was lost.
    await setReviewEnabled(true);
    script({ score: 9, rationale: "clean", findings: null });
    const targetId = await approvedTarget("Mangled report run");

    const boomGh = writeBin(
      binDir,
      "gh-boom-mangled",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.exit(1);}
console.error('gh boom: no PR may be opened on an unreadable review report');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
      // No fix round: an unreadable verdict is never dispatched for repair.
      expect(dispatches()).toEqual(["implement", "review"]);

      const target = await beads.show(repo, targetId);
      expect(beads.getPrRef(target) ?? null).toBeNull();
      expect(target.notes ?? "").toMatch(/unreadable findings list/i);
      expect(scoreComments(targetId)).toMatchObject([{ round: 1, verdict: "protocol-violation" }]);
      // The score it claimed is not banked either — it was never a verdict anton could read.
      expect((target.labels ?? []).some((l) => l.startsWith("review-score:"))).toBe(false);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("reverts a reviewer that edits the worktree and parks instead of trusting its verdict", async () => {
    // A swapped, implementation-minded reviewer that repairs what it finds and then reports clean
    // would ship a 9/10 PR whose branch never carried the repair. Its edit is undone and its review
    // discarded — `gh` booms so a fall-through to the PR step is loud.
    await setReviewEnabled(true);
    script({ score: 9, rationale: "I fixed it while I was in there", findings: [] });
    const targetId = await approvedTarget("Editing reviewer run");

    const boomGh = writeBin(
      binDir,
      "gh-boom-editing",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.exit(1);}
console.error('gh boom: no PR may be opened on a review that edited the code');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;
    process.env.ANTON_TEST_REVIEW_MUTATES = "1";

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
      // One review, no fix round: an untrusted review is never dispatched for repair.
      expect(dispatches()).toEqual(["implement", "review"]);

      // The reviewer's edit is gone from the worktree, and its branch tip carries only the run's work.
      const worktree = worktreePathFor(repo, `anton/${targetId}`);
      expect(existsSync(join(worktree, "REVIEWER_EDIT.md"))).toBe(false);
      expect(
        execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8" }).trim(),
      ).toBe("");

      const target = await beads.show(repo, targetId);
      expect(beads.getPrRef(target) ?? null).toBeNull();
      expect(target.notes ?? "").toMatch(/EDITED the worktree/);
      expect(scoreComments(targetId)).toMatchObject([{ round: 1, verdict: "protocol-violation" }]);
      expect((target.labels ?? []).some((l) => l.startsWith("review-score:"))).toBe(false);
    } finally {
      delete process.env.ANTON_TEST_REVIEW_MUTATES;
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("does not re-review on a resume once the PR is open", async () => {
    // Review is not free — a retry that lands after the PR opened (a lost lease race, a crash after
    // step 5) must finish idempotently, not re-review and re-score a diff already under review.
    await setReviewEnabled(true);
    const targetId = await approvedTarget("Resumed run");

    const runner = makeEpicRunner(ctx);
    let jobId1: string;
    let jobId2: string;
    try {
      jobId1 = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      expect((await getJob(tdb.db, jobId1))?.status).toBe("done");
      expect(dispatches()).toEqual(["implement", "review"]);
      const scoresAfterFirst = scoreComments(targetId);
      expect(scoresAfterFirst).toHaveLength(1);

      // Second attempt against a gh that reports the PR OPEN; `pr create` would boom.
      const openGh = writeBin(
        binDir,
        "gh-open-review",
        `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.stdout.write(JSON.stringify({state:'OPEN',url:'https://github.com/acme/repo/pull/42',number:42})+'\\n');process.exit(0);}
if(a[0]==='pr'&&a[1]==='create'){console.error('gh boom: must not reach the PR step');process.exit(1);}
process.exit(0);`,
      );
      const okGh = process.env.ANTON_GH_BIN!;
      process.env.ANTON_GH_BIN = openGh;
      try {
        jobId2 = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
        expect((await getJob(tdb.db, jobId2))?.status).toBe("done");
        // No further dispatch of any kind, and no second score series on the bead.
        expect(dispatches()).toEqual(["implement", "review"]);
        expect(scoreComments(targetId)).toEqual(scoresAfterFirst);
      } finally {
        process.env.ANTON_GH_BIN = okGh;
      }
    } finally {
      if (jobId1!) await park(tdb.db, clock, jobId1, "test cleanup: not re-dispatched");
      if (jobId2!) await park(tdb.db, clock, jobId2, "test cleanup: not re-dispatched");
    }
  });
});
