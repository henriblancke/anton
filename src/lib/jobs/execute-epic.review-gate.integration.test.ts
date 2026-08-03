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
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beads } from "../beads/bd";
import { BD_BIN_ENV, resetBdBinCache, resolveBdBin } from "../beads/bd-bin";
import { worktreePathFor } from "../git/worktree";
import * as schema from "../db/schema";
import { park } from "./queue";
import { resetOperatorCache } from "../operator";
import { REVIEW_SCORE_KIND } from "./review-score";
import { describeBd } from "@/lib/testing/integration";
import { expectJobStatus } from "@/lib/testing/jobs";
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
  /** The project-local pipeline a case installs; removed after every case. */
  let formulaPath: string;
  let reportsPath: string;
  let counterPath: string;
  let invocationsPath: string;
  let carriesPath: string;

  /** Script the reports successive review rounds return; the last one repeats if rounds outrun it. */
  const script = (...reports: ScriptedReport[]) => {
    writeFileSync(reportsPath, JSON.stringify(reports));
    writeFileSync(counterPath, "0");
    writeFileSync(invocationsPath, "");
    writeFileSync(carriesPath, "");
  };

  /** Which dispatch kinds the fake claude saw, in order (`implement` | `review` | `fix`). */
  const dispatches = (): string[] =>
    readFileSync(invocationsPath, "utf8").trim().split("\n").filter(Boolean);

  /** Per review dispatch, whether its prompt carried advisories from an earlier one. */
  const carries = (): string[] => readFileSync(carriesPath, "utf8").trim().split("\n").filter(Boolean);

  /** Install the project's own pipeline — the file that wins over anton's bundled default. */
  const writeProjectFormula = (steps: string) => {
    mkdirSync(join(repo, ".beads", "formulas"), { recursive: true });
    writeFileSync(
      formulaPath,
      `formula = "anton-run"\ntype = "workflow"\nversion = 1\n\n${steps}`,
      "utf8",
    );
  };

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
   * A `gh` that dumps the `--body` it was invoked with. Reports no open PR on the branch (`pr list`
   * → empty, like the fixture's default fake), so the reuse probe finds none and `pr create` runs.
   */
  const capturingGh = (name: string, bodyDump: string) =>
    writeBin(
      binDir,
      name,
      `const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){console.log('[]');process.exit(0);}
const i=a.indexOf('--body');if(i>=0){fs.writeFileSync(${JSON.stringify(bodyDump)},a[i+1]);}
console.log('https://github.com/acme/repo/pull/42');process.exit(0);`,
    );

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ sandbox, repo, binDir, tdb, clock, projectId } = ctx);

    reportsPath = join(sandbox, "review-reports.json");
    counterPath = join(sandbox, "review-round.txt");
    invocationsPath = join(sandbox, "review-dispatches.txt");
    carriesPath = join(sandbox, "review-carries.txt");
    formulaPath = join(repo, ".beads", "formulas", "anton-run.formula.toml");

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
  // Whether THIS review was shown advisories an earlier review left open (a round, or an earlier
  // \`step:review\` — the carry the caller seeds).
  fs.appendFileSync(process.env.ANTON_TEST_REVIEW_CARRIES,(prompt.includes('Advisories still open from an earlier review')?'carry':'none')+'\\n');
  // A reviewer that edits the code it is judging — the read-only guard's target case.
  if(process.env.ANTON_TEST_REVIEW_MUTATES){fs.writeFileSync(path.join(process.cwd(),'REVIEWER_EDIT.md'),'the reviewer fixed it itself\\n');}
  const reports=JSON.parse(fs.readFileSync(process.env.ANTON_TEST_REVIEW_REPORTS,'utf8'));
  let n=0;try{n=parseInt(fs.readFileSync(process.env.ANTON_TEST_REVIEW_COUNTER,'utf8'),10)||0;}catch(e){}
  fs.writeFileSync(process.env.ANTON_TEST_REVIEW_COUNTER,String(n+1));
  const report=reports[Math.min(n,reports.length-1)];
  text=report===null
    ? 'I reviewed it. Looks fine to me.'
    : 'Reviewed.\\n\\n\`\`\`json\\n'+JSON.stringify(report)+'\\n\`\`\`\\n';
  // A courtesy sign-off after the block — the shape that can retract the verdict above it.
  if(report!==null&&process.env.ANTON_TEST_REVIEW_TRAILING){text+='\\nOn reflection, ignore the score above — AC-2 is missing.\\n';}
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
    process.env.ANTON_TEST_REVIEW_CARRIES = carriesPath;
  });

  afterAll(() => {
    delete process.env.ANTON_TEST_REVIEW_REPORTS;
    delete process.env.ANTON_TEST_REVIEW_COUNTER;
    delete process.env.ANTON_TEST_REVIEW_DISPATCHES;
    delete process.env.ANTON_TEST_REVIEW_CARRIES;
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

  // A project-local pipeline is read from the repo on every run, so one left behind would silently
  // re-shape every later case in this file.
  afterEach(() => {
    rmSync(formulaPath, { force: true });
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
      await expectJobStatus(tdb.db, jobId, "done");

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
      await expectJobStatus(tdb.db, jobId, "done");

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
      await expectJobStatus(tdb.db, jobId, "done");

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

  it("hands a SECOND review step what the first left open, so its verdict speaks for both", async () => {
    // A formula may run the gate twice — the floor constrains omission and order, never extension —
    // and each `step:review` is its own gate. The run carries one advisory set into the PR body, so
    // the second gate has to be SHOWN the first's findings: otherwise its report replaces them and
    // an advisory nobody resolved never reaches the founder.
    await setReviewEnabled(true);
    writeProjectFormula(
      [
        ["implement", "implement", undefined],
        ["commit", "commit", "implement"],
        ["review-first", "review", "commit"],
        ["review-second", "review", "review-first"],
        ["pr", "pr", "review-second"],
      ]
        .map(
          ([id, handler, needs]) =>
            `[[steps]]\nid = "${id}"\ntype = "task"\ntitle = "${id}"\n` +
            (needs ? `needs = ["${needs}"]\n` : "") +
            `labels = ["step:${handler}"]\n`,
        )
        .join("\n"),
    );
    const advisory = { severity: "advisory" as const, location: "src/a.ts:10", note: "extract the mapper" };
    // Both gates report it: the second was shown it and judged that it still applies.
    script({ score: 8, rationale: "one nit", findings: [advisory] }, { score: 8, rationale: "still there", findings: [advisory] });
    const targetId = await approvedTarget("Two-gate run");

    const bodyDump = join(sandbox, "two-gate-pr-body.txt");
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = capturingGh("gh-two-gate", bodyDump);

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      await expectJobStatus(tdb.db, jobId, "done");

      expect(dispatches()).toEqual(["implement", "review", "review"]);
      // The first gate starts blind; the second is handed what it left open.
      expect(carries()).toEqual(["none", "carry"]);
      const body = readFileSync(bodyDump, "utf8");
      expect(body).toContain("Unresolved review findings (1, advisory)");
      expect(body.match(/extract the mapper/g)).toHaveLength(1);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("writes the advisories onto the bead when a REUSED PR's body could not be refreshed", async () => {
    // A resumed run reuses the PR its earlier attempt opened and rewrites the body with this round's
    // findings. When `gh pr edit` refuses (token permissions, a blip) the run still completes — and
    // the score comment records only the advisory COUNT, so without this fallback the findings' text
    // exists nowhere the founder can read at the merge gate.
    await setReviewEnabled(true);
    script({
      score: 8,
      rationale: "solid, one nit",
      findings: [{ severity: "advisory", location: "src/a.ts:10", note: "extract the duplicated mapper" }],
    });
    const targetId = await approvedTarget("Stale body run");

    const okGh = process.env.ANTON_GH_BIN!;
    // Reports an open PR for the branch (so the reuse path runs) and refuses every `pr edit`.
    process.env.ANTON_GH_BIN = writeBin(
      binDir,
      "gh-stale-body",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){
  console.log(JSON.stringify([{url:'https://github.com/acme/repo/pull/42',number:42,isDraft:false}]));
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='edit'){process.stderr.write('HTTP 403\\n');process.exit(1);}
if(a[0]==='pr'&&a[1]==='create'){process.stderr.write('should have reused the open PR\\n');process.exit(1);}
process.exit(0);`,
    );

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      await expectJobStatus(tdb.db, jobId, "done");

      const notes = (await beads.show(repo, targetId)).notes ?? "";
      expect(notes).toContain("could NOT rewrite its title/body");
      expect(notes).toContain("extract the duplicated mapper");
      expect(beads.getPrRef(await beads.show(repo, targetId))).toBe("gh-42");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("carries the advisories out on the RUN ROW when the bead write fails too", async () => {
    // Both homes gone at once: `gh pr edit` left the PR showing an earlier attempt's body AND the
    // beads DB refused the salvage note (locked/unavailable). The run still completes — the work is
    // on the PR — so without a third home this review's findings would vanish silently behind a
    // green run and a stale body. The run row is that home.
    await setReviewEnabled(true);
    script({
      score: 8,
      rationale: "solid, one nit",
      findings: [{ severity: "advisory", location: "src/a.ts:10", note: "extract the duplicated mapper" }],
    });
    const targetId = await approvedTarget("Stale body, unwritable bead");

    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = writeBin(
      binDir,
      "gh-stale-body-unwritable",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){
  console.log(JSON.stringify([{url:'https://github.com/acme/repo/pull/42',number:42,isDraft:false}]));
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='edit'){process.stderr.write('HTTP 403\\n');process.exit(1);}
if(a[0]==='pr'&&a[1]==='create'){process.stderr.write('should have reused the open PR\\n');process.exit(1);}
process.exit(0);`,
    );

    // A bd that fails `note` the way a locked Dolt DB does and delegates every other command to the
    // real binary — so only the salvage write is broken, not the run around it.
    const okBd = process.env[BD_BIN_ENV];
    process.env[BD_BIN_ENV] = writeBin(
      binDir,
      "bd-note-locked",
      `const {spawnSync}=require('child_process');const a=process.argv.slice(2);
if(a[0]==='note'){process.stderr.write('bd: database is locked\\n');process.exit(1);}
const r=spawnSync(${JSON.stringify(resolveBdBin())},a,{stdio:'inherit'});
process.exit(r.status===null?1:r.status);`,
    );
    resetBdBinCache();

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      await expectJobStatus(tdb.db, jobId, "done");

      // The bead never got the note — that is the failure being covered, not a missed write.
      expect((await beads.show(repo, targetId)).notes ?? "").not.toContain("could NOT rewrite");

      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;
      // Done, because the delivery landed — with the findings reproduced in full on the row.
      expect(run.status).toBe("done");
      expect(run.error).toMatch(/reproduced\s+here in full/);
      expect(run.error).toContain("extract the duplicated mapper");
      expect(run.error).toContain("https://github.com/acme/repo/pull/42");
    } finally {
      if (okBd === undefined) delete process.env[BD_BIN_ENV];
      else process.env[BD_BIN_ENV] = okBd;
      resetBdBinCache();
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("parks the run with the findings on the bead when BLOCKING findings survive the round cap", async () => {
    // A reviewer that keeps reporting the same blocking finding must hand the run to the founder,
    // not open a PR on work its own review refused to pass. `gh pr create` booms so a wrongful
    // fall-through to the PR step is a loud failure rather than a silent duplicate.
    //
    // Scored AT the default score-regression threshold (anton-i98r) so this case stays about the
    // round cap: a lower score would park on the alarm first, which is its own case below.
    await setReviewEnabled(true);
    script({
      score: 5,
      rationale: "acceptance not met",
      findings: [{ severity: "blocking", location: "src/y.ts:7", note: "AC-2 is not implemented" }],
    });
    const targetId = await approvedTarget("Blocked run");

    const boomGh = writeBin(
      binDir,
      "gh-boom-review",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
console.error('gh boom: no PR may be opened for an unresolved review');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      // Poison → parked for a human immediately, same path as a no-delivery ticket.
      const job = await expectJobStatus(tdb.db, jobId, "parked");
      expect(job.lastError).toMatch(/self-review/i);
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
        { round: 1, score: 5, blocking: 1, verdict: "fixed" },
        { round: 2, score: 5, blocking: 1, verdict: "unresolved" },
      ]);
      expect(target.labels ?? []).toContain("review-score:5");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("parks on K consecutive LOW SCORES with the series attached, before the round cap (anton-i98r)", async () => {
    // Sustained low quality is a founder decision, not an infinite fix loop: two rounds at 3/10 stop
    // the converge loop with four rounds still on the clock, and the score SERIES — not just this
    // round's findings — is what the park carries, on the bead and on the run row.
    await setReviewEnabled(true, { reviewMaxRounds: 4, reviewMinScore: 5, reviewLowScoreRounds: 2 });
    const low = {
      score: 3,
      rationale: "the acceptance criteria are not met",
      findings: [{ severity: "blocking" as const, location: "src/q.ts:3", note: "AC-1 is not implemented" }],
    };
    script(low, low, low, low);
    const targetId = await approvedTarget("Regressing run");

    // Any attempt to open a PR is a loud failure: a run the reviewer scored 3/10 twice must not
    // reach the founder's merge gate wearing a self-reviewed badge.
    const boomGh = writeBin(
      binDir,
      "gh-boom-regression",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
console.error('gh boom: no PR may be opened for a score-regressed run');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      await expectJobStatus(tdb.db, jobId, "parked");

      // Stopped EARLY: the cap allowed four rounds and the alarm ended it after two.
      expect(dispatches()).toEqual(["implement", "review", "fix", "review"]);

      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;
      expect(run.status).toBe("parked");
      expect(run.error).toContain("(score-regression)");
      expect(run.error).toContain("2 consecutive review round(s) scored below 5/10 (3, 3)");
      expect(run.error).toContain("round 1: 3/10 · round 2: 3/10");

      // No PR, and the board carries the evidence a founder decides on.
      const target = await beads.show(repo, targetId);
      expect(beads.getPrRef(target) ?? null).toBeNull();
      const notes = target.notes ?? "";
      expect(notes).toContain("2 consecutive review round(s) scored below 5/10 (3, 3)");
      expect(notes).toContain("Score series: round 1: 3/10 · round 2: 3/10");
      expect(notes).toContain("AC-1 is not implemented");
      expect(scoreComments(targetId)).toMatchObject([
        { round: 1, score: 3, verdict: "fixed" },
        { round: 2, score: 3, verdict: "score-regression" },
      ]);
      expect(target.labels ?? []).toContain("review-score:3");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("drafts a PR a previous attempt orphaned on the branch instead of parking it mergeable", async () => {
    // The lost-ref window (anton-3apm): `gh pr create` lands server-side but its response — or the
    // best-effort setPrRef after it — is lost, so this retry sees no PR ref, re-runs, and blocks on
    // review. Parking blind would leave un-reviewed work mergeable at the founder's merge gate while
    // anton reports no PR was opened. The gate must find that PR, draft it, and say so.
    await setReviewEnabled(true);
    script({
      score: 2,
      rationale: "acceptance not met",
      findings: [{ severity: "blocking", location: "src/z.ts:1", note: "AC-1 is not implemented" }],
    });
    const targetId = await approvedTarget("Orphaned PR run");

    const ghLog = join(sandbox, "gh-orphan-calls.jsonl");
    const orphanGh = writeBin(
      binDir,
      "gh-orphan-review",
      `const fs=require('fs');const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(a)+'\\n');
if(a[0]==='pr'&&a[1]==='list'){
  process.stdout.write(JSON.stringify([{url:'https://github.com/acme/repo/pull/77',number:77,isDraft:false}])+'\\n');
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='ready'){process.exit(0);}
console.error('gh boom: no PR may be opened for an unresolved review');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = orphanGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      await expectJobStatus(tdb.db, jobId, "parked");

      // The orphan was converted to a draft — `--undo` is what makes a PR non-mergeable again.
      const calls = readFileSync(ghLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
      expect(calls).toContainEqual(["pr", "ready", "77", "--undo"]);

      // Run row and bead both name the PR instead of claiming none exists.
      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;
      expect(run.status).toBe("parked");
      expect(run.error).toContain("https://github.com/acme/repo/pull/77");
      expect(run.error).toMatch(/converted to a DRAFT/);
      const target = await beads.show(repo, targetId);
      expect(target.notes ?? "").toContain("https://github.com/acme/repo/pull/77");
      // Still NOT stamped as the epic's PR: a ref whose PR is open makes the next resume
      // short-circuit as finished, retiring the epic with its blocking findings unaddressed.
      expect(beads.getPrRef(target) ?? null).toBeNull();
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("says so when the orphan lookup FAILED instead of reporting that no PR was opened", async () => {
    // `gh` exits non-zero on an auth or network failure exactly as it does for a branch with no PR.
    // Reading that as "no PR" is the same false green the draft pass exists to prevent, one step
    // quieter: a live PR from an earlier attempt stays mergeable while anton reports none exists.
    await setReviewEnabled(true);
    script({
      score: 2,
      rationale: "acceptance not met",
      findings: [{ severity: "blocking", location: "src/z.ts:1", note: "AC-1 is not implemented" }],
    });
    const targetId = await approvedTarget("Unknown orphan run");

    const okGh = process.env.ANTON_GH_BIN!;
    // Every gh call fails the way an expired token does — including the orphan lookup.
    process.env.ANTON_GH_BIN = writeBin(
      binDir,
      "gh-auth-failed",
      `process.stderr.write('gh: HTTP 401: Bad credentials\\n');process.exit(1);`,
    );

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      await expectJobStatus(tdb.db, jobId, "parked");

      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;
      expect(run.error).toContain("could NOT check whether an earlier attempt left a PR open");
      expect(await beads.show(repo, targetId).then((b) => b.notes ?? "")).toContain(
        "could NOT check whether an earlier attempt left a PR open",
      );
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("defuses an orphaned PR when the gate DIES mid-review, not only when it refuses the work", async () => {
    // The same lost-ref window reached through a different door: the reviewer hits a usage limit
    // instead of returning a verdict, so the run parks for a retry — while the previous attempt's
    // untracked PR sits READY on the branch, one click from merging un-reviewed work. A gate exit
    // anton doesn't compose a park note for is still a gate exit with no PR of its own.
    await setReviewEnabled(true);
    const targetId = await approvedTarget("Quota mid-review run");

    const resetSec = Math.floor(clock.now() / 1000) + 3600;
    // Implements normally, then hits the quota on the review dispatch (told apart by the same
    // protocol marker the suite's shared fake uses).
    const quotaReviewClaude = writeBin(
      binDir,
      "claude-quota-review",
      fakeClaudeReadingStdin(`const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(prompt.includes('## Reporting format (required)')){
  e({type:'result',subtype:'error',result:'Claude AI usage limit reached|${resetSec}',is_error:true});
  process.exit(0);
}
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+'\\n');
e({type:'system',subtype:'init',session_id:'sq'});
e({type:'assistant',message:{content:[{type:'text',text:'done'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'sq',num_turns:1,is_error:false});
process.exit(0);`),
    );

    const ghLog = join(sandbox, "gh-quota-orphan-calls.jsonl");
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = writeBin(
      binDir,
      "gh-quota-orphan",
      `const fs=require('fs');const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(a)+'\\n');
if(a[0]==='pr'&&a[1]==='list'){
  process.stdout.write(JSON.stringify([{url:'https://github.com/acme/repo/pull/91',number:91,isDraft:false}])+'\\n');
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='ready'){process.exit(0);}
console.error('gh boom: no PR may be opened for a review that never finished');process.exit(1);`,
    );
    process.env.ANTON_CLAUDE_BIN = quotaReviewClaude;

    const runner = makeEpicRunner(ctx, { quotaCooloffMs: 60_000 });
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      // A quota failure reschedules the job rather than parking it for a human — the run row is what
      // reports the orphan.
      await expectJobStatus(tdb.db, jobId, "queued");

      const calls = readFileSync(ghLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
      expect(calls).toContainEqual(["pr", "ready", "91", "--undo"]);

      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;
      expect(run.status).toBe("parked");
      // The quota classification still drives the runner's backoff — the orphan rides along with it.
      expect(run.error).toMatch(/^usage-limit/);
      expect(run.error).toContain("https://github.com/acme/repo/pull/91");
      expect(run.error).toMatch(/converted to a DRAFT/);
      // Still not stamped as the epic's PR: a ref whose PR is open short-circuits the next resume.
      expect(beads.getPrRef(await beads.show(repo, targetId)) ?? null).toBeNull();
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("defuses the orphan — and keeps the finished round — when the run's own LEASE lapses mid-gate", async () => {
    // A lease this run couldn't KEEP (its refresh writes to the shared board are failing) is not
    // evidence that another machine owns the branch: nothing read a foreign lease. Treating it as
    // such skipped the reconcile and left the previous attempt's untracked PR ready and mergeable,
    // with the round the gate had already scored lost to the reschedule on top of it.
    await setReviewEnabled(true);
    script({
      score: 6,
      rationale: "one guard missing",
      findings: [{ severity: "blocking", location: "src/z.ts:1", note: "guard the null case" }],
    });
    const targetId = await approvedTarget("Lapsed lease run");

    // Lapses the run-lease the moment the REVIEW has been dispatched — the gate re-checks it before
    // dispatching the fix, which is the window a review → fix → re-review sequence spends past the
    // TTL. A full TTL (15 min) plus a minute, so the check reads the lease as expired.
    const reviewed = () => readFileSync(invocationsPath, "utf8").includes("review");
    class LapsingClock extends FakeClock {
      now() {
        return super.now() + (reviewed() ? 16 * 60_000 : 0);
      }
    }

    const ghLog = join(sandbox, "gh-lapsed-lease-calls.jsonl");
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = writeBin(
      binDir,
      "gh-lapsed-lease",
      `const fs=require('fs');const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(a)+'\\n');
if(a[0]==='pr'&&a[1]==='list'){
  process.stdout.write(JSON.stringify([{url:'https://github.com/acme/repo/pull/58',number:58,isDraft:false}])+'\\n');
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='ready'){process.exit(0);}
console.error('gh boom: no PR may be opened under a lapsed lease');process.exit(1);`,
    );

    const runner = makeEpicRunner({ tdb, clock: new LapsingClock(clock.now()) });
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      // A lease conflict reschedules the job (and refunds the attempt) rather than parking it.
      await expectJobStatus(tdb.db, jobId, "queued");
      // The lease died before the fix could be dispatched — nothing was written under it.
      expect(dispatches()).toEqual(["implement", "review"]);

      const calls = readFileSync(ghLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
      expect(calls).toContainEqual(["pr", "ready", "58", "--undo"]);

      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;
      expect(run.status).toBe("parked");
      // The lease classification still drives the runner's recovery — the orphan rides along.
      expect(run.error).toMatch(/^run-live-elsewhere/);
      expect(run.error).toContain("https://github.com/acme/repo/pull/58");
      expect(run.error).toMatch(/converted to a DRAFT/);

      // And the round the gate DID finish is on the board: the run is rescheduled and its resumed
      // gate restarts at round 1, so a score never written here is lost with the attempt.
      expect(scoreComments(targetId)).toMatchObject([
        { round: 1, score: 6, blocking: 1, advisory: 0, verdict: "interrupted" },
      ]);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("records the review's ADVISORIES on the bead when it parks on a blocking finding", async () => {
    // A parked run opens no PR, and the PR body is where advisories normally reach the founder. The
    // resumed run re-reviews from scratch with an empty carry, so an advisory nobody wrote down here
    // can vanish between the review that found it and the merge gate it was meant to reach.
    await setReviewEnabled(true);
    // At the alarm's threshold, so the park under test is the blocking one (see the cap case above).
    const mixed = {
      score: 5,
      rationale: "AC-2 unmet",
      findings: [
        { severity: "blocking", location: "src/z.ts:1", note: "AC-2 is not implemented" },
        { severity: "advisory", location: "src/a.ts:10", note: "extract the duplicated mapper" },
      ],
    };
    script(mixed, mixed); // the fix never resolves it → parks with both findings still open
    const targetId = await approvedTarget("Parked advisory run");

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });
      await expectJobStatus(tdb.db, jobId, "parked");

      const notes = (await beads.show(repo, targetId)).notes ?? "";
      expect(notes).toContain("AC-2 is not implemented");
      expect(notes).toContain("Advisory findings from the same review (1)");
      expect(notes).toContain("extract the duplicated mapper");
    } finally {
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
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
console.error('gh boom: no PR may be opened on an unreported review');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      await expectJobStatus(tdb.db, jobId, "parked");
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
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
console.error('gh boom: no PR may be opened on an unreadable review report');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      await expectJobStatus(tdb.db, jobId, "parked");
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

  it("parks when the reviewer scores without a rationale — a bare number is not a review", async () => {
    // The contract makes the rationale the Acceptance-grounded half of the verdict. Accepting a
    // number on its own would pass a run whose reviewer never said which criteria it checked, and
    // leave the founder a score on the board with nothing behind it.
    await setReviewEnabled(true);
    script({ score: 9, findings: [] });
    const targetId = await approvedTarget("Rationale-less report run");

    const boomGh = writeBin(
      binDir,
      "gh-boom-rationale",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
console.error('gh boom: no PR may be opened on an unjustified score');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      await expectJobStatus(tdb.db, jobId, "parked");
      expect(dispatches()).toEqual(["implement", "review"]);

      const target = await beads.show(repo, targetId);
      expect(beads.getPrRef(target) ?? null).toBeNull();
      expect(target.notes ?? "").toMatch(/score with no rationale/i);
      expect(scoreComments(targetId)).toMatchObject([{ round: 1, verdict: "protocol-violation" }]);
      // The 9 is not banked: anton cannot tell a graded run from an ungraded one without the reason.
      expect((target.labels ?? []).some((l) => l.startsWith("review-score:"))).toBe(false);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("parks with the RIGHT reason when the reviewer signs off after its report block", async () => {
    // A clean-scoring block followed by prose that takes it back. The park note must name the
    // envelope — an operator told "never reported a valid score" would go hunting for a silent
    // reviewer when the reviewer in fact scored and then retracted.
    await setReviewEnabled(true);
    script({ score: 9, rationale: "clean", findings: [] });
    const targetId = await approvedTarget("Trailing sign-off run");

    const boomGh = writeBin(
      binDir,
      "gh-boom-trailing",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
console.error('gh boom: no PR may be opened on a retracted review');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;
    process.env.ANTON_TEST_REVIEW_TRAILING = "1";

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      await expectJobStatus(tdb.db, jobId, "parked");
      expect(dispatches()).toEqual(["implement", "review"]);

      const target = await beads.show(repo, targetId);
      expect(beads.getPrRef(target) ?? null).toBeNull();
      expect(target.notes ?? "").toMatch(/appended text AFTER its report block/i);
      expect(target.notes ?? "").not.toMatch(/never reported a valid score/i);
      // The 9 it printed is not banked: a retracted verdict is no verdict.
      expect(scoreComments(targetId)).toMatchObject([{ round: 1, verdict: "protocol-violation" }]);
      expect((target.labels ?? []).some((l) => l.startsWith("review-score:"))).toBe(false);
    } finally {
      delete process.env.ANTON_TEST_REVIEW_TRAILING;
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
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
console.error('gh boom: no PR may be opened on a review that edited the code');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;
    process.env.ANTON_TEST_REVIEW_MUTATES = "1";

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      await expectJobStatus(tdb.db, jobId, "parked");
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

  it("parks the RUN — not fails it — when the gate itself raises poison", async () => {
    // The gate parks for a human on more than a blocking verdict: an unrevertable reviewer commit, a
    // fixer that switched branches, or (scripted here) a round cap that forbids it from ever
    // reviewing all throw PoisonError from inside it. Marking the run `failed` would hide the row
    // from findOpenRunForEpic, so the repair-then-resume the founder is told to do would start a
    // REPLACEMENT run instead of continuing this one and its session history.
    await setReviewEnabled(true, { reviewMaxRounds: 0 });
    const targetId = await approvedTarget("Gate poison run");

    const boomGh = writeBin(
      binDir,
      "gh-boom-gate-poison",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
console.error('gh boom: no PR may be opened when the gate never reviewed');process.exit(1);`,
    );
    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = boomGh;

    const runner = makeEpicRunner(ctx);
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: targetId });

      await expectJobStatus(tdb.db, jobId, "parked");
      // No reviewer ever ran — that is the poison.
      expect(dispatches()).toEqual(["implement"]);

      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;
      expect(run.status).toBe("parked");
      expect(run.endedAt ?? null).toBeNull();
      expect(run.error).toMatch(/ran no rounds/);

      expect(beads.getPrRef(await beads.show(repo, targetId)) ?? null).toBeNull();
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      await setReviewEnabled(true, { reviewMaxRounds: undefined });
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
      await expectJobStatus(tdb.db, jobId1, "done");
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
        await expectJobStatus(tdb.db, jobId2, "done");
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
