/**
 * THE FENCE'S REGRESSION CORPUS (anton-otos): anton's own board as it stood on 2026-09-05 — 842
 * beads, 1285 edges, 37 picks under an armed policy — and the proof that the narrowed stamp
 * (anton-7zpv) still catches every move that could reorder them.
 *
 * A narrowing argued over fixtures is an argument about fixtures. What the classification claims
 * (anton-gsny) is a claim about a REAL board: that anton's own bookkeeping churns in namespaces no
 * reader of the decision consults, while everything the ranking reads still moves the fence. Both
 * halves are only checkable against a board with real parentage, real `blocks` chains, real
 * contracts and real label vocabulary — a synthetic three-bead board has no bead three hops
 * downstream of a pick to close.
 *
 * The snapshot: `bd list --status all --json --limit 0`, run in this repo on 2026-09-05, keeping the
 * fields the decision reads. Two encodings, both lossless for that decision:
 *
 *   • description bodies are elided to `…`, with every heading and every unfilled formula prompt
 *     (`TODO —`) kept verbatim — the contract gate judges section PRESENCE and prompt-vs-content, so
 *     each bead's verdict is preserved (checked bead-by-bead against the raw export at capture).
 *   • `dependencies` are written `type>id`; bd inlines a bead's edges on the bead itself, so the
 *     `issue_id` is always its own and {@link corpus} restores it.
 *
 * MEASURED HERE, on this board (the generation-lifetime question the epic asks):
 *
 *   • The heartbeat, which is the churn that actually dominates: a run refreshes its `run-lease:`
 *     every 5 minutes (`RUN_LEASE_REFRESH_MS`, execute-epic-lease.ts) against a pass that reruns
 *     every 10. The pre-narrowing fence therefore died on the FIRST heartbeat — with any run in
 *     flight a generation lasted ≤5 minutes, half a pass cadence, so the recorded plan read stale
 *     for most of every window. The narrowed fence survives all 12 heartbeats of an hour and is not
 *     capped by them at all — measured against a restated pre-narrowing control in "generation
 *     lifetime" below.
 *   • The board's standing label writes: 287 of 3894 (7.4%) sit in namespaces the fence now
 *     ignores, so they stop retiring a generation on their own. A floor, not the rate — a persisted
 *     snapshot counts each label once and cannot see a heartbeat rewritten every five minutes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LABELS } from "./beads/bd";
import type { Bead } from "./beads/types";
import {
  DIGEST_FIELDS,
  isDecisionRelevantLabel,
  isPlanStale,
  stampBoard,
  type BoardPickerPlan,
} from "./board-picker-plan";
import { decideBoardPickerPlan } from "./jobs/picker-decision";
import { armedPickerPolicy } from "./jobs/picker-policy";
import type { Policy } from "./policy/types";

/** The snapshot's row shape: the fields the decision reads, with bd's inlined edges compacted to
 *  `type>id` — see the module note. Written out rather than derived from `Bead`, so the fixture's
 *  schema is stated where the loader reads it. */
interface CorpusRow {
  id: string;
  title: string;
  status: string;
  issue_type?: string;
  priority?: number;
  assignee?: string;
  created_at?: string;
  parent?: string;
  labels?: string[];
  deps?: string[];
  description?: string;
  acceptance_criteria?: string;
}

function corpus(): Bead[] {
  const rows = JSON.parse(
    readFileSync(join(process.cwd(), "src/lib/board-picker-plan.corpus.fixture.json"), "utf8"),
  ) as CorpusRow[];
  return rows.map(({ deps, ...row }) => ({
    ...row,
    ...(deps
      ? {
          dependencies: deps.map((dep) => {
            const [type, dependsOn] = dep.split(">");
            return { issue_id: row.id, depends_on_id: dependsOn, type };
          }),
        }
      : {}),
  }));
}

const BOARD = corpus();

/** The moment the snapshot was read, to the minute — every decision below is judged at it. */
const OBSERVED = Date.parse("2026-09-05T13:00:00Z");

/** Refresh cadence of the run-lease heartbeat (`RUN_LEASE_REFRESH_MS`, execute-epic-lease.ts). */
const HEARTBEAT_MS = 5 * 60_000;

/** The policy the corpus is decided under: this repo's own vocabulary, narrowing 67 structurally
 *  claimable targets to 37 picks. Armed rather than admit-all so the policy half of the stamp is
 *  under test beside the board half. */
const POLICY: Policy = {
  types: ["feature", "task", "bug"],
  maxPriority: 2,
  labels: [{ namespace: "domain", values: ["eng"] }],
};

