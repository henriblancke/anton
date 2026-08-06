/**
 * `projectHealthFromBoard` composes `rankAttention` for the Health page. What matters: escalations
 * never taint what this page calls "worth a look" or "clean" (they're answered on the board, not
 * here), the attention/housekeeping split still comes straight from `rankAttention`, and the stopped
 * count is carried through untouched for the right rail's "answered on the board" line.
 */
import { describe, expect, it } from "vitest";

import { projectHealthFromBoard } from "./health";
import type { Board, HygieneFinding, HygieneReport, ReviewTrajectory } from "./types";

type BoardSlice = Pick<Board, "hygiene" | "scanHealth" | "reviewTrajectory">;

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

describe("projectHealthFromBoard", () => {
  it("reports nothing checked for a project with no patrol, no scan, no scores", () => {
    const board: BoardSlice = { hygiene: undefined, scanHealth: undefined, reviewTrajectory: undefined };
    const health = projectHealthFromBoard(board, 0);
    expect(health.worthALook).toEqual([]);
    expect(health.housekeeping).toEqual([]);
    expect(health.hygiene).toBeUndefined();
    expect(health.scanHealth).toBeUndefined();
    expect(health.trajectory).toBeUndefined();
  });

  it("distinguishes 'checked, clean' from 'never checked' by keeping the patrol report itself", () => {
    const board: BoardSlice = { hygiene: hygiene([]), scanHealth: undefined, reviewTrajectory: undefined };
    const health = projectHealthFromBoard(board, 0);
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
    const health = projectHealthFromBoard(board, 0);
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
    const health = projectHealthFromBoard(board, 0);
    expect(health.worthALook).toEqual([]);
    expect(health.housekeeping).toHaveLength(1);
    expect(health.housekeeping[0]).toMatchObject({ source: "hygiene", severity: "housekeeping" });
  });

  it("promotes a rework-band worst score into worthALook", () => {
    const board: BoardSlice = { hygiene: undefined, scanHealth: undefined, reviewTrajectory: trajectory(3) };
    const health = projectHealthFromBoard(board, 0);
    expect(health.worthALook).toHaveLength(1);
    expect(health.worthALook[0]).toMatchObject({ source: "review" });
  });

  it("leaves a healthy trend out of worthALook", () => {
    const board: BoardSlice = { hygiene: undefined, scanHealth: undefined, reviewTrajectory: trajectory(8) };
    const health = projectHealthFromBoard(board, 0);
    expect(health.worthALook).toEqual([]);
  });

  it("carries the stopped count through untouched, independent of hygiene/review findings", () => {
    const board: BoardSlice = { hygiene: undefined, scanHealth: undefined, reviewTrajectory: undefined };
    const health = projectHealthFromBoard(board, 3);
    expect(health.stoppedCount).toBe(3);
    // An open escalation must not turn a project with no findings into a "not clean" one — it's a
    // different question, answered on the board, and this page never mixes the two.
    expect(health.worthALook).toEqual([]);
  });
});
