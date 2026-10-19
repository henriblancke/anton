/**
 * `projectDigest` (anton-rokar): the digest page's one read, proving it reports the empty-window
 * state only when nothing happened AND nothing needs the operator, and that a changed feature's
 * card is built off the SAME bd board snapshot `operatorQueue`/`openProposals` judge.
 *
 * Mirrors `feature-cards-read.test.ts`'s own wiring-level approach: the pure folds underneath
 * (`digestNeedsYou`, `foldTimeline`, `groupFeatureCards`) are exhaustively covered elsewhere, so
 * this file only proves the composition — the right board, the right window, the right escape
 * hatches for an empty window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beads, type Bead } from "../beads/bd";
import { resetIssueSnapshots } from "../beads/snapshot";
import * as schema from "../db/schema";
import type { EscalationView } from "../escalations";
import { makeProjectDb, type TestProjectDb } from "../testing/project";
import type { Project } from "../types";
import { projectDigest, projectDigestSummary } from "./digest-read";

vi.mock("../git/remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/remote")>();
  return { ...actual, githubBaseUrl: vi.fn(async () => undefined) };
});

let escalations: EscalationView[] = [];
vi.mock("../escalations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../escalations")>();
  return { ...actual, openEscalations: vi.fn(async () => escalations) };
});
vi.mock("../autopilot-state", () => ({ currentBreaker: vi.fn(async () => undefined) }));

let board: Bead[] = [];
vi.mock("../beads/issues", () => ({
  refreshAllIssues: vi.fn(async () => board),
  // `projectDigestSummary` reads the cached snapshot (PR #350 review), not `refreshAllIssues` —
  // same underlying board either way, so the test fixtures stay a single `board` variable.
  readAllIssues: vi.fn(async () => ({ beads: board, version: 1, generation: 0 })),
}));

const bead = (over: Partial<Bead> & { id: string }): Bead =>
  ({ title: over.id, status: "open", issue_type: "feature", labels: [], ...over }) as Bead;

function escalation(over: Partial<EscalationView> & { id: string }): EscalationView {
  return {
    findingKey: `k-${over.id}`,
    kind: "needs-human",
    reason: "asked",
    ageMs: 0,
    status: "open",
    noted: true,
    raisedAt: 0,
    ...over,
  };
}

let t: TestProjectDb;
let project: Project;

beforeEach(() => {
  resetIssueSnapshots();
  t = makeProjectDb({ repoPath: "/repo", slug: "acme", name: "acme" });
  project = {
    id: t.projectId,
    slug: "acme",
    name: "acme",
    repoPath: "/repo",
    defaultBranch: "main",
    hasBeads: true,
    createdAt: 0,
  };
  board = [];
  escalations = [];
  vi.spyOn(beads, "list").mockImplementation(async () => [...board]);
  vi.spyOn(beads, "showWithComments").mockImplementation(async (_cwd, id) => ({
    ...bead({ id }),
    comments: [],
  }));
});

afterEach(() => vi.restoreAllMocks());

describe("projectDigest", () => {
  it("reports an empty window when nothing happened and the viewer has never looked", async () => {
    const digest = await projectDigest(t.db, project);

    expect(digest.since).toBeNull();
    expect(digest.isEmpty).toBe(true);
    expect(digest.headline).toBe("No new activity");
    expect(digest.needsYou.total).toBe(0);
    expect(digest.groups).toEqual([]);
  });

  it("is not empty when an open ask needs the operator, even with no feature events", async () => {
    escalations = [escalation({ id: "esc-1" })];

    const digest = await projectDigest(t.db, project);

    expect(digest.isEmpty).toBe(false);
    expect(digest.needsYou.total).toBe(1);
    expect(digest.groups).toEqual([]);
  });

  it("groups a changed feature's events off the same board the needs-you queue reads", async () => {
    board = [bead({ id: "feat-1" })];
    await t.db.insert(schema.runs).values({
      id: "run-1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      ticketBeadId: "feat-1",
      status: "implementing",
      // A few seconds in the past, not `now`: `until` is minted AFTER this insert, and the window's
      // upper bound is exclusive (timeline-sources.ts) — a `startedAt` landing in the same second
      // as `until` would be dropped by the boundary this test does not mean to exercise.
      startedAt: new Date(Date.now() - 5000),
    });

    const digest = await projectDigest(t.db, project);

    expect(digest.isEmpty).toBe(false);
    expect(digest.groups.flatMap((g) => g.cards).map((c) => c.id)).toContain("feat-1");
    expect(digest.headline).toMatch(/run started/);
    // The board banner's "N things since you looked" (anton-16s0t) names this same count.
    expect(digest.activityCount).toBe(1);
  });

  it("starts the window at the viewer's own watermark, not at zero", async () => {
    await t.db
      .insert(schema.viewerMarks)
      .values({ viewerId: "default", projectId: t.projectId, seenAt: new Date(5000 * 1000) });

    const digest = await projectDigest(t.db, project);

    expect(digest.since).toBe(5000);
  });
});

describe("projectDigestSummary", () => {
  it("reports the same needsYou and activityCount the full digest would, without feature groups", async () => {
    board = [bead({ id: "feat-1" })];
    escalations = [escalation({ id: "esc-1" })];
    await t.db.insert(schema.runs).values({
      id: "run-1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      ticketBeadId: "feat-1",
      status: "implementing",
      startedAt: new Date(Date.now() - 5000),
    });

    const [summary, digest] = await Promise.all([
      projectDigestSummary(t.db, project),
      projectDigest(t.db, project),
    ]);

    expect(summary.needsYou.total).toBe(digest.needsYou.total);
    expect(summary.activityCount).toBe(digest.activityCount);
    expect(summary.activityCount).toBe(1);
    expect(summary.needsYou.total).toBe(1);
  });

  it("reports zero/zero for a quiet project", async () => {
    const summary = await projectDigestSummary(t.db, project);

    expect(summary.needsYou.total).toBe(0);
    expect(summary.activityCount).toBe(0);
  });
});
