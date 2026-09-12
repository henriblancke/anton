/**
 * Unit tests for the pure PR-link helpers: ref normalization and the write plan. No bd — these are
 * the decision functions the /epics/<id>/pr route relies on. Mirrors board-move.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type { Bead } from "./beads/bd";
import type { Project } from "./types";

const setPrRefMock = vi.fn(async () => "");
const tagMock = vi.fn(async () => "");
const untagMock = vi.fn(async () => "");

vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: { ...actual.beads, setPrRef: setPrRefMock, tag: tagMock, untag: untagMock },
  };
});
vi.mock("./beads/sync-nudge", () => ({ nudgeSync: () => {} }));

const { LABELS } = await import("./beads/bd");
const { withBeadWriteLock } = await import("./beads/claim-lock");
const { linkPr, normalizePrRef, planPrLink } = await import("./pr-link");

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
    expect(
      normalizePrRef("https://github.com/owner/repo/pull/44", "https://github.com/owner/repo"),
    ).toEqual({ ok: true, ref: "gh-44" });
    // trailing path segments (…/files), host/owner casing, and a trailing base slash tolerated
    expect(
      normalizePrRef("https://github.com/Owner/Repo/pull/44/files", "https://github.com/owner/repo/"),
    ).toEqual({ ok: true, ref: "gh-44" });
  });

  it("REJECTS an off-repo PR url (would mis-target review-fix's sweep in this repo)", () => {
    const r = normalizePrRef(
      "https://github.com/other/project/pull/44",
      "https://github.com/owner/repo",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/other\/project/);
  });

  it("REJECTS a same-slug PR url on a DIFFERENT host (GHE/mirror — gh in this repo can't reach it)", () => {
    const r = normalizePrRef(
      "https://ghe.corp.example/owner/repo/pull/44",
      "https://github.com/owner/repo",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ghe\.corp\.example/);
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

  const IN_REVIEW_OPS = [
    { kind: "tag", labels: [IN_REVIEW] },
    { kind: "untag", labels: [IMPLEMENTING] },
  ];

  it("flips an open epic to in-review (tag in-review, untag implementing)", () => {
    const epic = makeBead({ id: "e-1", issue_type: "epic", labels: [IMPLEMENTING] });
    const plan = planPrLink(epic, "gh-44", [epic]);
    expect(plan.ref).toBe("gh-44");
    expect(plan.stageOps).toEqual(IN_REVIEW_OPS);
  });

  it("flips an open standalone task/bug (an epic-of-one) to in-review", () => {
    const task = makeBead({ id: "t-1", issue_type: "task" });
    expect(planPrLink(task, "gh-7", [task]).stageOps).toEqual(IN_REVIEW_OPS);
  });

  it("flips a feature — the tier that owns the worktree and the PR", () => {
    const epic = makeBead({ id: "e-1", issue_type: "epic" });
    const feature = makeBead({ id: "f-1", issue_type: "feature", parent_id: "e-1" });
    expect(planPrLink(feature, "gh-8", [epic, feature]).stageOps).toEqual(IN_REVIEW_OPS);
  });

  it("does NOT flip a container epic — its features each carry their own PR (ref only)", () => {
    // Without the board the container reads as a plain epic and would be swept by review-fix,
    // whose merge finalization then closes its feature children (anton-9pkk review).
    const epic = makeBead({ id: "e-1", issue_type: "epic" });
    const feature = makeBead({ id: "f-1", issue_type: "feature", parent_id: "e-1" });
    expect(planPrLink(epic, "gh-5", [epic, feature]).stageOps).toEqual([]);
  });

  it("does NOT flip a child ticket — it runs via its epic's PR (ref only)", () => {
    const child = makeBead({ id: "t-2", issue_type: "task", parent_id: "e-1" });
    expect(planPrLink(child, "gh-9", [child]).stageOps).toEqual([]);
  });

  it("does NOT flip a closed/merged run target back into review (ref only)", () => {
    const closed = makeBead({ id: "e-2", issue_type: "epic", status: "closed" });
    expect(planPrLink(closed, "gh-3", [closed]).stageOps).toEqual([]);
  });

  it("does NOT flip a non-runnable parentless type (learning/chore/etc.)", () => {
    const learning = makeBead({ id: "l-1", issue_type: "learning" });
    expect(planPrLink(learning, "gh-1", [learning]).stageOps).toEqual([]);
  });
});

// The `already-shipped` retirement verifies a survivor through its PR pointer and re-reads it under
// the bead's write lock before it writes (gardener/repair-already-shipped.ts). A link written
// outside that lock could swap a verified merged PR for an unmerged one in the window; under it,
// the swap either precedes the reread — and is refused — or waits behind the supersede.
describe("linkPr", () => {
  it("writes the ref and stage ops under the target's bead write lock", async () => {
    const project = { repoPath: "/tmp/anton-pr-link" } as Project;
    const target = makeBead({ id: "anton-1", issue_type: "epic", labels: [LABELS.stage("implementing")] });
    let releasedAt = 0;
    const holding = withBeadWriteLock(project.repoPath, target.id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      releasedAt = Date.now();
    });
    let wroteAt = 0;
    setPrRefMock.mockImplementationOnce(async () => {
      wroteAt = Date.now();
      return "";
    });

    await linkPr(project, target, "gh-44", [target]);
    await holding;

    expect(wroteAt).toBeGreaterThanOrEqual(releasedAt);
    expect(setPrRefMock).toHaveBeenCalledWith(project.repoPath, target.id, "gh-44");
    expect(tagMock).toHaveBeenCalledWith(project.repoPath, target.id, [LABELS.stage("in-review")]);
    expect(untagMock).toHaveBeenCalledWith(project.repoPath, target.id, [LABELS.stage("implementing")]);
  });
});
