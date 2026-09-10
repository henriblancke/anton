/**
 * Tests for the escalation store (anton-wvcy) against a real migrated anton.db.
 *
 * Two invariants carry the feature and are tested here rather than inferred from the sweep:
 *   • RAISE IS IDEMPOTENT — one open row per (project, finding), so an hourly sweep over an
 *     unchanged stall yields one board item instead of a growing pile the founder learns to ignore.
 *   • SETTLE IS A COMPARE-AND-SWAP — only the first `open → resolved` wins, which is what stops a
 *     double-click (or two operators on one board) from resuming the same epic twice.
 *
 * And, since anton-7gxs, a third:
 *   • A HUMAN DISMISSAL STAYS DOWN — a stall a person put down is not raised again while it is
 *     unchanged, and IS raised again the moment it changes. That is the difference between an alert
 *     list a founder can clear after an outage and one that refills hourly until they stop reading
 *     it. The two halves are tested together because getting either wrong is a silent failure: too
 *     sticky hides a live stall, too loose makes the button useless.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "./db/schema";
import { makeTestDb, type TestDb } from "./db/testing";
import {
  escalationSignature,
  getEscalation,
  listDismissedEscalations,
  listOpenEscalations,
  markEscalationNoted,
  raiseEscalation,
  restoreEscalation,
  settleEscalation,
  toEscalationView,
} from "./escalations";
import type { RunHealthFinding } from "./run-health";
import type { Clock } from "./jobs/queue";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const clock: Clock = { now: () => NOW };

let t: TestDb;

beforeEach(() => {
  t = makeTestDb();
  for (const id of ["p1", "p2"]) {
    t.db.insert(schema.projects).values({ id, slug: id, name: id, repoPath: `/tmp/${id}` }).run();
  }
});
afterEach(() => t.close());

function finding(o: Partial<RunHealthFinding> = {}): RunHealthFinding {
  return {
    kind: "parked-run",
    key: "parked-run:r-1",
    reason: "parked 4h ago: agent exited 1",
    since: NOW - 4 * HOUR,
    ageMs: 4 * HOUR,
    runId: "r-1",
    beadId: "t-9",
    ...o,
  };
}

const raise = (o: { projectId?: string; finding?: RunHealthFinding; epicBeadId?: string } = {}) =>
  raiseEscalation(t.db, clock, {
    projectId: o.projectId ?? "p1",
    finding: o.finding ?? finding(),
    epicBeadId: "epicBeadId" in o ? o.epicBeadId : "e-1",
  });

describe("raiseEscalation", () => {
  it("stores the finding's evidence, target and decision state", async () => {
    const { escalation, created } = await raise();

    expect(created).toBe(true);
    expect(escalation).toMatchObject({
      projectId: "p1",
      findingKey: "parked-run:r-1",
      kind: "parked-run",
      reason: "parked 4h ago: agent exited 1",
      beadId: "t-9",
      epicBeadId: "e-1",
      runId: "r-1",
      status: "open",
      resolution: null,
      notedAt: null,
    });
    expect(JSON.parse(escalation.evidenceJson)).toEqual(finding());
  });

  it("returns the open row and inserts nothing when the same finding is raised again", async () => {
    const first = await raise();
    const again = await raise({ finding: finding({ reason: "parked 9h ago: agent exited 1" }) });

    expect(again.created).toBe(false);
    expect(again.escalation.id).toBe(first.escalation.id);
    // The reason is NOT refreshed: the row records what was escalated, and rewriting it would make
    // "resolved" ambiguous about which claim the founder actually answered.
    expect(again.escalation.reason).toBe("parked 4h ago: agent exited 1");
    expect(t.db.select().from(schema.escalations).all()).toHaveLength(1);
  });

  it("keeps findings and projects independent", async () => {
    const a = await raise();
    const b = await raise({ finding: finding({ key: "parked-run:r-2" }) });
    const c = await raise({ projectId: "p2" });

    expect(new Set([a, b, c].map((r) => r.escalation.id)).size).toBe(3);
  });

  it("raises again once the prior escalation is resolved — a recurrence is new news", async () => {
    const first = await raise();
    await settleEscalation(t.db, clock, first.escalation.id, "abandoned");

    const second = await raise();
    expect(second.created).toBe(true);
    expect(second.escalation.id).not.toBe(first.escalation.id);
    expect(await listOpenEscalations(t.db, "p1")).toHaveLength(1);
  });

  it("tolerates a finding that names no bead at all", async () => {
    const { escalation } = await raise({
      finding: finding({ key: "exhausted-job:j-1", kind: "exhausted-job", beadId: undefined }),
      epicBeadId: undefined,
    });
    expect(escalation.beadId).toBeNull();
    expect(toEscalationView(escalation).beadId).toBeUndefined();
  });
});

describe("escalations_open_unique (DB backstop)", () => {
  it("rejects a second OPEN row for the same (project, finding)", async () => {
    await raise();
    expect(() =>
      t.db
        .insert(schema.escalations)
        .values({
          id: "dup",
          projectId: "p1",
          findingKey: "parked-run:r-1",
          kind: "parked-run",
          reason: "dup",
          evidenceJson: "{}",
          status: "open",
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("permits a resolved duplicate, so history is kept rather than overwritten", async () => {
    const { escalation } = await raise();
    await settleEscalation(t.db, clock, escalation.id, "resumed");
    await raise();
    expect(t.db.select().from(schema.escalations).all()).toHaveLength(2);
  });
});

describe("settleEscalation", () => {
  it("records the founder's answer and closes the item", async () => {
    const { escalation } = await raise();

    expect(await settleEscalation(t.db, clock, escalation.id, "resumed")).toBe(true);
    const row = t.db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.id, escalation.id))
      .get();
    expect(row).toMatchObject({ status: "resolved", resolution: "resumed" });
    expect(await listOpenEscalations(t.db, "p1")).toEqual([]);
  });

  it("lets only the first settle win — the second reports false and changes nothing", async () => {
    // This is the guard that makes a double-clicked Resume enqueue one job, not two.
    const { escalation } = await raise();

    expect(await settleEscalation(t.db, clock, escalation.id, "resumed")).toBe(true);
    expect(await settleEscalation(t.db, clock, escalation.id, "abandoned")).toBe(false);
    const row = t.db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.id, escalation.id))
      .get();
    expect(row?.resolution).toBe("resumed");
  });

  it("reports false for an unknown id rather than throwing", async () => {
    expect(await settleEscalation(t.db, clock, "nope", "resumed")).toBe(false);
  });
});

describe("reads", () => {
  it("lists only this project's open escalations, newest stall first", async () => {
    const older = await raise({ finding: finding({ key: "parked-run:old" }) });
    t.db
      .update(schema.escalations)
      .set({ raisedAt: new Date(NOW - 6 * HOUR) })
      .where(eq(schema.escalations.id, older.escalation.id))
      .run();
    const newer = await raise({ finding: finding({ key: "parked-run:new" }) });
    const settled = await raise({ finding: finding({ key: "parked-run:done" }) });
    await settleEscalation(t.db, clock, settled.escalation.id, "abandoned");
    await raise({ projectId: "p2" });

    const rows = await listOpenEscalations(t.db, "p1");
    expect(rows.map((r) => r.id)).toEqual([newer.escalation.id, older.escalation.id]);
  });

  it("scopes a single read to its project, so a route can't settle another project's item", async () => {
    const { escalation } = await raise();
    expect(await getEscalation(t.db, "p1", escalation.id)).toBeDefined();
    expect(await getEscalation(t.db, "p2", escalation.id)).toBeUndefined();
  });
});

describe("markEscalationNoted", () => {
  it("stamps the bd note so later sweeps stop retrying it", async () => {
    const { escalation } = await raise();
    expect(toEscalationView(escalation).noted).toBe(false);

    await markEscalationNoted(t.db, clock, escalation.id);
    const row = await getEscalation(t.db, "p1", escalation.id);
    expect(toEscalationView(row!).noted).toBe(true);
  });
});

describe("toEscalationView", () => {
  it("surfaces the PR evidence the panel links to", async () => {
    const { escalation } = await raise({
      finding: finding({
        kind: "stale-pr",
        key: "stale-pr:e-1:42",
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
      }),
    });
    expect(toEscalationView(escalation)).toMatchObject({
      kind: "stale-pr",
      prNumber: 42,
      prUrl: "https://github.com/o/r/pull/42",
      ageMs: 4 * HOUR,
      since: Math.floor((NOW - 4 * HOUR) / 1000),
      status: "open",
    });
  });

  it("surfaces the gate a wait on a person hangs on — the bead resolve-and-resume closes", async () => {
    // The gate has no column of its own, so this blob IS the link between the detector that found
    // the wait and the verb that ends it (escalation-actions.ts).
    const { escalation } = await raise({
      finding: finding({
        kind: "needs-human",
        key: "needs-human:g-1",
        gateId: "g-1",
        beadId: "t-1",
        targetBeadId: "e-1",
      }),
    });
    expect(toEscalationView(escalation)).toMatchObject({ kind: "needs-human", gateId: "g-1" });
  });

  it("stays actionable when the evidence blob is corrupt", async () => {
    // The row's own columns carry the reason, target and stall time, so a bad blob costs the extra
    // evidence — never the escalation itself.
    const { escalation } = await raise();
    t.db
      .update(schema.escalations)
      .set({ evidenceJson: "{not json" })
      .where(eq(schema.escalations.id, escalation.id))
      .run();

    const view = toEscalationView((await getEscalation(t.db, "p1", escalation.id))!);
    expect(view).toMatchObject({ reason: "parked 4h ago: agent exited 1", epicBeadId: "e-1" });
    expect(view.ageMs).toBe(0);
    expect(view.prNumber).toBeUndefined();
  });
});


/**
 * The signature is the whole basis of "until it changes", so what it does and does NOT distinguish
 * is the contract. It must ignore nothing that moves when the stall moves, and it must be stable
 * across two sweeps that re-derive the same event — a hash that drifted with a re-read timestamp
 * would make every dismissal expire on the next pass.
 */
