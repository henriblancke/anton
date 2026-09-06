/**
 * PLAN CURRENCY (anton-icu6): how often the recorded generation still names the current top pick,
 * measured before and after the fence is narrowed to the decision's reachable set — and the proof
 * that "current far more often" did not become "current when it should not be".
 *
 * The fence exists for exactly one promise: no run is ever accepted against a generation that did
 * not decide it. Narrowing it (anton-t01f) makes the recorded plan read current far more often,
 * which is the point — and is also precisely how a fence gets weakened. So this file measures both
 * sides of that trade on anton's own board rather than asserting either.
 *
 * THE MODEL, stated so the numbers can be re-weighted rather than believed:
 *
 *   • the board is the 2026-09-05 corpus (`board-picker-plan.corpus.fixture.json`) — 842 beads, 164
 *     of them open, 29 picks under the armed policy below.
 *   • it moves ONCE A MINUTE for an hour, which is the rate the epic is about. 56 of the 60 writes
 *     are grooming that provably cannot change the answer — an `area:` tag on a bead drawn evenly
 *     across the board in read order — and 4 are real moves: two runs start, a blocker closes, a
 *     target is filed. Which of the 56 land inside the decision's reach is the BOARD's answer, not
 *     this file's.
 *   • the pass re-decides on the board-change nudge (anton-h32k), so the recorded generation lags
 *     each write by one debounce window (`PICKER_NUDGE_WINDOW_MS`, 30s) and no longer.
 *
 * MEASURED (see "the hour", below):
 *
 *   • BEFORE — the fence over the whole board: the recorded generation names the current top pick
 *     50.0% of the hour. That is the ceiling, not a coincidence: every write moves a whole-board
 *     digest, so the generation is retired for one debounce window out of every write interval and
 *     the plan can never read current more than 1 − 30s/60s of the time, however irrelevant the
 *     write was.
 *   • AFTER — the fence over the decision's reachable set: 85.8%. Only 17 of the 60 writes move it
 *     — the 4 real ones and the 13 grooming tags that happened to land inside the reach — so the
 *     hour costs 17 debounce windows instead of 60.
 *   • FALSE CURRENT — the fence reads current while the recorded generation does NOT name the live
 *     top pick: 0 seconds of the hour, under both fences. That is the guard, and it is the number
 *     that had to stay at zero.
 *
 * THE HOLE THE SWEEP FOUND, and why {@link reachableSet} has three parts rather than two. The
 * epic specifies the reachable set as "the candidate pool plus the blocks-closure over it". That is
 * not sound on its own: `beads.isContainer` counts a feature child of ANY status, so re-parenting a
 * CLOSED feature under an epic pick turns that pick into a container and drops it from the plan —
 * with no bead entering the pool and no `blocks` edge moving, so a pool+blocks fence never fires.
 * Pinned below as "a closed feature child". Feature children of the set are therefore in the fence,
 * which widens it from 199 beads to 288 of 842 — some of the 85.8% above is paid for that, and it
 * is cheap at the price.
 *
 * SWEPT EXHAUSTIVELY AT CAPTURE, and sampled in the gate: every one of the 569 beads this fence
 * drops, mutated seven ways the decision reads (reopened, re-parented under the top pick, retyped
 * to `feature`, removed from the board, contract cleared, `approved` dropped, raised to P0) — 3983
 * probes, of which 21 moved the ranking and 0 escaped the fence. The suite keeps a fixed sample of
 * that sweep so the unit gate stays fast; re-run it in full when the fence changes.
 *
 * THE CONTROL IS THE OLD FENCE. The narrowing has since landed in `stampBoard` (anton-t01f), so the
 * AFTER side of every measurement below is production and it is the BEFORE side that is restated
 * here — the whole-board digest, over the same classified columns, the way
 * `board-picker-plan.corpus.test.ts` restates the pre-narrowing label fence beside it. The
 * comparison is the measurement; without the control, "the plan reads current more often" is a
 * number with nothing behind it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Bead } from "./beads/types";
import {
  DIGEST_FIELDS,
  isPlanStale,
  reachableSet,
  stampBoard,
  type BoardPickerPlan,
  type BoardStamp,
} from "./board-picker-plan";
import * as schema from "./db/schema";
import { makeTestDb, type TestDb } from "./db/testing";
import { ADMIT_ALL_POLICY, decideBoardPickerPlan } from "./jobs/picker-decision";
import { PICKER_NUDGE_WINDOW_MS } from "./jobs/picker-nudge";
import { armedPickerPolicy } from "./jobs/picker-policy";
import type { Clock } from "./jobs/queue";
import {
  PICKER_DEFER_WINDOW_MS,
  activeDeferrals,
  declinedPicks,
  recordPickerAccept,
  recordPickerVeto,
} from "./picker-veto";
import { policyDigest } from "./policy/digest";
import type { Policy } from "./policy/types";

/** The fixture's row shape and encoding — see the module note on `board-picker-plan.corpus.test.ts`,
 *  which captured it. */
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

