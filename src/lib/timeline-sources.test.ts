/**
 * The timeline's source readers (anton-4ldxk), against a real migrated anton.db plus bd-shaped bead
 * fixtures — what each reader owes `foldTimeline`: the right rows, windowed, off an index rather
 * than a scan, and the bead-derived facts off the caller's own snapshot rather than a new `bd` call.
 */
import { describe, expect, it } from "vitest";

import { LABELS, type Bead } from "./beads/bd";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import { appliedCloseReason } from "./gardener/apply";
import { foldReason } from "./gardener/emit";
import {
  readAutopilotDisarmRows,
  readBeadBoardRows,
  readEscalationRows,
  readPickerStartRows,
  readPickerVerdictRows,
  readProposalRows,
  readRunAttemptRows,
  readRunRows,
  readScanSummaryRows,
  type TimelineWindow,
} from "./timeline-sources";

const PROJECT = "proj-a";
const WINDOW: TimelineWindow = { since: 1_000, until: 2_000 };
const OUTSIDE = 50; // before WINDOW.since
const date = (sec: number) => new Date(sec * 1000);

function makeDb(): TestDb {
  const tdb = makeTestDb();
  tdb.db.insert(schema.projects).values({ id: PROJECT, slug: "a", name: "A", repoPath: "/tmp/a" }).run();
  return tdb;
}

const bead = (id: string, extra: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  ...extra,
});

describe("readRunRows", () => {
  it("reads a run started in the window, and resolves prOpenedAt off the caller's own board", async () => {
    const tdb = makeDb();
    tdb.db
      .insert(schema.runs)
      .values([
        {
          id: "run-in",
          projectId: PROJECT,
          epicBeadId: "anton-epic",
          ticketBeadId: "anton-t1",
          status: "in_review",
          startedAt: date(1_500),
          updatedAt: date(1_800),
        },
        {
          id: "run-out",
          projectId: PROJECT,
          epicBeadId: "anton-epic",
          status: "done",
          startedAt: date(OUTSIDE),
          updatedAt: date(OUTSIDE),
        },
      ])
      .run();

    const board = [bead("anton-t1", { metadata: { pr: "gh-org/repo#9" } })];
    const rows = await readRunRows(tdb.db, PROJECT, WINDOW, board);

    expect(rows).toEqual([
      {
        source: "run",
        id: "run-in",
        projectId: PROJECT,
        ticketBeadId: "anton-t1",
        startedAt: 1_500,
        prOpenedAt: 1_800,
      },
    ]);
    tdb.close();
  });

  it("reports no PR-opened time when the ticket carries no PR ref", async () => {
    const tdb = makeDb();
    tdb.db
      .insert(schema.runs)
      .values({
        id: "run-1",
        projectId: PROJECT,
        epicBeadId: "anton-epic",
        ticketBeadId: "anton-t1",
        status: "implementing",
        startedAt: date(1_500),
        updatedAt: date(1_800),
      })
      .run();

    const board = [bead("anton-t1")];
    const rows = await readRunRows(tdb.db, PROJECT, WINDOW, board);

    expect(rows).toEqual([
      expect.objectContaining({ id: "run-1", startedAt: 1_500, prOpenedAt: null }),
    ]);
    tdb.close();
  });
});

