/**
 * `step:commit` against REAL git (anton-8t1f).
 *
 * The delivery-evidence gate reads this step's verdict, and the verdict is a fact about a git
 * repository — whether the ticket's work exists on the run's branch. A fake git could be made to
 * say anything, so every case here runs against a real one: the honest empty tree, the agent that
 * committed its own work (which leaves an identical empty INDEX and a moved HEAD), the resume of a
 * ticket whose timed-out work is already preserved on the branch (anton-d967 — an empty index AND a
 * still HEAD), and the agent that committed somewhere the PR push will never look.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeTestDb, type TestDb } from "../db/testing";
import type { Bead } from "../beads/bd";
import type { ProjectSettings } from "../projects";
import { worktreeHasCommitFor } from "../git/ops";
import { isPoisonError } from "./errors";
import type { Clock } from "./queue";
import { commitStep, type StepContext } from "./step-registry";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

const BRANCH = "anton/anton-8t1f";

const ticket: Bead = {
  id: "anton-8t1f",
  title: "The cadence editor reads as parts",
  status: "in_progress",
  issue_type: "feature",
};

class FixedClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

suite("commitStep (real git)", () => {
  let sandbox: string;
  let repo: string;
  let tdb: TestDb;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const out = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const head = () => out(["rev-parse", "HEAD"]);
  const subjects = () => out(["log", "--format=%s"]).split("\n");

  /** Stand in for the agent editing the worktree. */
  const write = (name: string, body: string) => writeFileSync(join(repo, name), body);
  /** Stand in for the agent committing its own work — the contract violation this step absorbs. */
  const selfCommit = (message: string) => {
    g(["add", "-A"]);
    g(["commit", "-q", "-m", message]);
  };

  function context(overrides: Partial<StepContext> = {}): StepContext {
    return {
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
      tickets: [ticket],
      settings: {} satisfies ProjectSettings,
      ...overrides,
    };
  }

  beforeEach(() => {
    tdb = makeTestDb();
    sandbox = mkdtempSync(join(tmpdir(), "anton-commit-step-"));
    repo = join(sandbox, "repo");
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

  it("commits a dirty worktree under the ticket's name", async () => {
    const started = head();
    write("cadence-editor.tsx", "export const CadenceEditor = () => null;\n");

    const result = await commitStep(context({ ticketStartHead: started }));

    expect(result.ok).toBe(true);
    expect(result.facts.committed).toBe(true);
    expect(subjects()[0]).toBe(`${ticket.id}: ${ticket.title}`);
  });

  // The gate's whole reason for existing: a clean agent exit that changed nothing delivered nothing,
  // and closing the ticket on it would be a false success.
  it("reports zero diff when the agent changed nothing and HEAD stood still", async () => {
    const result = await commitStep(context({ ticketStartHead: head() }));

    expect(result.ok).toBe(false);
    expect(result.facts.committed).toBe(false);
    expect(result.detail).toBe("nothing to commit (zero diff)");
  });

  // The RESUME of a ticket whose budget expired on a gate-passing tree (anton-d967). Its work is on
  // the branch under a `WIP <id>:` subject — invisible to `worktreeHasCommitFor` by design — so an
  // agent that finds the change already made leaves HEAD exactly where it was. Read as an empty
  // tree, that parks the run, and the next resume does the same: work already earned, permanently
  // one step short of its PR.
  it("adopts the work a previous attempt's TIMEOUT preserved when nothing is left to do", async () => {
    write("cadence-editor.tsx", "export const CadenceEditor = () => null;\n");
    selfCommit(`WIP ${ticket.id}: ${ticket.title}`);
    const preserved = head();

    const result = await commitStep(context({ ticketStartHead: preserved }));

    expect(result.ok).toBe(true);
    expect(result.facts.committed).toBe(true);
    // The evidence is a PREVIOUS attempt's explicitly incomplete commit, so it travels labelled:
    // the delivery gate reads `preservedAdoption` and asks this run's agent to affirm it is done.
    expect(result.facts.preservedAdoption).toBe(true);
    // The preserved commit is untouched, and the ticket is now discoverable under its own id.
    expect(subjects()).toContain(`WIP ${ticket.id}: ${ticket.title}`);
    expect(await worktreeHasCommitFor(repo, ticket.id)).toBe(true);
    expect(out(["diff", "--stat", preserved, "HEAD"])).toBe("");
  });

  // The adoption is scoped to THIS ticket's preserved work: another bead's WIP commit is somebody
  // else's, and reading it as delivery here would close a ticket on a diff it never wrote.
  it("still reports zero diff when the preserved commit belongs to another ticket", async () => {
    write("a.ts", "export const a = 1;\n");
    selfCommit("WIP anton-other: another ticket's preserved work");

    const result = await commitStep(context({ ticketStartHead: head() }));

    expect(result.ok).toBe(false);
    expect(result.facts.committed).toBe(false);
    expect(await worktreeHasCommitFor(repo, ticket.id)).toBe(false);
  });

  // The regression. Both this case and the one above leave an empty index; reading the index alone
  // read them as the same thing and threw away 775 lines of gate-passed work.
  it("adopts work the agent committed itself onto the run's branch", async () => {
    const started = head();
    write("cadence-editor.test.tsx", "it('covers the presets', () => {});\n");
    selfCommit("test(settings): cover the Automation surface");
    const tip = head();

    const result = await commitStep(context({ ticketStartHead: started }));

    expect(result.ok).toBe(true);
    expect(result.facts.committed).toBe(true);
    // Work THIS run produced — no affirmation beyond the diff itself, unlike an adopted preserve.
    expect(result.facts.preservedAdoption).toBeUndefined();
    // The agent's own commit is the delivery and is left exactly as it was.
    expect(subjects()).toContain("test(settings): cover the Automation surface");
    expect(out(["rev-parse", `${tip}`])).toBe(tip);
  });

  // Without the attribution a resume cannot see the ticket in the agent's own subjects, re-runs it
  // onto a tree with nothing left to do, and lands back in the state this fix removes.
  it("records the ticket attribution the agent's own subjects lack", async () => {
    const started = head();
    write("a.ts", "export const a = 1;\n");
    selfCommit("refactor: split the editor");

    expect(await worktreeHasCommitFor(repo, ticket.id)).toBe(false);
    await commitStep(context({ ticketStartHead: started }));

    expect(await worktreeHasCommitFor(repo, ticket.id)).toBe(true);
    expect(subjects()[0]).toBe(`${ticket.id}: ${ticket.title}`);
  });

  it("records that attribution as an EMPTY commit, changing nothing the agent wrote", async () => {
    const started = head();
    write("a.ts", "export const a = 1;\n");
    selfCommit("refactor: split the editor");
    const tree = out(["rev-parse", "HEAD^{tree}"]);

    await commitStep(context({ ticketStartHead: started }));

    expect(out(["rev-parse", "HEAD^{tree}"])).toBe(tree);
    expect(out(["diff", "--stat", "HEAD~1", "HEAD"])).toBe("");
  });

  it("does not double-record when the agent already wrote a conforming subject", async () => {
    const started = head();
    write("a.ts", "export const a = 1;\n");
    selfCommit(`${ticket.id}: the cadence editor reads as parts`);

    const result = await commitStep(context({ ticketStartHead: started }));

    expect(result.ok).toBe(true);
    expect(subjects().filter((s) => s.startsWith(`${ticket.id}:`))).toHaveLength(1);
  });

  // Accepting this as delivery would be a REAL false success — worse than the bug being fixed.
  // anton pushes the run's branch by name, so these commits reach no PR.
  it("parks when the agent committed onto a branch of its own", async () => {
    const started = head();
    g(["checkout", "-q", "-b", "scratch"]);
    write("a.ts", "export const a = 1;\n");
    selfCommit("wip");

    let raised: unknown;
    await commitStep(context({ ticketStartHead: started })).catch((e) => {
      raised = e;
    });

    expect(isPoisonError(raised)).toBe(true);
    expect((raised as Error).message).toContain("refs/heads/scratch");
    expect((raised as Error).message).toContain(BRANCH);
  });

  // "HEAD is different" is not "HEAD moved forward". A reset moves it exactly as visibly while
  // DELETING commits — on a multi-ticket run, an earlier ticket's, whose bead is already closed.
  it("parks when the agent reset the run's branch backward", async () => {
    write("earlier.ts", "export const earlier = 1;\n");
    selfCommit("anton-earlier: an earlier ticket's work");
    const started = head();
    g(["reset", "--hard", "-q", "HEAD~1"]);

    let raised: unknown;
    await commitStep(context({ ticketStartHead: started })).catch((e) => {
      raised = e;
    });

    expect(isPoisonError(raised)).toBe(true);
    expect((raised as Error).message).toContain("no longer contains the commit the ticket started from");
    // The marker must NOT have been written: nothing here is a delivery.
    expect(await worktreeHasCommitFor(repo, ticket.id)).toBe(false);
  });

  it("parks when the agent rewrote the branch's history in place", async () => {
    write("a.ts", "export const a = 1;\n");
    selfCommit("anton-earlier: an earlier ticket's work");
    const started = head();
    write("a.ts", "export const a = 2;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "--amend", "-m", "anton-earlier: an earlier ticket's work, rewritten"]);

    let raised: unknown;
    await commitStep(context({ ticketStartHead: started })).catch((e) => {
      raised = e;
    });

    expect(isPoisonError(raised)).toBe(true);
    expect((raised as Error).message).toContain("reset, amended or rebased");
  });

  it("parks when the agent committed onto a detached HEAD", async () => {
    const started = head();
    g(["checkout", "-q", "--detach"]);
    write("a.ts", "export const a = 1;\n");
    selfCommit("wip");

    let raised: unknown;
    await commitStep(context({ ticketStartHead: started })).catch((e) => {
      raised = e;
    });

    expect(isPoisonError(raised)).toBe(true);
    expect((raised as Error).message).toContain("detached HEAD");
  });

  // A missing anchor must not be able to manufacture the false success the gate exists to catch, so
  // it falls back to the index — the behaviour that predates the anchor.
  it("falls back to the index alone when the caller could not read a start HEAD", async () => {
    write("a.ts", "export const a = 1;\n");
    selfCommit("refactor: split the editor");

    const result = await commitStep(context({ ticketStartHead: undefined }));

    expect(result.ok).toBe(false);
    expect(result.facts.committed).toBe(false);
  });
});
