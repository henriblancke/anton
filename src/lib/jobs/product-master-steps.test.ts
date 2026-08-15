/**
 * The product-master pass's steps, exercised DIRECTLY (anton-l4do) — no runner, no claude, no bd.
 *
 * The pass is built around ONE confusion it must never allow: "the board is healthy" and "anton
 * learned nothing" look identical from the outside. Every case here is a way that could happen — a
 * session that errored, a report anton cannot read, a claim the board refuses — and what the step
 * does instead of quietly reporting nothing.
 */
import { describe, expect, it, vi } from "vitest";

import type { Bead } from "../beads/bd";
import type { ClaudeResult, RunClaudeOptions } from "../claude/driver";
import type { PmBoardInput, PmClaim } from "../pm/context";
import type { ProjectSettings } from "../projects";
import { fakeScope } from "./pass.fixture";
import { acceptClaims, judgeBoard, PM_DENIED_TOOLS, revalidationTier } from "./product-master-steps";

const REPO = "/tmp/product-master-steps";
const NOW = Date.parse("2026-08-04T12:00:00Z");

const bead = (id: string, o: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  priority: 2,
  ...o,
});

const boardInput = (board: Bead[]): PmBoardInput => ({ board, runs: [], now: NOW });

const claim = (o: Partial<PmClaim> = {}): PmClaim =>
  ({
    kind: "kill",
    bead: "anton-a",
    summary: "nothing wants this",
    evidence: ["three reviews at 3, 2, 2"],
    ...o,
  }) as PmClaim;

/** A session that answers with `text` and records what it was dispatched with. */
function session(text: string, ok = true) {
  const seen: RunClaudeOptions[] = [];
  const claude = async (opts: RunClaudeOptions): Promise<ClaudeResult> => {
    seen.push(opts);
    return { ok, text } as ClaudeResult;
  };
  return { claude, seen };
}

const report = (body: string): string => `Judgment:\n\n\`\`\`json\n${body}\n\`\`\``;

describe("revalidationTier", () => {
  it("says nothing about a board whose approvals still hold", async () => {
    const scope = fakeScope(REPO);
    expect(await revalidationTier(scope, [bead("anton-a")], NOW)).toEqual([]);
    expect(scope.logged).toEqual([]);
  });

  it("names how many approved targets rotted — the log is where an operator sees it", async () => {
    const scope = fakeScope(REPO);
    // The severest rot there is: an approved epic that has since gained a feature child, so it is a
    // container the claimable set skips — approved forever, and no worker will ever come.
    const rotten = bead("anton-x", { issue_type: "epic", labels: ["approved"] });
    const child = bead("anton-f", { issue_type: "feature", parent: "anton-x" });

    const degraded = await revalidationTier(scope, [rotten, child], NOW);

    expect(degraded.length).toBeGreaterThan(0);
    expect(scope.logged.join("")).toContain(
      `${degraded.length} approved target(s) no longer meet the approve gate`,
    );
  });
});

describe("judgeBoard", () => {
  const settings = {} as ProjectSettings;

  it("dispatches a session that cannot write, and returns the claims it reported", async () => {
    const { claude, seen } = session(report(JSON.stringify({ proposals: [claim()] })));
    const scope = fakeScope(REPO);

    const claims = await judgeBoard(scope, {
      settings,
      boardInput: boardInput([bead("anton-a")]),
      claude,
      onEvent: undefined,
    });

    expect(claims).toHaveLength(1);
    expect(claims[0].bead).toBe("anton-a");
    expect(seen[0].cwd).toBe(REPO);
    // The whole safety case for arming this job: no shell and no editor means no `bd`.
    expect(seen[0].disallowedTools).toEqual(PM_DENIED_TOOLS);
    expect(seen[0].signal).toBe(scope.ctx.signal);
    expect(scope.logged.join("")).toContain("judging 1 bead(s) with the shipped contract");
  });

  it("says which reasoning it judged with, so a restyled pass is never mistaken for the default", async () => {
    const { claude } = session(report(`{"proposals":[]}`));
    const scope = fakeScope(REPO);

    await judgeBoard(scope, {
      settings: { productMasterPrompt: "Judge it my way." } as ProjectSettings,
      boardInput: boardInput([bead("anton-a")]),
      claude,
      onEvent: undefined,
    });

    expect(scope.logged.join("")).toContain("with the operator's prompt");
  });

  it("throws on a session that errored rather than calling its silence an empty board", async () => {
    const { claude } = session("quota exhausted", false);
    await expect(
      judgeBoard(fakeScope(REPO), {
        settings,
        boardInput: boardInput([]),
        claude,
        onEvent: undefined,
      }),
    ).rejects.toThrow("the product-master session reported an error");
  });

  it.each([
    ["no report at all", "I read the board and it looked fine to me."],
    ["a report anton cannot parse", '```json\n{"proposals": [{\n```'],
    ["prose after the report", `${report(`{"proposals":[]}`)}\n\nActually, ignore that.`],
  ])("throws on %s — an unreadable report is not a healthy board", async (_label, text) => {
    const { claude } = session(text);
    await expect(
      judgeBoard(fakeScope(REPO), {
        settings,
        boardInput: boardInput([]),
        claude,
        onEvent: undefined,
      }),
    ).rejects.toThrow("report protocol");
  });
});

describe("acceptClaims", () => {
  it("passes a claim the board bears out", async () => {
    const scope = fakeScope(REPO);
    const detections = await acceptClaims(scope, {
      claims: [claim()],
      board: [bead("anton-a")],
      observedAtMs: NOW,
    });

    expect(detections).toHaveLength(1);
    expect(scope.logged.join("")).toContain("1 claim(s) reported, 1 accepted");
  });

  it("logs the refusal rather than dropping it — all-refused must not read as all-healthy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scope = fakeScope(REPO);

    const detections = await acceptClaims(scope, {
      claims: [claim({ bead: "anton-ghost" })],
      board: [bead("anton-a")],
      observedAtMs: NOW,
    });

    expect(detections).toEqual([]);
    const log = scope.logged.join("");
    expect(log).toContain("REFUSED a kill claim about anton-ghost");
    expect(log).toContain("1 claim(s) reported, 0 accepted");
    // The console line carries the project, because a refusal is a per-project fact an operator greps.
    expect(warn.mock.calls[0][0]).toContain(`(${scope.slug})`);
    warn.mockRestore();
  });

  it("checks the claims against the read they were made about, not the clock they finished at", async () => {
    // A session runs for many minutes. Dating the in-flight check at the end would read a lease that
    // was live at the read as expired, and file a proposal racing that very run.
    const { LABELS } = await import("../beads/bd");
    const leased = bead("anton-a", { labels: [LABELS.runLease(NOW + 600_000, "abc")] });

    const live = await acceptClaims(fakeScope(REPO), {
      claims: [claim()],
      board: [leased],
      observedAtMs: NOW,
    });
    const expired = await acceptClaims(fakeScope(REPO), {
      claims: [claim()],
      board: [leased],
      observedAtMs: NOW + 20 * 60_000,
    });

    expect(live).toEqual([]); // the run held it when the board was read
    expect(expired).toHaveLength(1);
  });
});
