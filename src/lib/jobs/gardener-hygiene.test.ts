/**
 * The gardener patrol's two mechanical tiers, exercised DIRECTLY (anton-l4do) — no runner, no queue,
 * no anton.db. Driving the whole handler to assert "the stale window is 30 days" made every one of
 * these a five-mock arrange block; split out, each tier is a function with an argument.
 *
 * The properties that carry them:
 *   • tier 1 writes exactly twice and returns what it wrote, so the report can be persisted before
 *     the fallible read tier runs;
 *   • tier 2 writes NOTHING — every judgment it could make is a finding for a human;
 *   • both extend the lease around the slow verbs, because a big board outruns a job's lease.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead, DuplicateGroup, EpicCloseSweep, LintReport, StaleOpts } from "../beads/bd";
import { fakeJobContext } from "./pass.fixture";

const epicCloseMock = vi.fn<(cwd: string, opts?: { apply?: boolean }) => Promise<EpicCloseSweep>>();
const recomputeMock = vi.fn<(cwd: string) => Promise<number>>();
const lintMock = vi.fn<(cwd: string) => Promise<LintReport>>();
const staleMock = vi.fn<(cwd: string, opts?: StaleOpts) => Promise<Bead[]>>();
const orphansMock = vi.fn();
const cyclesMock = vi.fn();
const duplicatesMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      epicCloseEligible: (...a: [string, { apply?: boolean }?]) => epicCloseMock(...a),
      recomputeBlocked: (...a: [string]) => recomputeMock(...a),
      lintReport: (...a: [string]) => lintMock(...a),
      staleList: (...a: [string, StaleOpts?]) => staleMock(...a),
      orphansList: (...a: [string]) => orphansMock(...a),
      depCycles: (...a: [string]) => cyclesMock(...a),
      duplicateGroups: (...a: [string]) => duplicatesMock(...a),
    },
  };
});

const {
  applySafeVerbs,
  collectFindings,
  cycleFindings,
  duplicateFindings,
  lintFindings,
  orphanFindings,
  staleFindings,
  STALE_IN_PROGRESS_DAYS,
  STALE_OPEN_DAYS,
} = await import("./gardener-hygiene");

const REPO = "/tmp/gardener-hygiene";

beforeEach(() => {
  vi.clearAllMocks();
  epicCloseMock.mockResolvedValue({ dryRun: false, eligible: [], closed: [] });
  recomputeMock.mockResolvedValue(0);
  lintMock.mockResolvedValue({ warnings: 0, issues: 0, violations: [] });
  staleMock.mockResolvedValue([]);
  orphansMock.mockResolvedValue([]);
  cyclesMock.mockResolvedValue([]);
  duplicatesMock.mockResolvedValue([]);
});

describe("finding builders", () => {
  it("names what a lint violation is missing, and falls back when bd names nothing", () => {
    const [missing, shapeless] = lintFindings([
      { id: "t-1", title: "no acceptance", type: "task", missing: ["## Acceptance Criteria"] },
      { id: "t-2", title: "off template", type: "", missing: [] },
    ]);
    expect(missing).toMatchObject({ kind: "lint", key: "lint:t-1", beadId: "t-1" });
    expect(missing.detail).toBe("task is missing ## Acceptance Criteria");
    // No type and no list: still a finding, phrased as the only thing bd actually claimed.
    expect(shapeless.detail).toBe("bead does not match its template");
  });

  it("keeps the two stale kinds apart — one is a backlog call, the other an abandoned run", () => {
    const [open] = staleFindings([{ id: "t-2" }], "open", STALE_OPEN_DAYS);
    const [running] = staleFindings(
      [{ id: "t-3", assignee: "someone" }],
      "in_progress",
      STALE_IN_PROGRESS_DAYS,
    );
    expect(open.kind).toBe("stale-open");
    expect(open.detail).toBe(`open and untouched for over ${STALE_OPEN_DAYS} days`);
    expect(running.kind).toBe("stale-in-progress");
    // The assignee is the point of the in-progress row: it names who to ask.
    expect(running.detail).toContain("(assignee someone)");
  });

  it("trims a title that would wrap the report line", () => {
    const [finding] = orphanFindings([
      { id: "t-4", title: "x".repeat(200), status: "open", latestCommit: "abc1234" },
    ]);
    expect(finding.title).toHaveLength(80);
    expect(finding.detail).toBe("named by a commit (abc1234) but still open");
  });

  it("reports a cycle bd could not name rather than dropping the one condition it exists to find", () => {
    const [named, unnamed, second] = cycleFindings([
      { ids: ["b", "a"] },
      { ids: [] },
      { ids: [] },
    ]);
    // Keyed on the sorted members, so the same cycle read from either end is one finding.
    expect(named.key).toBe("dep-cycle:a+b");
    expect(named.detail).toBe("dependency cycle: b → a");
    // Two unnamed cycles are two findings, not one collapsed row.
    expect(unnamed.key).not.toBe(second.key);
    expect(unnamed.detail).toContain("bd dep cycles");
  });

  it("names bd's merge target and ignores a group of one", () => {
    const member = (id: string) => ({
      id,
      title: "same title",
      status: "open",
      references: 0,
      isMergeTarget: false,
    });
    const groups: DuplicateGroup[] = [
      { title: "same title", target: "t-5", sources: ["t-6"], members: [member("t-6"), member("t-5")] },
      { title: "alone", target: undefined, sources: [], members: [member("t-7")] },
    ];
    const findings = duplicateFindings(groups);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("duplicate:t-5+t-6"); // sorted, so member order cannot fork the key
    expect(findings[0].detail).toContain("bd suggests keeping t-5");
  });
});

describe("tier 1 · the safe verbs", () => {
  it("applies both and returns what it wrote, so the report can be persisted before tier 2", async () => {
    epicCloseMock.mockResolvedValue({ dryRun: false, eligible: [], closed: ["e-1", "e-2"] });
    recomputeMock.mockResolvedValue(3);
    const ctx = fakeJobContext();

    expect(await applySafeVerbs(REPO, ctx)).toEqual({
      closedEpics: ["e-1", "e-2"],
      rowsRecomputed: 3,
    });
    // `apply: true` is the whole difference between the sweep and a dry run.
    expect(epicCloseMock).toHaveBeenCalledWith(REPO, { apply: true });
    expect(ctx.beats).toBe(2); // a board big enough to matter outruns the lease between them
  });

  it("propagates a failed sweep — half a sweep is not a hygiene action anyone can trust", async () => {
    epicCloseMock.mockRejectedValue(new Error("bd epic close-eligible exploded"));
    await expect(applySafeVerbs(REPO, fakeJobContext())).rejects.toThrow("close-eligible");
    expect(recomputeMock).not.toHaveBeenCalled();
  });
});

describe("tier 2 · the report verbs", () => {
  it("asks each verb once, with the window each status is judged on", async () => {
    const ctx = fakeJobContext();
    await collectFindings(REPO, ctx);

    expect(staleMock).toHaveBeenCalledWith(REPO, { status: "open", days: STALE_OPEN_DAYS });
    expect(staleMock).toHaveBeenCalledWith(REPO, {
      status: "in_progress",
      days: STALE_IN_PROGRESS_DAYS,
    });
    expect(lintMock).toHaveBeenCalledTimes(1);
    expect(orphansMock).toHaveBeenCalledTimes(1);
    expect(ctx.beats).toBe(1);
  });

  it("returns every kind in report order on a rotten board", async () => {
    lintMock.mockResolvedValue({
      warnings: 1,
      issues: 1,
      violations: [
        { id: "t-1", title: "no acceptance", type: "task", missing: ["## Acceptance"], warnings: 1 },
      ],
    });
    staleMock.mockImplementation(async (_cwd, opts) =>
      opts?.status === "open"
        ? [{ id: "t-2" } as Bead]
        : [{ id: "t-3", status: "in_progress" } as Bead],
    );
    orphansMock.mockResolvedValue([{ id: "t-4", title: "shipped", status: "open" }]);
    cyclesMock.mockResolvedValue([{ ids: ["t-8", "t-9"] }]);
    duplicatesMock.mockResolvedValue([
      {
        title: "same",
        target: "t-5",
        sources: ["t-6"],
        members: [
          { id: "t-5", title: "same", status: "open", references: 1, isMergeTarget: true },
          { id: "t-6", title: "same", status: "open", references: 0, isMergeTarget: false },
        ],
      },
    ]);

    const findings = await collectFindings(REPO, fakeJobContext());
    expect(findings.map((f) => f.kind)).toEqual([
      "lint",
      "stale-open",
      "stale-in-progress",
      "orphan",
      "dep-cycle",
      "duplicate",
    ]);
  });

  it("fails rather than return a partial report — a short one reads as a clean board", async () => {
    orphansMock.mockRejectedValue(new Error("bd orphans: output was not JSON"));
    await expect(collectFindings(REPO, fakeJobContext())).rejects.toThrow("bd orphans");
  });
});
