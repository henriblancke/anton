/**
 * `projectHealthFromBoard` composes `rankAttention` for the Health page. What matters: escalations
 * never taint what this page calls "worth a look" or "clean", the attention/housekeeping split still
 * comes straight from `rankAttention`, and the alerts are carried through untouched beside it.
 *
 * The separation outlived the move that brought the alerts onto this page (anton-7gxs). It was never
 * about WHERE they are answered — it is that "the codebase is healthy" and "work is stopped" are two
 * different claims, and folding one into the other would let a single upstream outage make a clean
 * codebase look sick, or a clean patrol hide a board that has not moved in a day.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { projectHealthFromBoard, type HealthAlerts } from "./health";
import type { ServerDrift } from "./build/drift";
import type {
  Board,
  EscalationView,
  HygieneFinding,
  HygieneReport,
  Project,
  ReviewTrajectory,
} from "./types";

type BoardSlice = Pick<Board, "hygiene" | "scanHealth" | "reviewTrajectory">;

const project: Project = {
  id: "p1",
  slug: "anton",
  name: "anton",
  repoPath: "/tmp/anton",
  defaultBranch: "main",
  hasBeads: true,
  createdAt: 1_700_000_000,
};

afterEach(() => {
  vi.doUnmock("./board");
  vi.doUnmock("./escalations");
  vi.doUnmock("./build/drift");
  vi.doUnmock("./picker-starts");
  vi.doUnmock("./picker-veto");
  vi.resetModules();
});

function finding(kind: HygieneFinding["kind"], id: string): HygieneFinding {
  return { kind, key: `${kind}:${id}`, detail: `${kind} on ${id}`, beadId: id };
}

function hygiene(findings: HygieneFinding[]): HygieneReport {
  const counts = {
    lint: 0,
    "stale-open": 0,
    "stale-in-progress": 0,
    orphan: 0,
    "dep-cycle": 0,
    duplicate: 0,
  };
  for (const f of findings) counts[f.kind] += 1;
  return {
    id: "h-1",
    projectId: "p1",
    generatedAt: 1_700_000_000,
    actions: { closedEpics: [], rowsRecomputed: 0 },
    findings,
    counts,
  };
}

function trajectory(score: number): ReviewTrajectory {
  const worst = { id: "anton-bad", title: "the bad one", score };
  return { recent: [worst], average: score, worst, scored: 1 };
}

/**
 * The alert bag the composition takes, defaulted to "nothing is stopped". Named per case rather than
 * passed positionally: the four reads arrive together and only the count matters to most of these.
 */
function alerts(over: Partial<HealthAlerts> = {}): HealthAlerts {
  return { escalations: [], dismissed: [], ...over };
}

/** `n` open escalations, distinguishable only by id — these cases count them, never read them. */
function stopped(n: number): EscalationView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `esc-${i}`,
    findingKey: `exhausted-job:job-${i}`,
    kind: "exhausted-job" as const,
    reason: "claude exited 1",
    ageMs: 0,
    status: "open" as const,
    noted: true,
    raisedAt: 0,
  }));
}

