/**
 * Unit tests for the gate-check pass's pure decisions (anton-286r) — which gates anton may close,
 * which have died and need a human, and which run target a gate-closed step belongs to. No bd here;
 * the end-to-end proof against real bd lives in gate-check.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { LABELS, type Bead, type Gate, type GatedMolecule } from "../beads/bd";
import {
  beadBlockedByGate,
  checkScopes,
  expiredGateNote,
  expiredGates,
  gateDeadline,
  isResumableTarget,
  mergedGateTargets,
  plainGateResumes,
  resumeTargets,
  runTargetAbove,
  GATE_EXPIRED_LABEL,
  GATE_RESUMED_LABEL,
} from "./gate-check";

const NOW = 1_700_000_000_000;
/** bd stores gate timeouts in nanoseconds (Go duration) — `2h` reads back as 7.2e12. */
const HOURS = (n: number) => n * 3_600 * 1e9;

function gate(id: string, o: Partial<Gate> = {}): Gate {
  return {
    id,
    title: `Gate: ${id}`,
    status: "open",
    issue_type: "gate",
    await_type: "gh:pr",
    created_at: new Date(NOW).toISOString(),
    ...o,
  };
}

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", ...o };
}

describe("checkScopes", () => {
  it("spawns a check only for the gate types actually open", () => {
    expect(checkScopes([gate("g1", { await_type: "timer" })])).toEqual(["timer"]);
    expect(checkScopes([gate("g1", { await_type: "gh:run" })])).toEqual(["gh"]);
    expect(
      checkScopes([gate("g1", { await_type: "timer" }), gate("g2", { await_type: "gh:pr" })]),
    ).toEqual(["timer", "gh"]);
  });

  it("never scopes a check at a human gate — the founder's control point", () => {
    expect(checkScopes([gate("g1", { await_type: "human" })])).toEqual([]);
  });

  it("never scopes a check at a bead gate — unresolvable at this bd", () => {
    expect(checkScopes([gate("g1", { await_type: "bead" as Gate["await_type"] })])).toEqual([]);
  });

  it("is empty for a project with no gates, so an idle pass spawns nothing", () => {
    expect(checkScopes([])).toEqual([]);
  });
});

describe("gateDeadline", () => {
  it("reads bd's nanosecond timeout off created_at", () => {
    expect(gateDeadline(gate("g1", { timeout: HOURS(2) }))).toBe(NOW + 2 * 3_600_000);
  });

  it("is undefined for a gate with no timeout — bd's default is to wait forever", () => {
    expect(gateDeadline(gate("g1"))).toBeUndefined();
    expect(gateDeadline(gate("g1", { timeout: 0 }))).toBeUndefined();
  });

  it("is undefined when created_at is missing or unparseable, rather than guessing a deadline", () => {
    expect(gateDeadline(gate("g1", { timeout: HOURS(1), created_at: undefined }))).toBeUndefined();
    expect(gateDeadline(gate("g1", { timeout: HOURS(1), created_at: "not a date" }))).toBeUndefined();
  });
});

describe("expiredGates", () => {
  const overdue = { timeout: HOURS(2) };
  const later = NOW + 3 * 3_600_000;

  it("reports an open gh gate past its deadline", () => {
    expect(expiredGates([gate("g1", overdue)], later).map((g) => g.id)).toEqual(["g1"]);
  });

  it("ignores one still inside its timeout", () => {
    expect(expiredGates([gate("g1", overdue)], NOW + 3_600_000)).toEqual([]);
  });

  it("never reports a human gate — it is already with a human, deadline or not", () => {
    expect(expiredGates([gate("g1", { ...overdue, await_type: "human" })], later)).toEqual([]);
  });

  it("never reports a timer gate — its timeout is when it RESOLVES, not when it gives up", () => {
    expect(expiredGates([gate("g1", { ...overdue, await_type: "timer" })], later)).toEqual([]);
  });

  it("reports a blown bead gate — this bd can never resolve one, so the deadline is all there is", () => {
    const g = gate("g1", { ...overdue, await_type: "bead" as Gate["await_type"] });
    expect(expiredGates([g], later).map((x) => x.id)).toEqual(["g1"]);
  });

  it("skips a gate already surfaced — one note per dead wait, not one per pass", () => {
    expect(expiredGates([gate("g1", { ...overdue, labels: [GATE_EXPIRED_LABEL] })], later)).toEqual(
      [],
    );
  });

  it("skips a closed gate and a gate with no timeout at all", () => {
    const closed = gate("g1", { ...overdue, status: "closed" });
    expect(expiredGates([closed, gate("g2")], later)).toEqual([]);
  });
});

