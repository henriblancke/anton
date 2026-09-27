/**
 * `featureLedger` (anton-8zckg) — the wiring that resolves a real board, pulls real rows, and folds
 * them into the answer the pure halves compute. The pure fold and scope resolution each have their
 * own exhaustive tests; this file's job is only to prove the wiring itself: the right beads get
 * queried, the right rows come back, and an unresolvable project is told apart from a resolved scope
 * that recorded nothing.
 *
 * The friction half (anton-sdz00) is tested the same way. Every counter is proved in isolation by
 * `feature-ledger.friction.test.ts`; what is proved here is that each one is fed from the source
 * that actually holds it, over a scope that spent money AND took interventions — a field wired to
 * the wrong table reads zero, which is indistinguishable from a quiet feature until a fixture makes
 * it move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewScoreEntry } from "./jobs/review-score";
import { beads, type Bead } from "./beads/bd";
import { formatHumanNote } from "./beads/notes";
import { resetIssueSnapshots } from "./beads/snapshot";
import * as schema from "./db/schema";
import { featureLedger } from "./feature-ledger-read";
import { formatReviewScoreComment } from "./jobs/review-score";
import { originNoteBody } from "./rework-notes";
import { makeProjectDb, type TestProjectDb } from "./testing/project";

const bead = (over: Partial<Bead> & { id: string }): Bead =>
  ({ title: over.id, status: "open", issue_type: "task", labels: [], ...over }) as Bead;

/** feat-1 (a feature) with one working-layer child, task-1 — the scope `ledgerScope` should resolve. */
const BOARD: Bead[] = [
  bead({ id: "feat-1", issue_type: "feature" }),
  bead({ id: "task-1", parent: "feat-1" }),
];

function fakeBoard(board: Bead[]) {
  return vi.spyOn(beads, "list").mockImplementation(async () => [...board]);
}

/**
 * The run target's hydrated comment thread — the one friction source that is not a table. Defaults
 * to an empty thread so every existing case reads as "never reviewed" rather than throwing on the
 * unmocked bd spawn.
 */
function fakeThread(rounds: ReviewScoreEntry[] = []) {
  return vi.spyOn(beads, "showWithComments").mockImplementation(async (_cwd, id) => ({
    ...bead({ id }),
    comments: rounds.map((entry) => ({ text: formatReviewScoreComment(entry) })),
  }));
}

let t: TestProjectDb;

beforeEach(() => {
  resetIssueSnapshots();
  t = makeProjectDb({ repoPath: "/repo" });
  // Every case reaches the review thread, so the bd spawn is stubbed by default; a case that cares
  // about the rounds re-stubs it with its own.
  fakeThread();
});
afterEach(() => vi.restoreAllMocks());

async function seedInvocation(row: {
  id: string;
  beadId: string;
  recordedAt: Date;
  durationMs: number;
  modelReported?: string;
  jobType?: string;
  step?: string | null;
  stepHandler?: string | null;
}): Promise<void> {
  await t.db.insert(schema.claudeInvocations).values({
    id: row.id,
    projectId: t.projectId,
    jobType: row.jobType ?? "execute-epic",
    step: row.step === undefined ? "implement" : row.step,
    stepHandler: row.stepHandler === undefined ? "implement" : row.stepHandler,
    runId: "r1",
    beadId: row.beadId,
    modelRequested: "claude-opus-5",
    modelReported: row.modelReported ?? "claude-opus-5",
    inputTokens: 1000,
    outputTokens: 1000,
    outcome: "ok",
    recordedAt: row.recordedAt,
    durationMs: row.durationMs,
  });
}

