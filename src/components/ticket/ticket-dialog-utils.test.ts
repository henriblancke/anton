import { describe, expect, it } from "vitest";
import {
  composeDescription,
  diffTicketPatch,
  draftFromDetail,
  hasTicketChanges,
  stripContractSections,
  type TicketDraft,
} from "@/components/ticket/ticket-dialog-utils";
import { parseAcceptance, parseGoal } from "@/lib/tickets";
import type { Bead } from "@/lib/beads/bd";
import type { TicketDetail } from "@/lib/types";

/** Minimal bead carrying just the fields parseAcceptance reads. */
const asBead = (fields: Partial<Bead>): Bead => ({ id: "x", title: "t", status: "open", ...fields });

/** The claimed-by + created metadata every TicketDetail now carries; incidental to these tests. */
const meta = { assignee: null, createdAt: "", createdBy: null, approved: false } satisfies Pick<
  TicketDetail,
  "assignee" | "createdAt" | "createdBy" | "approved"
>;

const detail: TicketDetail = {
  id: "bd-1",
  title: "Do the thing",
  status: "open",
  stage: "backlog",
  type: "task",
  priority: 2,
  agent: "nextjs",
  risk: "low",
  size: "M",
  ...meta,
};

const base = draftFromDetail(detail);

describe("draftFromDetail", () => {
  it("maps detail fields, defaulting absent labels and contract to empty strings", () => {
    const bare = draftFromDetail({ id: "x", title: "t", status: "open", stage: "backlog", type: "task", ...meta });
    expect(bare).toEqual({
      title: "t",
      status: "open",
      priority: undefined,
      agent: "",
      risk: "",
      size: "",
      goal: "",
      acceptance: "",
      body: "",
    });
  });

  it("splits the contract into goal / acceptance / body, keeping the rest in body", () => {
    const draft = draftFromDetail({
      id: "x",
      title: "t",
      status: "open",
      stage: "backlog",
      type: "task",
      ...meta,
      goal: "Ship the widget",
      acceptance: "- [ ] It renders",
      description: "## Goal\n\nShip the widget\n\n## Acceptance\n\n- [ ] It renders\n\n## Verify\n\nRun the tests",
    });
    expect(draft.goal).toBe("Ship the widget");
    expect(draft.acceptance).toBe("- [ ] It renders");
    expect(draft.body).toBe("## Verify\n\nRun the tests");
  });

  it("falls back to the acceptance field when the description has no ## Acceptance section", () => {
    const draft = draftFromDetail({
      id: "x",
      title: "t",
      status: "open",
      stage: "backlog",
      type: "task",
      ...meta,
      acceptance: "legacy field-only criteria",
      description: "## Goal\n\nDo it",
    });
    expect(draft.acceptance).toBe("legacy field-only criteria");
    expect(draft.body).toBe("");
  });
});

describe("stripContractSections", () => {
  it("removes the Goal and Acceptance blocks and trims the remainder", () => {
    const desc = "## Goal\n\ng\n\n## Acceptance\n\na\n\n## Out of scope\n\nnothing";
    expect(stripContractSections(desc)).toBe("## Out of scope\n\nnothing");
  });

  it("returns '' when the description is only Goal + Acceptance", () => {
    expect(stripContractSections("## Goal\n\ng\n\n## Acceptance\n\na")).toBe("");
  });
});

