import { describe, expect, it } from "vitest";
import {
  contractGatedBoard,
  parseAcceptance,
  parseGoal,
  resumeSkipped,
  runContractStatus,
  runTickets,
  toStandaloneItem,
} from "./ticket-view";
import type { Bead } from "./beads/bd";

function makeBead(overrides: Partial<Bead> & { id: string }): Bead {
  return {
    title: overrides.id,
    status: "open",
    issue_type: "task",
    labels: [],
    ...overrides,
  };
}

describe("runTickets (the tickets a run target contains)", () => {
  it("collects the whole working-layer subtree, not just direct children", () => {
    // epic → feature → task → subtask. The subtask ships in the feature's worktree and PR, so the
    // run must execute it — a direct-children run merged the PR and stranded it open.
    const board = [
      makeBead({ id: "epic-p", issue_type: "epic" }),
      makeBead({ id: "feat-1", issue_type: "feature", parent: "epic-p" }),
      makeBead({ id: "task-1", parent: "feat-1" }),
      makeBead({ id: "sub-1", parent: "task-1" }),
    ];
    expect(runTickets(board, "feat-1").map((b) => b.id)).toEqual(["task-1", "sub-1"]);
  });

  it("stops descending at a nested card — it owns its own subtree and its own PR", () => {
    const board = [
      makeBead({ id: "feat-1", issue_type: "feature" }),
      makeBead({ id: "task-1", parent: "feat-1" }),
      makeBead({ id: "feat-2", issue_type: "feature", parent: "feat-1" }),
      makeBead({ id: "task-2", parent: "feat-2" }),
    ];
    expect(runTickets(board, "feat-1").map((b) => b.id)).toEqual(["task-1"]);
    expect(runTickets(board, "feat-2").map((b) => b.id)).toEqual(["task-2"]);
  });

  it("carries a legacy epic's tickets, however deep", () => {
    const board = [
      makeBead({ id: "epic-legacy", issue_type: "epic" }),
      makeBead({ id: "task-1", parent: "epic-legacy" }),
      makeBead({ id: "sub-1", parent: "task-1" }),
    ];
    expect(runTickets(board, "epic-legacy").map((b) => b.id)).toEqual(["task-1", "sub-1"]);
  });

  it("gives a container epic no tickets — its features each run on their own", () => {
    const board = [
      makeBead({ id: "epic-p", issue_type: "epic" }),
      makeBead({ id: "feat-1", issue_type: "feature", parent: "epic-p" }),
      makeBead({ id: "task-1", parent: "feat-1" }),
      // A task parked directly under the container ships in no run — it belongs to no card.
      makeBead({ id: "loose-1", parent: "epic-p" }),
    ];
    expect(runTickets(board, "epic-p")).toEqual([]);
  });

  it("closes over a malformed parent cycle rather than hanging", () => {
    const board = [
      makeBead({ id: "feat-1", issue_type: "feature" }),
      makeBead({ id: "a", parent: "b" }),
      makeBead({ id: "b", parent: "a" }),
    ];
    expect(runTickets(board, "feat-1")).toEqual([]);
  });
});

describe("resumeSkipped (the beads a run won't dispatch an agent for)", () => {
  const inReview = makeBead({ id: "task-1", labels: ["stage:in-review"] });

  it("skips a closed bead on either run shape", () => {
    const closed = makeBead({ id: "task-done", status: "closed" });
    expect(resumeSkipped(closed, true)).toBe(true);
    expect(resumeSkipped(closed, false)).toBe(true);
  });

  it("skips a standalone target already in review — only the agent-free PR step is left", () => {
    expect(resumeSkipped(inReview, true)).toBe(true);
  });

  it("keeps an in-review bead inside a grouped run — the label belongs to the epic, not the ticket", () => {
    expect(resumeSkipped(inReview, false)).toBe(false);
  });

  it("keeps an open, unlabeled bead — its agent still runs", () => {
    expect(resumeSkipped(makeBead({ id: "task-open" }), true)).toBe(false);
  });
});

describe("toStandaloneItem (the chip's contract matches the approve gate)", () => {
  it("carries no gaps for an in-review standalone missing Acceptance — its run dispatches no agent", () => {
    // A legacy standalone undergoing closed-PR recovery: the approve route Force-runs it
    // (resumeSkipped → contractGatedBeads → []), so the chip must not render "needs Acceptance"
    // against exactly the action the gate permits.
    const bead = makeBead({
      id: "task-legacy",
      labels: ["stage:in-review"],
      description: "written before the contract — no sections",
      created_at: "2026-07-28T00:00:00Z",
    });
    expect(toStandaloneItem(bead).contract).toEqual({ blocking: [], advisory: [] });
  });

  it("still reports the gaps on a backlog standalone — its run would dispatch an agent", () => {
    const bead = makeBead({
      id: "task-unshaped",
      description: "no sections",
      created_at: "2026-07-28T00:00:00Z",
    });
    expect(toStandaloneItem(bead).contract?.blocking.map((v) => v.section)).toEqual(["Acceptance"]);
  });
});

