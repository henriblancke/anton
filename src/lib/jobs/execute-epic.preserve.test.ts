/**
 * What a timed-out ticket's preserve DECIDES, against real git (anton-d967 / PR #228 review).
 *
 * Three facts the end-to-end budget suite cannot reach cheaply, and each one is a way the preserve
 * can lose work or lie about it:
 *
 * - a job-level abort landing inside the verify window (up to 15 minutes) must not be read as a
 *   failed gate — that verdict hard-resets the worktree to the baseline and writes the board, which
 *   is exactly what an operator's kill must NOT do;
 * - a resume that starts FROM a preserved commit and times out again without touching the tree still
 *   has its work on the branch, so it must report that rather than "nothing was kept";
 * - a run that gained child tickets since the preserve may not start on a branch that still carries
 *   the parent's incomplete commit — the children's pull request would ship it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeTestDb, type TestDb } from "../db/testing";
import type { Bead } from "../beads/bd";
import type { Worktree } from "../git/worktree";
import type { ProjectSettings } from "../projects";
import { readWorktreeState } from "../git/ops";
import { isPoisonError } from "./errors";
import { outOfTimeParkMessage } from "./execute-epic-dispatch";
import { assertPreservedWorkFitsShape } from "./execute-epic-prepare";
import type { EpicRun } from "./execute-epic-run";
import { preserveTimedOutWork } from "./execute-epic-ticket";
import type { Clock } from "./queue";
import type { StepContext } from "./step-registry";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

const BRANCH = "anton/anton-d967";

const ticket: Bead = {
  id: "anton-d967",
  title: "A ticket timeout destroys finished work",
  status: "in_progress",
  issue_type: "feature",
};

class FixedClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

suite("preserveTimedOutWork (real git)", () => {
  let sandbox: string;
  let repo: string;
  let logPath: string;
  let tdb: TestDb;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const out = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const head = () => out(["rev-parse", "HEAD"]);
  const subjects = () => out(["log", "--format=%s"]).split("\n");
  const write = (name: string, body: string) => writeFileSync(join(repo, name), body);

  /** The run the preserve reads: the worktree it judges, and the signal its gates run on. */
  function run(
    signal: AbortSignal,
    settings: ProjectSettings = {},
  ): Omit<StepContext, "tickets"> {
    return {
      db: tdb.db,
      clock: new FixedClock(1_700_000_000_000),
      ctx: { signal, heartbeat: async () => {}, report: () => {} },
      projectId: randomUUID(),
      runId: randomUUID(),
      repoPath: repo,
      worktreePath: repo,
      branch: BRANCH,
      baseBranch: "main",
      baseRef: "origin/main",
      target: ticket,
      settings,
    };
  }

  beforeEach(() => {
    tdb = makeTestDb();
    sandbox = mkdtempSync(join(tmpdir(), "anton-preserve-"));
    repo = join(sandbox, "repo");
    logPath = join(sandbox, "session.log");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    write("README.md", "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["checkout", "-q", "-b", BRANCH]);
  });

  afterEach(() => {
    tdb.close();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  // The data-loss race the verification window opens: the gates run on the JOB's signal (the ticket's
  // is already spent), so an operator's kill, a lost lease or the runner's no-progress timeout
  // rejects them exactly as a broken tree does. Classified as a gate failure it would reset the
  // worktree to the baseline — deleting up to a whole ticket's work that nobody judged unfit.
  it("reports the JOB's abort rather than a failed gate, and keeps its hands off the tree", async () => {
    const baseline = await readWorktreeState(repo);
    write("HALF_WRITTEN.md", "the work the abort must not delete\n");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 150);

    const kept = await preserveTimedOutWork({
      run: run(abort.signal, { testCommand: "sleep 5" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({ jobAborted: true });
    // Nothing committed, nothing reverted: the work and the board belong to whoever stopped the run.
    expect(head()).toBe(baseline.head);
    expect(out(["status", "--porcelain"])).toContain("HALF_WRITTEN.md");
  });

  // The refusal that survives the abort check above: a gate that genuinely fails on a live job is
  // still the rollback it always was, and the bead still gets the reason.
  it("still rolls back a tree that fails the gates while the job is alive", async () => {
    const baseline = await readWorktreeState(repo);
    write("HALF_WRITTEN.md", "work that does not verify\n");

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "exit 1" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toMatchObject({
      rolledBackWhy: expect.stringContaining("does not pass this project's verify gates"),
    });
    expect(head()).toBe(baseline.head);
  });

  // A repeated timeout on a childless target: the tree is untouched because the work is ALREADY in
  // the baseline, as the previous attempt's preserved commit. Reported as rolled back, the bead note
  // and the park would tell the operator the work is gone and the resume starts over — when in fact
  // it continues from that commit.
  it("keeps reporting the work a previous attempt preserved when this one changed nothing", async () => {
    write("HALF_WRITTEN.md", "work preserved by the attempt before this one\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", `WIP ${ticket.id}: ${ticket.title}`]);
    const baseline = await readWorktreeState(repo);

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "exit 1" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    // Reported as preserved — and the gates were never asked, because nothing new was written.
    expect(kept).toEqual({ branch: BRANCH, retained: true });
    expect(head()).toBe(baseline.head);
    expect(subjects()).toContain(`WIP ${ticket.id}: ${ticket.title}`);
  });

  // …and the same "nothing new" tree with no preserved commit behind it is what it always was.
  it("reports an empty attempt as such when nothing of this ticket is on the branch", async () => {
    const baseline = await readWorktreeState(repo);

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "exit 1" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({ rolledBackWhy: "it left nothing in the worktree" });
  });
});

suite("assertPreservedWorkFitsShape — preserved work may only ride the shape that kept it", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const worktree = (): Worktree => ({
    path: repo,
    branch: BRANCH,
    baseBranch: "main",
    repoPath: repo,
  });
  const epicRun = (standaloneRun: boolean): EpicRun =>
    ({ targetId: ticket.id, standaloneRun }) as unknown as EpicRun;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-preserve-shape-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["checkout", "-q", "-b", BRANCH]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  const preserve = () => {
    writeFileSync(join(repo, "HALF_WRITTEN.md"), "incomplete\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", `WIP ${ticket.id}: ${ticket.title}`]);
  };

  // Following the park's own advice — split the target into children — changes the run's shape, and
  // the children then dispatch on a branch that still carries the parent's incomplete commit. The
  // first delivery among them opens a pull request whose diff ships it into the trunk, under a
  // delivery it is no part of. That is what the standalone-only limit exists to prevent, so the new
  // shape is refused until a person reconciles the commit.
  it("parks a run that gained children while its parent's preserved commit is still on the branch", async () => {
    preserve();

    const err = await assertPreservedWorkFitsShape(epicRun(false), worktree()).catch(
      (e: unknown) => e,
    );

    expect(isPoisonError(err)).toBe(true);
    expect((err as Error).message).toContain(`WIP ${ticket.id}:`);
    expect((err as Error).message).toContain(BRANCH);
    expect((err as Error).message).toMatch(/resume the run/);
  });

  it("lets the standalone run that KEPT the work carry on — the resume it was parked for", async () => {
    preserve();
    await expect(assertPreservedWorkFitsShape(epicRun(true), worktree())).resolves.toBeUndefined();
  });

  it("says nothing about a multi-ticket run whose branch carries no preserved commit", async () => {
    await expect(assertPreservedWorkFitsShape(epicRun(false), worktree())).resolves.toBeUndefined();
  });
});

describe("outOfTimeParkMessage — what the operator may safely do next (anton-d967)", () => {
  const parkRun = (preserved: boolean): EpicRun =>
    ({
      targetId: ticket.id,
      branch: BRANCH,
      standaloneRun: true,
      ticketTimeoutMs: 45 * 60_000,
      timedOut: [{ id: ticket.id, committed: false, ...(preserved ? { preserved: true } : {}) }],
    }) as unknown as EpicRun;

  it("warns that splitting means taking the preserved commit off the branch first", () => {
    const message = outOfTimeParkMessage(parkRun(true), []);

    expect(message).toContain(`split ${ticket.id} into child tickets`);
    expect(message).toMatch(/PRESERVED on branch/);
    expect(message).toMatch(/taking the preserved commit off/);
    expect(message).toContain(BRANCH);
  });

  it("keeps the plain advice when the work was rolled back — there is nothing to reconcile", () => {
    const message = outOfTimeParkMessage(parkRun(false), []);

    expect(message).toContain(`split ${ticket.id} into child tickets`);
    expect(message).not.toMatch(/preserved commit/);
    expect(message).toMatch(/rolled back, so resuming starts it over/);
  });
});