describe("featureLedger", () => {
  it("resolves the board, folds the scope's rows, and reports the last delivery as the lead", async () => {
    fakeBoard(BOARD);
    await seedInvocation({
      id: "i1",
      beadId: "feat-1",
      recordedAt: new Date("2026-09-20T09:10:00Z"),
      durationMs: 10 * 60_000,
    });
    // A row on the CHILD is part of the same feature's cost — the scope walks it in.
    await seedInvocation({
      id: "i2",
      beadId: "task-1",
      recordedAt: new Date("2026-09-20T09:30:00Z"),
      durationMs: 5 * 60_000,
    });
    const deliveredAt = new Date("2026-09-20T10:00:00Z");
    await t.db.insert(schema.runs).values({
      id: "r1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      branch: "anton/feat-1",
      status: "done",
      startedAt: new Date("2026-09-20T09:00:00Z"),
      endedAt: deliveredAt,
      updatedAt: deliveredAt,
    });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.scope.ids).toEqual(["feat-1", "task-1"]);
    expect(ledger?.totals.recorded).toBe(true);
    // Two opus invocations, one per bead in the scope.
    expect(ledger?.totals.totals.runs).toBe(2);
    expect(ledger?.totals.phases.get("implement")?.runs).toBe(2);
    expect(ledger?.timing.activeMs).toBe(15 * 60_000);
    expect(ledger?.timing.leadMs).toBe(deliveredAt.getTime() - Date.parse("2026-09-20T09:00:00Z"));
  });

  it("is undefined for a project id this anton.db does not carry", async () => {
    fakeBoard(BOARD);
    expect(await featureLedger(t.db, "no-such-project", "feat-1")).toBeUndefined();
  });

  it("resolves a scope that recorded nothing as `recorded: false`, not as an absent ledger", async () => {
    fakeBoard(BOARD);
    const ledger = await featureLedger(t.db, t.projectId, "feat-1");
    expect(ledger?.scope.ids).toEqual(["feat-1", "task-1"]);
    expect(ledger?.totals.recorded).toBe(false);
    expect(ledger?.timing.invocations).toBe(0);
  });

  it("does not treat a child's local commit as delivery when the run never pushed", async () => {
    // A ticket session can settle `done` on its own commit even though the outer run then parks or
    // fails before ever pushing the branch — that commit is not a feature delivery, and must not
    // hand the feature a `leadMs` (PR #320 review).
    fakeBoard(BOARD);
    await seedInvocation({
      id: "i1",
      beadId: "task-1",
      recordedAt: new Date("2026-09-20T09:10:00Z"),
      durationMs: 5 * 60_000,
    });
    await t.db.insert(schema.sessions).values({
      id: "s1",
      projectId: t.projectId,
      kind: "execute",
      beadId: "task-1",
      status: "done",
      endedAt: new Date("2026-09-20T09:30:00Z"),
    });
    await t.db.insert(schema.runs).values({
      id: "r1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      branch: "anton/feat-1",
      status: "parked",
      startedAt: new Date("2026-09-20T09:00:00Z"),
      updatedAt: new Date("2026-09-20T09:30:00Z"),
    });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.timing.leadMs).toBeUndefined();
  });

  it("leaves a sibling feature's rows out of the scope", async () => {
    fakeBoard([...BOARD, bead({ id: "feat-2", issue_type: "feature" })]);
    await seedInvocation({
      id: "i1",
      beadId: "feat-2",
      recordedAt: new Date("2026-09-20T09:10:00Z"),
      durationMs: 10 * 60_000,
    });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.totals.recorded).toBe(false);
  });

  it("keeps a scheduled pass's duration out of the feature's own timing (PR #329 review)", async () => {
    // `ledgerTotals` already reports overhead outside the feature's bill (design §D4); the timing
    // half must agree, or the Unallocated section's claim that this time is excluded is a lie.
    fakeBoard(BOARD);
    await seedInvocation({
      id: "i1",
      beadId: "feat-1",
      recordedAt: new Date("2026-09-20T09:10:00Z"),
      durationMs: 10 * 60_000,
    });
    await seedInvocation({
      id: "i2",
      beadId: "feat-1",
      recordedAt: new Date("2026-09-20T09:20:00Z"),
      durationMs: 5 * 60_000,
      jobType: "gardener",
      step: null,
      stepHandler: null,
    });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.totals.overhead?.activeMs).toBe(5 * 60_000);
    // Only the implement invocation's own 10 minutes — the gardener pass's 5 minutes never reach it.
    expect(ledger?.timing.activeMs).toBe(10 * 60_000);
    expect(ledger?.timing.invocations).toBe(1);
  });
});

