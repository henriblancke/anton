/**
 * `cohortFeatures` (anton-lplyz) — the wiring that turns a real board and real `claude_invocations`
 * rows into the `CohortFeature[]` `promptSeries` folds. The pure fold has its own exhaustive tests;
 * this file proves the wiring: which run targets the window picks up, that each one's figures are
 * its WHOLE life rather than a slice of the window, and that delivery is read off `listDeliveriesByBead`
 * rather than guessed from invocation timestamps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads, type Bead } from "./beads/bd";
import { cohortFeatures } from "./cohort-read";
import * as schema from "./db/schema";
import { resetIssueSnapshots } from "./beads/snapshot";
import { makeProjectDb, type TestProjectDb } from "./testing/project";

const bead = (over: Partial<Bead> & { id: string }): Bead =>
  ({ title: over.id, status: "open", issue_type: "task", labels: [], ...over }) as Bead;

const BOARD: Bead[] = [
  bead({ id: "feat-1", issue_type: "feature" }),
  bead({ id: "task-1", parent: "feat-1" }),
];

function fakeBoard(board: Bead[]) {
  return vi.spyOn(beads, "list").mockImplementation(async () => [...board]);
}

/** Every case reaches the review thread; default to an empty one so none throws on the bd spawn. */
function fakeThread() {
  return vi
    .spyOn(beads, "showWithComments")
    .mockImplementation(async (_cwd, id) => ({ ...bead({ id }), comments: [] }));
}

let t: TestProjectDb;

beforeEach(() => {
  resetIssueSnapshots();
  t = makeProjectDb({ repoPath: "/repo" });
  fakeThread();
});
afterEach(() => vi.restoreAllMocks());

async function seedInvocation(row: {
  id: string;
  beadId: string;
  recordedAt: Date;
  durationMs?: number;
  promptDigest?: string;
  agentTag?: string;
}): Promise<void> {
  await t.db.insert(schema.claudeInvocations).values({
    id: row.id,
    projectId: t.projectId,
    jobType: "execute-epic",
    step: "implement",
    stepHandler: "implement",
    runId: "r1",
    beadId: row.beadId,
    modelRequested: "claude-opus-5",
    modelReported: "claude-opus-5",
    inputTokens: 1000,
    outputTokens: 1000,
    outcome: "ok",
    recordedAt: row.recordedAt,
    durationMs: row.durationMs ?? 60_000,
    promptDigest: row.promptDigest ?? null,
    agentTag: row.agentTag ?? null,
  });
}

async function seedDelivery(row: { epicBeadId: string; endedAt: Date }): Promise<void> {
  await t.db.insert(schema.runs).values({
    id: `run-${row.epicBeadId}`,
    projectId: t.projectId,
    epicBeadId: row.epicBeadId,
    branch: `anton/${row.epicBeadId}`,
    status: "done",
    startedAt: row.endedAt,
    endedAt: row.endedAt,
    updatedAt: row.endedAt,
  });
}

describe("cohortFeatures", () => {
  it("is undefined for a project id this anton.db does not carry", async () => {
    fakeBoard(BOARD);
    expect(await cohortFeatures(t.db, "no-such-project")).toBeUndefined();
  });

  it("folds a run target's WHOLE life, not just the invocations inside the window", async () => {
    fakeBoard(BOARD);
    // One old invocation, outside a 7-day window, and one recent one that pulls the feature in.
    await seedInvocation({
      id: "i-old",
      beadId: "feat-1",
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      durationMs: 10 * 60_000,
      promptDigest: "a3f1c2",
    });
    await seedInvocation({
      id: "i-new",
      beadId: "feat-1",
      recordedAt: new Date("2026-09-25T00:00:00Z"),
      durationMs: 5 * 60_000,
      promptDigest: "a3f1c2",
    });
    await seedDelivery({ epicBeadId: "feat-1", endedAt: new Date("2026-09-25T00:10:00Z") });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toHaveLength(1);
    const feature = features?.[0];
    expect(feature?.beadId).toBe("feat-1");
    expect(feature?.delivered).toBe(true);
    // Both invocations' rows are in the fold, not only the one inside the window.
    expect(feature?.rows).toHaveLength(2);
    expect(feature?.rows.map((r) => r.promptDigest)).toEqual(["a3f1c2", "a3f1c2"]);
  });

  it("excludes a run target with no activity in the window", async () => {
    fakeBoard([...BOARD, bead({ id: "feat-2", issue_type: "feature" })]);
    await seedInvocation({
      id: "i1",
      beadId: "feat-2",
      recordedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toEqual([]);
  });

  it("reports delivered: false and no deliveredAtMs for a feature that has not shipped", async () => {
    fakeBoard(BOARD);
    await seedInvocation({ id: "i1", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features?.[0]?.delivered).toBe(false);
    expect(features?.[0]?.deliveredAtMs).toBeUndefined();
  });

  it("rolls a working-layer child's invocations into its feature's cohort", async () => {
    fakeBoard(BOARD);
    await seedInvocation({
      id: "i1",
      beadId: "task-1",
      recordedAt: new Date("2026-09-25T00:00:00Z"),
      agentTag: "agent:nextjs",
    });
    await seedDelivery({ epicBeadId: "feat-1", endedAt: new Date("2026-09-25T00:10:00Z") });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toHaveLength(1);
    expect(features?.[0]?.beadId).toBe("feat-1");
    expect(features?.[0]?.rows[0]?.agentTag).toBe("agent:nextjs");
  });

  it("excludes a target still in_progress — its outcome is not known yet", async () => {
    // A live run has no delivery yet, so folding it in now would count its partial spend and friction
    // against an outcome (delivered, gave-up, abandoned) that has not happened.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "in_progress" })]);
    await seedInvocation({ id: "i1", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toEqual([]);
  });

  it("resolves every run target under bounded concurrency, none dropped", async () => {
    // cohortFeatureOf shells out to `bd` per target (reviewRoundsOf), so an all-time read with many
    // targets must not fire every call at once — this proves the bounded pool still returns all of
    // them rather than silently truncating.
    const board = Array.from({ length: 12 }, (_, i) =>
      bead({ id: `feat-${i}`, issue_type: "feature" }),
    );
    fakeBoard(board);
    for (const b of board) {
      await seedInvocation({ id: `i-${b.id}`, beadId: b.id, recordedAt: new Date("2026-09-25T00:00:00Z") });
    }

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features?.map((f) => f.beadId).sort()).toEqual(board.map((b) => b.id).sort());
  });

  it("never surfaces a bead that is not a run target on its own", async () => {
    // A parented ticket's own id is never a cohort's key — only the feature it rolls up into is.
    fakeBoard(BOARD);
    await seedInvocation({ id: "i1", beadId: "task-1", recordedAt: new Date("2026-09-25T00:00:00Z") });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features?.map((f) => f.beadId)).toEqual(["feat-1"]);
  });
});
