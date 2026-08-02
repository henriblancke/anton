/**
 * End-to-end proof that a run IS a walk over the project's formula (anton-lnkt), not a sequence
 * anton holds in code. Two properties, both invisible to a unit test:
 *
 * 1. **Reordering the formula reorders the run, with no anton code change.** The same handler, the
 *    same tickets, the same fake claude — only the `.beads/formulas/anton-run.formula.toml` differs
 *    — and the verify gate moves from once-per-ticket to once-per-run because the project moved it
 *    past the commit.
 * 2. **A run that dies mid-walk resumes at the step git says it reached.** There is no second store
 *    of run progress: the resumed walk re-reads the board and the branch, skips the ticket whose
 *    commit is already there, and re-runs the one that never landed.
 * 3. **The work's own labels can pick the pipeline (anton-aa3m).** With a `risk:high → <formula>`
 *    mapping configured, a run over a `risk:high` target walks that formula's extra step and its run
 *    row NAMES the formula; an unlabelled target in the same project still walks the default.
 *
 * The "formula walk" slice of `execute-epic.integration.test.ts`, split out to run in parallel with
 * its siblings (anton-0oi). Drives the REAL handler + runner + bd/git with fake `claude`/`gh`.
 * Skipped without bd + git.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beads } from "../beads/bd";
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

/** A pipeline step, written the way a project writes one: an id, its `needs`, and its handler label. */
const step = (id: string, handler: string, needs?: string) =>
  `[[steps]]\nid = "${id}"\ntype = "task"\ntitle = "${id}"\n` +
  (needs ? `needs = ["${needs}"]\n` : "") +
  `labels = ["step:${handler}"]\n`;

