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
});

describe("featureLedger's friction half", () => {
  /** A job of `type` for `epicBeadId`, in the status the counter reads it at. */
  async function seedJob(row: {
    id: string;
    type: string;
    epicBeadId: string;
    status: string;
    lastError?: string;
  }): Promise<void> {
    await t.db.insert(schema.jobs).values({
      id: row.id,
      type: row.type,
      projectId: t.projectId,
      payloadJson: JSON.stringify({ projectId: t.projectId, epicBeadId: row.epicBeadId }),
      status: row.status,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    });
  }

  async function seedEscalation(row: {
    id: string;
    kind: string;
    beadId?: string;
    epicBeadId?: string;
    status?: string;
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

  it("leaves a sibling feature's jobs and escalations out of the scope", async () => {
    fakeBoard([...BOARD, bead({ id: "feat-2", issue_type: "feature" })]);
    await seedJob({ id: "j1", type: "execute-epic", epicBeadId: "feat-2", status: "cancelled" });
    await seedEscalation({ id: "e1", kind: "needs-human", beadId: "feat-2" });

    const ledger = await featureLedger(t.db, t.projectId, "feat-1");

    expect(ledger?.friction.cancels).toBe(0);
    expect(ledger?.friction.escalations).toBe(0);
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
});