/** The moment the snapshot was read. Every decision here is judged at it, so the hour below is a
 *  board that moves and a clock that does not — age is re-judged by `agedOutPicks`, not by a fence. */
const OBSERVED = Date.parse("2026-09-05T13:00:00Z");

/** The same armed policy the corpus is decided under, so the two files measure one board. */
const POLICY: Policy = {
  types: ["feature", "task", "bug"],
  maxPriority: 2,
  labels: [{ namespace: "domain", values: ["eng"] }],
};

function decide(board: Bead[]) {
  return decideBoardPickerPlan({
    board,
    policy: armedPickerPolicy(POLICY, board, new Date(OBSERVED)),
    armedPolicy: POLICY,
    runtime: { observedAtMs: OBSERVED },
  });
}

const ranking = (board: Bead[]) => decide(board).entries.map((e) => `${e.rank}:${e.beadId}`);

const patch = (board: Bead[], id: string, change: Partial<Bead>): Bead[] =>
  board.map((bead) => (bead.id === id ? { ...bead, ...change } : bead));

// ── the two fences ──────────────────────────────────────────────────────────────────────────────

/**
 * BEFORE: the fence as it stood before the narrowing — the same classified columns over EVERY bead
 * on the board. Restated here as a control because production no longer writes it; derived from
 * {@link DIGEST_FIELDS}, so a column added to the table joins both sides of the measurement at once.
 *
 * The digest is the projection itself rather than a hash of it. Nothing compares it to a stored
 * row — `isPlanStale` asks only whether two stamps agree — and an unhashed control is one fewer
 * step between the reader and what is being measured.
 */
const wholeBoardStamp = (board: Bead[]): BoardStamp => ({
  observedAtMs: OBSERVED,
  digest: JSON.stringify([
    policyDigest(POLICY),
    ...board.map((bead) => DIGEST_FIELDS.map((f) => f.read(bead)).join("\t")).sort(),
  ]),
  beadCount: board.length,
});

/**
 * AFTER: the fence as `stampBoard` now writes it — narrowed to {@link reachableSet}, the beads one
 * decision can actually read. Production, not a restatement: the numbers below are what the running
 * system does.
 */
const reachableStamp = (board: Bead[]): BoardStamp => stampBoard(board, OBSERVED, POLICY);

// ── the hour ────────────────────────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;

const BASE = decide(BOARD);
const [TOP] = BASE.entries;

/** The beads the grooming stream tags — every 14th of the board in read order. Spread rather than
 *  chosen, so how many of them sit inside the decision's reach is a fact about anton's board. */
const GROOMED = BOARD.filter((_, i) => i % 14 === 0).map((bead) => bead.id);

/** One board write, and whether it is one the decision can actually see. */
interface BoardWrite {
  what: string;
  movesTheDecision: boolean;
  apply: (board: Bead[]) => Bead[];
}

/** A target filed since the snapshot: approved, eng, P0 and old, so it lands at the head of the
 *  queue rather than somewhere the top-pick comparison cannot see. */