describeBd("execute-epic e2e — the formula walk (real handler · real bd/git · fake claude/gh)", () => {
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let projectId: string;
  let successClaude: string;
  let ctx: ExecuteEpicSandbox;
  /** The project-local pipeline a case installs; removed after every case. */
  let formulaPath: string;
  /** Any NAMED pipelines a case installs (per-label variants); removed after every case. */
  const extraFormulas: string[] = [];

  /** Install the project's own pipeline — the file that wins over anton's bundled default. */
  const writeProjectFormula = (steps: string) => {
    mkdirSync(join(repo, ".beads", "formulas"), { recursive: true });
    writeFileSync(
      formulaPath,
      `formula = "anton-run"\ntype = "workflow"\nversion = 1\n\n${steps}`,
      "utf8",
    );
  };

  /** A named pipeline of the project's own — how a per-label variant (anton-aa3m) is installed. */
  const writeNamedFormula = (name: string, steps: string) => {
    mkdirSync(join(repo, ".beads", "formulas"), { recursive: true });
    const path = join(repo, ".beads", "formulas", `${name}.formula.toml`);
    writeFileSync(path, `formula = "${name}"\ntype = "workflow"\nversion = 1\n\n${steps}`, "utf8");
    extraFormulas.push(path);
    return path;
  };

  /** Merge a settings patch into the sandbox project's settingsJson. */
  const patchSettings = async (patch: Record<string, unknown>) => {
    const proj = (
      await tdb.db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    )[0];
    const base = JSON.parse(proj.settingsJson ?? "{}") as Record<string, unknown>;
    await tdb.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ ...base, ...patch }) })
      .where(eq(schema.projects.id, projectId));
  };

  /** Point the project's verify gate at a command that records each time it runs. */
  const recordVerifyInto = (orderLog: string) =>
    // Still a real gate (the work file must exist) — it just leaves a trace of WHEN it ran.
    patchSettings({ testCommand: `test -f AGENT_WORK.md && printf 'verify\\n' >> ${orderLog}` });

  /** An approved epic with two tickets — enough for "per ticket" and "per run" to differ. */
  const approvedEpic = async (
    title: string,
    labels?: string[],
  ): Promise<{ id: string; tickets: string[] }> => {
    const id = await beads.create(repo, {
      title,
      type: "epic",
      acceptance: "work file exists",
      description: `## Goal\n${title}`,
      labels,
    });
    const tickets = ["one", "two"].map((n) =>
      createTicket(repo, { title: `${title} ${n}`, parent: id, acceptance: "work file exists" }),
    );
    await beads.approve(repo, id);
    return { id, tickets };
  };

  const lines = (path: string): string[] =>
    existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ sandbox, repo, binDir, tdb, clock, projectId, successClaude } = ctx);
    formulaPath = join(repo, ".beads", "formulas", "anton-run.formula.toml");
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

  // A project-local pipeline is read from the repo on every run, so leaving one behind would
  // silently re-shape every later case in this file.
  afterEach(async () => {
    rmSync(formulaPath, { force: true });
    for (const path of extraFormulas.splice(0)) rmSync(path, { force: true });
    // Settings outlive a case (only sessions/runs/jobs are reset), and a stray label→formula map
    // would re-shape every later case in this file.
    await patchSettings({ formulaVariants: undefined });
  });

  it("walks anton's default pipeline: the verify gate runs once per TICKET, before each commit", async () => {
    // The baseline the reordering case is measured against. No project formula → anton's bundled
    // default (implement → verify → commit → review → pr), so the gate sits inside the ticket phase.
    const orderLog = join(sandbox, "order-default.log");
    await recordVerifyInto(orderLog);
    const { id: epicId, tickets } = await approvedEpic("Default pipeline");

    const orderClaude = writeBin(
      binDir,
      "claude-order-default",
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(orderLog)},'implement '+(m?m[1]:'?')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'s'});
e({type:'result',subtype:'success',result:'done',session_id:'s',num_turns:1,is_error:false});
process.exit(0);`),
    );

    process.env.ANTON_CLAUDE_BIN = orderClaude;
    try {
      const jobId = await driveEpicRun(runnerFor(), { projectId, epicBeadId: epicId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // Each ticket implements, then is verified, then commits — so the gate ran twice, interleaved.
      const order = lines(orderLog);
      expect(order).toHaveLength(4);
      expect(order.filter((l) => l === "verify")).toHaveLength(2);
      expect(order[1]).toBe("verify");
      expect(order[3]).toBe("verify");
      for (const t of tickets) expect((await beads.show(repo, t)).status).toBe("closed");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  });

  it("reorders the run when the project reorders the formula — verify AFTER the commit, no code change", async () => {
    // The SAME handler, tickets and fake claude as the case above; only the pipeline file differs.
    // Moving `step:verify` past the commit moves it out of the ticket phase, so it runs ONCE over
    // the finished run instead of once per ticket — which is the whole point of owning the formula.
    const orderLog = join(sandbox, "order-reordered.log");
    await recordVerifyInto(orderLog);
    writeProjectFormula(
      step("implement", "implement") +
        "\n" +
        step("commit", "commit", "implement") +
        "\n" +
        step("verify", "verify", "commit") +
        "\n" +
        step("pr", "pr", "verify"),
    );
    const { id: epicId, tickets } = await approvedEpic("Reordered pipeline");

    const orderClaude = writeBin(
      binDir,
      "claude-order-reordered",
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(orderLog)},'implement '+(m?m[1]:'?')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'s'});
e({type:'result',subtype:'success',result:'done',session_id:'s',num_turns:1,is_error:false});
process.exit(0);`),
    );

    process.env.ANTON_CLAUDE_BIN = orderClaude;
    try {
      const jobId = await driveEpicRun(runnerFor(), { projectId, epicBeadId: epicId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // Both tickets implemented first; the gate ran exactly once, at the end.
      const order = lines(orderLog);
      expect(order).toHaveLength(3);
      expect(order.slice(0, 2).every((l) => l.startsWith("implement"))).toBe(true);
      expect(order[2]).toBe("verify");

      // And the run still delivered everything the floor guarantees: both tickets closed on their
      // own commits, one PR, the epic in review.
      for (const t of tickets) expect((await beads.show(repo, t)).status).toBe("closed");
      const log = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/anton/${epicId}`], {
        encoding: "utf8",
      });
      for (const t of tickets) expect(log).toContain(`${t}:`);
      const epic = await beads.show(repo, epicId);
      expect(beads.getPrRef(epic)).toBe("gh-42");
      expect(epic.labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  });

  it("resumes a run that died mid-walk at the step the git/label evidence says it reached", async () => {
    // Nothing records "the walk got to step N" — git does. The first attempt lands one ticket's
    // commit and dies dispatching the next; the resumed walk re-reads the board and the branch, so
    // the committed ticket is skipped (its commit is on the branch) and only the one that never
    // landed re-runs, before the run phase opens the single PR.
    const invLog = join(sandbox, "resume-dispatches.log");
    const { id: epicId, tickets } = await approvedEpic("Dies mid-walk");

    // Fails the SECOND dispatch of the run's whole lifetime; the log doubles as the counter, so the
    // resumed attempt's dispatch (the third) succeeds.
    const flakyClaude = writeBin(
      binDir,
      "claude-mid-walk",
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);const ticket=m?m[1]:'?';
const log=${JSON.stringify(invLog)};
fs.appendFileSync(log,ticket+'\\n');
const n=fs.readFileSync(log,'utf8').trim().split('\\n').length;
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'sw'});
if(n===2){e({type:'result',subtype:'error',result:'boom — claude fell over mid-walk',is_error:true});process.exit(0);}
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+ticket+'\\n');
e({type:'result',subtype:'success',result:'done',session_id:'sw',num_turns:1,is_error:false});
process.exit(0);`),
    );

    const runner = runnerFor();
    process.env.ANTON_CLAUDE_BIN = flakyClaude;
    let jobId: string | undefined;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: epicId });

      // Attempt 1 died in the ticket phase: one ticket committed + closed, the other back in the
      // ready pool, no PR.
      const run1 = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epicId)!;
      expect(run1.status).toBe("failed");
      const dispatched = lines(invLog);
      expect(dispatched).toHaveLength(2);
      const [landed, doomed] = dispatched;
      expect(landed).not.toBe(doomed);
      expect((await beads.show(repo, landed)).status).toBe("closed");
      expect((await beads.show(repo, doomed)).status).toBe("open");
      expect(beads.getPrRef(await beads.show(repo, epicId))).toBeUndefined();

      // The evidence the resume reads: the landed ticket's commit is on the branch, the other's isn't.
      const branchLog = () =>
        execFileSync("git", ["-C", repo, "log", "--oneline", `anton/${epicId}`], {
          encoding: "utf8",
        });
      expect(branchLog()).toContain(`${landed}:`);
      expect(branchLog()).not.toContain(`${doomed}:`);

      // Resume the same job. A failed run row is not reopened (findOpenRunForEpic ignores it), so
      // the resumed attempt gets a fresh row — and picks up the SAME worktree, which is where the
      // evidence it walks by lives.
      expect(await park(tdb.db, clock, jobId, "test: simulate resume")).toBe(true);
      expect(await resumeJob(tdb.db, clock, jobId)).toBe(true);
      await tickToIdle(runner);

      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      const runs = (await tdb.db.select().from(schema.runs)).filter((r) => r.epicBeadId === epicId);
      const resumed = runs.find((r) => r.status === "done")!;
      expect(resumed).toBeTruthy();
      expect(resumed.worktreePath).toBe(run1.worktreePath); // reused, not started over

      // The walk picked up where the evidence said it was: the committed ticket was NOT re-dispatched
      // (still one invocation), the failed one ran again, and the run phase then opened the one PR.
      const after = lines(invLog);
      expect(after.filter((t) => t === landed)).toHaveLength(1);
      expect(after.filter((t) => t === doomed)).toHaveLength(2);
      for (const t of tickets) expect((await beads.show(repo, t)).status).toBe("closed");
      const pushed = execFileSync(
        "git",
        ["-C", repo, "log", "--oneline", `origin/anton/${epicId}`],
        { encoding: "utf8" },
      );
      for (const t of tickets) expect(pushed).toContain(`${t}:`);
      // Exactly one commit per ticket — the skipped one was not re-committed.
      expect(pushed.split("\n").filter((l) => l.includes(`${landed}:`))).toHaveLength(1);
      const epic = await beads.show(repo, epicId);
      expect(beads.getPrRef(epic)).toBe("gh-42");
      expect(epic.labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("walks the label's own pipeline: risk:high runs the variant's extra step, and the run names it", async () => {
    // The point of per-label variants (anton-aa3m): risk drives process. The heavy pipeline verifies
    // ONE MORE TIME over the finished run — a step the default doesn't have — and the run record has
    // to say which formula it walked, because "why did this run do that" is now project-specific.
    const orderLog = join(sandbox, "order-variant.log");
    await recordVerifyInto(orderLog);
    const variantPath = writeNamedFormula(
      "anton-run-risk-high",
      step("implement", "implement") +
        "\n" +
        step("verify", "verify", "implement") +
        "\n" +
        step("commit", "commit", "verify") +
        "\n" +
        step("final-check", "verify", "commit") +
        "\n" +
        step("pr", "pr", "final-check"),
    );
    await patchSettings({
      formulaVariants: [{ label: "risk:high", formula: "anton-run-risk-high" }],
    });
    const { id: epicId, tickets } = await approvedEpic("Risky work", ["risk:high"]);

    const orderClaude = writeBin(
      binDir,
      "claude-order-variant",
      fakeClaudeReadingStdin(`const m=prompt.match(/Ticket: (\\S+)/);
fs.appendFileSync(${JSON.stringify(orderLog)},'implement '+(m?m[1]:'?')+'\\n');
fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'s'});
e({type:'result',subtype:'success',result:'done',session_id:'s',num_turns:1,is_error:false});
process.exit(0);`),
    );

    process.env.ANTON_CLAUDE_BIN = orderClaude;
    try {
      const jobId = await driveEpicRun(runnerFor(), { projectId, epicBeadId: epicId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // Two tickets verified in the ticket phase, then the variant's extra run-wide check — three
      // gate runs where the default pipeline does two.
      const order = lines(orderLog);
      expect(order.filter((l) => l === "verify")).toHaveLength(3);
      expect(order[order.length - 1]).toBe("verify");

      // The run record NAMES the pipeline and the label that chose it.
      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epicId)!;
      expect(run.formula).toBe(variantPath);
      expect(run.formulaVariant).toBe("risk:high");

      // And the floor still held: both tickets committed and closed, one PR, epic in review.
      for (const t of tickets) expect((await beads.show(repo, t)).status).toBe("closed");
      const epic = await beads.show(repo, epicId);
      expect(beads.getPrRef(epic)).toBe("gh-42");
      expect(epic.labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  });

  it("leaves an unmapped target on the default pipeline, in the same project, same settings", async () => {
    // The other half of the guarantee: a variant map changes NOTHING for work that doesn't carry a
    // mapped label — same project, same mapping in settings, plain default walk.
    const orderLog = join(sandbox, "order-unmapped.log");
    await recordVerifyInto(orderLog);
    writeNamedFormula(
      "anton-run-risk-high",
      step("implement", "implement") +
        "\n" +
        step("commit", "commit", "implement") +
        "\n" +
        step("pr", "pr", "commit"),
    );
    await patchSettings({
      formulaVariants: [{ label: "risk:high", formula: "anton-run-risk-high" }],
    });
    const { id: epicId } = await approvedEpic("Routine work", ["risk:low"]);

    const orderClaude = writeBin(
      binDir,
      "claude-order-unmapped",
      fakeClaudeReadingStdin(`fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+'\\n');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'s'});
e({type:'result',subtype:'success',result:'done',session_id:'s',num_turns:1,is_error:false});
process.exit(0);`),
    );

    process.env.ANTON_CLAUDE_BIN = orderClaude;
    try {
      const jobId = await driveEpicRun(runnerFor(), { projectId, epicBeadId: epicId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");

      // anton's default: the gate runs once per ticket and not again.
      expect(lines(orderLog).filter((l) => l === "verify")).toHaveLength(2);

      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epicId)!;
      expect(run.formula?.endsWith("anton-run.formula.toml")).toBe(true);
      expect(run.formulaVariant).toBeNull();
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
    }
  });

  /** The runner every case drives — one job in flight, on the shared sandbox db + clock. */
  function runnerFor() {
    return makeEpicRunner({ tdb, clock });
  }
});