describe("escalationSignature", () => {
  it("is stable across sweeps that re-derive the same stall", () => {
    expect(escalationSignature(finding())).toBe(escalationSignature(finding()));
  });

  it("is stable across sub-second drift in the stall's start time", () => {
    // The row stores `since` to the second, so a re-read that lands 200ms later is the same stall.
    const a = escalationSignature(finding({ since: NOW - 4 * HOUR }));
    const b = escalationSignature(finding({ since: NOW - 4 * HOUR + 200 }));
    expect(a).toBe(b);
  });

  it("changes when the failure changes, even for the same subject", () => {
    // The case this exists for: one job id, two different failures. `findingKey` cannot tell them
    // apart, and a dismissal keyed on it alone would silence the second one.
    const first = finding({ kind: "exhausted-job", key: "exhausted-job:j-1", reason: "API 503" });
    const second = { ...first, reason: "API 401 — bad credentials" };
    expect(escalationSignature(first)).not.toBe(escalationSignature(second));
  });

  it("changes when the stall restarts, even with the same reason", () => {
    const first = finding({ since: NOW - 4 * HOUR });
    expect(escalationSignature(first)).not.toBe(
      escalationSignature({ ...first, since: NOW - 30 * 60_000 }),
    );
  });

  /**
   * The regression from PR #261's review. Three detectors render `humanAge(ageMs)` into `reason`,
   * so an UNTOUCHED stall re-reads with different text the moment it crosses a minute/hour/day
   * boundary. Hashing that text made the next sweep miss the dismissed row and re-raise the exact
   * alert the operator had put down.
   */
  it("ignores the rendered age ticking over inside an otherwise unchanged reason", () => {
    const at4h = finding({ reason: "run parked 4h: agent exited 1" });
    const at5h = finding({ reason: "run parked 5h: agent exited 1" });
    expect(escalationSignature(at4h)).toBe(escalationSignature(at5h));
  });

  it("ignores the age on every detector that renders one", () => {
    const stalePr = (age: string) =>
      finding({
        kind: "stale-pr",
        key: "stale-pr:t-9:12",
        reason: `PR #12 idle ${age} with the target still in review`,
      });
    expect(escalationSignature(stalePr("3d"))).toBe(escalationSignature(stalePr("4d")));

    const deadLease = (age: string) =>
      finding({
        kind: "dead-lease",
        key: "dead-lease:t-9",
        reason: `run-lease expired ${age} ago with no job to resume it — the owning run died mid-flight`,
      });
    expect(escalationSignature(deadLease("59m"))).toBe(escalationSignature(deadLease("1h")));

    // The fourth, and the one the first pass at this test missed (PR #261 review). `needs-human` is
    // not dismissable today (escalation-kinds.ts), so nothing depends on it — but the detector
    // renders an age like every other, and the day that kind becomes dismissable the omission would
    // be the P1 bug again with no test failing.
    const needsHuman = (age: string) =>
      finding({
        kind: "needs-human",
        key: "needs-human:g-1",
        reason: `waiting on a human ${age}: review the migration plan`,
      });
    expect(escalationSignature(needsHuman("2h"))).toBe(escalationSignature(needsHuman("3h")));
  });

  it("still separates two failures that differ by more than their age", () => {
    // The coarsening must not swallow the case the signature exists for.
    const first = finding({ reason: "run parked 4h: API 503" });
    const second = finding({ reason: "run parked 5h: API 401 — bad credentials" });
    expect(escalationSignature(first)).not.toBe(escalationSignature(second));
  });
});