describe("expiredGateNote", () => {
  it("names the gate, the wait, how overdue it is, and how a human settles it", () => {
    const note = expiredGateNote(
      gate("g1", { timeout: HOURS(2), await_type: "gh:pr", await_id: "42" }),
      NOW + 5 * 3_600_000,
    );
    expect(note).toContain("g1");
    expect(note).toContain("gh:pr 42");
    expect(note).toContain("3h ago");
    expect(note).toContain("bd gate resolve g1");
  });

  it("stays on one line — beads splits a note blob on newlines into separate entries", () => {
    expect(expiredGateNote(gate("g1", { timeout: HOURS(1) }), NOW + 7_200_000)).not.toContain("\n");
  });
});

describe("beadBlockedByGate", () => {
  it("finds the bead carrying the gate's blocks edge (bd records it on the blocked side)", () => {
    const board = [
      bead("t-1", { dependencies: [{ issue_id: "t-1", depends_on_id: "g1", type: "blocks" }] }),
      bead("t-2"),
    ];
    expect(beadBlockedByGate(board, "g1")?.id).toBe("t-1");
  });

  it("ignores a non-blocks edge to the same id, and returns undefined when nothing blocks", () => {
    const board = [
      bead("t-1", { dependencies: [{ issue_id: "t-1", depends_on_id: "g1", type: "related" }] }),
    ];
    expect(beadBlockedByGate(board, "g1")).toBeUndefined();
  });
});

describe("runTargetAbove", () => {
  it("walks up from the gated step to the epic anton actually runs", () => {
    const board = [bead("t-1", { parent: "e-1" }), bead("e-1", { issue_type: "epic" })];
    expect(runTargetAbove(board, "t-1")?.id).toBe("e-1");
  });

  it("returns the step itself when it IS the run target (a parentless task)", () => {
    const board = [bead("t-1")];
    expect(runTargetAbove(board, "t-1")?.id).toBe("t-1");
  });

  it("stops at the feature, not the container epic above it — one feature is one run", () => {
    const board = [
      bead("t-1", { parent: "f-1" }),
      bead("f-1", { issue_type: "feature", parent: "e-1" }),
      bead("e-1", { issue_type: "epic" }),
    ];
    expect(runTargetAbove(board, "t-1")?.id).toBe("f-1");
  });

  it("stops at a molecule between the step and a feature — those steps are not that feature's run", () => {
    // The poured shape: a molecule root reparented under a feature. `runTickets` stops at the
    // molecule, so resuming the feature would run unrelated work and leave the step gated forever.
    const board = [
      bead("s-1", { parent: "m-1" }),
      bead("m-1", { issue_type: "molecule", parent: "f-1" }),
      bead("f-1", { issue_type: "feature", labels: [LABELS.approved] }),
    ];
    expect(runTargetAbove(board, "s-1")).toBeUndefined();
    expect(runTargetAbove(board, "m-1")).toBeUndefined();
  });

  it("is undefined for an unknown id or a chain that reaches no run target", () => {
    const board = [bead("t-1", { parent: "missing" })];
    expect(runTargetAbove(board, "nope")).toBeUndefined();
    expect(runTargetAbove(board, "t-1")).toBeUndefined();
  });

  it("survives a cyclic parent chain instead of spinning", () => {
    const board = [
      bead("a", { issue_type: "chore", parent: "b" }),
      bead("b", { issue_type: "chore", parent: "a" }),
    ];
    expect(runTargetAbove(board, "a")).toBeUndefined();
  });
});

