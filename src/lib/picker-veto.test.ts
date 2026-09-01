/**
 * The veto store (anton-jqvy). What these pin is what the two affordances promise: a veto defers ONE
 * target for a BOUNDED window, it is recorded as a decline against the decision it answers, and the
 * window closes by itself — nobody has to remember to clear it, and nothing here can silence a bead
 * for good.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import {
  PICKER_DEFER_WINDOW_MS,
  PICKER_RECORD_WINDOW,
  activeDeferrals,
  deferralVersion,
  listPickerVerdicts,
  pickerTrackRecord,
  recordPickerAccept,
  recordPickerVeto,
} from "./picker-veto";
import type { Clock } from "./jobs/queue";

const NOW = 1_800_000_000_000;
const PROJECT = "p-veto";
const OTHER = "p-other";

let test: TestDb;
let clock: Clock;
let nowMs: number;

beforeEach(async () => {
  test = makeTestDb();
  nowMs = NOW;
  clock = { now: () => nowMs };
  await test.db.insert(schema.projects).values([
    { id: PROJECT, slug: "veto", name: "veto", repoPath: "/tmp/veto" },
    { id: OTHER, slug: "other", name: "other", repoPath: "/tmp/other" },
  ]);
});

afterEach(() => test.close());

const at = (ms: number) => new Date(ms);

describe("recording a veto", () => {
  it("defers that target only, for the bounded window", async () => {
    await recordPickerVeto(test.db, clock, {
      projectId: PROJECT,
      beadId: "anton-a",
      action: "not-now",
    });

    const held = await activeDeferrals(test.db, PROJECT, at(NOW));
    expect([...held.keys()]).toEqual(["anton-a"]);
    expect(held.get("anton-a")).toBe(NOW + PICKER_DEFER_WINDOW_MS);
  });

  it("holds nothing on another project — a veto is one operator's pacing, not board state", async () => {
    await recordPickerVeto(test.db, clock, { projectId: PROJECT, beadId: "anton-a", action: "never" });
    expect((await activeDeferrals(test.db, OTHER, at(NOW))).size).toBe(0);
  });

  it("lets the target back in once the window closes — the bound is what makes it not a blocklist", async () => {
    await recordPickerVeto(test.db, clock, {
      projectId: PROJECT,
      beadId: "anton-a",
      action: "not-now",
    });

    const inside = at(NOW + PICKER_DEFER_WINDOW_MS - 1000);
    expect((await activeDeferrals(test.db, PROJECT, inside)).size).toBe(1);

    const after = at(NOW + PICKER_DEFER_WINDOW_MS + 1000);
    expect((await activeDeferrals(test.db, PROJECT, after)).size).toBe(0);
  });

  it("keeps the LATER expiry when a target is vetoed twice — a second veto never shortens the first", async () => {
    await recordPickerVeto(test.db, clock, {
      projectId: PROJECT,
      beadId: "anton-a",
      action: "not-now",
    });
    const later = NOW + 60_000;
    nowMs = later;
    await recordPickerVeto(test.db, clock, { projectId: PROJECT, beadId: "anton-a", action: "never" });

    const held = await activeDeferrals(test.db, PROJECT, at(later));
    expect(held.get("anton-a")).toBe(later + PICKER_DEFER_WINDOW_MS);
  });

  it("holds nothing on an ACCEPT, whatever timestamp it carries", async () => {
    // Written raw: no code path puts an expiry on an accept today, and the point of the assertion is
    // that one appearing later cannot silently hold a target out of the plan. The verdict is the
    // intent; the expiry is only how long it lasts.
    await test.db.insert(schema.pickerVerdicts).values({
      id: "v-accepted",
      projectId: PROJECT,
      beadId: "anton-a",
      verdict: "accepted",
      action: "release",
      deferredUntil: at(NOW + PICKER_DEFER_WINDOW_MS),
      decidedAt: at(NOW),
    });

    expect((await activeDeferrals(test.db, PROJECT, at(NOW))).size).toBe(0);
  });

  it("both actions defer — a veto that left the card in the next plan would be no veto", async () => {
    await recordPickerVeto(test.db, clock, { projectId: PROJECT, beadId: "anton-a", action: "not-now" });
    await recordPickerVeto(test.db, clock, { projectId: PROJECT, beadId: "anton-b", action: "never" });

    const held = await activeDeferrals(test.db, PROJECT, at(NOW));
    expect([...held.keys()].sort()).toEqual(["anton-a", "anton-b"]);
  });
});

describe("the decline record", () => {
  it("records both vetoes as declines against the decision they answer", async () => {
    await recordPickerVeto(test.db, clock, {
      projectId: PROJECT,
      beadId: "anton-a",
      action: "never",
      rule: "the work policy armed on this machine",
      criterion: "labels:domain",
      rank: 2,
      planId: "cafebabecafebabe",
    });

    const [row] = await listPickerVerdicts(test.db, PROJECT);
    expect(row).toMatchObject({
      beadId: "anton-a",
      verdict: "declined",
      action: "never",
      rule: "the work policy armed on this machine",
      criterion: "labels:domain",
      rank: 2,
      planId: "cafebabecafebabe",
    });
  });

  it("counts declines as the track record earned autonomy reads", async () => {
    await recordPickerVeto(test.db, clock, { projectId: PROJECT, beadId: "anton-a", action: "not-now" });
    await recordPickerVeto(test.db, clock, { projectId: PROJECT, beadId: "anton-b", action: "never" });

    expect(await pickerTrackRecord(test.db, PROJECT)).toEqual({
      accepted: 0,
      declined: 2,
      settled: 2,
    });
  });

  it("keeps an expired veto in the record — the hold ends, the decision does not", async () => {
    await recordPickerVeto(test.db, clock, { projectId: PROJECT, beadId: "anton-a", action: "not-now" });

    const after = at(NOW + PICKER_DEFER_WINDOW_MS * 2);
    expect((await activeDeferrals(test.db, PROJECT, after)).size).toBe(0);
    expect((await pickerTrackRecord(test.db, PROJECT)).declined).toBe(1);
  });

  it("cuts the window at a fixed boundary when verdicts share a timestamp", async () => {
    // `decided_at` is second-resolution, so a burst of verdicts — a double-click, a seeded fixture,
    // two tabs answering at once — can tie. Without a tiebreaker the row that falls outside the
    // window is SQLite's choice, and the counts earned autonomy reads change between two reads of
    // one table (PR #212 review). The id settles it: the window is the newest by id, always.
    const row = (i: number) => ({
      id: `v-${String(i).padStart(2, "0")}`,
      projectId: PROJECT,
      beadId: `anton-${i}`,
      // The lowest id is the only decline, so it is exactly the row the boundary drops.
      verdict: i === 0 ? "declined" : "accepted",
      action: i === 0 ? "not-now" : "release",
      decidedAt: at(NOW),
    });
    // Written LAST, so insertion order and id order disagree: a read that fell back to the table's
    // own row order would keep this decline and drop an accept instead.
    await test.db
      .insert(schema.pickerVerdicts)
      .values([...Array.from({ length: PICKER_RECORD_WINDOW }, (_, i) => row(i + 1)), row(0)]);

    expect(await pickerTrackRecord(test.db, PROJECT)).toEqual({
      accepted: PICKER_RECORD_WINDOW,
      declined: 0,
      settled: PICKER_RECORD_WINDOW,
    });
    // The audit trail behind the counts reads the same window, in the same order.
    const listed = await listPickerVerdicts(test.db, PROJECT);
    expect(listed.map((r) => r.beadId)).toEqual(
      Array.from({ length: PICKER_RECORD_WINDOW }, (_, i) => `anton-${PICKER_RECORD_WINDOW - i}`),
    );
  });

  it("counts an accept beside the declines, so the record has two sides", async () => {
    await test.db.insert(schema.pickerVerdicts).values({
      id: "v-accept",
      projectId: PROJECT,
      beadId: "anton-c",
      verdict: "accepted",
      action: "release",
      decidedAt: at(NOW),
    });
    await recordPickerVeto(test.db, clock, { projectId: PROJECT, beadId: "anton-a", action: "never" });

    expect(await pickerTrackRecord(test.db, PROJECT)).toEqual({
      accepted: 1,
      declined: 1,
      settled: 2,
    });
  });
});

describe("recording an accept", () => {
  it("records the release against the pick it answers, and defers nothing", async () => {
    await recordPickerAccept(test.db, clock, {
      projectId: PROJECT,
      beadId: "anton-a",
      rule: "the work policy armed on this machine",
      rank: 1,
      planId: "cafebabecafebabe",
    });

    expect(await listPickerVerdicts(test.db, PROJECT)).toEqual([
      expect.objectContaining({
        beadId: "anton-a",
        verdict: "accepted",
        action: "release",
        rule: "the work policy armed on this machine",
        rank: 1,
        planId: "cafebabecafebabe",
      }),
    ]);
    // Agreeing with a pick has no window to bound, so it holds nothing out of the next plan.
    expect((await activeDeferrals(test.db, PROJECT, at(NOW))).size).toBe(0);
  });

  it("counts one accept per PICK, so a re-released target never inflates the record", async () => {
    const pick = { projectId: PROJECT, beadId: "anton-a", rank: 1, planId: "d1" };
    await recordPickerAccept(test.db, clock, pick);
    nowMs = NOW + 5_000;
    await recordPickerAccept(test.db, clock, pick);

    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ accepted: 1, settled: 1 });
  });

  it("counts one accept when two releases of the same pick OVERLAP", async () => {
    const pick = { projectId: PROJECT, beadId: "anton-a", rank: 1, planId: "d1" };
    // A read-then-insert lets both requests pass the check before either writes. The unique index is
    // what makes the second one a no-op instead of a second accept.
    await Promise.all([
      recordPickerAccept(test.db, clock, pick),
      recordPickerAccept(test.db, clock, pick),
    ]);

    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ accepted: 1, settled: 1 });
  });

  it("leaves a DECLINE against the same plan repeatable — a second veto extends the window", async () => {
    const veto = { projectId: PROJECT, beadId: "anton-a", action: "not-now" as const, planId: "d1" };
    await recordPickerVeto(test.db, clock, veto);
    nowMs = NOW + 60_000;
    const second = await recordPickerVeto(test.db, clock, veto);

    expect(second).toMatchObject({ recorded: true });
    const untilMs = second.recorded ? second.deferral.untilMs : undefined;
    expect(untilMs).toBe(nowMs + PICKER_DEFER_WINDOW_MS);
    expect((await activeDeferrals(test.db, PROJECT, at(nowMs))).get("anton-a")).toBe(untilMs);
  });

  it("counts a repeated veto of one pick ONCE — two tabs are one answer, not two declines", async () => {
    // The window still extends (above); what must not double is the EVIDENCE. `pickerTrackRecord`
    // counts rows, so a retry that filed a second decline would inflate the negative half of the
    // record and push other decisions out of its rolling window.
    const veto = { projectId: PROJECT, beadId: "anton-a", action: "not-now" as const, planId: "d1" };
    await recordPickerVeto(test.db, clock, veto);
    nowMs = NOW + 60_000;
    await recordPickerVeto(test.db, clock, veto);

    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ declined: 1, settled: 1 });
    expect((await listPickerVerdicts(test.db, PROJECT)).length).toBe(1);
  });

  it("keeps the provenance a repeat veto no longer carries, and takes the criterion it adds", async () => {
    // A stale tab that has lost the rank must not erase the rank the first veto recorded, and a
    // `Never` following a `not-now` still has to leave the criterion the operator was sent at.
    const pick = { projectId: PROJECT, beadId: "anton-a", planId: "d1" };
    await recordPickerVeto(test.db, clock, {
      ...pick,
      action: "not-now",
      rule: "the work policy armed on this machine",
      rank: 2,
    });
    nowMs = NOW + 60_000;
    await recordPickerVeto(test.db, clock, { ...pick, action: "never", criterion: "labels:domain" });

    expect((await listPickerVerdicts(test.db, PROJECT))[0]).toMatchObject({
      action: "never",
      rule: "the work policy armed on this machine",
      criterion: "labels:domain",
      rank: 2,
      planId: "d1",
    });
  });

  it("files its own decline against a LATER plan that re-picks the target", async () => {
    const veto = { projectId: PROJECT, beadId: "anton-a", action: "not-now" as const };
    await recordPickerVeto(test.db, clock, { ...veto, planId: "d1" });
    nowMs = NOW + 60_000;
    await recordPickerVeto(test.db, clock, { ...veto, planId: "d2" });

    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ declined: 2, settled: 2 });
  });

  it("records again once a later plan re-picks it — a new decision is a new answer", async () => {
    await recordPickerAccept(test.db, clock, { projectId: PROJECT, beadId: "anton-a", planId: "d1" });
    nowMs = NOW + 60_000;
    await recordPickerAccept(test.db, clock, { projectId: PROJECT, beadId: "anton-a", planId: "d2" });

    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ accepted: 2, settled: 2 });
  });

  it("records a release against no recorded plan — there is no pick to dedupe on", async () => {
    await recordPickerAccept(test.db, clock, { projectId: PROJECT, beadId: "anton-a" });
    await recordPickerAccept(test.db, clock, { projectId: PROJECT, beadId: "anton-a" });

    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ accepted: 2 });
  });

  it("keeps another project's record its own", async () => {
    await recordPickerAccept(test.db, clock, { projectId: PROJECT, beadId: "anton-a", planId: "d1" });
    expect(await pickerTrackRecord(test.db, OTHER)).toEqual({ accepted: 0, declined: 0, settled: 0 });
  });
});

/**
 * ONE ANSWER PER PICK (PR #212 review). The accept and the decline come from two different routes,
 * so a pick open in two tabs can be released and vetoed at once — and only the store can decide that,
 * because no client-side lock spans two tabs. What these pin is the shape of the refusal: first
 * answer wins, the loser records NOTHING, and only the OPPOSITE verdict on the SAME pick conflicts.
 */
