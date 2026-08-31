/**
 * The stored policy, bound to a board for the picker.
 *
 * What is pinned here is the AGREEMENT: the pass narrows its plan with the same predicate, over the
 * same projection, that the settings panel counted with — so the boundary an operator accepted is
 * the boundary the recorded plan keeps. And the direction it fails: a target the projection does not
 * carry is refused, never admitted (R2.5).
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/types";
import { armedPickerPolicy, ARMED_RULE } from "./picker-policy";

/** A dated, contract-shaped bead — nothing for the approve gate to fault. */
function bead(id: string, o: Partial<Bead> = {}): Bead {
  return {
    id,
    title: id,
    status: "open",
    issue_type: "task",
    created_at: "2026-08-01T00:00:00Z",
    description: "## Goal\n\nShip it.\n",
    acceptance_criteria: "- [ ] it ships",
    ...o,
  };
}

const NOW = new Date("2026-08-29T00:00:00Z");

describe("armedPickerPolicy", () => {
  it("admits a target the policy covers, naming the rule the plan records", () => {
    const board = [bead("t1", { issue_type: "bug", priority: 1 })];
    const verdict = armedPickerPolicy({ types: ["bug"] }, board, NOW).admits(board[0]);
    expect(verdict).toEqual({ admitted: true, rule: ARMED_RULE });
  });

  it("refuses a target the policy excludes, in the words the editor uses", () => {
    const board = [bead("t1", { issue_type: "bug" })];
    const verdict = armedPickerPolicy({ types: ["chore"] }, board, NOW).admits(board[0]);
    expect(verdict.admitted).toBe(false);
    // "Why not this one?" is asked of the plan as often as of the panel, and both answer the same.
    expect(verdict.admitted === false && verdict.detail).toContain("the policy admits only chore");
  });

  it("judges age against the pass's observation instant, not the moment each bead is read", () => {
    const board = [bead("t1", { created_at: "2026-08-28T00:00:00Z" })];
    const policy = { minAgeDays: 5 };
    expect(armedPickerPolicy(policy, board, NOW).admits(board[0]).admitted).toBe(false);
    const older = new Date("2026-09-30T00:00:00Z");
    expect(armedPickerPolicy(policy, board, older).admits(board[0]).admitted).toBe(true);
  });

  it("refuses a target the startable projection does not carry (R2.5)", () => {
    // Fails closed on the miss: the projection IS the startable set, so a target it does not carry
    // is one the picker could not start — admitting it would start work no rule covered.
    const board = [bead("t1")];
    const stranger = bead("elsewhere");
    const verdict = armedPickerPolicy({}, board, NOW).admits(stranger);
    expect(verdict).toEqual({ admitted: false, detail: expect.stringContaining("startable") });
  });

  it("admits everything the policy asserts nothing about", () => {
    const board = [bead("t1"), bead("t2", { issue_type: "feature" })];
    const policy = armedPickerPolicy({}, board, NOW);
    expect(board.every((b) => policy.admits(b).admitted)).toBe(true);
  });
});