describe("isResumableTarget", () => {
  const approved = { labels: [LABELS.approved] };

  it("accepts an approved, open target with no live run-lease", () => {
    expect(isResumableTarget(bead("e-1", { issue_type: "epic", ...approved }), NOW)).toBe(true);
  });

  it("refuses unapproved work — a gate closing is not the founder approving a run", () => {
    expect(isResumableTarget(bead("e-1", { issue_type: "epic" }), NOW)).toBe(false);
  });

  it("refuses closed or abandoned work", () => {
    expect(isResumableTarget(bead("e-1", { ...approved, status: "closed" }), NOW)).toBe(false);
    expect(
      isResumableTarget(bead("e-1", { labels: [LABELS.approved, LABELS.abandoned] }), NOW),
    ).toBe(false);
  });

  it("refuses a target whose run-lease is still live — it is executing somewhere", () => {
    const live = bead("e-1", { labels: [LABELS.approved, LABELS.runLease(NOW + 60_000)] });
    expect(isResumableTarget(live, NOW)).toBe(false);
    const expired = bead("e-2", { labels: [LABELS.approved, LABELS.runLease(NOW - 60_000)] });
    expect(isResumableTarget(expired, NOW)).toBe(true);
  });
});

describe("resumeTargets", () => {
  const board: Bead[] = [
    bead("t-1", { parent: "e-1" }),
    bead("t-2", { parent: "e-1" }),
    bead("e-1", { issue_type: "epic", labels: [LABELS.approved] }),
    bead("t-9", { parent: "e-9" }),
    bead("e-9", { issue_type: "epic" }), // never approved
  ];
  const entry = (step: string, molecule: string): GatedMolecule => ({
    molecule_id: molecule,
    ready_step: bead(step),
  });

  it("maps each ungated step onto its run target, deduped — two steps of one epic are one run", () => {
    const targets = resumeTargets(board, [entry("t-1", "e-1"), entry("t-2", "e-1")], NOW);
    expect(targets.map((t) => t.id)).toEqual(["e-1"]);
  });

  it("drops an entry whose run target the founder never approved", () => {
    expect(resumeTargets(board, [entry("t-9", "e-9")], NOW)).toEqual([]);
  });

  it("falls back to the molecule id when bd reports no ready step", () => {
    expect(resumeTargets(board, [{ molecule_id: "e-1" }], NOW).map((t) => t.id)).toEqual(["e-1"]);
  });

  it("drops an entry that names nothing anton can resolve", () => {
    expect(resumeTargets(board, [{ molecule_id: "" }, entry("ghost", "ghost")], NOW)).toEqual([]);
  });

  it("waits while the TARGET has another open blocker, though its gated step is ready", () => {
    // `bd ready --gated` speaks for the step, not for the epic above it. Dispatching anyway parks
    // the job on execute-epic's own blocker check, and the entry stays listed — so every later pass
    // would resume and re-park the same job until the unrelated prerequisite lands.
    const blocked: Bead[] = [
      bead("t-1", { parent: "e-1" }),
      bead("e-1", {
        issue_type: "epic",
        labels: [LABELS.approved],
        dependencies: [{ issue_id: "e-1", depends_on_id: "e-0", type: "blocks" }],
      }),
      bead("e-0", { issue_type: "epic" }),
    ];
    expect(resumeTargets(blocked, [entry("t-1", "e-1")], NOW)).toEqual([]);
    // …and the moment that prerequisite lands, the still-listed entry releases the target.
    const done = [blocked[0], blocked[1], bead("e-0", { issue_type: "epic", status: "closed" })];
    expect(resumeTargets(done, [entry("t-1", "e-1")], NOW).map((t) => t.id)).toEqual(["e-1"]);
  });

  it("leaves an in-review target alone — step 4 owns the merge, and a resume would double up", () => {
    // A feature parented under a container epic DOES appear here once its merge gate closes, so
    // without this guard the same bead gets both a review-fix (step 4) and a redundant execute-epic.
    const inReview: Bead[] = [
      bead("f-1", {
        parent: "e-1",
        issue_type: "feature",
        labels: [LABELS.approved, LABELS.stage("in-review")],
      }),
      bead("e-1", { issue_type: "epic", labels: [LABELS.approved] }),
    ];
    expect(resumeTargets(inReview, [entry("f-1", "e-1")], NOW)).toEqual([]);
  });

  it("resumes only the operator's own targets — a shared board must not double-dispatch", () => {
    // `bd ready --gated` reads the SHARED board, so every instance sees the same released step.
    // Unfiltered, each enqueues an execute-epic in its own machine-local table; the loser then
    // retries against the winner's run lease, which no local dedupe can see.
    const shared: Bead[] = [
      bead("s-mine", { parent: "e-mine" }),
      bead("e-mine", { issue_type: "epic", labels: [LABELS.approved], assignee: "alice" }),
      bead("s-theirs", { parent: "e-theirs" }),
      bead("e-theirs", { issue_type: "epic", labels: [LABELS.approved], assignee: "bob" }),
      bead("s-free", { parent: "e-free" }),
      bead("e-free", { issue_type: "epic", labels: [LABELS.approved] }),
    ];
    const gated = [
      entry("s-mine", "e-mine"),
      entry("s-theirs", "e-theirs"),
      entry("s-free", "e-free"),
    ];
    expect(resumeTargets(shared, gated, NOW, "alice").map((t) => t.id)).toEqual([
      "e-mine",
      "e-free",
    ]);
    expect(resumeTargets(shared, gated, NOW, "bob").map((t) => t.id)).toEqual([
      "e-theirs",
      "e-free",
    ]);
    // An anton that cannot name itself takes unclaimed work only — it never races a claimed run.
    expect(resumeTargets(shared, gated, NOW, undefined).map((t) => t.id)).toEqual(["e-free"]);
  });
});