describe("opposite verdicts on one pick", () => {
  const PICK = { projectId: PROJECT, beadId: "anton-a", planId: "d1" };

  it("refuses a veto of a pick a release already accepted, and defers nothing", async () => {
    await recordPickerAccept(test.db, clock, PICK);

    const outcome = await recordPickerVeto(test.db, clock, { ...PICK, action: "not-now" });

    expect(outcome).toEqual({ recorded: false, reason: "released" });
    // The run is under way, so nothing is set aside and the record keeps the single answer it had.
    expect((await activeDeferrals(test.db, PROJECT, at(NOW))).size).toBe(0);
    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ accepted: 1, declined: 0 });
  });

  it("refuses an accept of a pick a veto already declined, and keeps the hold", async () => {
    await recordPickerVeto(test.db, clock, { ...PICK, action: "never" });

    expect(await recordPickerAccept(test.db, clock, PICK)).toBe("vetoed");

    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ accepted: 0, declined: 1 });
    expect((await activeDeferrals(test.db, PROJECT, at(NOW))).size).toBe(1);
  });

  it("settles a release and a veto that OVERLAP on exactly one verdict", async () => {
    // Neither request can see the other's write before it commits, which is the whole race the
    // client-side lock cannot cover: the store takes the write lock before it reads.
    await Promise.all([
      recordPickerAccept(test.db, clock, PICK),
      recordPickerVeto(test.db, clock, { ...PICK, action: "not-now" }),
    ]);

    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ settled: 1 });
  });

  it("answers a LATER plan's pick freshly — a new decision is not the old one's opposite", async () => {
    await recordPickerAccept(test.db, clock, PICK);

    const outcome = await recordPickerVeto(test.db, clock, {
      projectId: PROJECT,
      beadId: "anton-a",
      action: "not-now",
      planId: "d2",
    });

    expect(outcome).toMatchObject({ recorded: true });
    expect(await pickerTrackRecord(test.db, PROJECT)).toMatchObject({ accepted: 1, declined: 1 });
  });

  it("leaves a digest-less verdict unconstrained — it answers no recorded pick", async () => {
    await recordPickerAccept(test.db, clock, { projectId: PROJECT, beadId: "anton-a" });

    const outcome = await recordPickerVeto(test.db, clock, {
      projectId: PROJECT,
      beadId: "anton-a",
      action: "not-now",
    });

    expect(outcome).toMatchObject({ recorded: true });
  });

  it("keeps another project's identical pick its own", async () => {
    await recordPickerAccept(test.db, clock, PICK);

    const outcome = await recordPickerVeto(test.db, clock, {
      projectId: OTHER,
      beadId: "anton-a",
      action: "not-now",
      planId: "d1",
    });

    expect(outcome).toMatchObject({ recorded: true });
  });
});

describe("the freshness token", () => {
  it("moves when a window closes, without any write", () => {
    const held = new Map([["anton-a", NOW + PICKER_DEFER_WINDOW_MS]]);
    expect(deferralVersion(held)).not.toBe(deferralVersion(new Map()));
    expect(deferralVersion(new Map())).toBe("none");
  });

  it("is order-independent — two reads of the same holds agree", () => {
    const a = new Map([
      ["anton-a", 1],
      ["anton-b", 2],
    ]);
    const b = new Map([
      ["anton-b", 2],
      ["anton-a", 1],
    ]);
    expect(deferralVersion(a)).toBe(deferralVersion(b));
  });
});
