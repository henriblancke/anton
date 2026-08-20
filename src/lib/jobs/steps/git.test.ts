/**
 * Direct tests for the two steps that write the run's EVIDENCE.
 *
 * git is faked here on purpose: these pin the WIRING — which bead the commit speaks for, which base
 * the PR targets, what rides in its body. The delivery verdict itself is a fact about a real
 * repository, so its cases run against real git in `step-registry.commit.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead } from "../../beads/bd";
import { closeSandbox, openSandbox, target } from "./step.fixture";

const ops = vi.hoisted(() => ({
  commitAll: vi.fn(),
  commitMarker: vi.fn(),
  isAncestor: vi.fn(),
  openPullRequest: vi.fn(),
  readWorktreeState: vi.fn(),
  worktreeHasCommitFor: vi.fn(),
}));
vi.mock("../../git/ops", () => ops);

const { commitStep, prStep } = await import("./git");

let sandbox: Awaited<ReturnType<typeof openSandbox>>;

beforeEach(async () => {
  sandbox = await openSandbox("steps-git");
  for (const fn of Object.values(ops)) fn.mockReset();
  ops.commitAll.mockResolvedValue({ committed: true });
  ops.openPullRequest.mockResolvedValue({ url: "https://example.test/pr/7", ref: "gh-7" });
});

afterEach(() => closeSandbox(sandbox));

const ticket = (id: string): Bead => ({ ...target, id, title: `ticket ${id}` });

describe("step:commit", () => {
  // A ticket-phase step speaks for its one ticket; a run-phase step speaks for the run, so its
  // commit must not be filed under whichever ticket happened to be first.
  it("names the ticket it covers in the commit subject, else the run target", async () => {
    await commitStep(sandbox.context({ tickets: [ticket("anton-a")] }));
    expect(ops.commitAll).toHaveBeenLastCalledWith(sandbox.dir, "anton-a: ticket anton-a");

    await commitStep(sandbox.context({ tickets: [ticket("anton-a"), ticket("anton-b")] }));
    expect(ops.commitAll).toHaveBeenLastCalledWith(sandbox.dir, `${target.id}: ${target.title}`);
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
});