describe("contractGatedBoard (every spec a run on this board reads)", () => {
  it("seeds from run targets only — a container epic's spec strands nothing", () => {
    const board = [
      makeBead({ id: "epic-p", issue_type: "epic" }),
      makeBead({ id: "feat-1", issue_type: "feature", parent: "epic-p" }),
      makeBead({ id: "task-1", parent: "feat-1" }),
      // Judged by the contract, reachable by no run: a chore is never a target, and a task parked
      // under the container rides on no card.
      makeBead({ id: "chore-1", issue_type: "chore" }),
      makeBead({ id: "loose-1", parent: "epic-p" }),
    ];
    expect(contractGatedBoard(board).map((b) => b.id)).toEqual(["feat-1", "task-1"]);
  });

  it("rolls a target's whole ticket subtree in, and drops what its run skips", () => {
    const board = [
      makeBead({ id: "feat-1", issue_type: "feature" }),
      makeBead({ id: "task-1", parent: "feat-1" }),
      makeBead({ id: "sub-1", parent: "task-1" }),
      makeBead({ id: "task-done", parent: "feat-1", status: "closed" }),
      // A closed standalone target: its run dispatches nothing, so nothing re-reads its spec.
      makeBead({ id: "task-solo", status: "closed" }),
    ];
    expect(contractGatedBoard(board).map((b) => b.id)).toEqual(["feat-1", "task-1", "sub-1"]);
  });

  it("lists each bead once when two targets' gated sets overlap", () => {
    const board = [
      makeBead({ id: "feat-1", issue_type: "feature" }),
      makeBead({ id: "task-1", parent: "feat-1" }),
      makeBead({ id: "feat-2", issue_type: "feature", parent: "feat-1" }),
    ];
    const gated = contractGatedBoard(board).map((b) => b.id);
    expect(new Set(gated).size).toBe(gated.length);
    expect(gated.sort()).toEqual(["feat-1", "feat-2", "task-1"]);
  });
});

describe("runContractStatus (a card's contract covers the whole run)", () => {
  const SHAPED = "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO\n\n## Verify\nV";
  /** A bead a bd read produced, so the contract is judged rather than skipped. */
  const readBead = (over: Partial<Bead> & { id: string }) =>
    makeBead({ created_at: "2026-07-20T00:00:00.000Z", ...over });

  const target = readBead({
    id: "feat-1",
    issue_type: "feature",
    description: `${SHAPED}\n\n## Acceptance\n- [ ] it works`,
  });

  it("reports an open child's blocking gap on the target, named with the child's id", () => {
    // The approve route gates on `[target, ...open tickets]`, so a card showing only the target's
    // own status advertised Approve on a request that 422s.
    const child = readBead({ id: "task-1", parent: "feat-1", description: SHAPED });

    const status = runContractStatus(target, [child])!;

    expect(status.blocking.map((v) => v.section)).toEqual(["Acceptance"]);
    expect(status.blocking[0].message).toContain("task-1");
  });

  it("carries an open child's advisory gaps too, without inventing a blocker", () => {
    const child = readBead({
      id: "task-1",
      parent: "feat-1",
      acceptance_criteria: "- [ ] it works",
    });

    const status = runContractStatus(target, [child])!;

    expect(status.blocking).toEqual([]);
    expect(status.advisory.map((v) => v.section)).toEqual([
      "Goal",
      "Context",
      "Out of scope",
      "Verify",
    ]);
    expect(status.advisory.every((v) => v.message.startsWith("task-1 → "))).toBe(true);
  });

  it("drops a closed child — the runner resume-skips it, so its spec strands nothing", () => {
    const done = readBead({
      id: "task-done",
      parent: "feat-1",
      status: "closed",
      description: SHAPED,
    });

    expect(runContractStatus(target, [done])).toEqual({ blocking: [], advisory: [] });
  });

  it("ignores children of a leaf target — it runs as its own single ticket", () => {
    // A feature with no shaped tickets under it doesn't group children, so a sibling projection
    // handed in here must not fault it (beads.groupsChildren, shared with the runner).
    const stranger = readBead({ id: "task-x", description: SHAPED });

    expect(runContractStatus(target, [])).toEqual({ blocking: [], advisory: [] });
    expect(runContractStatus({ ...target, issue_type: "task" }, [stranger])).toEqual({
      blocking: [],
      advisory: [],
    });
  });

  it("clears a standalone target already in review, however thin its spec", () => {
    // Force-run recovery of a failed/closed PR on a legacy bead: the commit exists and only the PR
    // step is left, so a card that surfaced a gap here would withhold the one action that recovers it.
    const legacy = readBead({ id: "task-legacy", labels: ["stage:in-review"] });

    expect(runContractStatus(legacy, [])).toEqual({ blocking: [], advisory: [] });
  });

  it("clears a grouped target whose children are all closed — the same recovery, grouped", () => {
    // Every child done and the PR closed without merging: the run re-opens the PR and dispatches no
    // agent. Faulting the (legacy, pre-contract) parent here would strand the grouped half of the
    // closed-PR recovery that execute-epic supports and the standalone shape is already exempt for.
    const legacy = readBead({ id: "feat-legacy", issue_type: "feature" });
    const done = readBead({ id: "task-done", parent: "feat-legacy", status: "closed" });

    expect(runContractStatus(legacy, [done])).toEqual({ blocking: [], advisory: [] });
  });

  it("still faults a grouped target when one child is left to run", () => {
    // The exemption is "this run reads no spec", not "some children are closed" — with work left,
    // the target's own criteria are the rubric that work is judged against.
    const legacy = readBead({ id: "feat-legacy", issue_type: "feature" });
    const done = readBead({ id: "task-done", parent: "feat-legacy", status: "closed" });
    const open = readBead({ id: "task-open", parent: "feat-legacy", description: `${SHAPED}\n\n## Acceptance\n- [ ] it works` });

    const status = runContractStatus(legacy, [done, open])!;

    expect(status.blocking.map((v) => v.section)).toEqual(["Acceptance"]);
    expect(status.blocking[0].message).not.toContain("task-open");
  });

  it("stays undefined when nothing in the set was judged", () => {
    // A projection carrying no bd stamps was never read — "not judged" must not render as a gap.
    const bare = makeBead({ id: "feat-bare", issue_type: "feature" });
    expect(runContractStatus(bare, [makeBead({ id: "task-bare", parent: "feat-bare" })])).toBeUndefined();
  });
});

