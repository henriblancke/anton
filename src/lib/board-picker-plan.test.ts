/**
 * The picker's recorded plan (anton-it5i): the snapshot stamp that makes staleness detectable, and
 * the one-row-per-project persistence three surfaces read instead of re-ranking the board. What
 * these tests pin is what those surfaces depend on — a plan replaced rather than appended, a stamp
 * that round-trips, a digest that moves only when the answer could, and a read that never shells out.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import {
  agedOutPicks,
  DIGEST_FIELDS,
  DIGEST_LABEL_NAMESPACES,
  getBoardPickerPlan,
  isDecisionRelevantLabel,
  isPlanStale,
  reachableSet,
  saveBoardPickerPlan,
  sortExclusions,
  stampBoard,
  type BoardStamp,
  type PickerExclusion,
  type PickerPlanEntry,
} from "./board-picker-plan";
import { eligibleTargets } from "./jobs/picker-targets";
import { rankTargets } from "./beads/rank";
import type { Bead } from "./beads/types";
import type { Clock } from "./jobs/queue";

// Hoisted so the `node:child_process` mock below — which vitest lifts above the imports — can close
// over it. Nothing in the read path may spawn a process; `bd` is the one that would.
const spawned = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawned,
}));

const NOW = 1_800_000_000_000;
const OBSERVED = NOW - 4_000;
const clock: Clock = { now: () => NOW };

function bead(o: Partial<Bead> = {}): Bead {
  return {
    id: "anton-a",
    title: "a target",
    status: "open",
    issue_type: "feature",
    priority: 1,
    created_at: "2026-08-01T00:00:00Z",
    labels: ["approved", "domain:eng"],
    ...o,
  };
}

/** A bead whose contract holds — the state the approve gate admits, so a gap opened in it is a real
 *  flip from eligible to `approval-gap`. */
const SHAPED_BODY = [
  "## Goal",
  "Ship the thing",
  "",
  "## Context",
  "It lives in src/lib",
  "",
  "## Out of scope",
  "Everything else",
  "",
  "## Verify",
  "bun run test",
].join("\n");

function shaped(o: Partial<Bead> = {}): Bead {
  return bead({ description: SHAPED_BODY, acceptance_criteria: "- [ ] it works", ...o });
}

function stamp(o: Partial<BoardStamp> = {}): BoardStamp {
  return { observedAtMs: OBSERVED, digest: "cafebabecafebabe", beadCount: 3, ...o };
}

const entry = (o: Partial<PickerPlanEntry> = {}): PickerPlanEntry => ({
  beadId: "anton-a",
  rank: 1,
  rule: "type ∈ {feature} ∧ priority ≥ P1",
  ...o,
});

const excluded = (o: Partial<PickerExclusion> = {}): PickerExclusion => ({
  beadId: "anton-z",
  reason: "claimed",
  detail: "held by henri",
  ...o,
});