/**
 * The resume `bd ready --gated` cannot report: an ad-hoc gate hung straight on a plain bead. bd
 * reports gated MOLECULE steps only, so once such a gate closes its bead just returns to ordinary
 * `bd ready` — and nothing in anton polls that. Without this half the parked run waits forever on a
 * wait that is already over.
 */
describe("plainGateResumes", () => {
  const approved = [LABELS.approved];

  /** An approved standalone target blocked by `gateId`. */
  const parked = (id: string, gateId: string, o: Partial<Bead> = {}): Bead =>
    bead(id, {
      labels: approved,
      dependencies: [{ issue_id: id, depends_on_id: gateId, type: "blocks" }],
      ...o,
    });

  /** The human gate a founder hung on it, resolved. */
  const humanGate = (id: string, o: Partial<Gate> = {}): Gate =>
    gate(id, { await_type: "human", status: "closed", ...o });

  it("hands back a plain target whose ad-hoc gate has closed", () => {
    const out = plainGateResumes([parked("t-1", "g-1"), humanGate("g-1")], NOW);
    expect(out.map((r) => [r.gate.id, r.target.id])).toEqual([["g-1", "t-1"]]);
  });

  it("leaves the target alone while the gate is still open", () => {
    expect(plainGateResumes([parked("t-1", "g-1"), humanGate("g-1", { status: "open" })], NOW))
      .toEqual([]);
  });

  it("never touches a gh:pr gate — a merge is finalization, not a resume", () => {
    // Both halves would otherwise fire on the same bead: this pass would re-run a target while
    // review-fix is closing it out off the very same closed gate.
    const board = [
      parked("t-1", "g-1", { labels: [...approved, LABELS.stage("in-review")] }),
      gate("g-1", { await_type: "gh:pr", status: "closed", await_id: "7" }),
    ];
    expect(plainGateResumes(board, NOW)).toEqual([]);
    expect(mergedGateTargets([{ ...board[0], metadata: { pr: "gh-7" } }, board[1]])).toHaveLength(1);
  });

  it("leaves an in-review target alone — its implementation is done", () => {
    const board = [
      parked("t-1", "g-1", { labels: [...approved, LABELS.stage("in-review")] }),
      humanGate("g-1"),
    ];
    expect(plainGateResumes(board, NOW)).toEqual([]);
  });

  it("marks nothing twice: a gate already handed back is skipped", () => {
    // A resolved gate stays on its bead FOREVER, so without the marker every later pass would
    // re-dispatch the same target — an operator's park would become an endless retry.
    const board = [parked("t-1", "g-1"), humanGate("g-1", { labels: [GATE_RESUMED_LABEL] })];
    expect(plainGateResumes(board, NOW)).toEqual([]);
  });

  it("waits while ANOTHER blocker is open, rather than dispatching work execute-epic refuses", () => {
    const board = [
      parked("t-1", "g-1", {
        dependencies: [
          { issue_id: "t-1", depends_on_id: "g-1", type: "blocks" },
          { issue_id: "t-1", depends_on_id: "t-9", type: "blocks" },
        ],
      }),
      humanGate("g-1"),
      bead("t-9"),
    ];
    expect(plainGateResumes(board, NOW)).toEqual([]);
    // …and the moment that prerequisite lands, the still-unmarked gate releases the target.
    const done = [board[0], board[1], bead("t-9", { status: "closed" })];
    expect(plainGateResumes(done, NOW).map((r) => r.target.id)).toEqual(["t-1"]);
  });

  it("applies the same resumability rules as the molecule half", () => {
    const unapproved = [parked("t-1", "g-1", { labels: [] }), humanGate("g-1")];
    expect(plainGateResumes(unapproved, NOW)).toEqual([]);
    const live = [
      parked("t-1", "g-1", { labels: [...approved, LABELS.runLease(NOW + 60_000)] }),
      humanGate("g-1"),
    ];
    expect(plainGateResumes(live, NOW)).toEqual([]);
  });

  it("walks up to the run target when the gate sits on a child ticket", () => {
    const board = [
      parked("t-1", "g-1", { parent: "f-1" }),
      bead("f-1", { issue_type: "feature", labels: approved }),
      humanGate("g-1"),
    ];
    expect(plainGateResumes(board, NOW).map((r) => r.target.id)).toEqual(["f-1"]);
  });

  it("ignores a gate on a poured molecule step — that one bd DOES report", () => {
    const board = [
      parked("step-1", "g-1", { parent: "mol-1" }),
      bead("mol-1", { issue_type: "molecule", parent: "f-1" }),
      bead("f-1", { issue_type: "feature", labels: approved }),
      humanGate("g-1"),
    ];
    expect(plainGateResumes(board, NOW)).toEqual([]);
  });

  it("hands back only the operator's own targets — a shared board must not double-dispatch", () => {
    // The gate lives on the SHARED board, so every instance's local schedule sees it close. Each
    // would enqueue an execute-epic for the same bead in its own job table; one wins the claim and
    // the other retries on RunAlreadyLiveError until the bead closes.
    const board = [
      parked("mine", "g-1", { labels: approved, assignee: "alice" }),
      parked("theirs", "g-2", { labels: approved, assignee: "bob" }),
      parked("unclaimed", "g-3", { labels: approved, assignee: "" }),
      humanGate("g-1"),
      humanGate("g-2"),
      humanGate("g-3"),
    ];
    expect(plainGateResumes(board, NOW, "alice").map((r) => r.target.id)).toEqual([
      "mine",
      "unclaimed",
    ]);
    expect(plainGateResumes(board, NOW, "bob").map((r) => r.target.id)).toEqual([
      "theirs",
      "unclaimed",
    ]);
    // An anton that cannot name itself takes unclaimed work only — it never races a claimed run.
    expect(plainGateResumes(board, NOW, undefined).map((r) => r.target.id)).toEqual(["unclaimed"]);
  });

  it("reports every closed gate on one target, so each gets its own marker", () => {
    const board = [
      parked("t-1", "g-1", {
        dependencies: [
          { issue_id: "t-1", depends_on_id: "g-1", type: "blocks" },
          { issue_id: "t-1", depends_on_id: "g-2", type: "blocks" },
        ],
      }),
      humanGate("g-1"),
      humanGate("g-2", { await_type: "timer" }),
    ];
    expect(plainGateResumes(board, NOW).map((r) => r.gate.id)).toEqual(["g-1", "g-2"]);
  });
});