describe("diffTicketPatch", () => {
  it("returns an empty patch when nothing changed", () => {
    expect(diffTicketPatch(base, { ...base })).toEqual({});
  });

  it("sends only the one changed field", () => {
    expect(diffTicketPatch(base, { ...base, risk: "high" })).toEqual({ risk: "high" });
  });

  it("collects multiple changed fields", () => {
    const draft: TicketDraft = { ...base, title: "New title", status: "in_progress", size: "L" };
    expect(diffTicketPatch(base, draft)).toEqual({ title: "New title", status: "in_progress", size: "L" });
  });

  it("trims the title and ignores whitespace-only changes", () => {
    expect(diffTicketPatch(base, { ...base, title: "  Do the thing  " })).toEqual({});
    expect(diffTicketPatch(base, { ...base, title: "  Renamed  " })).toEqual({ title: "Renamed" });
  });

  it("never sends an empty title", () => {
    expect(diffTicketPatch(base, { ...base, title: "   " })).toEqual({});
  });

  it("sends a changed priority including 0, but not a cleared one", () => {
    expect(diffTicketPatch(base, { ...base, priority: 0 })).toEqual({ priority: 0 });
    expect(diffTicketPatch(base, { ...base, priority: undefined })).toEqual({});
  });

  it("sets a previously-absent label but never clears one to empty", () => {
    const bare = draftFromDetail({ id: "x", title: "t", status: "open", stage: "backlog", type: "task", ...meta });
    expect(diffTicketPatch(bare, { ...bare, agent: "docker" })).toEqual({ agent: "docker" });
    expect(diffTicketPatch(base, { ...base, agent: "" })).toEqual({});
  });
});

describe("hasTicketChanges", () => {
  it("is false when nothing changed and true otherwise", () => {
    expect(hasTicketChanges(base, { ...base })).toBe(false);
    expect(hasTicketChanges(base, { ...base, risk: "high" })).toBe(true);
    expect(hasTicketChanges(base, { ...base, goal: "New goal" })).toBe(true);
  });
});

describe("contract editing", () => {
  const contractDetail: TicketDetail = {
    id: "bd-1",
    title: "t",
    status: "open",
    stage: "backlog",
    type: "task",
    ...meta,
    goal: "Old goal",
    acceptance: "- [ ] old item",
    description: "## Goal\n\nOld goal\n\n## Acceptance\n\n- [ ] old item\n\n## Verify\n\ntests",
  };
  const original = draftFromDetail(contractDetail);

  it("emits both description and acceptance when the contract changes", () => {
    const patch = diffTicketPatch(original, { ...original, acceptance: "- [ ] new item" });
    expect(patch.acceptance).toBe("- [ ] new item");
    expect(patch.description).toContain("## Acceptance\n\n- [ ] new item");
  });

  it("does not touch the contract when only a label changes", () => {
    const patch = diffTicketPatch(original, { ...original, risk: "high" });
    expect(patch).toEqual({ risk: "high" });
  });

  it("round-trips an edited goal so parseGoal reads the new text", () => {
    const patch = diffTicketPatch(original, { ...original, goal: "Brand new goal" });
    expect(parseGoal(patch.description)).toBe("Brand new goal");
  });

  it("round-trips an edited acceptance so parseAcceptance (section-first) reads the new text", () => {
    const draft = { ...original, acceptance: "- [ ] A\n- [ ] B" };
    const patch = diffTicketPatch(original, draft);
    // parseAcceptance reads the ## Acceptance section of the description FIRST, so the board /
    // tickets checklist and the acceptance field agree — no drift between the two homes.
    const bead = asBead({ description: patch.description, acceptance: patch.acceptance });
    expect(parseAcceptance(bead)).toBe("- [ ] A\n- [ ] B");
    expect(patch.acceptance).toBe("- [ ] A\n- [ ] B");
  });

  it("promotes a legacy field-only acceptance into a ## Acceptance section on first edit", () => {
    const legacy = draftFromDetail({
      id: "x",
      title: "t",
      status: "open",
      stage: "backlog",
      type: "task",
      ...meta,
      acceptance: "field-only criteria",
      description: "## Goal\n\nDo it",
    });
    // Editing the goal (not the acceptance) still recomposes the whole description, so the
    // field-only acceptance is written into the section and both homes stay in sync.
    const patch = diffTicketPatch(legacy, { ...legacy, goal: "Do it better" });
    const bead = asBead({ description: patch.description, acceptance: legacy.acceptance });
    expect(parseAcceptance(bead)).toBe("field-only criteria");
    expect(patch.description).toContain("## Acceptance\n\nfield-only criteria");
  });

  it("composeDescription omits empty sections", () => {
    expect(composeDescription({ ...original, goal: "", acceptance: "", body: "just body" })).toBe(
      "just body",
    );
  });
});