describe("a dismissed stall stays down", () => {
  /** Raise, then put it down the way a person does — through the human-flagged settle. */
  async function dismiss(f: RunHealthFinding = finding()): Promise<void> {
    const { escalation } = await raise({ finding: f });
    expect(await settleEscalation(t.db, clock, escalation.id, "dismissed", true)).toBe(true);
  }

  it("raises nothing for the same stall, and says so rather than reporting a live row", async () => {
    await dismiss();
    const again = await raise();
    expect(again.suppressed).toBe(true);
    expect(again.created).toBe(false);
    // Nothing on the board: `suppressed` is what stops the sweep writing a bd note for it, which is
    // how an escalation is visible off the anton UI at all.
    expect(await listOpenEscalations(t.db, "p1")).toHaveLength(0);
  });

  it("raises again the moment the same subject fails a new way", async () => {
    const first = finding({ kind: "exhausted-job", key: "exhausted-job:j-1", reason: "API 503" });
    await dismiss(first);
    const next = await raise({ finding: { ...first, reason: "API 401 — bad credentials" } });
    expect(next.suppressed).toBeUndefined();
    expect(next.created).toBe(true);
    expect(await listOpenEscalations(t.db, "p1")).toHaveLength(1);
  });

  it("does not suppress after the SWEEP retired the stall as dismissed", async () => {
    // The sweep settles an ended stall as `dismissed` too (settleEndedStalls), meaning the exact
    // opposite: "this is over". Without the human stamp to tell them apart, every auto-retirement
    // would permanently silence its own finding.
    const { escalation } = await raise();
    expect(await settleEscalation(t.db, clock, escalation.id, "dismissed")).toBe(true);
    const again = await raise();
    expect(again.suppressed).toBeUndefined();
    expect(again.created).toBe(true);
  });

  it("keeps a live row winning over a dismissed one for the same finding", async () => {
    await dismiss();
    // The stall came back different, so it is on the board again...
    const changed = { ...finding(), reason: "parked 9h ago: usage limit" };
    const live = await raise({ finding: changed });
    expect(live.created).toBe(true);
    // ...and a re-raise of THAT reports the open row, not the older dismissal.
    const again = await raise({ finding: changed });
    expect(again.suppressed).toBeUndefined();
    expect(again.escalation.id).toBe(live.escalation.id);
  });

  it("stays down when only the rendered age moved on (PR #261 review)", async () => {
    // The sweep re-derives `reason` every pass, so an untouched stall crossing an hour boundary
    // arrives with new TEXT and identical evidence. That must not read as a new stall.
    await dismiss(finding({ reason: "run parked 4h: agent exited 1" }));
    const later = await raise({ finding: finding({ reason: "run parked 5h: agent exited 1" }) });
    expect(later.suppressed).toBe(true);
    expect(later.created).toBe(false);
    expect(await listOpenEscalations(t.db, "p1")).toHaveLength(0);
  });

  it("is scoped to its project — one board's dismissal never silences another's", async () => {
    await dismiss();
    const other = await raise({ projectId: "p2" });
    expect(other.suppressed).toBeUndefined();
    expect(await listOpenEscalations(t.db, "p2")).toHaveLength(1);
  });

  it("lists what was put down, newest dismissal first", async () => {
    await dismiss();
    await dismiss(finding({ key: "parked-run:r-2", runId: "r-2" }));
    const rows = await listDismissedEscalations(t.db, "p1");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.dismissedAt != null)).toBe(true);
  });
});