describe("board stamp", () => {
  it("is independent of the order the board was read in", () => {
    const board = [bead({ id: "anton-a" }), bead({ id: "anton-b" }), bead({ id: "anton-c" })];
    const shuffled = [board[2], board[0], board[1]];

    expect(stampBoard(shuffled, OBSERVED).digest).toBe(stampBoard(board, OBSERVED).digest);
  });

  it("stamps the same board the same way every time it is asked", () => {
    const board = () => [bead({ id: "anton-a" }), bead({ id: "anton-b" })];

    expect(stampBoard(board(), OBSERVED).digest).toBe(stampBoard(board(), OBSERVED).digest);
  });

  // Admission is a function of the board AND the policy, so the fence has to move with either.
  it("folds the armed policy into the digest", () => {
    const board = [bead()];
    const armed = stampBoard(board, OBSERVED, { types: ["feature"] });

    expect(armed.digest).not.toBe(stampBoard(board, OBSERVED).digest);
    expect(armed.digest).not.toBe(stampBoard(board, OBSERVED, { types: ["bug"] }).digest);
    expect(armed.digest).toBe(stampBoard(board, OBSERVED, { types: ["feature"] }).digest);
  });

  // `beadCount` is the size of the set the digest COVERS, not of the snapshot it was narrowed from
  // (anton-t01f) — the closed chore below is on the board and outside the decision's reach.
  it("carries the observation moment and the size of the set it covers", () => {
    const stamped = stampBoard(
      [bead(), bead({ id: "anton-b" }), bead({ id: "anton-done", status: "closed" })],
      OBSERVED,
    );

    expect(stamped).toMatchObject({ observedAtMs: OBSERVED, beadCount: 2 });
    expect(stamped.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  // Every field the digest carries moves it — driven off the classification itself, in
  // "decision inputs" below, so the list cannot fall behind the columns.

  // The contract lives in prose, but eligibility reads it: the approve gate faults a cleared
  // Acceptance as `approval-gap`, so a digest blind to the description would hold still across the
  // one edit that flips rank 1 out of the plan entirely.
  it.each([
    ["its Acceptance criteria are cleared", { acceptance_criteria: undefined }],
    ["its Acceptance heading is deleted from the description", { description: "## Goal\nShip the thing" }],
    ["a section still holds the formula's prompt", { acceptance_criteria: "TODO — state the criteria" }],
  ])("moves when %s", (_edit, change) => {
    const before = stampBoard([shaped()], OBSERVED);

    expect(stampBoard([shaped(change)], OBSERVED).digest).not.toBe(before.digest);
  });

  it("moves when a bead joins or leaves the board", () => {
    const one = stampBoard([bead()], OBSERVED);
    const two = stampBoard([bead(), bead({ id: "anton-b" })], OBSERVED);

    expect(two.digest).not.toBe(one.digest);
  });

  // Otherwise a typo fix marks every plan stale on a board the pass re-reads every ten minutes, and
  // "the board moved" stops carrying any information. The contract enters the digest as a verdict,
  // not as its text, so reworded prose under intact headings reads as the same board.
  it("holds still when prose moves but nothing the decision reads does", () => {
    const before = stampBoard([shaped()], OBSERVED);

    const after = stampBoard(
      [
        shaped({
          title: "a target, renamed",
          description: SHAPED_BODY.replace("Ship the thing", "Ship the thing, spelled right"),
          acceptance_criteria: "- [ ] it works, restated",
          updated_at: "2026-08-19T09:00:00Z",
        }),
      ],
      OBSERVED + 60_000,
    );

    expect(after.digest).toBe(before.digest);
  });

  it("holds still when the same labels and edges arrive in a different order", () => {
    const deps = [
      { issue_id: "anton-a", depends_on_id: "anton-b", type: "blocks" },
      { issue_id: "anton-a", depends_on_id: "anton-c", type: "blocks" },
    ];
    const before = stampBoard([bead({ labels: ["a", "b"], dependencies: deps })], OBSERVED);

    const after = stampBoard(
      [bead({ labels: ["b", "a"], dependencies: [deps[1], deps[0]] })],
      OBSERVED,
    );

    expect(after.digest).toBe(before.digest);
  });
});

/**
 * The classification the fence's narrowing rests on (anton-gsny): every column of the digest with a
 * verdict and a stated reason, and the proof that each verdict describes the code rather than the
 * hope — a field called decision-relevant must actually move the stamp, a namespace called
 * irrelevant must be one nothing in the decision reads, and anything unclassified must stay in.
 */
describe("decision inputs", () => {
  /** One edit per classified column, each chosen to move THAT column. */
  const EDIT: Record<string, Partial<Bead>> = {
    id: { id: "anton-z" },
    status: { status: "closed" },
    issue_type: { issue_type: "epic" },
    priority: { priority: 0 },
    assignee: { assignee: "henri" },
    parent: { parent: "anton-epic" },
    created_at: { created_at: "2026-07-01T00:00:00Z" },
    labels: { labels: ["approved", "domain:eng", "risk:high"] },
    dependencies: {
      dependencies: [{ issue_id: "anton-a", depends_on_id: "anton-b", type: "blocks" }],
    },
    contract: { acceptance_criteria: undefined },
  };

  // The argued set, written out: a column added, dropped or reclassified is a decision somebody
  // makes on purpose here, not a diff that slips through with the code that motivated it.
  it("classifies every field the digest carries", () => {
    expect(DIGEST_FIELDS.map((f) => `${f.field}: ${f.relevance} (${f.scope})`)).toEqual([
      "id: decision-relevant (board)",
      "status: decision-relevant (board)",
      "issue_type: decision-relevant (board)",
      "priority: decision-relevant (candidate)",
      "assignee: decision-relevant (candidate)",
      "parent: decision-relevant (board)",
      "created_at: decision-relevant (candidate)",
      "labels: decision-relevant (board)",
      "dependencies: decision-relevant (board)",
      "contract: decision-relevant (board)",
    ]);
  });

  it.each([...DIGEST_FIELDS, ...DIGEST_LABEL_NAMESPACES])(
    "states one line of reasoning for %s",
    ({ why }) => {
      expect(why.trim()).not.toBe("");
      expect(why).not.toContain("\n");
    },
  );

  it("has an edit for every classified column", () => {
    expect(Object.keys(EDIT).sort()).toEqual(DIGEST_FIELDS.map((f) => f.field).sort());
  });

  // A verdict of "decision-relevant" is a claim about the fence as it stands: the column moves, and
  // the stamp with it. Anything that stopped being true here is a plan holding still across an edit
  // that could have changed its picks.
  it.each(DIGEST_FIELDS)("carries $field in the fence", ({ field, read }) => {
    const before = shaped();
    const after = shaped(EDIT[field]);

    expect(read(after)).not.toBe(read(before));
    expect(stampBoard([after], OBSERVED).digest).not.toBe(stampBoard([before], OBSERVED).digest);
  });

  /**
   * Why `board` scope is not a hedge. The comparator's second term counts what finishing a target
   * transitively releases, so a status three hops downstream of a pick — on a bead no policy would
   * ever admit, and that appears in no plan — reorders the queue. A fence narrowed to the beads a
   * plan named would hold still across exactly this.
   */
  it("reorders the picks off a bead the plan neither picked nor could pick", () => {
    const tie = { priority: 1, created_at: "2026-08-01T00:00:00Z" };
    const held = (id: string, by: string, o: Partial<Bead> = {}) =>
      bead({
        id,
        ...o,
        dependencies: [{ issue_id: id, depends_on_id: by, type: "blocks" }],
      });
    // anton-a frees a 2-long chain, anton-b a 3-long one, and nothing else separates them.
    const chain = [
      held("anton-c", "anton-a"),
      held("anton-d", "anton-c"),
      held("anton-e", "anton-b"),
      held("anton-f", "anton-e"),
      held("anton-g", "anton-f"),
    ];
    const picks = [bead({ id: "anton-a", ...tie }), bead({ id: "anton-b", ...tie })];
    const board = [...picks, ...chain];
    const order = (all: Bead[]) => rankTargets(picks, all).map((r) => r.bead.id);

    expect(order(board)).toEqual(["anton-b", "anton-a"]);

    // Close the tail of anton-b's chain: it stops waiting, so anton-b's lead over anton-a goes with
    // it and the id tiebreak decides instead.
    const settled = board.map((b) => (b.id === "anton-g" ? { ...b, status: "closed" } : b));

    expect(order(settled)).toEqual(["anton-a", "anton-b"]);
    expect(stampBoard(settled, OBSERVED).digest).not.toBe(stampBoard(board, OBSERVED).digest);
  });

  /**
   * The one namespace anton writes that eligibility reads back — the finding that keeps `stage:` out
   * of the irrelevant set. `contractGatedBeads` skips a standalone target already in review, so no
   * contract gate refuses it, and a target the gate had faulted becomes startable on a label alone.
   */
  it("flips a target into the eligible set on a stage: label alone", () => {
    const thin = bead({ labels: ["approved"] });
    const inReview = bead({ labels: ["approved", "stage:in-review"] });

    expect(eligibleTargets([thin])).toMatchObject({
      eligible: [],
      exclusions: [{ beadId: "anton-a", reason: "approval-gap" }],
    });
    expect(eligibleTargets([inReview]).eligible).toHaveLength(1);
  });

  it.each(DIGEST_LABEL_NAMESPACES)("holds $namespace as $relevance", ({ namespace, relevance }) => {
    expect(isDecisionRelevantLabel(`${namespace}:whatever`)).toBe(
      relevance === "decision-relevant",
    );
  });

  // Fail closed: a board invents its own vocabulary and an operator's criteria are written over it,
  // so a namespace nobody has classified is one nobody has proved unread.
  it.each(["domain:eng", "agent:human", "area:picker", "approved", "abandoned", ""])(
    "keeps the unclassified label %j in the fence",
    (label) => {
      expect(isDecisionRelevantLabel(label)).toBe(true);
    },
  );

  // The narrowing itself (anton-7zpv), driven off the table so a namespace reclassified there moves
  // the fence and this test together or not at all.
  it.each(DIGEST_LABEL_NAMESPACES)(
    "stamps a $namespace label only while it is decision-relevant",
    ({ namespace, relevance }) => {
      const before = stampBoard([bead()], OBSERVED);
      const tagged = stampBoard(
        [bead({ labels: ["approved", "domain:eng", `${namespace}:whatever`] })],
        OBSERVED,
      );

      expect(tagged.digest === before.digest).toBe(relevance === "not-decision-relevant");
    },
  );

  /**
   * What the narrowing buys: anton's own bookkeeping churns inside the `labels` column — a lease
   * heartbeat rewritten every few seconds, a score filed when a run lands, provenance on a bead its
   * automation created — and none of it can retire a ranking any more.
   */
  it("holds still while anton rewrites its own bookkeeping labels", () => {
    const before = [bead({ id: "anton-a" }), bead({ id: "anton-b" })];
    const churned = [
      bead({ id: "anton-a", labels: ["approved", "domain:eng", "run-lease:1800000042"] }),
      bead({
        id: "anton-b",
        labels: ["review-score:8", "approved", "source:stringer", "domain:eng"],
      }),
    ];

    expect(stampBoard(churned, OBSERVED).digest).toBe(stampBoard(before, OBSERVED).digest);
  });

  // Order-independence survives the narrowing: the filter runs before the sort, and the bead order
  // still does not reach the hash.
  it("holds still when the surviving labels arrive in a different order", () => {
    const one = bead({ id: "anton-a", labels: ["run-lease:1", "domain:eng", "approved"] });
    const two = bead({ id: "anton-b", labels: ["stage:implementing", "approved"] });
    const swapped = [
      { ...two, labels: ["approved", "stage:implementing", "review-score:9"] },
      { ...one, labels: ["approved", "domain:eng"] },
    ];

    expect(stampBoard(swapped, OBSERVED).digest).toBe(stampBoard([one, two], OBSERVED).digest);
  });

  // The mirror of "carries $field in the fence", and vacuous only while every column is
  // decision-relevant: the moment one is not, it must leave the digest rather than merely be
  // annotated as unread.
  it("drops any column it has classified irrelevant", () => {
    for (const { field, read } of DIGEST_FIELDS.filter(
      (f) => f.relevance === "not-decision-relevant",
    )) {
      const before = shaped();
      const after = shaped(EDIT[field]);

      expect(read(after)).not.toBe(read(before));
      expect(stampBoard([after], OBSERVED).digest).toBe(stampBoard([before], OBSERVED).digest);
    }
  });
});

/**
 * The fence's INPUT SET (anton-t01f): the beads one decision can reach, and the narrowing that keeps
 * an edit which cannot change the ranking from retiring the plan.
 *
 * Both directions, because a fence is only as good as both: an edit outside the reach must leave the
 * generation standing, and every edit inside it must retire the generation. The same property is
 * measured over anton's real board — 289 beads of 842, swept exhaustively for an escape — in
 * `board-picker-plan.currency.test.ts`; what is pinned here is each clause of the set on its own.
 */
describe("the decision's reachable set", () => {
  const blocks = (id: string, by: string) => ({ issue_id: id, depends_on_id: by, type: "blocks" });

  /** A closed chore in a corner of the board: no candidate, no `blocks` edge, no parent a candidate
   *  reads. The bead the narrowing exists to drop. */
  const chore = (o: Partial<Bead> = {}) =>
    bead({ id: "anton-chore", status: "closed", issue_type: "task", ...o });

  it("covers the candidate pool and what it reaches, and nothing else", () => {
    const pick = shaped({ id: "anton-a", dependencies: [blocks("anton-a", "anton-blocker")] });
    const board = [pick, bead({ id: "anton-blocker", status: "closed" }), chore()];

    expect(reachableSet(board)).toEqual(new Set(["anton-a", "anton-blocker"]));
  });

  // The ranking's second term is computed off beads no policy would ever admit, so what HOLDS a
  // candidate and what a candidate RELEASES are both decision inputs whatever their status.
  it("reaches the closed blocker and the open gate that hold a candidate", () => {
    const pick = shaped({
      id: "anton-a",
      dependencies: [blocks("anton-a", "anton-settled"), blocks("anton-a", "anton-gate")],
    });
    const board = [
      pick,
      bead({ id: "anton-settled", status: "closed" }),
      bead({ id: "anton-gate", issue_type: "gate" }),
      chore(),
    ];

    expect(reachableSet(board)).toEqual(new Set(["anton-a", "anton-settled", "anton-gate"]));
  });

  // OUTSIDE: the whole point. A board where the only write is one the decision cannot read must
  // leave the recorded generation exactly where it was.
  it.each<[string, (board: Bead[]) => Bead[]]>([
    ["it is raised to P0", (b) => b.map((x) => (x.id === "anton-chore" ? { ...x, priority: 0 } : x))],
    ["it is re-typed", (b) => b.map((x) => (x.id === "anton-chore" ? { ...x, issue_type: "bug" } : x))],
    ["it leaves the board", (b) => b.filter((x) => x.id !== "anton-chore")],
  ])("holds still when a bead outside the reach %s", (_edit, mutate) => {
    const board = [shaped({ id: "anton-a" }), chore()];

    expect(stampBoard(mutate(board), OBSERVED).digest).toBe(stampBoard(board, OBSERVED).digest);
  });

  // INSIDE: the same edits, on the CLOSED blocker one hop from the pick — a bead no candidate pool
  // holds and no policy would ever admit, in the fence on the strength of its edge alone. A fence
  // over "the beads the plan named" would hold still across every row of this.
  it.each<[string, (board: Bead[]) => Bead[]]>([
    ["it reopens", (b) => b.map((x) => (x.id === "anton-settled" ? { ...x, status: "open" } : x))],
    ["it is re-typed", (b) => b.map((x) => (x.id === "anton-settled" ? { ...x, issue_type: "bug" } : x))],
    ["it leaves the board", (b) => b.filter((x) => x.id !== "anton-settled")],
  ])("retires the generation when a bead inside the reach %s", (_edit, mutate) => {
    const board = [
      shaped({ id: "anton-a", dependencies: [blocks("anton-a", "anton-settled")] }),
      bead({ id: "anton-settled", status: "closed" }),
      chore(),
    ];

    expect(stampBoard(mutate(board), OBSERVED).digest).not.toBe(stampBoard(board, OBSERVED).digest);
  });

  /**
   * The clause the epic's own statement of the narrowing is missing (anton-icu6). `beads.isContainer`
   * counts a feature child of ANY status, so filing a finished feature under an epic pick turns that
   * pick into a container and drops it from the plan — with no bead entering the pool and no `blocks`
   * edge moving. A fence of "pool plus blocks-closure" reads current straight through it.
   */
  it("reaches the closed feature children of the pool, so re-parenting one is never silent", () => {
    const epic = shaped({ id: "anton-epic", issue_type: "epic" });
    const shipped = shaped({
      id: "anton-shipped",
      issue_type: "feature",
      status: "closed",
      parent: "anton-elsewhere",
    });
    const before = [epic, shipped, shaped({ id: "anton-elsewhere", issue_type: "epic", status: "closed" })];
    const after = before.map((b) => (b.id === "anton-shipped" ? { ...b, parent: "anton-epic" } : b));

    expect(reachableSet(before).has("anton-shipped")).toBe(false);
    expect(reachableSet(after).has("anton-shipped")).toBe(true);
    expect(stampBoard(after, OBSERVED).digest).not.toBe(stampBoard(before, OBSERVED).digest);
  });

  /**
   * The same clause one edge UP, and why the two run to a fixpoint together. `structureGaps` reads a
   * candidate's ancestors — a parent's type decides `feature-under-non-epic`, an ancestor's feature
   * children decide `ticket-under-container-epic` — and an ancestor may be closed, so the pool, the
   * blocks closure and the feature-children clause all miss it. The closed feature below is reached
   * only through the closed epic, which is itself reached only through the ticket's parent edge.
   */
  it("reaches the closed ancestors of the pool, and their feature children in turn", () => {
    const board = [
      shaped({ id: "anton-top", issue_type: "epic" }),
      shaped({ id: "anton-mid", issue_type: "epic", status: "closed", parent: "anton-top" }),
      shaped({ id: "anton-ticket", issue_type: "task", parent: "anton-mid" }),
      shaped({ id: "anton-shipped", issue_type: "feature", status: "closed", parent: "anton-mid" }),
      chore(),
    ];

    expect(reachableSet(board)).toEqual(
      new Set(["anton-top", "anton-mid", "anton-ticket", "anton-shipped"]),
    );
  });

  // The ancestor clause is UPWARD only, and the ticket clause is scoped to the POOL: a closed
  // sibling under a CLOSED parent decides nothing — `isContainer` counts feature children, `cardOf`
  // walks up, and a closed target is refused on status before the gate reads its tickets.
  it("does not reach down from an ancestor to anything but its feature children", () => {
    const board = [
      shaped({ id: "anton-a", issue_type: "feature", parent: "anton-epic" }),
      shaped({ id: "anton-epic", issue_type: "epic", status: "closed" }),
      chore({ parent: "anton-epic" }),
    ];

    expect(reachableSet(board)).toEqual(new Set(["anton-a", "anton-epic"]));
  });

  /**
   * The clause below the pool, for the same reason the feature-children one sits above it.
   * `contractGatedBeads` reads `beads.groupsChildren`, which counts a ticket child of ANY status, so
   * a feature whose only ticket is CLOSED is gated on nothing — and grooming that finished ticket
   * onto another card gates the feature on its own thin spec and drops it from the plan. No bead
   * enters the pool, no edge above it moves: a fence of "pool plus blocks plus ancestry" reads
   * current straight through it and goes on naming the feature at rank 1.
   */
  it("reaches the closed tickets of the pool, so grooming a finished one is never silent", () => {
    const thin = bead({ id: "anton-f", description: "", acceptance_criteria: "" });
    const done = bead({ id: "anton-t", issue_type: "task", status: "closed", parent: "anton-f" });
    const before = [thin, done, shaped({ id: "anton-other", issue_type: "task" })];
    const after = before.map((b) => (b.id === "anton-t" ? { ...b, parent: "anton-other" } : b));

    // The flip the fence has to see: gated on nothing, then gated on a spec it does not have.
    expect(eligibleTargets(before).eligible.map((b) => b.id)).toContain("anton-f");
    expect(eligibleTargets(after)).toMatchObject({
      exclusions: [{ beadId: "anton-f", reason: "approval-gap" }],
    });

    expect(reachableSet(before).has("anton-t")).toBe(true);
    expect(stampBoard(after, OBSERVED).digest).not.toBe(stampBoard(before, OBSERVED).digest);
  });

  // Computed over the board being STAMPED, never carried on the plan: that is what makes the two
  // digests comparable, so a bead that has newly become a candidate is an honest mismatch rather
  // than a bead neither stamp was looking at.
  it("admits a newly eligible bead to the fence on the board it stamps", () => {
    const before = [shaped({ id: "anton-a" }), chore()];
    const after = before.map((b) => (b.id === "anton-chore" ? { ...b, status: "open" } : b));

    expect(reachableSet(before).has("anton-chore")).toBe(false);
    expect(reachableSet(after).has("anton-chore")).toBe(true);
    expect(stampBoard(after, OBSERVED).digest).not.toBe(stampBoard(before, OBSERVED).digest);
  });

  // The policy fold is outside the narrowing and unchanged by it: admission is a function of the
  // rules as well as the beads, so an operator's edit has to move the stamp even on a board whose
  // decision reaches nothing at all.
  it("carries the armed policy even when the decision reaches no bead", () => {
    const board = [chore()];
    const unarmed = stampBoard(board, OBSERVED);

    expect(unarmed.beadCount).toBe(0);
    expect(stampBoard(board, OBSERVED, { types: ["feature"] }).digest).not.toBe(unarmed.digest);
  });
});

describe("staleness", () => {
  const plan = {
    projectId: "p1",
    planId: "plan-1",
    generatedAt: Math.floor(NOW / 1000),
    stamp: stampBoard([bead()], OBSERVED),
    entries: [entry()],
    exclusions: [],
  };

  it("is a claim about the board, not about the clock", () => {
    const muchLater = stampBoard([bead()], OBSERVED + 86_400_000);

    expect(isPlanStale(plan, muchLater)).toBe(false);
  });

  it("catches a board that moved a second after the plan was computed", () => {
    const moved = stampBoard([bead({ assignee: "henri" })], OBSERVED + 1);

    expect(isPlanStale(plan, moved)).toBe(true);
  });

  // The invariant the fence exists for, stated against the real eligibility predicate rather than
  // against a field list: any edit that changes who may be started must read as a moved board, or a
  // surface presents as rank 1 a target the gate now refuses.
  it("catches an edit that flips a target out of the eligible set", () => {
    const before = [shaped()];
    const after = [shaped({ acceptance_criteria: undefined })];
    expect(eligibleTargets(before).eligible).toHaveLength(1);
    expect(eligibleTargets(after)).toMatchObject({
      eligible: [],
      exclusions: [{ beadId: "anton-a", reason: "approval-gap" }],
    });

    const shapedPlan = { ...plan, stamp: stampBoard(before, OBSERVED) };

    expect(isPlanStale(shapedPlan, stampBoard(after, OBSERVED + 1))).toBe(true);
  });

  /**
   * The other half of the decision. An operator editing `pickerPolicy` changes who may be started
   * without touching a bead, so a fence over the beads alone would keep calling the old plan current
   * — and the lane would go on offering a start the new policy refuses until the next pass ran.
   */
  it("catches a policy saved after the plan was computed", () => {
    const board = [bead()];
    const unarmed = { ...plan, stamp: stampBoard(board, OBSERVED) };

    expect(isPlanStale(unarmed, stampBoard(board, OBSERVED + 1, { types: ["bug"] }))).toBe(true);
  });

  it("holds still when the policy is re-saved unchanged", () => {
    const board = [bead()];
    const policy = { types: ["feature", "bug"], labels: [{ namespace: "domain", values: ["eng"] }] };
    const armed = { ...plan, stamp: stampBoard(board, OBSERVED, policy) };

    // Same criteria, authored in another order — the same policy, so the same fence.
    const resaved = {
      types: ["bug", "feature"],
      labels: [{ namespace: "domain", values: ["eng"] }],
    };
    expect(isPlanStale(armed, stampBoard(board, OBSERVED + 1, resaved))).toBe(false);
  });

  it("catches an armed policy being cleared", () => {
    const board = [bead()];
    const armed = { ...plan, stamp: stampBoard(board, OBSERVED, { types: ["feature"] }) };

    expect(isPlanStale(armed, stampBoard(board, OBSERVED + 1))).toBe(true);
  });

  /**
   * The third decision input, and the only one no digest can carry: a deferral is anton's own state
   * with a wall-clock expiry, so a hold running out re-admits a target while every hashed input sits
   * still. Without this the re-eligible bead would stay out of Up Next — and unstartable there —
   * until the next scheduled pass rewrote the plan.
   */
  describe("deferrals", () => {
    const held = {
      ...plan,
      exclusions: [{ beadId: "anton-b", reason: "deferred" as const, detail: "you set this aside" }],
    };
    const current = stampBoard([bead()], OBSERVED + 1);

    it("holds still while the hold the pass acted on is still held", () => {
      expect(isPlanStale(held, current, new Map([["anton-b", NOW + 86_400_000]]))).toBe(false);
    });

    it("goes stale once a target it set aside is no longer deferred", () => {
      expect(isPlanStale(held, current, new Map())).toBe(true);
      expect(isPlanStale(held, current)).toBe(true);
    });

    it("ignores exclusions the operator never made — those are the board's own answer", () => {
      const blocked = {
        ...plan,
        exclusions: [{ beadId: "anton-b", reason: "blocked" as const }],
      };

      expect(isPlanStale(blocked, current, new Map())).toBe(false);
    });
  });

  /**
   * The same rule, for the window in which NO PASS RUNS (PR #212 review). The exclusion above is
   * written by a later pass; with the picker disarmed or failing for the whole deferral window there
   * is no such pass, so the vetoed target is still an ENTRY. Left to the exclusion rule alone, the
   * generation would read current again the moment the hold lapsed and re-offer the pick under the
   * very plan id whose decline stops `recordPickerAccept` recording the release — a start that
   * silently teaches the track record nothing.
   */
  describe("declines against this generation", () => {
    const current = stampBoard([bead()], OBSERVED + 1);
    const vetoed = new Set(["anton-a"]);

    it("holds still while the hold that veto placed is still running", () => {
      const held = new Map([["anton-a", NOW + 86_400_000]]);

      expect(isPlanStale(plan, current, held, vetoed)).toBe(false);
    });

    it("retires the generation once that hold runs out, with no pass in between", () => {
      expect(isPlanStale(plan, current, new Map(), vetoed)).toBe(true);
      expect(isPlanStale(plan, current, undefined, vetoed)).toBe(true);
    });

    it("ignores a decline against a target this plan does not pick", () => {
      expect(isPlanStale(plan, current, new Map(), new Set(["anton-z"]))).toBe(false);
    });

    // The caller keys the set on THIS plan id, so an earlier generation's decline never reaches
    // here — but the predicate must also stand on its own when no caller supplies one.
    it("holds still when nothing declined it", () => {
      expect(isPlanStale(plan, current, new Map(), new Set())).toBe(false);
      expect(isPlanStale(plan, current)).toBe(false);
    });
  });

  /**
   * The fourth input, and the one `digestLine` structurally cannot hold (PR #226 review): age moves
   * with the clock, so a pick crosses a policy's whole-day bound while every hashed field sits still.
   * Without this the derived lane would have dropped the target while the card kept a non-stale
   * `◈ policy` badge — and the `[Release]` derived from it would start, and record an accept for,
   * work the current policy refuses.
   */
  describe("picks the policy's age bounds have moved past", () => {
    const current = stampBoard([bead()], OBSERVED + 1);

    it("retires the generation once one of its picks ages out", () => {
      expect(isPlanStale(plan, current, new Map(), new Set(), new Set(["anton-a"]))).toBe(true);
    });

    it("ignores an aged-out bead this plan does not pick", () => {
      expect(isPlanStale(plan, current, new Map(), new Set(), new Set(["anton-z"]))).toBe(false);
      expect(isPlanStale(plan, current, new Map(), new Set(), new Set())).toBe(false);
    });
  });
});

/**
 * The age re-judgement itself: whole days since the bead was filed, against the bounds in force NOW.
 * Shared with the editor's own explanation (`policy/age.ts`), so a card can never be listed as
 * matching by one rounding of "a day" and released under another.
 */
describe("agedOutPicks", () => {
  const FILED = "2026-08-01T00:00:00Z";
  const filedAt = Date.parse(FILED);
  const board = [bead({ created_at: FILED })];
  const plan = {
    projectId: "p1",
    planId: "plan-1",
    generatedAt: Math.floor(NOW / 1000),
    stamp: stampBoard(board, OBSERVED),
    entries: [entry()],
    exclusions: [],
  };
  const at = (days: number) => filedAt + days * 86_400_000;

  it("names nothing when the policy asserts no age bound", () => {
    expect(agedOutPicks(plan, board, { types: ["feature"] }, at(400))).toEqual(new Set());
    expect(agedOutPicks(plan, board, undefined, at(400))).toEqual(new Set());
  });

  it("holds still while the pick is inside the ceiling", () => {
    // Day 30 exactly: `maxAgeDays` admits up to and including its own bound.
    expect(agedOutPicks(plan, board, { maxAgeDays: 30 }, at(30))).toEqual(new Set());
  });

  it("names the pick the moment it crosses the ceiling, with nothing else moved", () => {
    expect(agedOutPicks(plan, board, { maxAgeDays: 30 }, at(31))).toEqual(new Set(["anton-a"]));
  });

  it("names a pick that fell back inside a soak the operator lengthened", () => {
    // Only reachable by widening `minAgeDays`, which moves the policy digest too — but the fence
    // must not depend on the other half firing first.
    expect(agedOutPicks(plan, board, { minAgeDays: 10 }, at(3))).toEqual(new Set(["anton-a"]));
  });

  it("skips an entry whose bead has left the board — the digest is the stronger verdict there", () => {
    expect(agedOutPicks(plan, [], { maxAgeDays: 30 }, at(400))).toEqual(new Set());
  });
});

describe("plan storage", () => {
  let tdb: TestDb;
  const projectId = "p1";

  beforeEach(async () => {
    spawned.mockClear();
    tdb = makeTestDb();
    await tdb.db
      .insert(schema.projects)
      .values({ id: projectId, slug: "p1", name: "p1", repoPath: "/tmp/p1" });
  });

  afterEach(() => tdb.close());

  it("round-trips the ranked targets, their rules, and every exclusion reason", async () => {
    const entries = [entry(), entry({ beadId: "anton-b", rank: 2, rule: "type ∈ {bug}" })];
    const exclusions = [
      excluded(),
      excluded({ beadId: "anton-y", reason: "blocked", detail: "waits on anton-x" }),
    ];

    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      stamp: stamp(),
      entries,
      exclusions,
    });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan).toMatchObject({ projectId, jobId: "job-1", generatedAt: Math.floor(NOW / 1000) });
    expect(plan!.entries).toEqual(entries);
    expect(plan!.exclusions).toEqual(sortExclusions(exclusions));
  });

  it("round-trips the board stamp, keeping the observation moment at millisecond precision", async () => {
    const observedAtMs = OBSERVED + 137;

    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp({ observedAtMs, digest: "0123456789abcdef", beadCount: 42 }),
      entries: [],
      exclusions: [],
    });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan!.stamp).toEqual({ observedAtMs, digest: "0123456789abcdef", beadCount: 42 });
  });

  it("replaces the previous plan rather than appending — one row per project", async () => {
    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp({ digest: "1111111111111111" }),
      entries: [entry(), entry({ beadId: "anton-b", rank: 2 })],
      exclusions: [excluded()],
    });

    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp({ digest: "2222222222222222" }),
      entries: [entry({ beadId: "anton-c" })],
      exclusions: [],
    });

    const rows = await tdb.db.select().from(schema.boardPickerPlans);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetCount).toBe(1);
    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan!.entries.map((e) => e.beadId)).toEqual(["anton-c"]);
    expect(plan!.exclusions).toEqual([]);
    expect(plan!.stamp.digest).toBe("2222222222222222");
  });

  it("keeps one row per project, not one per board", async () => {
    await tdb.db
      .insert(schema.projects)
      .values({ id: "p2", slug: "p2", name: "p2", repoPath: "/tmp/p2" });

    await saveBoardPickerPlan(tdb.db, clock, { projectId, stamp: stamp(), entries: [entry()], exclusions: [] });
    await saveBoardPickerPlan(tdb.db, clock, {
      projectId: "p2",
      stamp: stamp(),
      entries: [entry({ beadId: "other-a" })],
      exclusions: [],
    });

    expect(await tdb.db.select().from(schema.boardPickerPlans)).toHaveLength(2);
    expect((await getBoardPickerPlan(tdb.db, projectId))!.entries[0].beadId).toBe("anton-a");
  });

  // "Never ran" and "ran, admitted nothing" are different answers, and the lane says different
  // things about them — an empty lane under an armed policy is not an unswept one.
  it("distinguishes a project the picker has never run for from a pass that admitted nothing", async () => {
    expect(await getBoardPickerPlan(tdb.db, projectId)).toBeUndefined();

    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp(),
      entries: [],
      exclusions: [excluded({ reason: "policy", detail: "no rule admits it" })],
    });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan).toBeTruthy();
    expect(plan!.entries).toEqual([]);
    expect(plan!.exclusions).toHaveLength(1);
  });

  it("stores the queue in rank order however the caller assembled it", async () => {
    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp(),
      entries: [entry({ beadId: "anton-c", rank: 3 }), entry({ beadId: "anton-a", rank: 1 }), entry({ beadId: "anton-b", rank: 2 })],
      exclusions: [],
    });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan!.entries.map((e) => e.beadId)).toEqual(["anton-a", "anton-b", "anton-c"]);
  });

  // Idempotence: two passes over an unchanged board must leave byte-identical blobs, or the row
  // "changes" every tick and anything watching it for movement is watching noise.
  it("serializes two passes over an unchanged board identically", async () => {
    const input = {
      projectId,
      stamp: stamp(),
      entries: [entry(), entry({ beadId: "anton-b", rank: 2 })],
      exclusions: [excluded({ beadId: "anton-z" }), excluded({ beadId: "anton-y", reason: "blocked" })],
    };

    await saveBoardPickerPlan(tdb.db, clock, input);
    const first = (await tdb.db.select().from(schema.boardPickerPlans))[0];

    await saveBoardPickerPlan(tdb.db, clock, {
      ...input,
      exclusions: [...input.exclusions].reverse(),
    });
    const second = (await tdb.db.select().from(schema.boardPickerPlans))[0];

    expect(second.entriesJson).toBe(first.entriesJson);
    expect(second.exclusionsJson).toBe(first.exclusionsJson);
  });

  /**
   * Idempotence per DECISION (anton-f12y). The board read records the ranking it derives on EVERY
   * read, so most saves restate the row rather than change it — and a restatement that rewrote the
   * row would move `generatedAt`, which is half the board's freshness token (`provenanceVersion`).
   * Every poll would then spend a full board read to hand back byte-identical data.
   */
  describe("restating a decision the row already holds", () => {
    const decided = () => ({
      projectId,
      jobId: "job-1",
      stamp: stamp(),
      entries: [entry(), entry({ beadId: "anton-b", rank: 2 })],
      exclusions: [excluded()],
    });

    it("leaves the generation, its stamp and the writer that minted it untouched", async () => {
      await saveBoardPickerPlan(tdb.db, clock, decided());
      const first = (await tdb.db.select().from(schema.boardPickerPlans))[0];

      const restated = await saveBoardPickerPlan(tdb.db, { now: () => NOW + 600_000 }, decided());

      const second = (await tdb.db.select().from(schema.boardPickerPlans))[0];
      expect(second.planId).toBe(first.planId);
      expect(second.generatedAt).toEqual(first.generatedAt);
      expect(second.jobId).toBe("job-1");
      expect(restated.planId).toBe(first.planId);
      expect(restated.generatedAt).toBe(Math.floor(NOW / 1000));
    });

    // The one thing a restatement DOES record: this decision was confirmed against a fresher read of
    // the board than the one that minted it.
    it("carries the observation forward, and only forward", async () => {
      await saveBoardPickerPlan(tdb.db, clock, decided());

      const ahead = { ...decided(), stamp: stamp({ observedAtMs: OBSERVED + 5_000 }) };
      expect((await saveBoardPickerPlan(tdb.db, clock, ahead)).stamp.observedAtMs).toBe(
        OBSERVED + 5_000,
      );

      // A slower writer holding an older snapshot of the same board must not date the row backwards.
      const behind = { ...decided(), stamp: stamp({ observedAtMs: OBSERVED - 5_000 }) };
      expect((await saveBoardPickerPlan(tdb.db, clock, behind)).stamp.observedAtMs).toBe(
        OBSERVED + 5_000,
      );
    });

    // A row written before the id existed has no name to carry over, so it is re-minted rather than
    // restated — otherwise every surface would go on naming the empty string.
    it("mints an id for a row that predates the field", async () => {
      await saveBoardPickerPlan(tdb.db, clock, decided());
      await tdb.db.update(schema.boardPickerPlans).set({ planId: "" });

      expect((await saveBoardPickerPlan(tdb.db, clock, decided())).planId).not.toBe("");
    });
  });

  /**
   * Two writers at once — the board read and the scheduled pass, or two reads of the same board — pick
   * the generation id by comparing against the row, so a read-then-write split by an await would let
   * both mint one and the loser would hand a surface a name the row does not hold.
   */
  describe("overlapping saves", () => {
    it("leaves one row and one generation when both decide the same plan", async () => {
      const decision = { projectId, stamp: stamp(), entries: [entry()], exclusions: [excluded()] };

      const [first, second] = await Promise.all([
        saveBoardPickerPlan(tdb.db, clock, decision),
        saveBoardPickerPlan(tdb.db, clock, decision),
      ]);

      expect(second.planId).toBe(first.planId);
      const rows = await tdb.db.select().from(schema.boardPickerPlans);
      expect(rows).toHaveLength(1);
      expect(rows[0].planId).toBe(first.planId);
    });

    it("leaves one whole decision when they disagree, never a row torn between the two", async () => {
      const [a, b] = await Promise.all([
        saveBoardPickerPlan(tdb.db, clock, {
          projectId,
          stamp: stamp({ digest: "1111111111111111" }),
          entries: [entry()],
          exclusions: [],
        }),
        saveBoardPickerPlan(tdb.db, clock, {
          projectId,
          stamp: stamp({ digest: "2222222222222222" }),
          entries: [entry({ beadId: "anton-b" }), entry({ beadId: "anton-c", rank: 2 })],
          exclusions: [excluded()],
        }),
      ]);

      const rows = await tdb.db.select().from(schema.boardPickerPlans);
      expect(rows).toHaveLength(1);
      expect(a.planId).not.toBe(b.planId);
      // Whichever landed last, the row is that plan WHOLE: its digest, its ranking and its
      // exclusions, never one writer's digest over the other's queue.
      const stored = (await getBoardPickerPlan(tdb.db, projectId))!;
      expect([a.planId, b.planId]).toContain(stored.planId);
      const landed = stored.planId === a.planId ? a : b;
      expect(stored.stamp.digest).toBe(landed.stamp.digest);
      expect(stored.entries).toEqual(landed.entries);
      expect(stored.exclusions).toEqual(landed.exclusions);
      expect(rows[0].targetCount).toBe(landed.entries.length);
    });
  });

  /**
   * The fallback writer (anton-m4il). The scheduled pass stamps its observation before a board read
   * that costs seconds, so it can land a decision made from an OLDER board after the operator's own
   * read recorded one made from a newer one — and the generation it would retire is the one the
   * Release button on screen names.
   */
  describe("a writer that yields to a fresher observation", () => {
    const fresher = () => ({
      projectId,
      stamp: stamp({ observedAtMs: OBSERVED + 5_000, digest: "2222222222222222" }),
      entries: [entry({ beadId: "anton-b" })],
      exclusions: [],
    });
    /** The pass: an older look at the board, and a different answer about it. */
    const older = () => ({
      projectId,
      jobId: "job-1",
      stamp: stamp({ digest: "1111111111111111" }),
      entries: [entry()],
      exclusions: [excluded()],
    });
    /** …handed over as the pass hands it over, with the fallback writer's one refusal. */
    const yielding = () => ({ ...older(), yieldToFresher: true });

    it("keeps the standing generation whole rather than replacing it", async () => {
      const standing = await saveBoardPickerPlan(tdb.db, clock, fresher());

      const returned = await saveBoardPickerPlan(tdb.db, clock, yielding());

      // The row is untouched — id, ranking, digest and observation — and the yielding writer is
      // handed the generation that stands, not the one it decided.
      expect(returned).toEqual(standing);
      const stored = (await getBoardPickerPlan(tdb.db, projectId))!;
      expect(stored).toEqual(standing);
      expect((await tdb.db.select().from(schema.boardPickerPlans))[0].jobId).toBeNull();
    });

    // The pass is the fallback, not a lesser writer: with nothing fresher on the row it decides and
    // records exactly as it always did.
    it("records as before when the row holds an older observation, or the same one", async () => {
      await saveBoardPickerPlan(tdb.db, clock, {
        ...fresher(),
        stamp: stamp({ observedAtMs: OBSERVED - 5_000, digest: "2222222222222222" }),
      });

      const written = await saveBoardPickerPlan(tdb.db, clock, yielding());
      expect((await getBoardPickerPlan(tdb.db, projectId))!.planId).toBe(written.planId);
      expect(written.entries.map((e) => e.beadId)).toEqual(["anton-a"]);

      // Equal observations are not an ordering: two writers looking at the same instant race as
      // they always have, last one wins.
      const same = await saveBoardPickerPlan(tdb.db, clock, {
        ...yielding(),
        entries: [entry({ beadId: "anton-c" })],
      });
      expect((await getBoardPickerPlan(tdb.db, projectId))!.entries.map((e) => e.beadId)).toEqual([
        "anton-c",
      ]);
      expect(same.planId).not.toBe(written.planId);
    });

    // The board read is the PRIMARY writer: what it records is what it drew, so it never yields.
    it("leaves a writer that did not ask to yield replacing the row as before", async () => {
      const standing = await saveBoardPickerPlan(tdb.db, clock, fresher());

      const written = await saveBoardPickerPlan(tdb.db, clock, older());

      expect(written.planId).not.toBe(standing.planId);
      expect((await getBoardPickerPlan(tdb.db, projectId))!.entries.map((e) => e.beadId)).toEqual([
        "anton-a",
      ]);
    });

    // A restatement is not a replacement: the same decision from an older look leaves the row's
    // observation where the fresher writer put it, exactly as it did before the guard existed.
    it("leaves the observation forward when it restates what the row already holds", async () => {
      const standing = await saveBoardPickerPlan(tdb.db, clock, fresher());

      const restated = await saveBoardPickerPlan(tdb.db, clock, {
        ...fresher(),
        yieldToFresher: true,
        stamp: stamp({ observedAtMs: OBSERVED, digest: "2222222222222222" }),
      });

      expect(restated.planId).toBe(standing.planId);
      expect(restated.stamp.observedAtMs).toBe(OBSERVED + 5_000);
    });
  });

  /**
   * The plan's own identity, which is what a verdict answers (PR #212 review). The board digest
   * cannot serve: it describes the decision INPUTS, so a pass that re-admits a target once its veto
   * expires stamps the same digest the decline was filed against, and the new pick would inherit the
   * old answer.
   */
  describe("the plan's generation id", () => {
    it("carries over while the pass keeps deciding the same plan", async () => {
      const input = { projectId, stamp: stamp(), entries: [entry()], exclusions: [excluded()] };

      await saveBoardPickerPlan(tdb.db, clock, input);
      const first = (await getBoardPickerPlan(tdb.db, projectId))!.planId;
      await saveBoardPickerPlan(tdb.db, clock, input);

      expect(first).not.toBe("");
      expect((await getBoardPickerPlan(tdb.db, projectId))!.planId).toBe(first);
    });

    it("is minted afresh the moment the pass decides differently", async () => {
      await saveBoardPickerPlan(tdb.db, clock, { projectId, stamp: stamp(), entries: [entry()], exclusions: [] });
      const first = (await getBoardPickerPlan(tdb.db, projectId))!.planId;

      await saveBoardPickerPlan(tdb.db, clock, {
        projectId,
        stamp: stamp(),
        entries: [entry({ beadId: "anton-b" })],
        exclusions: [],
      });

      expect((await getBoardPickerPlan(tdb.db, projectId))!.planId).not.toBe(first);
    });

    // The regression this id exists for: veto → the window closes → the same target, ranked the same
    // way, against a board and a policy nobody touched. Same digest, and it must NOT be the same pick.
    it("never re-issues the id of a plan a veto has since answered", async () => {
      const offered = { projectId, stamp: stamp(), entries: [entry()], exclusions: [] };
      await saveBoardPickerPlan(tdb.db, clock, offered);
      const before = (await getBoardPickerPlan(tdb.db, projectId))!.planId;

      // The pass that sees the deferral: the target drops out of the ranking and is named as held.
      await saveBoardPickerPlan(tdb.db, clock, {
        projectId,
        stamp: stamp(),
        entries: [],
        exclusions: [excluded({ beadId: "anton-a", reason: "deferred", detail: "vetoed" })],
      });
      // And the pass after the window closes, over the very same board.
      await saveBoardPickerPlan(tdb.db, clock, offered);

      expect((await getBoardPickerPlan(tdb.db, projectId))!.planId).not.toBe(before);
    });
  });

  it("degrades a corrupt blob to nothing recorded, leaving the count to show the discrepancy", async () => {
    await saveBoardPickerPlan(tdb.db, clock, { projectId, stamp: stamp(), entries: [entry()], exclusions: [] });
    await tdb.db.update(schema.boardPickerPlans).set({ entriesJson: "{ not json" });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan!.entries).toEqual([]);
    expect((await tdb.db.select().from(schema.boardPickerPlans))[0].targetCount).toBe(1);
  });

  // The reason the plan is recorded at all: a surface answers "what runs next?" from anton.db, so
  // rendering the lane can never cost a board read or block on bd.
  it("reads back without shelling out to bd", async () => {
    await saveBoardPickerPlan(tdb.db, clock, { projectId, stamp: stamp(), entries: [entry()], exclusions: [excluded()] });

    const plan = await getBoardPickerPlan(tdb.db, projectId);

    expect(plan!.entries).toHaveLength(1);
    expect(spawned).not.toHaveBeenCalled();
  });
});
