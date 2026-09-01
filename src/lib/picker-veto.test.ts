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
  activeDeferrals,
  deferralVersion,
  listPickerVerdicts,
  pickerTrackRecord,
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
      planDigest: "cafebabecafebabe",
    });

    const [row] = await listPickerVerdicts(test.db, PROJECT);
    expect(row).toMatchObject({
      beadId: "anton-a",
      verdict: "declined",
      action: "never",
      rule: "the work policy armed on this machine",
      criterion: "labels:domain",
      rank: 2,
      planDigest: "cafebabecafebabe",
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