/**
 * The rows on the board the day this shipped were raised before the column existed, so they carry no
 * signature — and a NULL never matches, which would make dismissing exactly the storm that motivated
 * this feature do nothing at all. The stamp is therefore derived at dismissal time from the row's
 * own columns, and it has to hash identically to the same stall raised fresh.
 */
describe("dismissing a row raised before signatures existed", () => {
  /** A row as an upgrading machine has it: raised, then stripped of the column the migration added. */
  async function legacyRow(): Promise<string> {
    const { escalation } = await raise();
    t.db
      .update(schema.escalations)
      .set({ signature: null })
      .where(eq(schema.escalations.id, escalation.id))
      .run();
    return escalation.id;
  }

  it("stamps one on the way down, and suppresses the re-raise like any other", async () => {
    const id = await legacyRow();
    expect(await settleEscalation(t.db, clock, id, "dismissed", true)).toBe(true);

    const row = await getEscalation(t.db, "p1", id);
    expect(row?.signature).toBe(escalationSignature(finding()));
    expect((await raise()).suppressed).toBe(true);
  });

  it("stays down across an age tick too, so the backfill matches a fresh raise", async () => {
    // The two paths must normalize identically: the stamp is derived from the stored `reason`
    // COLUMN, the re-raise from a freshly rendered finding. Normalization living anywhere but
    // inside escalationSignature would drift them apart and re-raise a dismissed legacy row.
    const { escalation } = await raise({ finding: finding({ reason: "run parked 4h: agent exited 1" }) });
    t.db
      .update(schema.escalations)
      .set({ signature: null })
      .where(eq(schema.escalations.id, escalation.id))
      .run();
    expect(await settleEscalation(t.db, clock, escalation.id, "dismissed", true)).toBe(true);

    const later = await raise({ finding: finding({ reason: "run parked 5h: agent exited 1" }) });
    expect(later.suppressed).toBe(true);
  });

  it("still lets a changed stall through", async () => {
    await settleEscalation(t.db, clock, await legacyRow(), "dismissed", true);
    const changed = await raise({ finding: { ...finding(), reason: "parked: worktree dirty" } });
    expect(changed.suppressed).toBeUndefined();
    expect(changed.created).toBe(true);
  });

  it("leaves a row with no start time unsignatured rather than guessing", async () => {
    // Nothing to compare against, so it never suppresses — the honest outcome, and the one that
    // errs toward showing a live stall rather than hiding one.
    const { escalation } = await raise();
    t.db
      .update(schema.escalations)
      .set({ signature: null, since: null })
      .where(eq(schema.escalations.id, escalation.id))
      .run();

    expect(await settleEscalation(t.db, clock, escalation.id, "dismissed", true)).toBe(true);
    expect((await getEscalation(t.db, "p1", escalation.id))?.signature).toBeNull();
    expect((await raise()).suppressed).toBeUndefined();
  });
});