const FILED: Bead = {
  id: "anton-filed",
  title: "filed during the hour",
  status: "open",
  issue_type: "task",
  priority: 0,
  created_at: "2025-06-01T00:00:00Z",
  labels: ["approved", "domain:eng"],
  description: [
    "## Goal",
    "ship it",
    "## Acceptance Criteria",
    "- [ ] it ships",
    "## Context",
    "the hour",
    "## Out of scope",
    "everything else",
    "## Verify",
    "the suite",
  ].join("\n\n"),
  acceptance_criteria: "- [ ] it ships",
};

/** A run starting on whatever the pass would pick NOW — read off the board it is handed, so the
 *  second one of these claims the successor rather than a target already under way. */
function claimTheTopPick(board: Bead[]): Bead[] {
  const top = decide(board).entries[0];
  return top ? patch(board, top.beadId, { assignee: "henri" }) : board;
}

/**
 * The four writes an hour of real work makes, at the minutes they land. Everything else in the hour
 * is grooming. `anton-v55d` is the corpus's off-candidate blocker — open, blocked, pickable by
 * nobody, and the one bead a pick releases — so closing it reorders the queue from outside the
 * plan entirely.
 */
const REAL_MOVES: Record<number, BoardWrite> = {
  15: {
    what: "a run starts and claims the top pick",
    movesTheDecision: true,
    apply: claimTheTopPick,
  },
  30: {
    what: "the one bead a pick releases closes",
    movesTheDecision: true,
    apply: (board) => patch(board, "anton-v55d", { status: "closed" }),
  },
  45: {
    what: "a target is filed and approved",
    movesTheDecision: true,
    apply: (board) => [...board, FILED],
  },
  58: {
    what: "a second run starts and claims the top pick of the moment",
    movesTheDecision: true,
    apply: claimTheTopPick,
  },
};

/** The hour, minute by minute. */
const STREAM: BoardWrite[] = Array.from({ length: HOUR_MINUTES }, (_, i) => {
  const minute = i + 1;
  const real = REAL_MOVES[minute];
  if (real) return real;
  const beadId = GROOMED[i % GROOMED.length];
  return {
    what: `the gardener tags ${beadId}`,
    movesTheDecision: false,
    apply: (board) =>
      patch(board, beadId, {
        labels: [...(board.find((b) => b.id === beadId)?.labels ?? []), "area:picker"],
      }),
  };
});

/** The board after each minute's write; index 0 is the snapshot itself. */
const STATES: Bead[][] = STREAM.reduce<Bead[][]>(
  (states, write) => [...states, write.apply(states[states.length - 1])],
  [BOARD],
);

// Memoized: every question below is asked per minute, and both the decision and the reachable set
// walk the whole board.
const DECISIONS = STATES.map(decide);
const WHOLE_BOARD = STATES.map(wholeBoardStamp);
const REACHABLE = STATES.map(reachableStamp);

/** The generation the pass recorded off `STATES[minute]`, under one fence or the other. */
function generation(minute: number, stamps: BoardStamp[]): BoardPickerPlan {
  return {
    projectId: "anton",
    planId: `generation-${minute}`,
    generatedAt: Math.floor(OBSERVED / 1000),
    stamp: stamps[minute],
    entries: DECISIONS[minute].entries,
    exclusions: DECISIONS[minute].exclusions,
  };
}

/**
 * Walk the hour under one fence, handing each interval to `visit`.
 *
 * Two intervals per minute, because the nudge is a debounce: the write at the top of the minute
 * leaves the PREVIOUS minute's generation recorded for one window, then the pass it triggered
 * replaces it for the rest.
 */
function overTheHour(
  stamps: BoardStamp[],
  visit: (interval: { minute: number; ms: number; recorded: BoardPickerPlan; liveTop?: string }) => void,
): void {
  for (let minute = 1; minute <= HOUR_MINUTES; minute++) {
    const liveTop = DECISIONS[minute].entries[0]?.beadId;
    const windows = [
      [minute - 1, PICKER_NUDGE_WINDOW_MS],
      [minute, MINUTE_MS - PICKER_NUDGE_WINDOW_MS],
    ] as const;
    for (const [recorded, ms] of windows) {
      visit({ minute, ms, recorded: generation(recorded, stamps), liveTop });
    }
  }
}