describe("readRunAttemptRows", () => {
  it("reads a settled attempt ended in the window and resolves ticketBeadId off its run", async () => {
    const tdb = makeDb();
    tdb.db
      .insert(schema.runs)
      .values({
        id: "run-1",
        projectId: PROJECT,
        epicBeadId: "anton-epic",
        ticketBeadId: "anton-t1",
        status: "parked",
        startedAt: date(1_000),
      })
      .run();
    tdb.db
      .insert(schema.runAttempts)
      .values([
        {
          id: "att-in",
          runId: "run-1",
          projectId: PROJECT,
          attempt: 1,
          startedAt: date(1_000),
          endedAt: date(1_500),
          outcome: "parked",
        },
        {
          id: "att-out",
          runId: "run-1",
          projectId: PROJECT,
          attempt: 2,
          startedAt: date(OUTSIDE),
          endedAt: date(OUTSIDE),
          outcome: "parked",
        },
        // Still running: no `endedAt`, must never surface regardless of window.
        {
          id: "att-running",
          runId: "run-1",
          projectId: PROJECT,
          attempt: 3,
          startedAt: date(1_600),
        },
      ])
      .run();

    const rows = await readRunAttemptRows(tdb.db, PROJECT, WINDOW);

    expect(rows).toEqual([
      {
        source: "run_attempt",
        id: "att-in",
        projectId: PROJECT,
        ticketBeadId: "anton-t1",
        outcome: "parked",
        endedAt: 1_500,
      },
    ]);
    tdb.close();
  });
});

describe("readEscalationRows", () => {
  it("reads an escalation raised in the window, and reports resolvedAt only once resolved", async () => {
    const tdb = makeDb();
    tdb.db
      .insert(schema.escalations)
      .values([
        {
          id: "esc-open",
          projectId: PROJECT,
          findingKey: "k1",
          kind: "parked-run",
          reason: "stuck",
          beadId: "anton-t1",
          raisedAt: date(1_200),
          updatedAt: date(1_200),
          status: "open",
        },
        {
          id: "esc-resolved",
          projectId: PROJECT,
          findingKey: "k2",
          kind: "stale-pr",
          reason: "stuck",
          raisedAt: date(1_300),
          updatedAt: date(1_900),
          status: "resolved",
          resolution: "resumed",
        },
        {
          id: "esc-out",
          projectId: PROJECT,
          findingKey: "k3",
          kind: "dead-lease",
          reason: "stuck",
          raisedAt: date(OUTSIDE),
          updatedAt: date(OUTSIDE),
          status: "open",
        },
      ])
      .run();

    const rows = await readEscalationRows(tdb.db, PROJECT, WINDOW);

    expect(rows).toEqual([
      {
        source: "escalation",
        id: "esc-open",
        projectId: PROJECT,
        ticketBeadId: "anton-t1",
        raisedAt: 1_200,
        resolvedAt: null,
      },
      {
        source: "escalation",
        id: "esc-resolved",
        projectId: PROJECT,
        ticketBeadId: null,
        raisedAt: 1_300,
        resolvedAt: 1_900,
      },
    ]);
    tdb.close();
  });
});

describe("readPickerStartRows / readPickerVerdictRows / readAutopilotDisarmRows / readScanSummaryRows", () => {
  it("windows each table on its own project+time index", async () => {
    const tdb = makeDb();
    tdb.db
      .insert(schema.pickerStarts)
      .values([
        { id: "ps-in", projectId: PROJECT, beadId: "anton-t1", rank: 1, ranked: 3, rule: "r", startedAt: date(1_200) },
        { id: "ps-out", projectId: PROJECT, beadId: "anton-t2", rank: 1, ranked: 3, rule: "r", startedAt: date(OUTSIDE) },
      ])
      .run();
    tdb.db
      .insert(schema.pickerVerdicts)
      .values([
        { id: "pv-in", projectId: PROJECT, beadId: "anton-t1", verdict: "accepted", action: "release", decidedAt: date(1_300) },
        { id: "pv-out", projectId: PROJECT, beadId: "anton-t2", verdict: "declined", action: "not-now", decidedAt: date(OUTSIDE) },
      ])
      .run();
    tdb.db
      .insert(schema.autopilotDisarms)
      .values([
        { id: "ad-in", projectId: PROJECT, reason: "score-regression", detail: "d", disarmedAt: date(1_400) },
        {
          id: "ad-out",
          projectId: PROJECT,
          reason: "consecutive-failures",
          detail: "d",
          disarmedAt: date(OUTSIDE),
          // Re-armed, so it doesn't collide with `ad-in` on the latched-disarm partial unique index.
          rearmedAt: date(OUTSIDE + 1),
        },
      ])
      .run();
    tdb.db
      .insert(schema.scanSummaries)
      .values([
        { id: "ss-in", projectId: PROJECT, generatedAt: date(1_600) },
        { id: "ss-out", projectId: PROJECT, generatedAt: date(OUTSIDE) },
      ])
      .run();

    expect(await readPickerStartRows(tdb.db, PROJECT, WINDOW)).toEqual([
      { source: "picker_start", id: "ps-in", projectId: PROJECT, beadId: "anton-t1", startedAt: 1_200 },
    ]);
    expect(await readPickerVerdictRows(tdb.db, PROJECT, WINDOW)).toEqual([
      { source: "picker_verdict", id: "pv-in", projectId: PROJECT, beadId: "anton-t1", verdict: "accepted", decidedAt: 1_300 },
    ]);
    expect(await readAutopilotDisarmRows(tdb.db, PROJECT, WINDOW)).toEqual([
      { source: "autopilot_disarm", id: "ad-in", projectId: PROJECT, disarmedAt: 1_400 },
    ]);
    expect(await readScanSummaryRows(tdb.db, PROJECT, WINDOW)).toEqual([
      { source: "scan_summary", id: "ss-in", projectId: PROJECT, generatedAt: 1_600 },
    ]);
    tdb.close();
  });
});

