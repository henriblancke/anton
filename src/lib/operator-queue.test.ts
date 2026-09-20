/**
 * The operator queue's SET and ORDER (anton-qfso.1).
 *
 * The set is the whole point: `agent:human` beads are excluded from everything anton dispatches
 * (anton-mv70), so this list is the only place they still exist as work. It must therefore hold
 * exactly the work a person owes — approved, still open, human — and nothing it cannot back up: a
 * container epic is not work, an unapproved bead is not yet anyone's, and a closed one already
 * happened.
 */
import { describe, expect, it } from "vitest";

import { operatorQueue } from "./operator-queue";
import type { Bead } from "./beads/bd";

const bead = (b: Partial<Bead>): Bead =>
  ({
    id: "x",
    title: "x",
    status: "open",
    issue_type: "task",
    labels: ["approved", "agent:human"],
    created_at: "2026-08-01T00:00:00.000Z",
    ...b,
  }) as Bead;

const ids = (items: ReturnType<typeof operatorQueue>) => items.map((i) => i.id);

describe("operatorQueue — the set", () => {
  it("keeps an approved, open, human run target", () => {
    const board = [bead({ id: "f1", issue_type: "feature" })];
    expect(ids(operatorQueue(board))).toEqual(["f1"]);
  });

  it("drops work no one labelled for a person — that is the agents' queue", () => {
    const board = [bead({ id: "f1", issue_type: "feature", labels: ["approved", "agent:nextjs"] })];
    expect(operatorQueue(board)).toEqual([]);
  });

  it("drops an unapproved human bead — nobody has said it should be done yet", () => {
    const board = [bead({ id: "f1", issue_type: "feature", labels: ["agent:human"] })];
    expect(operatorQueue(board)).toEqual([]);
  });

  it("drops closed and deferred beads: one happened, the other was snoozed on purpose", () => {
    const board = [
      bead({ id: "t1", status: "closed" }),
      bead({ id: "t2", status: "deferred" }),
      bead({ id: "t3" }),
    ];
    expect(ids(operatorQueue(board))).toEqual(["t3"]);
  });

  it("keeps a bead a person has already started — in_progress is doing it, not done with it", () => {
    // Dropping it here would hide the work at exactly the moment someone picked it up.
    const board = [bead({ id: "t1", status: "in_progress" })];
    expect(ids(operatorQueue(board))).toEqual(["t1"]);
  });

  it("keeps a human ticket inside an approved run, and names the run it holds", () => {
    // The claimable-set exclusion can't reach this one — the feature is the claimable thing, not its
    // child — so the run reaches the ticket, arms a gate, and waits on a person.
    const board = [
      bead({ id: "f1", title: "Ship billing", issue_type: "feature", labels: ["approved"] }),
      bead({ id: "f1.1", issue_type: "task", parent: "f1" }),
    ];
    const [item] = operatorQueue(board);
    expect(item.id).toBe("f1.1");
    expect(item.runTarget).toEqual({ id: "f1", title: "Ship billing" });
    expect(item.holdsRun).toBe(true);
  });

  it("keeps a human GRANDCHILD of the run target — it ships in the same PR, so the run holds on it", () => {
    // The approval-gate toast counts human work with `contractGatedBeads`, which reaches every
    // descendant ticket; this list must reach exactly as far or a run that says "2 tickets need you"
    // would show only one of them here (PR #214 review). Both derive depth from `boardCards.cardOf`,
    // which walks the whole parent chain to the nearest card.
    const board = [
      bead({ id: "f1", title: "Ship billing", issue_type: "feature", labels: ["approved"] }),
      bead({ id: "f1.1", issue_type: "task", parent: "f1", labels: [] }),
      bead({ id: "f1.1.1", issue_type: "task", parent: "f1.1" }),
    ];
    const [item] = operatorQueue(board);
    expect(item.id).toBe("f1.1.1");
    // It rides the FEATURE — the card is the run, not the agent task in between.
    expect(item.runTarget).toEqual({ id: "f1", title: "Ship billing" });
    expect(item.holdsRun).toBe(true);
  });

  it("holds no run when the target is human work too — the run is refused before any gate arms", () => {
    // execute-epic poisons an `agent:human` target before it dispatches a single child, so nothing
    // under it is ever reached. Calling this ticket "holds a run" would send the operator looking
    // for a "Waiting on you" escalation that was never armed (PR #214 review).
    const board = [
      bead({ id: "f1", title: "Buy the domain", issue_type: "feature" }),
      bead({ id: "f1.1", issue_type: "task", parent: "f1" }),
    ];
    const [target, ticket] = operatorQueue(board);
    expect(target.id).toBe("f1");
    expect(target.holdsRun).toBeUndefined();
    expect(ticket.id).toBe("f1.1");
    expect(ticket.runTarget).toEqual({ id: "f1", title: "Buy the domain" });
    expect(ticket.holdsRun).toBe(false);
  });

  it("drops a human ticket whose run target is not approved — the run cannot reach it", () => {
    const board = [
      bead({ id: "f1", issue_type: "feature", labels: [] }),
      bead({ id: "f1.1", issue_type: "task", parent: "f1" }),
    ];
    expect(operatorQueue(board)).toEqual([]);
  });

  it("keeps a human ticket stranded under an already-closed run target — the run shipped, the ticket didn't", () => {
    // PR #288 review: this used to drop the row entirely once the target settled, hiding exactly the
    // ticket the ticket dialog's own Mark-done gate (ticket-detail.ts) now treats as real, actionable
    // work via the same `liveRunTargetOf` predicate — the operator queue is the primary place to find
    // it, and silently omitting the row left it undiscoverable there.
    const board = [
      bead({ id: "f1", title: "Ship billing", issue_type: "feature", labels: ["approved"], status: "closed" }),
      bead({ id: "f1.1", issue_type: "task", parent: "f1" }),
    ];
    const [item] = operatorQueue(board);
    expect(item.id).toBe("f1.1");
    expect(item.runTarget).toEqual({ id: "f1", title: "Ship billing" });
    expect(item.holdsRun).toBe(false);
  });

  it("keeps a human ticket stranded under a deferred run target the same way", () => {
    const board = [
      bead({ id: "f1", title: "Ship billing", issue_type: "feature", labels: ["approved"], status: "deferred" }),
      bead({ id: "f1.1", issue_type: "task", parent: "f1" }),
    ];
    const [item] = operatorQueue(board);
    expect(item.id).toBe("f1.1");
    expect(item.holdsRun).toBe(false);
  });

  it("names no run target for a target of its own", () => {
    const board = [bead({ id: "t1" })];
    expect(operatorQueue(board)[0].runTarget).toBeUndefined();
  });

  it("drops a container epic — its features each run on their own", () => {
    const board = [
      bead({ id: "e1", issue_type: "epic" }),
      bead({ id: "f1", issue_type: "feature", labels: ["approved"] , parent: "e1" }),
    ];
    expect(operatorQueue(board)).toEqual([]);
  });

  it("drops pipeline plumbing — a gate coordinates work without being any", () => {
    const board = [bead({ id: "g1", issue_type: "gate" })];
    expect(operatorQueue(board)).toEqual([]);
  });

  it("flags a human epic that still has open work under it — Mark done would 409 there", () => {
    const board = [
      bead({ id: "e1", issue_type: "epic", labels: ["approved", "agent:human"] }),
      bead({ id: "e1.1", issue_type: "task", parent: "e1" }),
    ];
    const [target] = operatorQueue(board);
    expect(target.id).toBe("e1");
    expect(target.hasOpenDescendants).toBe(true);
  });

  it("does not flag a human epic once its child has closed", () => {
    const board = [
      bead({ id: "e1", issue_type: "epic", labels: ["approved", "agent:human"] }),
      bead({ id: "e1.1", issue_type: "task", parent: "e1", status: "closed" }),
    ];
    const [target] = operatorQueue(board);
    expect(target.id).toBe("e1");
    expect(target.hasOpenDescendants).toBeUndefined();
  });

  it("does not flag a leaf human ticket — a task/bug never has children", () => {
    const board = [bead({ id: "t1" })];
    expect(operatorQueue(board)[0].hasOpenDescendants).toBeUndefined();
  });

  it("does not flag a human epic for an open molecule/gate hung under it — pipeline plumbing, not open work", () => {
    // PR #288 review: this predicate used to filter no pipeline artifacts at all, disagreeing with
    // the identical read on the ticket dialog (ticket-detail.ts) and closeHumanTicket, which both
    // already excluded a bare molecule/gate — hiding a working Mark done here for a bead the close
    // route would actually accept.
    const board = [
      bead({ id: "e1", issue_type: "epic", labels: ["approved", "agent:human"] }),
      bead({ id: "e1.1", issue_type: "molecule", parent: "e1", labels: [] }),
      bead({ id: "e1.2", issue_type: "gate", parent: "e1.1", labels: [] }),
    ];
    const [target] = operatorQueue(board);
    expect(target.id).toBe("e1");
    expect(target.hasOpenDescendants).toBeUndefined();
  });

  it("does not flag a human epic for a task poured under an open molecule — the whole subtree is pruned", () => {
    // Codex review (PR #288): filtering only the molecule/gate NODES still left a poured `task` step
    // underneath them counted as open work, 409ing the close for as long as the run lasted.
    const board = [
      bead({ id: "e1", issue_type: "epic", labels: ["approved", "agent:human"] }),
      bead({ id: "e1.1", issue_type: "molecule", parent: "e1", labels: [] }),
      bead({ id: "e1.2", issue_type: "task", parent: "e1.1", labels: [] }),
    ];
    const [target] = operatorQueue(board);
    expect(target.id).toBe("e1");
    expect(target.hasOpenDescendants).toBeUndefined();
  });

  it("flags a human ticket still held by an ordinary open blocks dependency", () => {
    // PR #288 review: neither `holdsRun` nor `hasOpenDescendants` represents a plain sibling
    // prerequisite ("sign the contract, then wire the account"), so this row offered Mark done for
    // work `closeHumanTicket` would still 409 — it 409s on ANY open `blocks` dependency, not just a
    // run's own hold.
    const board = [
      bead({ id: "b1", labels: ["approved"] }),
      bead({
        id: "t1",
        dependencies: [{ issue_id: "t1", depends_on_id: "b1", type: "blocks" }],
      }),
    ];
    const [target] = operatorQueue(board);
    expect(target.id).toBe("t1");
    expect(target.hasOpenBlockers).toBe(true);
  });

  it("does not flag it once the blocker closes", () => {
    const board = [
      bead({ id: "b1", status: "closed" }),
      bead({
        id: "t1",
        dependencies: [{ issue_id: "t1", depends_on_id: "b1", type: "blocks" }],
      }),
    ];
    const [target] = operatorQueue(board);
    expect(target.hasOpenBlockers).toBeUndefined();
  });

  it("carries what the row acts on: the goal, the chips, and when it was asked", () => {
    const board = [
      bead({
        id: "t1",
        title: "Buy the domain",
        description: "## Goal\n\nRegister anton.dev before the launch post.\n",
        labels: ["approved", "agent:human", "risk:low", "size:S"],
        created_at: "2026-08-09T10:00:00.000Z",
      }),
    ];
    expect(operatorQueue(board)[0]).toMatchObject({
      id: "t1",
      title: "Buy the domain",
      goal: "Register anton.dev before the launch post.",
      risk: "low",
      size: "S",
      stage: "backlog",
      createdAt: "2026-08-09T10:00:00.000Z",
    });
  });
});

describe("operatorQueue — the order", () => {
  it("puts the newest ask first", () => {
    const board = [
      bead({ id: "old", created_at: "2026-07-01T00:00:00.000Z" }),
      bead({ id: "new", created_at: "2026-08-20T00:00:00.000Z" }),
      bead({ id: "mid", created_at: "2026-08-01T00:00:00.000Z" }),
    ];
    expect(ids(operatorQueue(board))).toEqual(["new", "mid", "old"]);
  });

  it("breaks a tie on id, so two renders of an unchanged board are identical", () => {
    const board = [bead({ id: "b" }), bead({ id: "a" })];
    expect(ids(operatorQueue(board))).toEqual(["a", "b"]);
  });

  it("sorts an undated ask last rather than letting it pass as new", () => {
    const board = [
      bead({ id: "undated", created_at: undefined }),
      bead({ id: "dated", created_at: "2026-07-01T00:00:00.000Z" }),
    ];
    expect(ids(operatorQueue(board))).toEqual(["dated", "undated"]);
  });
});
