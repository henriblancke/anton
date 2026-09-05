/**
 * What a timed-out ticket's preserve DECIDES, against real git (anton-d967 / PR #228 review).
 *
 * Facts the end-to-end budget suite cannot reach cheaply, and each one is a way the preserve can
 * lose work or lie about it:
 *
 * - a job-level abort landing inside the verify window (up to 15 minutes) must not be read as a
 *   failed gate — that verdict hard-resets the worktree to the baseline and writes the board, which
 *   is exactly what an operator's kill must NOT do;
 * - nor may one landing while the preserved commit is being made be read as a preserve — the commit
 *   stays, but the board belongs to whoever stopped the run;
 * - a resume that starts FROM a preserved commit and times out again still has that work on the
 *   branch, whether it touched the tree or had its additions refused, so it must report that rather
 *   than "nothing was kept";
 * - a run that gained child tickets since the preserve may not start on a branch that still carries
 *   the parent's incomplete commit — the children's pull request would ship it, and a branch whose
 *   history cannot be READ proves nothing about whether it does;
 * - a kill that lands after the preserve has decided but before the timeout writes the board still
 *   owns the ticket — the abort path writes nothing, and neither may this one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeTestDb, type TestDb } from "../db/testing";
import { beads, LABELS, type Bead } from "../beads/bd";
import type { Worktree } from "../git/worktree";
import type { ProjectSettings } from "../projects";
import { COMMIT_TIMEOUT_ENV, readWorktreeState } from "../git/ops";
import { isPoisonError } from "./errors";
import { TicketTimeoutError } from "./execute-epic-errors";
import { outOfTimeParkMessage } from "./execute-epic-dispatch";
import { assertPreservedWorkFitsShape } from "./execute-epic-prepare";
import type { EpicRun } from "./execute-epic-run";
import { preserveTimedOutWork, settleTicketTimeout } from "./execute-epic-ticket";
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
    delete process.env[COMMIT_TIMEOUT_ENV];
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

    expect(kept).toEqual({ rolledBackWhy: "it left nothing in the worktree", retainedOn: null });
  });

  // The same resume, one step further: it DID write something, and the gates refuse it. The rollback
  // drops only what this attempt added — the commit it started from stays on the branch — so a bare
  // "rolled back" would tell the operator work that is still there was thrown away, and send the
  // next resume off to redo it.
  it("keeps reporting the previous attempt's work when this one's additions are refused", async () => {
    write("HALF_WRITTEN.md", "work preserved by the attempt before this one\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", `WIP ${ticket.id}: ${ticket.title}`]);
    const baseline = await readWorktreeState(repo);
    write("MORE.md", "what this attempt added, and the gates refuse\n");

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
      retainedOn: BRANCH,
    });
    expect(subjects()).toContain(`WIP ${ticket.id}: ${ticket.title}`);
  });

  // The same resume once more, at the exit that runs FIRST (PR #228 review): `step:commit` adopted
  // the preserved commit, the delivery gate refused it, and the deadline landed. Nothing was rolled
  // back — the commit is where it always was — so an exit that reported no preserved branch would
  // hand the park a ticket it says starts over, and send the next resume off to redo kept work.
  it("reports the branch's preserved commit even when this attempt already committed", async () => {
    write("HALF_WRITTEN.md", "work preserved by the attempt before this one\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", `WIP ${ticket.id}: ${ticket.title}`]);
    const baseline = await readWorktreeState(repo);

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "exit 1" }),
      ticket,
      logPath,
      baseline,
      committed: true,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({
      rolledBackWhy: "its work was already committed",
      retainedOn: BRANCH,
    });
    expect(head()).toBe(baseline.head);
  });

  // The empty index that is NOT an empty ticket (PR #228 review): the agent committed its own work
  // and the deadline landed before `step:commit` recorded it. `commitAll` finds nothing staged, and
  // read as "nothing to commit" the rollback hard-resets to the baseline — deleting the finished,
  // gate-passed commit this path exists to save.
  it("keeps the work an agent committed itself when the index is empty", async () => {
    const baseline = await readWorktreeState(repo);
    write("FINISHED.md", "work the agent committed itself, against the contract\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feat: the agent's own subject"]);
    const selfCommitted = head();

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "true" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({ branch: BRANCH, retained: false });
    // The agent's commit is still on the branch, under a marker that makes it findable on resume —
    // its own subject carries neither the ticket id nor the `WIP` prefix.
    expect(out(["rev-list", "--count", `${selfCommitted}..HEAD`])).toBe("1");
    expect(subjects()).toContain("feat: the agent's own subject");
    expect(subjects()).toContain(`WIP ${ticket.id}: ${ticket.title}`);
  });

  // The marker is the ONLY way either reader finds self-committed work, and a project whose
  // `commit-msg` hook enforces its own subject convention refuses anton's `WIP` one (PR #228
  // review). Losing the marker to a message check costs the ticket its whole path back to a pull
  // request, so the retry bypasses the hooks — legitimate on this commit alone, which is empty.
  it("marks self-committed work even when a commit-msg hook refuses anton's subject", async () => {
    const baseline = await readWorktreeState(repo);
    write("FINISHED.md", "work the agent committed itself, against the contract\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feat: the subject this project's hook accepts"]);
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "commit-msg"), '#!/bin/sh\ngrep -q "^WIP " "$1" && exit 1\nexit 0\n', {
      mode: 0o755,
    });

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "true" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({ branch: BRANCH, retained: false });
    expect(subjects()).toContain(`WIP ${ticket.id}: ${ticket.title}`);
  });

  // …and when even that cannot be written, the work is neither kept-and-findable nor lost. Reported
  // as preserved it would promise a resume that continues from it (PR #228 review) — but nothing on
  // the branch names the ticket, so every resume reports a zero diff, and a resume taken after the
  // target is split walks these commits past the shape guard into a child's pull request.
  it("reports self-committed work it could not mark AT ALL rather than call it preserved", async () => {
    const baseline = await readWorktreeState(repo);
    write("FINISHED.md", "work the agent committed itself, against the contract\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feat: the agent's own subject"]);
    const selfCommitted = head();
    // No commit of any kind can be written from here — hooks bypassed or not.
    g(["config", "commit.gpgsign", "true"]);
    g(["config", "gpg.program", join(repo, "no-such-gpg")]);

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "true" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({ unmarkedOn: BRANCH });
    // The agent's commit outranks its bookkeeping: kept exactly where it was, never reset away.
    expect(head()).toBe(selfCommitted);
    expect(subjects()).toContain("feat: the agent's own subject");
    expect(subjects().some((s) => s.startsWith(`WIP ${ticket.id}:`))).toBe(false);
  });

  // …and the marker is written once. A resume that starts from a previous attempt's preserved
  // commit, self-commits more work and times out again already has the prefix on the branch.
  it("does not re-mark a branch that already carries this ticket's preserved commit", async () => {
    write("HALF_WRITTEN.md", "work preserved by the attempt before this one\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", `WIP ${ticket.id}: ${ticket.title}`]);
    const baseline = await readWorktreeState(repo);
    write("MORE.md", "what this attempt added, and committed itself\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feat: more of the agent's own work"]);
    const selfCommitted = head();

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "true" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({ branch: BRANCH, retained: false });
    expect(head()).toBe(selfCommitted);
    expect(subjects().filter((s) => s.startsWith(`WIP ${ticket.id}:`))).toHaveLength(1);
  });

  // The genuinely empty case the branch above must not swallow: nothing staged AND HEAD never moved
  // is still the rollback it always was.
  it("still rolls back when the index is empty and HEAD never moved", async () => {
    const baseline = await readWorktreeState(repo);
    // The tree differs from the baseline, so the preserve runs — and the gate itself clears the only
    // thing in it (a generated file a check regenerates or removes). `git add -A` then stages
    // nothing while HEAD stands exactly where the ticket started: nobody committed anything.
    write("GENERATED.md", "a file the project's own check removes\n");

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "rm -f GENERATED.md" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({
      rolledBackWhy: "there was nothing for git to commit",
      retainedOn: null,
    });
    expect(head()).toBe(baseline.head);
  });

  // The commit that LANDED under a call git then rejected (PR #228 review). `post-commit` runs after
  // the commit is made — githooks(5) is explicit that it cannot affect the outcome — so a hook that
  // outlives the commit budget fails a `git commit` whose commit is already on the branch. Read as
  // "nothing was committed", the rollback hard-resets to the baseline and deletes the preserved
  // commit this path had just finished making: the exact loss it exists to prevent.
  it("keeps a preserved commit that landed under a git commit the hooks then failed", async () => {
    const baseline = await readWorktreeState(repo);
    write("HALF_WRITTEN.md", "finished work a post-commit hook must not cost the run\n");
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "post-commit"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    // Long enough for git to reach the hook, short enough that the hook outlives it.
    process.env[COMMIT_TIMEOUT_ENV] = "1500";

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "true" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({ branch: BRANCH, retained: false });
    expect(head()).not.toBe(baseline.head);
    // Kept as it was made — the commit already carries the subject a resume reads, so nothing is
    // marked twice on top of it.
    expect(subjects().filter((s) => s.startsWith(`WIP ${ticket.id}:`))).toHaveLength(1);
  });

  // The marker is EMPTY by contract, and `--allow-empty` only permits that — it does not force it
  // (PR #228 review). A `pre-commit` hook that stages files before rejecting leaves them in the
  // index, and the retry that bypasses the hooks would commit that unverified content under a
  // message saying the commit is empty — while the caller's cleanliness check, reading the tree the
  // commit just emptied, reports nothing left behind.
  it("marks self-committed work with a commit that is EMPTY even when a hook staged files", async () => {
    const baseline = await readWorktreeState(repo);
    write("FINISHED.md", "work the agent committed itself, against the contract\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feat: the agent's own subject"]);
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      "#!/bin/sh\necho leaked > HOOK_STAGED.md\ngit add HOOK_STAGED.md\nexit 1\n",
      { mode: 0o755 },
    );

    const kept = await preserveTimedOutWork({
      run: run(new AbortController().signal, { testCommand: "true" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({ branch: BRANCH, retained: false });
    expect(subjects()).toContain(`WIP ${ticket.id}: ${ticket.title}`);
    // The marker carries no diff, and what the hook wrote is still in the tree for the caller's own
    // cleanliness check to halt on.
    expect(out(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("");
    expect(out(["status", "--porcelain"])).toContain("HOOK_STAGED.md");
  });

  // "No preserved commit on the branch" is what every refusal reports as work that is gone, so a
  // `git log` that could not RUN may not decay into it (PR #228 review). Read as proof of absence,
  // the bead note and the park tell the operator a resume starts the ticket over — while the
  // rollback restores a baseline that still carries the previous attempt's commit.
  it("reports the doubt when the branch's history cannot be read at all", async () => {
    write("HALF_WRITTEN.md", "work preserved by the attempt before this one\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", `WIP ${ticket.id}: ${ticket.title}`]);
    const baseline = await readWorktreeState(repo);
    write("MORE.md", "what this attempt added, and the gates refuse\n");
    // `git log` fails outright; every other read the preserve makes still works.
    g(["config", "log.date", "bogus"]);

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
      retainedOn: null,
    });
    expect((kept as { rolledBackWhy: string }).rolledBackWhy).toContain(
      `could not read \`${BRANCH}\`'s history`,
    );
    // …and the commit the read could not see is still there, exactly as the doubt says it may be.
    g(["config", "--unset", "log.date"]);
    expect(subjects()).toContain(`WIP ${ticket.id}: ${ticket.title}`);
  });

  // The abort's other landing spot: `commitAll` runs on no signal (a pre-commit hook can hold it for
  // minutes), so a kill can arrive with the preserved commit already made. Read as an ordinary
  // preserve it would write the board a human is deciding on; read as a failure it would roll the
  // commit away. It is neither — the work stays on the branch and the bead belongs to the abort.
  it("reports the JOB's abort that lands while the preserved commit is being made", async () => {
    const baseline = await readWorktreeState(repo);
    write("HALF_WRITTEN.md", "finished work the kill must not delete\n");
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 250);

    const kept = await preserveTimedOutWork({
      run: run(abort.signal, { testCommand: "true" }),
      ticket,
      logPath,
      baseline,
      committed: false,
      timeoutMs: 60_000,
      standalone: true,
    });

    expect(kept).toEqual({ jobAborted: true });
    // The commit landed before the kill was noticed — it stays, and the caller writes nothing.
    expect(subjects()).toContain(`WIP ${ticket.id}: ${ticket.title}`);
    expect(head()).not.toBe(baseline.head);
  });
});

// The board writes a kill must not make. `preserveTimedOutWork` asks whether the job was aborted,
// but the caller keeps working after that answer — it reads the tree back — and a kill landing in
// THAT window used to reach the board anyway (PR #228 review): status, assignee, labels and a note
// on a bead a human is deciding about, contrary to the ordinary abort path, which writes nothing.
suite("settleTicketTimeout — a kill after the preserve still owns the board", () => {
  let sandbox: string;
  let repo: string;
  let logPath: string;
  let tdb: TestDb;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

  const run = (signal: AbortSignal): Omit<StepContext, "tickets"> => ({
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
    settings: {} satisfies ProjectSettings,
  });

  beforeEach(() => {
    tdb = makeTestDb();
    sandbox = mkdtempSync(join(tmpdir(), "anton-settle-abort-"));
    repo = join(sandbox, "repo");
    logPath = join(sandbox, "session.log");
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
    tdb.close();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  // The abort lands after the entry tie-break (evaluated synchronously, before the first await) and
  // after the preserve's own check — exactly the window the tree read holds open. Settling here
  // would block the bead and write the note; the kill's own path is the one entitled to decide.
  it("hands the ticket to the abort path instead of writing the board", async () => {
    const abort = new AbortController();
    const baseline = await readWorktreeState(repo);

    const settled = settleTicketTimeout({
      run: run(abort.signal),
      ticket,
      session: { logPath },
      baseline,
      progress: { committed: false, delivered: false, selfReport: null },
      timeoutMs: 60_000,
      standalone: true,
      ranOutOfTime: true,
    });
    abort.abort();

    // No TicketTimeoutError, no poison: it returns, and the caller's abort path settles the ticket.
    await expect(settled).resolves.toBeUndefined();
  });
});

// The deadline can land while the delivery gate is REFUSING a commit that exists — a previous
// attempt's adopted `WIP` this run never affirmed, or work the agent itself declared blocked (PR
// #228 review). The timeout then settles the ticket from `progress` alone, and reading a bare
// "something is committed" as delivery skips the `not-delivered` marker and hands the dispatch loop
// a ticket it lists as delivered — shipping explicitly unfinished work under a pull request. The
// board is only half of it: the refused commit is on the branch and no rollback may touch it, so
// the run must STOP rather than let the siblings behind this ticket open a pull request whose diff
// physically contains it — which is what the refusal itself does when no deadline is racing it.
suite("settleTicketTimeout — a commit the delivery gate refused is not a delivery", () => {
  let sandbox: string;
  let repo: string;
  let logPath: string;
  let tdb: TestDb;
  let tagged: string[][];
  let notes: string[];

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

  const run = (): Omit<StepContext, "tickets"> => ({
    db: tdb.db,
    clock: new FixedClock(1_700_000_000_000),
    ctx: { signal: new AbortController().signal, heartbeat: async () => {}, report: () => {} },
    projectId: randomUUID(),
    runId: randomUUID(),
    repoPath: repo,
    worktreePath: repo,
    branch: BRANCH,
    baseBranch: "main",
    baseRef: "origin/main",
    target: ticket,
    settings: {} satisfies ProjectSettings,
  });

  /** Settle a timed-out ticket whose commit step reported evidence, and return what it threw. */
  async function settle(delivered: boolean): Promise<unknown> {
    const baseline = await readWorktreeState(repo);
    try {
      await settleTicketTimeout({
        run: run(),
        ticket,
        session: { logPath },
        baseline,
        progress: { committed: true, delivered, selfReport: null },
        timeoutMs: 60_000,
        standalone: true,
        ranOutOfTime: true,
      });
    } catch (e) {
      return e as TicketTimeoutError;
    }
    throw new Error("settleTicketTimeout resolved instead of throwing");
  }

  beforeEach(() => {
    tdb = makeTestDb();
    sandbox = mkdtempSync(join(tmpdir(), "anton-settle-refused-"));
    repo = join(sandbox, "repo");
    logPath = join(sandbox, "session.log");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["checkout", "-q", "-b", BRANCH]);

    // The board is stubbed rather than stood up: what is under test is WHICH writes the settlement
    // makes, not bd itself.
    tagged = [];
    notes = [];
    vi.spyOn(beads, "tag").mockImplementation(async (_repo, _id, labels) => {
      tagged.push(labels);
      return "";
    });
    vi.spyOn(beads, "note").mockImplementation(async (_repo, _id, body) => {
      notes.push(body);
      return "";
    });
    vi.spyOn(beads, "setStatus").mockResolvedValue("");
    vi.spyOn(beads, "unassign").mockResolvedValue("");
    vi.spyOn(beads, "untag").mockResolvedValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tdb.close();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  it("marks the ticket undelivered and stops the run rather than absorb the timeout", async () => {
    const err = await settle(false);

    // Not a TicketTimeoutError: that one the dispatch loop ABSORBS, carrying on to the pull request
    // the rest of the run opens — over a branch that carries this refused commit.
    expect(err).not.toBeInstanceOf(TicketTimeoutError);
    expect(isPoisonError(err)).toBe(true);
    expect((err as Error).message).toContain(BRANCH);
    expect((err as Error).message).toMatch(/REFUSING/);
    expect((err as Error).message).toMatch(/resume the run/);
    expect(tagged).toContainEqual([LABELS.notDelivered]);
    // The commit is still on the branch, and the note says so — the operator is owed both halves.
    expect(notes.join("\n")).toMatch(/committed on the branch/);
    expect(notes.join("\n")).toMatch(/REFUSED/);
  });

  it("still leaves an ACCEPTED commit delivered — the deadline hit the bookkeeping", async () => {
    const err = await settle(true);

    expect(err).toBeInstanceOf(TicketTimeoutError);
    expect((err as TicketTimeoutError).delivered).toBe(true);
    expect(tagged).not.toContainEqual([LABELS.notDelivered]);
    expect(notes.join("\n")).toMatch(/stopped after the commit/);
  });

  // The refusal that lands on an ADOPTED preserved commit (PR #228 review). Nothing was rolled back
  // — the commit is where the previous attempt left it — so the halt has to name the branch it is
  // on: that is what tells the operator a resume continues the work rather than starting it over.
  it("names the branch the work is still on when the refusal had nothing of its own to keep", async () => {
    g(["commit", "-q", "--allow-empty", "-m", `WIP ${ticket.id}: ${ticket.title}`]);

    const err = await settle(false);

    expect(isPoisonError(err)).toBe(true);
    expect((err as Error).message).toContain(BRANCH);
    expect(notes.join("\n")).toMatch(/committed on the branch/);
  });
});