describe("readProposalRows — off the caller's bd snapshot, no bd spawn", () => {
  const FINGERPRINT = "gardener:implied-order:deadbeefcafe";

  it("reports filed for an open proposal and nothing for one filed outside the window", () => {
    const filedIn = bead("anton-p1", {
      status: "open",
      labels: [FINGERPRINT],
      created_at: new Date(1_100 * 1000).toISOString(),
    });
    const filedOut = bead("anton-p2", {
      status: "open",
      labels: [FINGERPRINT],
      created_at: new Date(OUTSIDE * 1000).toISOString(),
    });

    expect(readProposalRows([filedIn, filedOut], PROJECT, WINDOW)).toEqual([
      { source: "proposal", id: "anton-p1:filed", projectId: PROJECT, ticketBeadId: null, outcome: "filed", at: 1_100 },
    ]);
  });

  it("reports applied for a plain close, refused for an abandoned one, and nothing for a fold", () => {
    const applied = bead("anton-p1", {
      status: "closed",
      labels: [FINGERPRINT],
      created_at: new Date(OUTSIDE * 1000).toISOString(),
      closed_at: new Date(1_200 * 1000).toISOString(),
      close_reason: appliedCloseReason("did the thing", "approval"),
    });
    const refused = bead("anton-p2", {
      status: "closed",
      labels: [FINGERPRINT, LABELS.abandoned],
      created_at: new Date(OUTSIDE * 1000).toISOString(),
      closed_at: new Date(1_300 * 1000).toISOString(),
      close_reason: "abandoned: no",
    });
    const folded = bead("anton-p3", {
      status: "closed",
      labels: [FINGERPRINT],
      created_at: new Date(OUTSIDE * 1000).toISOString(),
      closed_at: new Date(1_400 * 1000).toISOString(),
      close_reason: foldReason("anton-keep", FINGERPRINT),
    });

    const rows = readProposalRows([applied, refused, folded], PROJECT, WINDOW);

    expect(rows).toEqual([
      { source: "proposal", id: "anton-p1:applied", projectId: PROJECT, ticketBeadId: null, outcome: "applied", at: 1_200 },
      { source: "proposal", id: "anton-p2:refused", projectId: PROJECT, ticketBeadId: null, outcome: "refused", at: 1_300 },
    ]);
  });

  it("never reads a non-proposal bead as a proposal", () => {
    const plain = bead("anton-t1", {
      status: "closed",
      closed_at: new Date(1_200 * 1000).toISOString(),
      close_reason: "applied: looks like a proposal close but carries no fingerprint",
    });

    expect(readProposalRows([plain], PROJECT, WINDOW)).toEqual([]);
  });
});