function decide(board: Bead[], policy: Policy = POLICY) {
  return decideBoardPickerPlan({
    board,
    policy: armedPickerPolicy(policy, board, new Date(OBSERVED)),
    armedPolicy: policy,
    runtime: { observedAtMs: OBSERVED },
  });
}

const DECISION = decide(BOARD);

/** The recorded generation the fence is asked about, exactly as the pass would have saved it. */
const RECORDED: BoardPickerPlan = {
  projectId: "anton",
  planId: "corpus-generation",
  generatedAt: Math.floor(OBSERVED / 1000),
  stamp: DECISION.stamp,
  entries: DECISION.entries,
  exclusions: DECISION.exclusions,
};

/** Has the fence retired the recorded generation over this board? The predicate the lane, the
 *  `◈ policy` badge and the approve route all read — not the digest comparison behind it. */
const fenceFires = (board: Bead[], policy: Policy = POLICY) =>
  isPlanStale(RECORDED, stampBoard(board, OBSERVED, policy));

/** The picks, as the surfaces quote them: the ranking this whole fence exists to protect. */
const ranking = (board: Bead[]) => decide(board).entries.map((e) => `${e.rank}:${e.beadId}`);

const RANKING = ranking(BOARD);
const [TOP, RUNNER_UP] = DECISION.entries;

const patch = (board: Bead[], id: string, change: Partial<Bead>): Bead[] =>
  board.map((bead) => (bead.id === id ? { ...bead, ...change } : bead));

const relabel = (board: Bead[], id: string, labels: (before: string[]) => string[]): Bead[] =>
  board.map((bead) => (bead.id === id ? { ...bead, labels: labels(bead.labels ?? []) } : bead));

/** Every bead carrying a live lease — the runs in flight when the snapshot was taken. */
const LEASED = BOARD.filter((b) => (b.labels ?? []).some((l) => l.startsWith("run-lease:"))).map(
  (b) => b.id,
);

/** One heartbeat: each in-flight run republishes its lease with a fresh expiry, exactly as
 *  `beads.publishRunLease` writes it — the old label removed, the new one added. */
const heartbeat = (at: number) => (board: Bead[]) =>
  board.map((bead) => {
    const labels = bead.labels ?? [];
    if (!labels.some((l) => l.startsWith("run-lease:"))) return bead;
    return {
      ...bead,
      labels: [
        ...labels.filter((l) => !l.startsWith("run-lease:")),
        LABELS.runLease(at + 15 * 60_000, "run-corpus"),
      ],
    };
  });

describe("the corpus", () => {
  // The board the numbers in this file's note were measured on. Pinned so a refreshed snapshot is a
  // decision somebody makes here, with the measurement re-taken, rather than a fixture swap that
  // quietly moves what every assertion below is about.
  it("is anton's board as it stood on 2026-09-05", () => {
    expect({
      beads: BOARD.length,
      edges: BOARD.reduce((n, bead) => n + (bead.dependencies?.length ?? 0), 0),
      picks: DECISION.entries.length,
      excluded: DECISION.exclusions.length,
    }).toEqual({ beads: 842, edges: 1285, picks: 37, excluded: 127 });
  });

  // A board that reached one refusal would exercise one code path. This one reaches six, including
  // the two the ranking's `board` scope depends on: work held by a blocker, and work no policy admits.
  it("reaches six of the pass's refusals", () => {
    expect(new Set(DECISION.exclusions.map((x) => x.reason))).toEqual(
      new Set(["not-a-run-target", "not-open", "claimed", "blocked", "approval-gap", "policy"]),
    );
  });
});