// Work an agent committed itself that anton could NOT mark is on the branch and invisible to every
// reader of it (PR #228 review). Absorbed as a preserve, each resume reports a zero diff and parks
// again, and a resume taken after the target is split carries explicitly incomplete commits into a
// child's pull request. So the run stops here, on a bead a person can pick back up.
suite("settleTicketTimeout — unmarkable self-committed work stops the run", () => {
  let sandbox: string;
  let repo: string;
  let logPath: string;
  let tdb: TestDb;
  let notes: string[];
  let statuses: string[];

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const head = () => execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const run = (): Omit<StepContext, "tickets"> => ({
    db: tdb.db,
    clock: new FixedClock(1_700_000_000_000),
    ctx: { signal: new AbortController().signal, heartbeat: async () => {}, report: () => {} },
    projectId: randomUUID(),
    runId: randomUUID(),
    repoPath: repo,
    worktreePath: repo,
    branch: BRANCH,
    baseBranch: "main",
    baseRef: "origin/main",
    target: ticket,
    settings: { testCommand: "true" } satisfies ProjectSettings,
  });

  beforeEach(() => {
    tdb = makeTestDb();
    sandbox = mkdtempSync(join(tmpdir(), "anton-settle-unmarked-"));
    repo = join(sandbox, "repo");
    logPath = join(sandbox, "session.log");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["checkout", "-q", "-b", BRANCH]);

    notes = [];
    statuses = [];
    vi.spyOn(beads, "tag").mockResolvedValue("");
    vi.spyOn(beads, "note").mockImplementation(async (_repo, _id, body) => {
      notes.push(body);
      return "";
    });
    vi.spyOn(beads, "setStatus").mockImplementation(async (_repo, _id, status) => {
      statuses.push(status);
      return "";
    });
    vi.spyOn(beads, "unassign").mockResolvedValue("");
    vi.spyOn(beads, "untag").mockResolvedValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tdb.close();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  it("parks the run with what a person must do, and leaves the commits alone", async () => {
    const baseline = await readWorktreeState(repo);
    writeFileSync(join(repo, "FINISHED.md"), "work the agent committed itself\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feat: the agent's own subject"]);
    const selfCommitted = head();
    g(["config", "commit.gpgsign", "true"]);
    g(["config", "gpg.program", join(repo, "no-such-gpg")]);

    const err = await settleTicketTimeout({
      run: run(),
      ticket,
      session: { logPath },
      baseline,
      progress: { committed: false, delivered: false, selfReport: null },
      timeoutMs: 60_000,
      standalone: true,
      ranOutOfTime: true,
    }).catch((e: unknown) => e);

    expect(isPoisonError(err)).toBe(true);
    expect((err as Error).message).toContain(`WIP ${ticket.id}:`);
    expect((err as Error).message).toContain(BRANCH);
    expect((err as Error).message).toMatch(/resume the run/);
    // The work is untouched, the operator has the account, and the bead is claimable for the resume
    // that follows their fix.
    expect(head()).toBe(selfCommitted);
    expect(notes.join("\n")).toMatch(/could not record/);
    expect(statuses).toContain("open");
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

  // "No preserved commit" is this guard's PERMISSIVE answer, so it may not be what a failed history
  // read decays into (PR #228 review). A `git log` that cannot run proves nothing about the branch —
  // and treating it as proof clears the children to dispatch onto a branch that may still carry the
  // parent's incomplete commit, which is the one outcome this exists to prevent.
  it("parks rather than dispatch when the branch history cannot be read at all", async () => {
    const notARepo = join(sandbox, "not-a-repo");
    mkdirSync(notARepo);

    const err = await assertPreservedWorkFitsShape(epicRun(false), {
      ...worktree(),
      path: notARepo,
    }).catch((e: unknown) => e);

    expect(isPoisonError(err)).toBe(true);
    expect((err as Error).message).toContain("could not read the history");
    expect((err as Error).message).toContain(notARepo);
    expect((err as Error).message).toMatch(/resume the run/);
  });
});

describe("outOfTimeParkMessage — what the operator may safely do next (anton-d967)", () => {
  const parkRun = (preserved: boolean): EpicRun =>
    ({
      targetId: ticket.id,
      branch: BRANCH,
      standaloneRun: true,
      ticketTimeoutMs: 45 * 60_000,
      timedOut: [{ id: ticket.id, delivered: false, ...(preserved ? { preserved: true } : {}) }],
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