describe("readBeadBoardRows — off the caller's bd snapshot, no bd spawn", () => {
  const blockedBy = (id: string, gateId: string) => ({
    issue_id: id,
    depends_on_id: gateId,
    type: "blocks" as const,
  });

  /** A closed `gh:pr` merge-wait gate on PR #<prNumber> — the only proof a bead's PR merged. */
  const mergeGate = (id: string, prNumber: number): Bead => ({
    id,
    title: `Gate: ${id}`,
    status: "closed",
    issue_type: "gate",
    await_type: "gh:pr",
    await_id: String(prNumber),
  });

  it("reports a closed ticket as bead_closed, and additionally as pr_merged when its merge-wait gate confirms the merge", () => {
    const shipped = bead("anton-t1", {
      status: "closed",
      closed_at: new Date(1_200 * 1000).toISOString(),
      metadata: { pr: "gh-1" },
      dependencies: [blockedBy("anton-t1", "gate-1")],
    });
    const closedNoPr = bead("anton-t2", {
      status: "closed",
      closed_at: new Date(1_300 * 1000).toISOString(),
    });

    const { closed, merged } = readBeadBoardRows(
      [shipped, mergeGate("gate-1", 1), closedNoPr],
      PROJECT,
      WINDOW,
    );

    expect(closed).toEqual([
      { source: "bead_closed", id: "anton-t1", projectId: PROJECT, ticketBeadId: "anton-t1", closedAt: 1_200 },
      { source: "bead_closed", id: "anton-t2", projectId: PROJECT, ticketBeadId: "anton-t2", closedAt: 1_300 },
    ]);
    expect(merged).toEqual([
      { source: "pr_merged", id: "anton-t1", projectId: PROJECT, ticketBeadId: "anton-t1", mergedAt: 1_200 },
    ]);
  });

  it("reports no pr_merged when the bead carries a PR ref but its merge-wait gate is still open", () => {
    const closedUnmerged = bead("anton-t1", {
      status: "closed",
      closed_at: new Date(1_200 * 1000).toISOString(),
      metadata: { pr: "gh-1" },
      dependencies: [blockedBy("anton-t1", "gate-1")],
    });
    const openGate: Bead = { ...mergeGate("gate-1", 1), status: "open" };

    const { merged } = readBeadBoardRows([closedUnmerged, openGate], PROJECT, WINDOW);

    expect(merged).toEqual([]);
  });

  it("reports no pr_merged when the closed merge-wait gate names a different, superseded PR", () => {
    const resent = bead("anton-t1", {
      status: "closed",
      closed_at: new Date(1_200 * 1000).toISOString(),
      metadata: { pr: "gh-2" },
      dependencies: [blockedBy("anton-t1", "gate-1")],
    });

    const { merged } = readBeadBoardRows([resent, mergeGate("gate-1", 1)], PROJECT, WINDOW);

    expect(merged).toEqual([]);
  });

  it("excludes proposals, pipeline artifacts, and anything outside the window", () => {
    const proposal = bead("anton-p1", {
      status: "closed",
      labels: ["gardener:implied-order:deadbeefcafe"],
      closed_at: new Date(1_200 * 1000).toISOString(),
      close_reason: appliedCloseReason("x", "approval"),
    });
    const gate = bead("anton-g1", {
      status: "closed",
      issue_type: "gate",
      closed_at: new Date(1_200 * 1000).toISOString(),
    });
    const outOfWindow = bead("anton-t3", {
      status: "closed",
      closed_at: new Date(OUTSIDE * 1000).toISOString(),
    });
    const stillOpen = bead("anton-t4", { status: "open" });

    const { closed, merged } = readBeadBoardRows([proposal, gate, outOfWindow, stillOpen], PROJECT, WINDOW);

    expect(closed).toEqual([]);
    expect(merged).toEqual([]);
  });
});