/** The share of the hour the recorded generation names the current top pick, and the share it
 *  wrongly claims to. Percentages to one decimal — the pinned measurement. */
function currency(stamps: BoardStamp[]) {
  let names = 0;
  let falseCurrent = 0;
  let total = 0;
  overTheHour(stamps, ({ minute, ms, recorded, liveTop }) => {
    total += ms;
    if (isPlanStale(recorded, stamps[minute])) return;
    if (recorded.entries[0]?.beadId === liveTop) names += ms;
    else falseCurrent += ms;
  });
  const pct = (part: number) => Math.round((part / total) * 1000) / 10;
  return { namesTheTopPick: pct(names), falseCurrent: pct(falseCurrent) };
}

describe("the hour", () => {
  // The stream the two numbers below are measured over. Pinned so a change to the model is a
  // decision somebody makes here rather than a silent re-weighting of the measurement.
  it("is 60 writes a minute apart, four of which the decision can see", () => {
    expect({
      writes: STREAM.length,
      real: STREAM.filter((w) => w.movesTheDecision).length,
      grooming: STREAM.filter((w) => !w.movesTheDecision).length,
      picks: BASE.entries.length,
    }).toEqual({ writes: 60, real: 4, grooming: 56, picks: 29 });
  });

  // The four are real: each one reorders the queue. A "real move" that did not move the ranking
  // would leave the guard below measuring nothing.
  it("really moves the ranking on each of the four", () => {
    const moved = Object.keys(REAL_MOVES)
      .map(Number)
      .filter((minute) => ranking(STATES[minute]).join() !== ranking(STATES[minute - 1]).join());

    expect(moved).toEqual(Object.keys(REAL_MOVES).map(Number));
  });

  /**
   * THE MEASUREMENT (anton-icu6). Before: the whole-board fence is capped at one debounce window
   * per write interval by construction, whatever the write was. After: only the writes that landed
   * inside the decision's reach cost anything.
   */
  it("reports what narrowing the fence to the decision's reachable set buys", () => {
    expect({
      before: currency(WHOLE_BOARD).namesTheTopPick,
      after: currency(REACHABLE).namesTheTopPick,
    }).toEqual({ before: 50, after: 85.8 });
  });

  /**
   * AND WHAT IT MUST NOT COST — the promise the whole fence exists for, restated as a measurement:
   * the recorded generation is never readable as current while it does not name the live top pick.
   * A narrowing that bought its currency by going blind would show up here and nowhere else.
   */
  it("never reads current while the recorded generation has stopped naming the top pick", () => {
    expect({
      before: currency(WHOLE_BOARD).falseCurrent,
      after: currency(REACHABLE).falseCurrent,
    }).toEqual({ before: 0, after: 0 });
  });

  /**
   * The same guard at the granularity a start actually happens at (the ticket's first criterion,
   * over the narrowed fence): while a generation reads current, every pick it offers is still a
   * pick the live decision makes, at the rank it recorded. So an accept taken against it is an
   * accept of a decision anton still stands behind — which is the one thing the fence guards.
   */
  it("offers no pick the live decision has stopped making, at any moment of the hour", () => {
    const offered: string[] = [];
    overTheHour(REACHABLE, ({ minute, recorded }) => {
      if (isPlanStale(recorded, REACHABLE[minute])) return;
      const live = DECISIONS[minute].entries.map((e) => `${e.rank}:${e.beadId}`).join();
      if (recorded.entries.map((e) => `${e.rank}:${e.beadId}`).join() !== live) {
        offered.push(`minute ${minute}: ${recorded.planId}`);
      }
    });

    expect(offered).toEqual([]);
  });

  /**
   * Where the two numbers above come from, so neither is magic. A whole-board digest moves on every
   * write there is; the narrowed one moves on the 17 that reach the decision. Each move costs one
   * debounce window, and 60 and 17 windows of 30s in an hour are exactly the 50.0% and 85.8%.
   */
  it("is retired by all 60 writes under the whole-board fence and by 17 under the narrowed one", () => {
    const retiring = (stamps: BoardStamp[]) =>
      STREAM.filter((_, i) => stamps[i].digest !== stamps[i + 1].digest).length;

    expect({ wholeBoard: retiring(WHOLE_BOARD), reachable: retiring(REACHABLE) }).toEqual({
      wholeBoard: 60,
      reachable: 17,
    });
  });

  // The narrowing is only interesting if it is actually narrow: the reach is a minority of the
  // board, and it is what the 85.8% above is bought with.
  it("reaches 288 of the board's 842 beads", () => {
    expect({ reached: reachableSet(BOARD).size, board: BOARD.length }).toEqual({
      reached: 288,
      board: 842,
    });
  });
});

