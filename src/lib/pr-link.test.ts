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
    expect(normalizePrRef("44")).toEqual({ ok: true, ref: "gh-44" });
  });

  it("accepts a #-prefixed number", () => {
    expect(normalizePrRef("#44")).toEqual({ ok: true, ref: "gh-44" });
  });

  it("accepts an already-normalized gh-<n> ref (case-insensitive)", () => {
    expect(normalizePrRef("gh-44")).toEqual({ ok: true, ref: "gh-44" });
    expect(normalizePrRef("GH-44")).toEqual({ ok: true, ref: "gh-44" });
  });

  it("collapses a same-repo PR url to gh-<n> when origin matches", () => {
    expect(normalizePrRef("https://github.com/owner/repo/pull/44", "owner/repo")).toEqual({
      ok: true,
      ref: "gh-44",
    });
    // trailing path segments (…/files) and host/owner casing tolerated
    expect(normalizePrRef("https://github.com/Owner/Repo/pull/44/files", "owner/repo")).toEqual({
      ok: true,
      ref: "gh-44",
    });
  });

  it("REJECTS an off-repo PR url (would mis-target review-fix's sweep in this repo)", () => {
    const r = normalizePrRef("https://github.com/other/project/pull/44", "owner/repo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/other\/project/);
  });

  it("keeps a full url verbatim when origin can't be resolved (no web base to validate against)", () => {
    expect(normalizePrRef("https://github.com/owner/repo/pull/44", undefined)).toEqual({
      ok: true,
      ref: "https://github.com/owner/repo/pull/44",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePrRef("  44  ")).toEqual({ ok: true, ref: "gh-44" });
  });

  it("rejects empty / non-numeric / unparseable input", () => {
    for (const bad of ["", "   ", "abc", "pr-44", "https://example.com/foo"]) {
      expect(normalizePrRef(bad).ok).toBe(false);
    }
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