describe("the 2026-09-05 board, mutated the ways the classification calls irrelevant", () => {
  /**
   * anton's own writes, as it makes them: a lease heartbeat, a score filed when a run lands,
   * provenance on a bead its automation created, a PR pointer, a re-stamped `updated_at`, a founder
   * fixing prose. Each has to leave BOTH the ranking and the fence exactly where they were — the
   * ranking because the classification claims nothing reads these, the fence because a stamp that
   * moved anyway would retire the generation regardless of what the ranking did.
   */
  const IRRELEVANT: [name: string, mutate: (board: Bead[]) => Bead[]][] = [
    ["anton refreshes the run-lease on every run in flight", heartbeat(OBSERVED + HEARTBEAT_MS)],
    [
      "a run lands and anton files its review score",
      (board) => LEASED.reduce((b, id) => relabel(b, id, (l) => [...l, LABELS.reviewScore(8)]), board),
    ],
    [
      "the gardener stamps its provenance on a bead it filed",
      (board) => relabel(board, TOP.beadId, (l) => [...l, LABELS.source("gardener")]),
    ],
    [
      "a founder fixes a typo in a title",
      (board) => patch(board, TOP.beadId, { title: "The same pick, spelled right" }),
    ],
    [
      "prose is reworded under intact headings",
      (board) =>
        board.map((bead) =>
          bead.description
            ? { ...bead, description: bead.description.replaceAll("…", "reworded, at length") }
            : bead,
        ),
    ],
    [
      "bd re-stamps updated_at on everything it touched",
      (board) => board.map((bead) => ({ ...bead, updated_at: "2026-09-05T13:00:00Z" })),
    ],
    [
      "anton records the PR pointer on the bead it ran",
      (board) => patch(board, TOP.beadId, { metadata: { pr: "https://github.com/x/y/pull/232" } }),
    ],
    ["the board comes back in a different read order", (board) => [...board].reverse()],
    [
      "one run's whole bookkeeping trail at once",
      (board) => {
        const refreshed = heartbeat(OBSERVED + HEARTBEAT_MS)(board);
        const scored = LEASED.reduce(
          (b, id) => relabel(b, id, (l) => [...l, LABELS.reviewScore(9), LABELS.source("stringer")]),
          refreshed,
        );
        return patch(scored, TOP.beadId, {
          title: "retitled mid-run",
          updated_at: "2026-09-05T13:04:00Z",
          metadata: { pr: "https://github.com/x/y/pull/233" },
        });
      },
    ],
  ];

  it.each(IRRELEVANT)("holds the ranking and the fence when %s", (_name, mutate) => {
    const moved = mutate(BOARD);

    expect(ranking(moved)).toEqual(RANKING);
    expect(fenceFires(moved)).toBe(false);
  });
});

describe("the 2026-09-05 board, mutated the ways the classification calls relevant", () => {
  /**
   * One edit per decision-relevant input, made on the board rather than on a fixture. `anton-v55d`
   * is the case the whole `board` scope rests on: it is `open` and BLOCKED, so no plan picked it and
   * no policy could — and it is the one bead `anton-vgoh` (rank 5) releases, so closing it drops
   * that pick's unblocking count to zero and moves it down the queue.
   */
  const RELEVANT: [name: string, mutate: (board: Bead[]) => Bead[]][] = [
    ["a pick is claimed", (b) => patch(b, TOP.beadId, { assignee: "henri" })],
    // Raised on the RUNNER-UP: rank 1 already carries P0, so the edit that reorders is the one that
    // pulls the pick behind it level.
    ["a pick is raised to P0", (b) => patch(b, RUNNER_UP.beadId, { priority: 0 })],
    ["a pick closes", (b) => patch(b, TOP.beadId, { status: "closed" })],
    [
      "a pick's Acceptance section is cleared",
      (b) =>
        patch(b, TOP.beadId, {
          description: "## Goal\n\n…\n\n## Context\n\n…",
          acceptance_criteria: undefined,
        }),
    ],
    ["a pick is re-parented", (b) => patch(b, TOP.beadId, { parent: "anton-3xs" })],
    ["a pick's type changes", (b) => patch(b, TOP.beadId, { issue_type: "epic" })],
    ["a pick's created_at is corrected", (b) => patch(b, TOP.beadId, { created_at: "2025-01-01T00:00:00Z" })],
    [
      "the domain: label the policy reads is dropped",
      (b) => relabel(b, TOP.beadId, (l) => l.filter((x) => x !== "domain:eng")),
    ],
    [
      "anton marks a pick stage:in-review",
      (b) => relabel(b, TOP.beadId, (l) => [...l, LABELS.stage("in-review")]),
    ],
    [
      "a new blocks edge grips a pick",
      (b) =>
        patch(b, TOP.beadId, {
          dependencies: [
            ...(BOARD.find((x) => x.id === TOP.beadId)?.dependencies ?? []),
            { issue_id: TOP.beadId, depends_on_id: "anton-3xs", type: "blocks" },
          ],
        }),
    ],
    ["the one bead a pick releases closes", (b) => patch(b, "anton-v55d", { status: "closed" })],
    ["a bead leaves the board", (b) => b.filter((bead) => bead.id !== "anton-v55d")],
    [
      "a bead joins the board",
      (b) => [...b, { id: "anton-new", title: "filed since", status: "open", issue_type: "task" }],
    ],
  ];

  it.each(RELEVANT)("retires the generation when %s", (_name, mutate) => {
    expect(fenceFires(mutate(BOARD))).toBe(true);
  });

  // The board half of the stamp cannot see this one at all: the operator narrows their standing
  // rules and every bead sits still, while the picks those rules produced are no longer the picks.
  it("retires the generation when the operator narrows the armed policy", () => {
    const narrowed: Policy = { ...POLICY, maxPriority: 1 };

    expect(ranking(BOARD).length).toBeGreaterThan(decide(BOARD, narrowed).entries.length);
    expect(fenceFires(BOARD, narrowed)).toBe(true);
  });

  /**
   * The reorder the narrowing is most often accused of missing, spelled out: the bead that moves the
   * queue is neither a pick nor pickable, and it is not the bead whose rank changes.
   */
  it("catches a reorder made off a bead the plan neither picked nor could pick", () => {
    const settled = patch(BOARD, "anton-v55d", { status: "closed" });

    expect(DECISION.exclusions).toContainEqual(
      expect.objectContaining({ beadId: "anton-v55d", reason: "blocked" }),
    );
    expect(ranking(settled)).not.toEqual(RANKING);
    expect(fenceFires(settled)).toBe(true);
  });

  /**
   * The property the epic asks for, over the real picks rather than a fixture pair: lift each one to
   * the head of the queue and the fence must catch it — 37 reorders, none of them silent.
   */
  it.each(DECISION.entries.map((e) => e.beadId))("catches the reorder that lifts %s to rank 1", (beadId) => {
    const lifted = patch(BOARD, beadId, { priority: 0, created_at: "2020-01-01T00:00:00Z" });

    expect(ranking(lifted)[0]).toBe(`1:${beadId}`);
    expect(fenceFires(lifted)).toBe(true);
  });
});