describe("parseGoal / parseAcceptance (the validator's own parser)", () => {
  it("reads the heading levels the contract validator accepts, not `##` alone", () => {
    // The two used to disagree: a `# Goal` bead passed the gate and rendered blank everywhere.
    const description = "# Goal\nShip it.\n\n### Acceptance\n- [ ] it works";
    expect(parseGoal(makeBead({ id: "t-1", description }))).toBe("Ship it.");
    expect(parseAcceptance(makeBead({ id: "t-1", description }))).toBe("- [ ] it works");
  });

  it("reads an epic's outcome from `## Outcome` — the alias its tier is judged on", () => {
    // The validator accepts either heading for an epic's outcome, so a reader that knew only
    // `## Goal` rendered a goal-less card for an epic the gate had just called conformant.
    const bead = makeBead({
      id: "epic-1",
      issue_type: "epic",
      description: "## Outcome\nReports leave the app.\n\n## Success Criteria\n- [ ] every view exports",
    });
    expect(parseGoal(bead)).toBe("Reports leave the app.");
    // A ticket is judged on `## Goal` alone, so the alias must not render one the gate faults.
    expect(parseGoal({ ...bead, issue_type: "task" })).toBeUndefined();
  });

  it("matches the validator's heading spelling too — `## Acceptance Criteria` is Acceptance", () => {
    const description = "## Acceptance Criteria\n- [ ] it works";
    expect(parseAcceptance(makeBead({ id: "t-1", description }))).toBe("- [ ] it works");
  });

  it("reads an epic's rubric from `## Success Criteria` — the keys its tier is judged on", () => {
    // The validator accepts an epic whose rubric is `## Success Criteria`; a reader that knew only
    // `## Acceptance` let approval pass and the detail page omit the criteria the run is judged on.
    const bead = makeBead({
      id: "epic-1",
      issue_type: "epic",
      description: "Reports are shareable.\n\n## Success Criteria\n- [ ] every report leaves the app",
    });
    expect(parseAcceptance(bead)).toBe("- [ ] every report leaves the app");
    // A ticket is judged on Acceptance, so the same heading is not its rubric.
    expect(parseAcceptance({ ...bead, issue_type: "task" })).toBeUndefined();
  });

  it("falls back to bd's own field when the description carries no section", () => {
    const bead = makeBead({ id: "t-1", acceptance_criteria: "- [ ] field only" });
    expect(parseAcceptance(bead)).toBe("- [ ] field only");
    expect(parseGoal(bead)).toBeUndefined();
  });

  it("prefers the authored field over a section still holding the formula's TODO prompt", () => {
    // The repair the blocking gap prescribes (`bd update --acceptance`) writes bd's field and leaves
    // the cooked prompt in the description — a description-first read then showed the operator the
    // TODO they had just answered, on a bead approval now accepts.
    const epic = makeBead({
      id: "epic-1",
      issue_type: "epic",
      description: "Reports are shareable.\n\n## Success Criteria\n- [ ] TODO — how you know it landed",
      acceptance_criteria: "- [ ] every report leaves the app",
    });
    expect(parseAcceptance(epic)).toBe("- [ ] every report leaves the app");
    expect(parseAcceptance({ ...epic, issue_type: "task", description: "## Acceptance\n- [ ] TODO — done?" }))
      .toBe("- [ ] every report leaves the app");
  });

  it("still renders the prompt when no home is authored — the bead really has no rubric yet", () => {
    const bead = makeBead({ id: "t-1", description: "## Acceptance\n- [ ] TODO — a checkable statement" });
    expect(parseAcceptance(bead)).toBe("- [ ] TODO — a checkable statement");
  });
});