describe("the beads the narrowed fence drops", () => {
  const DROPPED = ((): Bead[] => {
    const reached = reachableSet(BOARD);
    return BOARD.filter((bead) => !reached.has(bead.id));
  })();

  /**
   * A fixed sample of the capture-time sweep — see the module note. Every 14th dropped bead, mutated
   * the three ways that actually moved a ranking or could reach one, and each mutation must either
   * leave the queue exactly where it was or retire the generation. Sampled rather than exhaustive
   * only so the unit gate stays under a second per assertion; the full 3983-probe sweep found the
   * same answer.
   */
  const SAMPLE = DROPPED.filter((_, i) => i % 14 === 0);
  const RANKING = ranking(BOARD).join();
  const FENCE = reachableStamp(BOARD).digest;

  const PROBES: [name: string, mutate: (bead: Bead) => Bead[]][] = [
    ["reopens", (bead) => patch(BOARD, bead.id, { status: "open" })],
    ["is re-parented under the top pick", (bead) => patch(BOARD, bead.id, { parent: TOP.beadId })],
    ["leaves the board", (bead) => BOARD.filter((b) => b.id !== bead.id)],
  ];

  it("samples the sweep across the whole dropped set", () => {
    expect({ dropped: DROPPED.length, sampled: SAMPLE.length }).toEqual({ dropped: 569, sampled: 41 });
  });

  it.each(PROBES)("holds the ranking or fires when one of them %s", (_name, mutate) => {
    const silent: string[] = [];
    for (const bead of SAMPLE) {
      const moved = mutate(bead);
      if (ranking(moved).join() === RANKING) continue;
      if (reachableStamp(moved).digest === FENCE) silent.push(bead.id);
    }

    expect(silent).toEqual([]);
  });

  /**
   * THE HOLE, pinned. `beads.isContainer` counts a feature child of any status, so a CLOSED feature
   * re-parented under an epic pick turns that pick into a container and drops it from the plan —
   * with no bead entering the candidate pool and no `blocks` edge moving. A reachable set of "pool
   * plus blocks-closure", which is how the epic states the narrowing, reads current through it and
   * offers a start the decision no longer makes. The feature-children clause of
   * {@link reachableSet} is what closes it, and this is the case that says so.
   */
  it("catches a closed feature child re-parented under an epic pick", () => {
    const shaped = (over: Partial<Bead>): Bead => ({
      id: "anton-x",
      title: "t",
      status: "open",
      issue_type: "epic",
      labels: ["approved", "domain:eng"],
      priority: 1,
      created_at: "2026-01-01T00:00:00Z",
      description: [
        "## Goal",
        "g",
        "## Acceptance Criteria",
        "- [ ] a",
        "## Context",
        "c",
        "## Out of scope",
        "o",
        "## Verify",
        "v",
      ].join("\n\n"),
      acceptance_criteria: "- [ ] a",
      ...over,
    });
    const epic = shaped({ id: "anton-epic" });
    const before = [
      epic,
      shaped({ id: "anton-ticket", issue_type: "task", parent: "anton-epic" }),
      shaped({ id: "anton-shipped", issue_type: "feature", status: "closed", parent: "anton-done" }),
      shaped({ id: "anton-done", status: "closed" }),
    ];
    // The write: the founder files the finished feature under the epic it belonged to all along.
    const after = patch(before, "anton-shipped", { parent: "anton-epic" });

    // Decided admit-all: the armed policy above narrows to feature/task/bug, and this case is about
    // an EPIC losing its run-target identity.
    const admitAll = (board: Bead[]) =>
      decideBoardPickerPlan({ board, policy: ADMIT_ALL_POLICY, runtime: { observedAtMs: OBSERVED } });

    expect(admitAll(before).entries.map((e) => e.beadId)).toEqual(["anton-epic"]);
    expect(admitAll(after).entries).toEqual([]);
    expect(reachableStamp(before).digest).not.toBe(reachableStamp(after).digest);
  });
});