/**
 * WHAT THE NARROWING BOUGHT, measured on this board.
 *
 * The baseline is the fence as it stood before anton-7zpv — the same classified columns, with the
 * `labels` column hashing every label rather than the decision-relevant ones. Restated here as a
 * CONTROL (derived from {@link DIGEST_FIELDS}, so a column added to the table joins both sides at
 * once) because the comparison is the measurement: without it "the fence holds" is a claim about
 * one digest, not an improvement over the one it replaced.
 */
describe("generation lifetime", () => {
  const allLabels = (bead: Bead) => [...(bead.labels ?? [])].sort().join(",");

  const preNarrowingFence = (board: Bead[]): string =>
    JSON.stringify(
      board
        .map((bead) =>
          DIGEST_FIELDS.map((f) => (f.field === "labels" ? allLabels(bead) : f.read(bead))).join("\t"),
        )
        .sort(),
    );

  const narrowedFence = (board: Bead[]): string => stampBoard(board, OBSERVED, POLICY).digest;

  /** How many writes of a stream a fence survives before it retires the generation. */
  function writesSurvived(fence: (board: Bead[]) => string, stream: ((board: Bead[]) => Bead[])[]) {
    const before = fence(BOARD);
    let board = BOARD;
    let survived = 0;
    for (const write of stream) {
      board = write(board);
      if (fence(board) !== before) break;
      survived++;
    }
    return survived;
  }

  /** An hour of run-lease heartbeats — 12 writes at `RUN_LEASE_REFRESH_MS`, against a pass that
   *  reruns every 10 minutes. */
  const HOUR_OF_HEARTBEATS = Array.from({ length: 12 }, (_, i) =>
    heartbeat(OBSERVED + (i + 1) * HEARTBEAT_MS),
  );

  const WRITES_SURVIVED = {
    before: writesSurvived(preNarrowingFence, HOUR_OF_HEARTBEATS),
    after: writesSurvived(narrowedFence, HOUR_OF_HEARTBEATS),
  };

  // The reported measurement: the old fence died on the first heartbeat, so a generation could not
  // outlive 5 minutes while any run was in flight — half the 10-minute pass cadence, which is why
  // the lane read stale more often than not. The narrowed one is not capped by the heartbeat at all.
  it("survives an hour of lease heartbeats that used to retire it on the first", () => {
    expect(WRITES_SURVIVED).toEqual({ before: 0, after: 12 });
  });

  // The other half of the same measurement, over the writes the snapshot itself preserves. A floor
  // rather than the rate: a persisted board counts each label once, however often it was rewritten.
  it("spares 287 of the board's 3894 standing label writes", () => {
    const writes = BOARD.flatMap((bead) => bead.labels ?? []);
    const spared = writes.filter((label) => !isDecisionRelevantLabel(label));

    expect({ writes: writes.length, spared: spared.length }).toEqual({ writes: 3894, spared: 287 });
    expect(new Set(spared.map((l) => l.split(":")[0]))).toEqual(
      new Set(["run-lease", "review-score", "source"]),
    );
  });

  // A fence that survived everything would be no fence: the same stream, with one claimed pick at
  // the end, still retires the generation.
  it("still retires the generation on the first write that could change a pick", () => {
    const claimed = (board: Bead[]) => patch(board, TOP.beadId, { assignee: "henri" });

    expect(writesSurvived(narrowedFence, [...HOUR_OF_HEARTBEATS, claimed])).toBe(12);
  });
});