describe("restoreEscalation", () => {
  it("puts a dismissed alert back on the list and clears its resolution", async () => {
    const { escalation } = await raise();
    await settleEscalation(t.db, clock, escalation.id, "dismissed", true);

    expect(await restoreEscalation(t.db, clock, "p1", escalation.id)).toBe(true);
    const [open] = await listOpenEscalations(t.db, "p1");
    expect(open?.id).toBe(escalation.id);
    // Not "dismissed" any more: leaving the word would have the two lists disagreeing about one row.
    expect(open?.resolution).toBeNull();
    expect(open?.dismissedAt).toBeNull();
  });

  it("un-suppresses the raise path, so the stall reports normally again", async () => {
    const { escalation } = await raise();
    await settleEscalation(t.db, clock, escalation.id, "dismissed", true);
    await restoreEscalation(t.db, clock, "p1", escalation.id);
    const again = await raise();
    expect(again.suppressed).toBeUndefined();
    expect(again.escalation.id).toBe(escalation.id);
  });

  it("refuses quietly when the sweep already raised the same finding again", async () => {
    // A dismissal restored elsewhere, or a changed stall re-raised: either way an open row exists,
    // and restoring would collide with `escalations_open_unique`. The honest answer is "already
    // back", not a 500.
    const { escalation } = await raise();
    await settleEscalation(t.db, clock, escalation.id, "dismissed", true);
    await raise({ finding: { ...finding(), reason: "parked again, differently" } });

    expect(await restoreEscalation(t.db, clock, "p1", escalation.id)).toBe(false);
  });

  it("refuses a row nobody dismissed, and one from another project", async () => {
    const { escalation } = await raise();
    expect(await restoreEscalation(t.db, clock, "p1", escalation.id)).toBe(false);
    await settleEscalation(t.db, clock, escalation.id, "dismissed", true);
    expect(await restoreEscalation(t.db, clock, "p2", escalation.id)).toBe(false);
  });
});
