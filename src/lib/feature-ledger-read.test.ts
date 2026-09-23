/**
 * `featureLedger` (anton-8zckg) — the wiring that resolves a real board, pulls real rows, and folds
 * them into the answer the pure halves compute. The pure fold and scope resolution each have their
 * own exhaustive tests; this file's job is only to prove the wiring itself: the right beads get
 * queried, the right rows come back, and an unresolvable project is told apart from a resolved scope
 * that recorded nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads, type Bead } from "./beads/bd";
import { resetIssueSnapshots } from "./beads/snapshot";
import * as schema from "./db/schema";
import { featureLedger } from "./feature-ledger-read";
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

let t: TestProjectDb;

beforeEach(() => {
  resetIssueSnapshots();
  t = makeProjectDb({ repoPath: "/repo" });
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