describe("featureLedger's friction half", () => {
  /** A job of `type` for `epicBeadId`, in the status the counter reads it at. */
  async function seedJob(row: {
    id: string;
    type: string;
    epicBeadId: string;
    status: string;
    lastError?: string;
    quotaParkCount?: number;
    failureParkCount?: number;
    createdAt?: Date;
    updatedAt?: Date;
  }): Promise<void> {
    await t.db.insert(schema.jobs).values({
      id: row.id,
      type: row.type,
      projectId: t.projectId,
      payloadJson: JSON.stringify({ projectId: t.projectId, epicBeadId: row.epicBeadId }),
      status: row.status,
      ...(row.lastError ? { lastError: row.lastError } : {}),
      ...(row.quotaParkCount ? { quotaParkCount: row.quotaParkCount } : {}),
      ...(row.failureParkCount ? { failureParkCount: row.failureParkCount } : {}),
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    });
  }

  async function seedEscalation(row: {
    id: string;
    kind: string;
    beadId?: string;
    epicBeadId?: string;
    status?: string;
    raisedAt?: Date;
  }): Promise<void> {
    await t.db.insert(schema.escalations).values({
      id: row.id,
      projectId: t.projectId,
      findingKey: `${row.kind}:${row.id}`,
      kind: row.kind,
      reason: "stalled",
      ...(row.beadId ? { beadId: row.beadId } : {}),
      ...(row.epicBeadId ? { epicBeadId: row.epicBeadId } : {}),
      status: row.status ?? "open",
      ...(row.raisedAt ? { raisedAt: row.raisedAt } : {}),
    });
  }

  it("returns friction beside the phases, totals and timing, each counter from its own source", async () => {
    // One feature that both SPENT and took interventions — the composed answer a surface reads.
    fakeBoard([
      BOARD[0]!,
      bead({
        id: "task-1",
        parent: "feat-1",
        notes: formatHumanNote(
          originNoteBody("anton-followup"),
          "Henri Blancke",
          new Date("2026-09-20T11:00:00Z"),
        ),
      }),
    ]);
    fakeThread([
      { round: 1, blocking: 2, advisory: 0, verdict: "fixed" },
      { round: 2, blocking: 0, advisory: 0, verdict: "clean" },
    ]);
    await seedInvocation({
      id: "i1",
      beadId: "feat-1",
      recordedAt: new Date("2026-09-20T09:10:00Z"),
      durationMs: 10 * 60_000,
    });
    await seedJob({ id: "j1", type: "review-fix-pr", epicBeadId: "feat-1", status: "done" });
    await seedJob({ id: "j2", type: "execute-epic", epicBeadId: "feat-1", status: "cancelled" });
    await seedJob({
      id: "j3",
      type: "execute-epic",
      epicBeadId: "feat-1",
      status: "queued",
      lastError: "usage-limit: resumes at 2026-09-21T02:00:00Z",
      quotaParkCount: 1,
    });
    // A gate raised on the TICKET and a park raised on the TARGET — both are this feature's.
    await seedEscalation({ id: "e1", kind: "needs-human", beadId: "task-1" });
    await seedEscalation({ id: "e2", kind: "parked-run", epicBeadId: "feat-1" });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    // The spend half still answers, from the same resolved scope.
    expect(ledger?.totals.recorded).toBe(true);
    expect(ledger?.timing.activeMs).toBe(10 * 60_000);
    expect(ledger?.friction).toEqual({
      reviewRounds: 2,
      prFixRounds: 1,
      escalations: 2,
      humanGates: 1,
      nonGateEscalations: 1,
      sendBacks: 1,
      cancels: 1,
      quotaParks: 1,
      failureParks: 0,
      // The gate, the non-gate escalation, the send-back and the cancel. The quota park and anton's
      // own review and PR-fix rounds are reported beside the sum, never inside it.
      humanTouches: 4,
    });
  });

  it("reports zero friction for a feature that recorded spend and nothing else", async () => {
    fakeBoard(BOARD);
    await seedInvocation({
      id: "i1",
      beadId: "feat-1",
      recordedAt: new Date("2026-09-20T09:10:00Z"),
      durationMs: 5 * 60_000,
    });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.totals.recorded).toBe(true);
    expect(ledger?.friction.humanTouches).toBe(0);
    expect(ledger?.friction.reviewRounds).toBe(0);
  });

  it("reports zero human touches for a feature parked on quota twice and never touched", async () => {
    // Two usage-limit parks, nothing else in the scope — proves the count through the real
    // `jobsForBeads` json_extract query rather than the pure fold, which a status-filter regression
    // in that SQL (e.g. excluding queued rows) would not otherwise catch.
    fakeBoard(BOARD);
    // Different job types — `jobs_active_epic_unique` allows only one active (queued|running) job
    // per (type, project, epicBeadId), so two quota parks on the same epic need distinct types.
    await seedJob({
      id: "j1",
      type: "execute-epic",
      epicBeadId: "feat-1",
      status: "queued",
      lastError: "usage-limit: resumes at 2026-09-21T02:00:00Z",
      quotaParkCount: 1,
    });
    await seedJob({
      id: "j2",
      type: "review-fix",
      epicBeadId: "feat-1",
      status: "queued",
      lastError: "usage-limit: resumes at 2026-09-22T02:00:00Z",
      quotaParkCount: 1,
    });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.friction.quotaParks).toBe(2);
    expect(ledger?.friction.humanTouches).toBe(0);
  });

  it("leaves a sibling feature's jobs and escalations out of the scope", async () => {
    fakeBoard([...BOARD, bead({ id: "feat-2", issue_type: "feature" })]);
    await seedJob({ id: "j1", type: "execute-epic", epicBeadId: "feat-2", status: "cancelled" });
    await seedEscalation({ id: "e1", kind: "needs-human", beadId: "feat-2" });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.friction.cancels).toBe(0);
    expect(ledger?.friction.escalations).toBe(0);
  });

  it("attributes a reparented gate to its NEW feature only, not the one it was raised under", async () => {
    // The row `raiseEscalation` wrote back when task-1 still lived under feat-1: `epicBeadId` is
    // frozen at "feat-1" forever, but `beadId` (task-1's own, never-reassigned id) now falls under
    // feat-2 on the board this test hands both reads. Matching on either frozen column independently
    // would bill this one gate to both features (PR #322 review); the fix must bill it to exactly
    // the one the board says owns task-1 right now.
    fakeBoard([
      bead({ id: "feat-1", issue_type: "feature" }),
      bead({ id: "feat-2", issue_type: "feature" }),
      bead({ id: "task-1", parent: "feat-2" }),
    ]);
    await seedEscalation({ id: "e1", kind: "needs-human", beadId: "task-1", epicBeadId: "feat-1" });

    const oldFeature = await featureLedger(t.db, t.projectId, "feat-1");
    const newFeature = await featureLedger(t.db, t.projectId, "feat-2");

    expect(oldFeature?.friction.escalations).toBe(0);
    expect(newFeature?.friction.escalations).toBe(1);
  });

  it("still answers the cost half when the review thread cannot be read", async () => {
    // The footnote must not cost the answer: an unreadable comment thread reports no rounds, and
    // the dollars and timing — which come from anton.db — are unaffected.
    fakeBoard(BOARD);
    vi.spyOn(beads, "showWithComments").mockRejectedValue(new Error("bd exploded"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedInvocation({
      id: "i1",
      beadId: "feat-1",
      recordedAt: new Date("2026-09-20T09:10:00Z"),
      durationMs: 5 * 60_000,
    });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.totals.recorded).toBe(true);
    expect(ledger?.friction.reviewRounds).toBe(0);
  });

  it("counts an escalation a founder already settled — it interrupted them either way", async () => {
    fakeBoard(BOARD);
    await seedEscalation({ id: "e1", kind: "needs-human", beadId: "feat-1", status: "resolved" });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.friction.humanGates).toBe(1);
    expect(ledger?.friction.humanTouches).toBe(1);
  });

  it("cuts every friction source at asOfMs, on its OWN clock — a rerun's own jobs, escalations, review rounds and send-back notes must not reach a preserved delivery's figures (PR #331 review)", async () => {
    // A target still live on a rerun of an already-delivered feature must report ONLY the completed
    // attempt's friction (`cohort-read.ts`'s `activeRunTargetIds`) — the rerun has no outcome yet, so
    // its own interventions are exactly as premature as its own invocations would be.
    const cutoff = new Date("2026-08-01T00:10:00Z");
    fakeBoard([
      BOARD[0]!,
      bead({
        id: "task-1",
        parent: "feat-1",
        notes: [
          formatHumanNote(
            originNoteBody("anton-old-followup"),
            "Henri Blancke",
            new Date("2026-08-01T00:05:00Z"),
          ),
          formatHumanNote(
            originNoteBody("anton-new-followup"),
            "Henri Blancke",
            new Date("2026-09-25T00:05:00Z"),
          ),
        ].join("\n"),
      }),
    ]);
    vi.spyOn(beads, "showWithComments").mockImplementation(async (_cwd, id) => ({
      ...bead({ id }),
      comments: [
        {
          text: formatReviewScoreComment({ round: 1, blocking: 0, advisory: 0, verdict: "clean" }),
          created_at: "2026-08-01T00:01:00.000Z",
        },
        {
          text: formatReviewScoreComment({ round: 1, blocking: 0, advisory: 0, verdict: "clean" }),
          created_at: "2026-09-25T00:01:00.000Z",
        },
      ],
    }));
    await seedJob({
      id: "j-old",
      type: "execute-epic",
      epicBeadId: "feat-1",
      status: "cancelled",
      createdAt: new Date("2026-08-01T00:00:00Z"),
      updatedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await seedJob({
      id: "j-new",
      type: "execute-epic",
      epicBeadId: "feat-1",
      status: "cancelled",
      createdAt: new Date("2026-09-25T00:00:00Z"),
      updatedAt: new Date("2026-09-25T00:00:00Z"),
    });
    await seedEscalation({
      id: "e-old",
      kind: "needs-human",
      beadId: "feat-1",
      raisedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await seedEscalation({
      id: "e-new",
      kind: "needs-human",
      beadId: "feat-1",
      raisedAt: new Date("2026-09-25T00:00:00Z"),
    });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1", { asOfMs: cutoff.getTime() });

    // Only the OLD job, escalation, review round and send-back note — every one before the cutoff —
    // count; the still-live rerun's own activity is invisible until it has an outcome.
    expect(ledger?.friction.cancels).toBe(1);
    expect(ledger?.friction.humanGates).toBe(1);
    expect(ledger?.friction.reviewRounds).toBe(1);
    expect(ledger?.friction.sendBacks).toBe(1);
  });

  it("excludes a live rerun's job cancelled after the cutoff even though it was CREATED before it (PR #331 review, P2 follow-up)", async () => {
    // An open rerun's execute job is necessarily enqueued before the run's own `attemptStartedAt` —
    // so `asOfMs` (which sits at-or-after that start) can land AFTER the job's `createdAt` while the
    // job is still live. If an operator then cancels it before the rerun settles, a creation-time
    // cutoff would keep the row and its now-`cancelled` status would bill this preserved delivery for
    // an interruption that belongs to the still-outcome-less rerun.
    fakeBoard(BOARD);
    const cutoff = new Date("2026-09-25T00:10:00Z");
    await seedJob({
      id: "j-live",
      type: "execute-epic",
      epicBeadId: "feat-1",
      status: "cancelled",
      createdAt: new Date("2026-09-25T00:00:00Z"),
      updatedAt: new Date("2026-09-25T00:20:00Z"),
    });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1", { asOfMs: cutoff.getTime() });

    expect(ledger?.friction.cancels).toBe(0);
    expect(ledger?.friction.humanTouches).toBe(0);
  });

  it("excludes an event stamped in the SAME instant as an exclusive asOfMs cutoff — the open-attempt boundary (PR #331 review, boundary follow-up)", async () => {
    // Run starts and invocation timestamps are both whole-second precision, so an open rerun's own
    // first invocation can land in the exact same second as the cutoff `cohort-read.ts` derives from
    // that rerun's `attemptStartedAt`. An inclusive comparison there would keep that unfinished
    // invocation in the preserved delivery it is cut for.
    fakeBoard(BOARD);
    const cutoff = new Date("2026-09-25T00:00:00Z");
    await seedInvocation({ id: "i-boundary", beadId: "feat-1", recordedAt: cutoff, durationMs: 60_000 });

    const inclusive = await featureLedger(t.db, t.projectId, "feat-1", { asOfMs: cutoff.getTime() });
    expect(inclusive?.rows).toHaveLength(1);

    const exclusive = await featureLedger(t.db, t.projectId, "feat-1", {
      asOfMs: cutoff.getTime(),
      asOfExclusive: true,
    });
    expect(exclusive?.rows).toHaveLength(0);
  });

  it("keeps an event stamped in the same instant as an INCLUSIVE asOfMs cutoff — the prior-delivery fallback must still capture the delivery's own final event", async () => {
    fakeBoard(BOARD);
    const cutoff = new Date("2026-09-25T00:00:00Z");
    await seedInvocation({ id: "i-delivery", beadId: "feat-1", recordedAt: cutoff, durationMs: 60_000 });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1", {
      asOfMs: cutoff.getTime(),
      asOfExclusive: false,
    });
    expect(ledger?.rows).toHaveLength(1);
  });
});
