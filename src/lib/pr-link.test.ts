/**
 * Unit tests for the pure PR-link helpers: ref normalization and the write plan. No bd — these are
 * the decision functions the /epics/<id>/pr route relies on. Mirrors board-move.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "./beads/bd";
import { LABELS } from "./beads/bd";
import { normalizePrRef, planPrLink } from "./pr-link";

function makeBead(overrides: Partial<Bead> & { id: string }): Bead {
  return {
    title: "t",
    status: "open",
    labels: [],
    ...overrides,
  };
}

describe("normalizePrRef", () => {
  it("accepts a bare number", () => {
    expect(normalizePrRef("44")).toBe("gh-44");
  });

  it("accepts a #-prefixed number", () => {
    expect(normalizePrRef("#44")).toBe("gh-44");
  });

  it("accepts an already-normalized gh-<n> ref (case-insensitive)", () => {
    expect(normalizePrRef("gh-44")).toBe("gh-44");
    expect(normalizePrRef("GH-44")).toBe("gh-44");
  });

  it("preserves a full GitHub PR url verbatim (keeps the repo; downstream reads the number out)", () => {
    expect(normalizePrRef("https://github.com/owner/repo/pull/44")).toBe(
      "https://github.com/owner/repo/pull/44",
    );
    expect(normalizePrRef("https://github.com/owner/repo/pull/44/files")).toBe(
      "https://github.com/owner/repo/pull/44/files",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePrRef("  44  ")).toBe("gh-44");
  });

  it("rejects empty / non-numeric / unparseable input", () => {
    expect(normalizePrRef("")).toBeNull();
    expect(normalizePrRef("   ")).toBeNull();
    expect(normalizePrRef("abc")).toBeNull();
    expect(normalizePrRef("pr-44")).toBeNull();
    expect(normalizePrRef("https://example.com/foo")).toBeNull();
  });
});

describe("planPrLink", () => {
  const IN_REVIEW = LABELS.stage("in-review");
  const IMPLEMENTING = LABELS.stage("implementing");

  it("flips an open epic to in-review (tag in-review, untag implementing)", () => {
    const epic = makeBead({ id: "e-1", issue_type: "epic", labels: [IMPLEMENTING] });
    const plan = planPrLink(epic, "gh-44");
    expect(plan.ref).toBe("gh-44");
    expect(plan.stageOps).toEqual([
      { kind: "tag", labels: [IN_REVIEW] },
      { kind: "untag", labels: [IMPLEMENTING] },
    ]);
  });

  it("flips an open standalone task/bug (an epic-of-one) to in-review", () => {
    const task = makeBead({ id: "t-1", issue_type: "task" });
    expect(planPrLink(task, "gh-7").stageOps).toEqual([
      { kind: "tag", labels: [IN_REVIEW] },
      { kind: "untag", labels: [IMPLEMENTING] },
    ]);
  });

  it("does NOT flip a child ticket — it runs via its epic's PR (ref only)", () => {
    const child = makeBead({ id: "t-2", issue_type: "task", parent_id: "e-1" });
    expect(planPrLink(child, "gh-9").stageOps).toEqual([]);
  });

  it("does NOT flip a closed/merged run target back into review (ref only)", () => {
    const closed = makeBead({ id: "e-2", issue_type: "epic", status: "closed" });
    expect(planPrLink(closed, "gh-3").stageOps).toEqual([]);
  });

  it("does NOT flip a non-runnable parentless type (learning/chore/etc.)", () => {
    const learning = makeBead({ id: "l-1", issue_type: "learning" });
    expect(planPrLink(learning, "gh-1").stageOps).toEqual([]);
  });
});