describe("projectHealthFromBoard", () => {
  it("reports nothing checked for a project with no patrol, no scan, no scores", () => {
    const board: BoardSlice = { hygiene: undefined, scanHealth: undefined, reviewTrajectory: undefined };
    const health = projectHealthFromBoard(board, alerts());
    expect(health.worthALook).toEqual([]);
    expect(health.housekeeping).toEqual([]);
    expect(health.hygiene).toBeUndefined();
    expect(health.scanHealth).toBeUndefined();
    expect(health.trajectory).toBeUndefined();
  });

  it("distinguishes 'checked, clean' from 'never checked' by keeping the patrol report itself", () => {
    const board: BoardSlice = { hygiene: hygiene([]), scanHealth: undefined, reviewTrajectory: undefined };
    const health = projectHealthFromBoard(board, alerts());
    expect(health.worthALook).toEqual([]);
    // The report ran and found nothing — that's a different claim from never having run, and the
    // page tells them apart by whether `hygiene` itself is present, not by the item lists alone.
    expect(health.hygiene).toBeDefined();
  });

  it("puts an attention-severity hygiene finding in worthALook, not housekeeping", () => {
    const board: BoardSlice = {
      hygiene: hygiene([finding("dep-cycle", "anton-a")]),
      scanHealth: undefined,
      reviewTrajectory: undefined,
    };
    const health = projectHealthFromBoard(board, alerts());
    expect(health.worthALook).toHaveLength(1);
    expect(health.worthALook[0]).toMatchObject({ source: "hygiene", severity: "attention" });
    expect(health.housekeeping).toEqual([]);
  });

  it("folds a housekeeping-severity finding into housekeeping, not worthALook", () => {
    const board: BoardSlice = {
      hygiene: hygiene([finding("lint", "anton-a")]),
      scanHealth: undefined,
      reviewTrajectory: undefined,
    };
    const health = projectHealthFromBoard(board, alerts());
    expect(health.worthALook).toEqual([]);
    expect(health.housekeeping).toHaveLength(1);
    expect(health.housekeeping[0]).toMatchObject({ source: "hygiene", severity: "housekeeping" });
  });

  it("promotes a rework-band worst score into worthALook", () => {
    const board: BoardSlice = { hygiene: undefined, scanHealth: undefined, reviewTrajectory: trajectory(3) };
    const health = projectHealthFromBoard(board, alerts());
    expect(health.worthALook).toHaveLength(1);
    expect(health.worthALook[0]).toMatchObject({ source: "review" });
  });

  it("leaves a healthy trend out of worthALook", () => {
    const board: BoardSlice = { hygiene: undefined, scanHealth: undefined, reviewTrajectory: trajectory(8) };
    const health = projectHealthFromBoard(board, alerts());
    expect(health.worthALook).toEqual([]);
  });

  it("carries the stopped count through untouched, independent of hygiene/review findings", () => {
    const board: BoardSlice = { hygiene: undefined, scanHealth: undefined, reviewTrajectory: undefined };
    const health = projectHealthFromBoard(board, alerts({ escalations: stopped(3) }));
    expect(health.stoppedCount).toBe(3);
    // An open escalation must not turn a project with no findings into a "not clean" one — it is a
    // different question, and this page keeps the two apart even though it now renders both.
    expect(health.worthALook).toEqual([]);
  });
});

// The stale-process verdict is about the SERVERS, not this project, and the page is where it has to
// be legible without a CLI (anton-pzfb) — so this composition carries them through untouched, and
// carries nothing when every running build is the build on disk.
describe("build drift on the health page", () => {
  const board: BoardSlice = { hygiene: undefined, scanHealth: undefined, reviewTrajectory: undefined };

  // One entry per drifting process, not one for the process that rendered the page: an install can
  // serve its UI from an `ANTON_RUNNER=off` server while a second one executes the nightlies, and
  // only the second explains a degraded scan (PR #217 review).
  it("carries every drifting server through to the page", () => {
    const servers: ServerDrift[] = [
      {
        pid: 4242,
        self: false,
        runner: true,
        drift: {
          state: "modified",
          running: { version: "0.4.0", revision: "a".repeat(40) },
          onDisk: { version: "0.4.0", revision: "b".repeat(40) },
          bootedAt: null,
        },
      },
    ];
    expect(projectHealthFromBoard(board, alerts(), servers).staleServers).toBe(servers);
  });

  it("reports none when every running server started from the current checkout", () => {
    expect(projectHealthFromBoard(board, alerts()).staleServers).toEqual([]);
  });
});

// Every read behind the page degrades rather than throwing — `getBoard` returns undefined on a bad
// anton.db, and drift detection has to match it: it shells out to the process table, so an EAGAIN
// under load must cost the page its drift banner, not the whole page (PR #217 review).
describe("getProjectHealth", () => {
  it("renders without a drift banner when drift detection fails", async () => {
    vi.doMock("./board", () => ({
      getBoard: vi.fn().mockResolvedValue({ hygiene: hygiene([]), scanHealth: undefined, reviewTrajectory: undefined }),
    }));
    vi.doMock("./escalations", () => ({
      openEscalations: vi.fn().mockResolvedValue([]),
      dismissedEscalations: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    }));
    vi.doMock("./build/drift", () => ({
      serverBuildDrifts: vi.fn().mockRejectedValue(new Error("spawnSync lsof EAGAIN")),
    }));
    // The breaker read reaches GitHub and the process table, and the park read reaches the db —
    // neither is what this case is about, and both are stubbed so the drift failure is the only
    // thing under test.
    vi.doMock("./autopilot-state", () => ({ currentBreaker: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock("./unwatched-parks", () => ({
      unwatchedParksForProject: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("./picker-starts", () => ({ latestPickerStarts: vi.fn().mockResolvedValue([]) }));
    vi.doMock("./picker-veto", () => ({ latestPickerDeclines: vi.fn().mockResolvedValue([]) }));

    const { getProjectHealth } = await import("./health");
    const health = await getProjectHealth(project);

    expect(health.staleServers).toEqual([]);
    expect(health.hygiene).toBeDefined();
  });
});
