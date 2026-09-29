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

  it("excludes a target that is blocked with no prior delivery — a run can gate on it mid-run (PR #331 review)", async () => {
    // `blocked` carries the same premature-outcome risk as `in_progress`: a run can gate a target on
    // a dependency mid-run and leave it in this status while it is still live.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "blocked" })]);
    await seedInvocation({ id: "i1", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toEqual([]);
  });

  it("includes a target whose blocked status is a TERMINATED attempt, not live work (PR #331 review)", async () => {
    // `execute-epic.abandon-base.integration.test.ts` proves an agent-declared incomplete attempt
    // settles its run `status: "failed"` while leaving the ticket `status: "blocked"` forever — a
    // finished, failed outcome the bead's own status cannot distinguish from a target merely gated
    // on a dependency mid-run. Its spend must land in a cohort's numerators as the failed attempt it
    // is, not vanish the way a genuinely live target's does.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "blocked" })]);
    await seedInvocation({ id: "i1", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });
    await t.db.insert(schema.runs).values({
      id: "run-feat-1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      branch: "anton/feat-1",
      status: "failed",
      error: "self-reported blocked",
      startedAt: new Date("2026-09-25T00:00:00Z"),
      endedAt: new Date("2026-09-25T00:05:00Z"),
      updatedAt: new Date("2026-09-25T00:05:00Z"),
    });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toHaveLength(1);
    expect(features?.[0]?.beadId).toBe("feat-1");
    expect(features?.[0]?.delivered).toBe(false);
    expect(features?.[0]?.rows).toHaveLength(1);
  });

  it("keeps treating a blocked target as live when a fresh run is still open behind the failed one (PR #331 review)", async () => {
    // A retry can leave the OLD failed row behind while a new attempt is already running — the
    // still-open row must win, or a retry in progress would be misread as terminated.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "blocked" })]);
    await seedInvocation({ id: "i1", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });
    await t.db.insert(schema.runs).values([
      {
        id: "run-feat-1-old",
        projectId: t.projectId,
        epicBeadId: "feat-1",
        branch: "anton/feat-1",
        status: "failed",
        startedAt: new Date("2026-09-24T00:00:00Z"),
        endedAt: new Date("2026-09-24T00:05:00Z"),
        updatedAt: new Date("2026-09-24T00:05:00Z"),
      },
      {
        id: "run-feat-1-retry",
        projectId: t.projectId,
        epicBeadId: "feat-1",
        branch: "anton/feat-1",
        status: "running",
        startedAt: new Date("2026-09-25T00:00:00Z"),
        updatedAt: new Date("2026-09-25T00:00:00Z"),
      },
    ]);

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toEqual([]);
  });

  it("excludes a deferred target whose execute job is still open — defer doesn't cancel it (PR #331 review)", async () => {
    // `close-human.test.ts`'s "defer doesn't cancel it" case: an operator can defer a target AFTER
    // its execute job has already started, and `setTicketDeferred` only calls `beads.defer` — it
    // never touches the running job. Trusting the deferred status alone would admit the target with
    // an unbounded ledger and count its unfinished spend/friction as a failed numerator.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "deferred" })]);
    await seedInvocation({ id: "i1", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });
    await t.db.insert(schema.runs).values({
      id: "run-feat-1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      branch: "anton/feat-1",
      status: "running",
      startedAt: new Date("2026-09-25T00:00:00Z"),
      updatedAt: new Date("2026-09-25T00:00:00Z"),
    });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toEqual([]);
  });

  it("includes a deferred target whose only run evidence is a terminated attempt (PR #331 review)", async () => {
    // A deferred target with no open run behind it has nothing live to protect — its failed attempt's
    // spend and friction belong in a cohort's numerators like any other terminated run.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "deferred" })]);
    await seedInvocation({ id: "i1", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });
    await t.db.insert(schema.runs).values({
      id: "run-feat-1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      branch: "anton/feat-1",
      status: "failed",
      startedAt: new Date("2026-09-25T00:00:00Z"),
      endedAt: new Date("2026-09-25T00:05:00Z"),
      updatedAt: new Date("2026-09-25T00:05:00Z"),
    });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toHaveLength(1);
    expect(features?.[0]?.beadId).toBe("feat-1");
    expect(features?.[0]?.delivered).toBe(false);
  });

  it("keeps a target's prior delivery while it is reopened and reruns (PR #331 review)", async () => {
    // The target already delivered once; reopening it for another round leaves it `in_progress`
    // again, but the delivery that already happened is real evidence and must not disappear from
    // the cohort for as long as the rerun takes.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "in_progress" })]);
    await seedInvocation({ id: "i-old", beadId: "feat-1", recordedAt: new Date("2026-08-01T00:00:00Z") });
    await seedDelivery({ epicBeadId: "feat-1", endedAt: new Date("2026-08-01T00:10:00Z") });
    // The rerun's own invocation — not yet concluded, but still inside the window so the target
    // qualifies as a candidate at all.
    await seedInvocation({ id: "i-new", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toHaveLength(1);
    expect(features?.[0]?.beadId).toBe("feat-1");
    expect(features?.[0]?.delivered).toBe(true);
    expect(features?.[0]?.deliveredAtMs).toBe(new Date("2026-08-01T00:10:00Z").getTime());
    // The rerun has no outcome yet, so its OWN row (`i-new`) must not reach the preserved delivery's
    // figures — only `i-old`, the completed attempt the delivery actually covers, comes through
    // (PR #331 review).
    // `CohortFeature.rows` is typed to the stamp columns `promptSeries` reads (`CohortStampRow`), but
    // the rows underneath are always the scope's full `ClaudeInvocationRow`s — `id` included.
    expect((features?.[0]?.rows as unknown as { id: string }[]).map((r) => r.id)).toEqual(["i-old"]);
  });

  it("retains a settled failed rerun between delivery and the currently open attempt (PR #331 review, second round)", async () => {
    // Delivered once, then a rerun that ran to completion and FAILED, then a fresh rerun that is
    // still open now. Cutting at the delivery timestamp (the old behavior) would drop the failed
    // rerun's own rows too, even though that attempt is settled and belongs in the cohort's
    // numerators — only the CURRENTLY OPEN attempt's rows are still premature.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "in_progress" })]);
    await seedInvocation({ id: "i-old", beadId: "feat-1", recordedAt: new Date("2026-08-01T00:00:00Z") });
    await seedDelivery({ epicBeadId: "feat-1", endedAt: new Date("2026-08-01T00:10:00Z") });
    await seedInvocation({
      id: "i-failed-rerun",
      beadId: "feat-1",
      recordedAt: new Date("2026-08-15T00:02:00Z"),
    });
    await t.db.insert(schema.runs).values([
      {
        id: "run-feat-1-failed",
        projectId: t.projectId,
        epicBeadId: "feat-1",
        branch: "anton/feat-1",
        status: "failed",
        startedAt: new Date("2026-08-15T00:00:00Z"),
        endedAt: new Date("2026-08-15T00:05:00Z"),
        updatedAt: new Date("2026-08-15T00:05:00Z"),
      },
      {
        id: "run-feat-1-live",
        projectId: t.projectId,
        epicBeadId: "feat-1",
        branch: "anton/feat-1",
        status: "running",
        startedAt: new Date("2026-09-01T00:00:00Z"),
        updatedAt: new Date("2026-09-01T00:00:00Z"),
      },
    ]);
    // The still-open rerun's own invocation — inside the window so the target qualifies as a
    // candidate at all, but recorded after the live attempt started, so it must not come through.
    await seedInvocation({ id: "i-live-rerun", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features).toHaveLength(1);
    expect(features?.[0]?.delivered).toBe(true);
    expect(features?.[0]?.deliveredAtMs).toBe(new Date("2026-08-01T00:10:00Z").getTime());
    expect((features?.[0]?.rows as unknown as { id: string }[]).map((r) => r.id)).toEqual([
      "i-old",
      "i-failed-rerun",
    ]);
  });

  it("does not let the unfinished rerun's own stamp span a preserved delivery's skill cohort (PR #331 review)", async () => {
    // The completed attempt ran under one prompt digest; the still-live rerun already recorded a
    // DIFFERENT one before finishing. Folding the rerun's row in would make `featureKeys` see two
    // distinct prompts and throw this already-delivered feature into `spanning` before the rerun even
    // has an outcome.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "in_progress" })]);
    await seedInvocation({
      id: "i-old",
      beadId: "feat-1",
      recordedAt: new Date("2026-08-01T00:00:00Z"),
      promptDigest: "old-prompt",
    });
    await seedDelivery({ epicBeadId: "feat-1", endedAt: new Date("2026-08-01T00:10:00Z") });
    await seedInvocation({
      id: "i-new",
      beadId: "feat-1",
      recordedAt: new Date("2026-09-25T00:00:00Z"),
      promptDigest: "new-prompt",
    });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features?.[0]?.rows.map((r) => r.promptDigest)).toEqual(["old-prompt"]);
  });

  it("does not let the unfinished rerun's own cancel inflate a preserved delivery's human touches (PR #331 review)", async () => {
    // Cutting the ROWS at the prior delivery is not enough on its own: `cohortFeatureOf` also reads
    // the target's friction, and an operator can cancel the rerun's own job before it has an outcome.
    // That cancel belongs to the unfinished rerun, not to the delivery it must not reach.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature", status: "in_progress" })]);
    await seedInvocation({ id: "i-old", beadId: "feat-1", recordedAt: new Date("2026-08-01T00:00:00Z") });
    await seedDelivery({ epicBeadId: "feat-1", endedAt: new Date("2026-08-01T00:10:00Z") });
    await seedInvocation({ id: "i-new", beadId: "feat-1", recordedAt: new Date("2026-09-25T00:00:00Z") });
    await t.db.insert(schema.jobs).values({
      id: "j-new",
      type: "execute-epic",
      projectId: t.projectId,
      payloadJson: JSON.stringify({ projectId: t.projectId, epicBeadId: "feat-1" }),
      status: "cancelled",
      createdAt: new Date("2026-09-25T00:05:00Z"),
    });

    const features = await cohortFeatures(t.db, t.projectId, {
      since: new Date("2026-09-20T00:00:00Z"),
    });

    expect(features?.[0]?.deliveredAtMs).toBe(new Date("2026-08-01T00:10:00Z").getTime());
    expect(features?.[0]?.humanTouches).toBe(0);
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
