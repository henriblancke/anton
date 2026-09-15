/**
 * Direct tests for the two steps that write the run's EVIDENCE.
 *
 * git is faked here on purpose: these pin the WIRING — which bead the commit speaks for, which base
 * the PR targets, what rides in its body. The delivery verdict itself is a fact about a real
 * repository, so its cases run against real git in `step-registry.commit.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import type { Bead } from "../../beads/bd";
import { schema } from "../../db";
import { getProjectSettings } from "../../projects";
import { closeSandbox, openSandbox, target } from "./step.fixture";

const ops = vi.hoisted(() => ({
  commitAll: vi.fn(),
  commitMarker: vi.fn(),
  isAncestor: vi.fn(),
  openPullRequest: vi.fn(),
  readWorktreeState: vi.fn(),
  resolveHooksPathOverride: vi.fn(),
  stageAll: vi.fn(),
  worktreeHasCommitFor: vi.fn(),
  worktreeHasPreservedCommitFor: vi.fn(),
}));
vi.mock("../../git/ops", () => ops);

const { commitStep, prStep, recordBoardOnlyAttribution } = await import("./git");

let sandbox: Awaited<ReturnType<typeof openSandbox>>;

beforeEach(async () => {
  sandbox = await openSandbox("steps-git");
  for (const fn of Object.values(ops)) fn.mockReset();
  ops.commitAll.mockResolvedValue({ committed: true });
  ops.worktreeHasPreservedCommitFor.mockResolvedValue(false);
  ops.openPullRequest.mockResolvedValue({ url: "https://example.test/pr/7", ref: "gh-7" });
  ops.resolveHooksPathOverride.mockResolvedValue(undefined);
});

afterEach(() => closeSandbox(sandbox));

const ticket = (id: string): Bead => ({ ...target, id, title: `ticket ${id}` });

describe("step:commit", () => {
  // A ticket-phase step speaks for its one ticket; a run-phase step speaks for the run, so its
  // commit must not be filed under whichever ticket happened to be first.
  it("names the ticket it covers in the commit subject, else the run target", async () => {
    const ticketContext = sandbox.context({ tickets: [ticket("anton-a")] });
    await commitStep(ticketContext);
    expect(ops.commitAll).toHaveBeenLastCalledWith(sandbox.dir, "anton-a: ticket anton-a", {
      hooksPath: undefined,
      timeoutMs: 120_000,
      signal: ticketContext.ctx.signal,
    });

    const runContext = sandbox.context({ tickets: [ticket("anton-a"), ticket("anton-b")] });
    await commitStep(runContext);
    expect(ops.commitAll).toHaveBeenLastCalledWith(sandbox.dir, `${target.id}: ${target.title}`, {
      hooksPath: undefined,
      timeoutMs: 120_000,
      signal: runContext.ctx.signal,
    });
  });

  it("round-trips the saved commit timeout into both normal and attribution commits", async () => {
    sandbox.tdb.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ commitTimeoutMinutes: 5 }) })
      .where(eq(schema.projects.id, sandbox.projectId))
      .run();
    const settings = await getProjectSettings(sandbox.tdb.db, sandbox.projectId);
    ops.commitAll.mockResolvedValue({ committed: false });
    ops.readWorktreeState.mockResolvedValue({
      ref: `refs/heads/${sandbox.context().branch}`,
      head: "agent-head",
    });
    ops.isAncestor.mockResolvedValue(true);
    ops.worktreeHasCommitFor.mockResolvedValue(false);

    await commitStep(sandbox.context({ settings, ticketStartHead: "start-head" }));

    expect(ops.commitAll).toHaveBeenCalledWith(
      sandbox.dir,
      `${target.id}: ${target.title}`,
      expect.objectContaining({ timeoutMs: 5 * 60_000 }),
    );
    expect(ops.commitMarker).toHaveBeenCalledWith(
      sandbox.dir,
      expect.any(String),
      expect.objectContaining({ timeoutMs: 5 * 60_000 }),
    );
  });

  // PR #263 review, round 37: the caller must stage the worktree BEFORE asking
  // `resolveHooksPathOverride` anything, so its submodule-staleness check reads an index that
  // already reflects everything this commit is about to include — not a pre-staging snapshot.
  it("stages the worktree before resolving hooksPath, not after", async () => {
    const order: string[] = [];
    ops.stageAll.mockImplementation(async () => {
      order.push("stageAll");
    });
    ops.resolveHooksPathOverride.mockImplementation(async () => {
      order.push("resolveHooksPathOverride");
      return undefined;
    });

    await commitStep(sandbox.context());

    expect(order).toEqual(["stageAll", "resolveHooksPathOverride"]);
  });

  // git is the run's evidence of record: a clean agent exit that left no diff delivered nothing.
  it("reports a zero diff as a failure, never as a quiet success", async () => {
    ops.commitAll.mockResolvedValue({ committed: false });

    const result = await commitStep(sandbox.context());

    expect(result.ok).toBe(false);
    expect(result.facts.committed).toBe(false);
    // Without a per-ticket anchor there is nothing to read HEAD against, so it never reaches git.
    expect(ops.readWorktreeState).not.toHaveBeenCalled();
  });

  // The marker commit adopting the agent's own self-committed work must resolve and pass hooksPath
  // the same way commitAll above does: commitMarker's --no-verify bypasses only pre-commit/commit-msg,
  // so a generated, base-only post-commit hook still needs the resolved path rather than silently
  // resolving against a cold worktree that never installed it (PR #263 review, round 15).
  it("passes the resolved hooksPath to the marker commit recording the agent's self-committed work", async () => {
    ops.commitAll.mockResolvedValue({ committed: false });
    ops.readWorktreeState.mockResolvedValue({
      ref: `refs/heads/${sandbox.context().branch}`,
      head: "agent-head",
    });
    ops.isAncestor.mockResolvedValue(true);
    ops.worktreeHasCommitFor.mockResolvedValue(false);
    ops.resolveHooksPathOverride.mockResolvedValue("/base/repo/.githooks");

    await commitStep(sandbox.context({ ticketStartHead: "start-head" }));

    expect(ops.commitMarker).toHaveBeenCalledWith(
      sandbox.dir,
      expect.any(String),
      expect.objectContaining({ hooksPath: "/base/repo/.githooks" }),
    );
  });
});

describe("recordBoardOnlyAttribution", () => {
  // PR #284 review round 5: an unbounded idempotency check reads a STALE `<id>:` commit sitting in
  // base history (e.g. from an earlier delivery of a board-only ticket reopened under the same id)
  // as "already recorded" and skips writing this run's marker, leaving the branch byte-identical to
  // its base with nothing for step:pr to open against. Bounding the lookup to this run's own delta
  // closes that gap — assert the call is actually bounded, not just that some call happened.
  it("bounds the idempotency lookup to this run's delta, not full branch history", async () => {
    ops.worktreeHasCommitFor.mockResolvedValue(false);

    const ctx = sandbox.context();
    await recordBoardOnlyAttribution(ctx);

    expect(ops.worktreeHasCommitFor).toHaveBeenCalledWith(sandbox.dir, target.id, {
      base: ctx.baseForkSha,
      excludeBase: ctx.baseRef,
    });
    expect(ops.commitMarker).toHaveBeenCalled();
  });

  // The stale-marker case this bound exists to fix: a commit under this ticket's id in BASE history
  // must not suppress writing this run's own marker.
  it("still writes the marker when only a stale attribution commit exists outside this run's delta", async () => {
    ops.worktreeHasCommitFor.mockResolvedValue(false);

    await recordBoardOnlyAttribution(sandbox.context());

    expect(ops.commitMarker).toHaveBeenCalled();
  });

  it("skips writing a second marker when this run's own delta already carries one", async () => {
    ops.worktreeHasCommitFor.mockResolvedValue(true);

    await recordBoardOnlyAttribution(sandbox.context());

    expect(ops.commitMarker).not.toHaveBeenCalled();
  });
});

describe("step:pr", () => {
  // `gh` takes a branch, so the PR targets the plain base — never the `origin/<base>` fork point the
  // review step diffs against.
  it("opens the PR against the base branch, from the run's branch", async () => {
    const result = await prStep(sandbox.context());

    expect(result.facts.pr.ref).toBe("gh-7");
    expect(ops.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: sandbox.dir,
        branch: "anton/anton-8d0f",
        base: "main",
        title: `${target.title} (${target.id})`,
      }),
    );
  });

  // Review finding: the fixture points repoPath and worktreePath at the same dir, which would let
  // a regression back to pushing from repoPath alone pass here undetected — assert the field is
  // forwarded explicitly, distinct from repoPath, so a caller that stops wiring it is caught.
  it("passes worktreePath through to openPullRequest, distinct from repoPath", async () => {
    await prStep(sandbox.context({ worktreePath: "/some/other/worktree" }));

    expect(ops.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: sandbox.dir,
        worktreePath: "/some/other/worktree",
      }),
    );
  });

  // Advisories never hold the PR back, so its body is the only place the founder would ever see them.
  it("carries the unresolved review findings into the PR body", async () => {
    await prStep(
      sandbox.context({
        advisories: [{ severity: "advisory", location: "src/a.ts:3", note: "tidy this" }],
      }),
    );

    const body = ops.openPullRequest.mock.calls[0][0].body as string;
    expect(body).toContain("Unresolved review findings (1, advisory)");
    expect(body).toContain("- src/a.ts:3 — tidy this");
  });

  // A project with no pushTimeoutMinutes setting must resolve to the same 2-minute default
  // pushBranch itself falls back to — byte-identical to before this option existed.
  it("resolves the push budget to the 2-minute default when the project has no setting", async () => {
    await prStep(sandbox.context({ settings: {} }));

    expect(ops.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pushTimeoutMs: 120_000 }),
    );
  });

  // The configured budget must ride through openPullRequest to pushBranch, read from the run's
  // PINNED settings snapshot (ctx.settings) rather than re-read mid-run.
  it("round-trips the saved push timeout from ctx.settings into openPullRequest", async () => {
    sandbox.tdb.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ pushTimeoutMinutes: 7 }) })
      .where(eq(schema.projects.id, sandbox.projectId))
      .run();
    const settings = await getProjectSettings(sandbox.tdb.db, sandbox.projectId);
    const ctx = sandbox.context({ settings });

    await prStep(ctx);

    expect(ops.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pushTimeoutMs: 7 * 60_000, signal: ctx.ctx.signal }),
    );
  });
});
