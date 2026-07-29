import { describe, expect, it } from "vitest";
import { parseAcceptance, parseGoal, resumeSkipped, runContractStatus, runTickets } from "./ticket-view";
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
    expect(parseGoal(description)).toBe("Ship it.");
    expect(parseAcceptance(makeBead({ id: "t-1", description }))).toBe("- [ ] it works");
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
    expect(parseGoal(bead.description)).toBeUndefined();
  });
});