/**
 * anton-k0kj: which in-review targets the pass hands to review-fix. The whole distinction lives
 * here — bd closes a `gh:pr` gate ONLY on a merge, so "gate closed" is the merge signal, while a PR
 * closed without merging leaves the gate open and the target alone.
 */
describe("mergedGateTargets", () => {
  /** An in-review target on PR #7, blocked by `gateId`. */
  const gated = (id: string, gateId: string, o: Partial<Bead> = {}): Bead =>
    bead(id, {
      issue_type: "epic",
      labels: [LABELS.stage("in-review")],
      metadata: { pr: "gh-7" },
      dependencies: [{ issue_id: id, depends_on_id: gateId, type: "blocks" }],
      ...o,
    });

  /** The gate that awaits that PR. */
  const mergeGate = (id: string, o: Partial<Gate> = {}): Gate =>
    gate(id, { await_id: "7", status: "closed", ...o });

  it("dispatches an in-review target whose merge gate has closed", () => {
    const board = [gated("e-1", "g-1"), mergeGate("g-1")];
    expect(mergedGateTargets(board).map((b) => b.id)).toEqual(["e-1"]);
  });

  it("leaves a target whose merge gate is still open — an unmerged PR is not a merge", () => {
    const board = [gated("e-1", "g-1"), mergeGate("g-1", { status: "open" })];
    expect(mergedGateTargets(board)).toEqual([]);
  });

  it("ignores a closed gate of another flavour — only gh:pr means merged", () => {
    const board = [gated("e-1", "g-1"), mergeGate("g-1", { await_type: "timer" })];
    expect(mergedGateTargets(board)).toEqual([]);
  });

  it("ignores a closed gate for a SUPERSEDED PR — the recovery PR is still open", () => {
    // armMergeGate resolves the old gate when a closed-unmerged PR is re-opened under a new number,
    // and that resolved edge stays on the bead forever. Reading it as a merge would dispatch
    // review-fix against the live PR on every pass.
    const board = [
      gated("e-1", "g-old", {
        dependencies: [
          { issue_id: "e-1", depends_on_id: "g-old", type: "blocks" },
          { issue_id: "e-1", depends_on_id: "g-new", type: "blocks" },
        ],
      }),
      mergeGate("g-old", { await_id: "3" }),
      mergeGate("g-new", { status: "open" }),
    ];
    expect(mergedGateTargets(board)).toEqual([]);
    // …and once THAT PR merges, the target is dispatched off its own gate.
    const merged = [board[0], board[1], mergeGate("g-new")];
    expect(mergedGateTargets(merged).map((b) => b.id)).toEqual(["e-1"]);
  });

  it("ignores a target with no PR number — there is nothing to finalize", () => {
    expect(mergedGateTargets([gated("e-1", "g-1", { metadata: {} }), mergeGate("g-1")])).toEqual([]);
    expect(
      mergedGateTargets([gated("e-1", "g-1", { metadata: { pr: "ENG-4" } }), mergeGate("g-1")]),
    ).toEqual([]);
  });

  it("drops a target once finalization lands, so a closed gate can't re-dispatch forever", () => {
    const closedGate = mergeGate("g-1");
    expect(mergedGateTargets([gated("e-1", "g-1", { status: "closed" }), closedGate])).toEqual([]);
    expect(mergedGateTargets([gated("e-1", "g-1", { labels: [] }), closedGate])).toEqual([]);
  });

  it("dispatches only the operator's own targets — a shared board must not double-finalize", () => {
    // The gate lives on the SHARED board, so every instance's local schedule sees it close. A
    // targeted review-fix bypasses the sweep's ownership filter, so it has to be applied here.
    const board = [
      gated("mine", "g-1", { assignee: "alice" }),
      gated("theirs", "g-2", { assignee: "bob" }),
      gated("unclaimed", "g-3", { assignee: "" }),
      mergeGate("g-1"),
      mergeGate("g-2"),
      mergeGate("g-3"),
    ];
    expect(mergedGateTargets(board, "alice").map((b) => b.id)).toEqual(["mine", "unclaimed"]);
    expect(mergedGateTargets(board, "bob").map((b) => b.id)).toEqual(["theirs", "unclaimed"]);
    // An anton that cannot name itself takes unclaimed work only — it never races a claimed PR.
    expect(mergedGateTargets(board, undefined).map((b) => b.id)).toEqual(["unclaimed"]);
  });

  it("ignores a non-blocks edge to a closed gate", () => {
    const board = [
      gated("e-1", "g-1", {
        dependencies: [{ issue_id: "e-1", depends_on_id: "g-1", type: "related" }],
      }),
      mergeGate("g-1"),
    ];
    expect(mergedGateTargets(board)).toEqual([]);
  });
});