/**
 * THE START DECISION THE FENCE GUARDS — the veto half (the ticket's second criterion), asked over
 * the narrowed fence and a real store rather than a fixture pair.
 *
 * The digest is not the whole fence: a decline is anton's own state with a wall-clock expiry, so it
 * moves no bead and a narrower digest cannot see it either. What has to stay true is that a veto
 * recorded against a GENERATION retires that generation once the hold it placed lapses — otherwise
 * the pick is re-offered under the very generation whose decline makes `recordPickerAccept` refuse
 * the release's accept, and the run starts with no evidence behind it.
 */
describe("a veto against the recorded generation", () => {
  const PROJECT = "p-currency";
  const NOW = OBSERVED;
  const GENERATION = generation(0, REACHABLE);

  let test: TestDb;
  let clock: Clock;
  let nowMs: number;

  beforeEach(async () => {
    test = makeTestDb();
    nowMs = NOW;
    clock = { now: () => nowMs };
    await test.db
      .insert(schema.projects)
      .values({ id: PROJECT, slug: "currency", name: "currency", repoPath: "/tmp/currency" });
  });

  afterEach(() => test.close());

  const veto = (beadId: string) =>
    recordPickerVeto(test.db, clock, {
      projectId: PROJECT,
      beadId,
      action: "not-now",
      planId: GENERATION.planId,
    });

  const fenceAt = async (atMs: number) =>
    isPlanStale(
      GENERATION,
      REACHABLE[0],
      await activeDeferrals(test.db, PROJECT, new Date(atMs)),
      await declinedPicks(test.db, PROJECT, GENERATION.planId),
    );

  it("retires it once the hold that veto placed runs out, with no pass in between", async () => {
    // Nothing on the board has moved, so the narrowed digest alone reads the generation as current.
    expect(isPlanStale(GENERATION, REACHABLE[0])).toBe(false);

    const outcome = await veto(TOP.beadId);
    expect(outcome).toEqual({
      recorded: true,
      deferral: { beadId: TOP.beadId, untilMs: NOW + PICKER_DEFER_WINDOW_MS },
    });

    // While the hold stands the generation stays current — the lane subtracts the vetoed card before
    // it ranks, which is narrower than withholding the whole plan.
    await expect(fenceAt(NOW)).resolves.toBe(false);
    // Once it lapses, the generation goes with it.
    await expect(fenceAt(NOW + PICKER_DEFER_WINDOW_MS + 1)).resolves.toBe(true);
  });

  it("leaves the next generation alone — a later pass re-picking the target is a new decision", async () => {
    await veto(TOP.beadId);

    const later = { ...generation(0, REACHABLE), planId: "generation-later" };
    const lapsed = await activeDeferrals(test.db, PROJECT, new Date(NOW + PICKER_DEFER_WINDOW_MS + 1));
    const declined = await declinedPicks(test.db, PROJECT, later.planId);

    expect(declined.size).toBe(0);
    expect(isPlanStale(later, REACHABLE[0], lapsed, declined)).toBe(false);
  });

  it("refuses the release's accept against the generation it answered", async () => {
    await veto(TOP.beadId);

    await expect(
      recordPickerAccept(test.db, clock, {
        projectId: PROJECT,
        beadId: TOP.beadId,
        rank: TOP.rank,
        planId: GENERATION.planId,
      }),
    ).resolves.toEqual({ recorded: false, reason: "vetoed" });
  });
});
