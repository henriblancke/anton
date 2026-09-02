/**
 * The decision log's merge (anton-vfvg / R3.10). What these pin is the reading it gives an operator:
 * anton's unattended starts and the operator's vetoes interleaved in one time order, `Never` told
 * apart from `not now` because only one of them names a rule to tighten, and the accepts left out —
 * a release is the operator starting a pick themselves, not something that happened without them.
 */
import { describe, expect, it } from "vitest";

import { PICKER_LOG_LIMIT, pickerLogEntries } from "./picker-log";
import type { PickerStartRow } from "./picker-starts";
import type { PickerVerdictRow } from "./picker-veto";

const NOW = 1_800_000_000_000;

function startRow(over: Partial<PickerStartRow> = {}): PickerStartRow {
  return {
    beadId: "anton-a",
    rank: 1,
    ranked: 4,
    rule: "the work policy armed on this machine",
    jobId: "job-1",
    startedAtMs: NOW,
    ...over,
  };
}

function verdictRow(over: Partial<PickerVerdictRow> = {}): PickerVerdictRow {
  return {
    beadId: "anton-b",
    verdict: "declined",
    action: "not-now",
    rule: "the work policy armed on this machine",
    rank: 2,
    decidedAtMs: NOW,
    deferredUntilMs: NOW + 86_400_000,
    ...over,
  };
}

describe("pickerLogEntries", () => {
  it("is empty when the picker has neither started nor been refused anything", () => {
    expect(pickerLogEntries({ starts: [], verdicts: [] })).toEqual([]);
  });

  it("carries a start with the rank it held and the rule that admitted it", () => {
    const [entry] = pickerLogEntries({ starts: [startRow()], verdicts: [] });
    expect(entry).toMatchObject({
      kind: "start",
      beadId: "anton-a",
      rank: 1,
      ranked: 4,
      rule: "the work policy armed on this machine",
      atMs: NOW,
    });
  });

  it("files `not now` as a deferral, carrying the window it bought", () => {
    const [entry] = pickerLogEntries({ starts: [], verdicts: [verdictRow()] });
    expect(entry).toMatchObject({ kind: "deferral", heldUntilMs: NOW + 86_400_000 });
    expect(entry?.criterion).toBeUndefined();
  });

  it("files `Never` as a veto, carrying the criterion it sent the operator to tighten", () => {
    const [entry] = pickerLogEntries({
      starts: [],
      verdicts: [verdictRow({ action: "never", criterion: "labels:severity" })],
    });
    expect(entry).toMatchObject({ kind: "veto", criterion: "labels:severity" });
  });

  it("leaves accepts out — a release is the operator's own start, not an unattended one", () => {
    const entries = pickerLogEntries({
      starts: [],
      verdicts: [
        verdictRow({ beadId: "anton-released", verdict: "accepted", action: "release" }),
        verdictRow({ beadId: "anton-vetoed" }),
      ],
    });
    expect(entries.map((e) => e.beadId)).toEqual(["anton-vetoed"]);
  });

  it("interleaves the two records newest first — the alternation IS the reading", () => {
    const entries = pickerLogEntries({
      starts: [
        startRow({ beadId: "anton-started-late", startedAtMs: NOW + 3_000 }),
        startRow({ beadId: "anton-started-early", startedAtMs: NOW + 1_000 }),
      ],
      verdicts: [verdictRow({ beadId: "anton-refused", decidedAtMs: NOW + 2_000 })],
    });
    expect(entries.map((e) => e.beadId)).toEqual([
      "anton-started-late",
      "anton-refused",
      "anton-started-early",
    ]);
  });

  it("orders a same-second start and veto deterministically, not by which store was read first", () => {
    const input = {
      starts: [startRow({ beadId: "anton-z" })],
      verdicts: [verdictRow({ beadId: "anton-a", decidedAtMs: NOW })],
    };
    const order = pickerLogEntries(input).map((e) => e.key);
    expect(pickerLogEntries(input).map((e) => e.key)).toEqual(order);
    // `deferral` before `start`: the tie-break is stable, whatever it resolves to.
    expect(order).toEqual(["deferral:anton-a:" + NOW, "start:anton-z:" + NOW]);
  });

  it("shows a bounded window of the newest decisions", () => {
    const starts = Array.from({ length: PICKER_LOG_LIMIT + 6 }, (_, i) =>
      startRow({ beadId: `anton-${i}`, startedAtMs: NOW + i * 1_000 }),
    );
    const entries = pickerLogEntries({ starts, verdicts: [] });
    expect(entries).toHaveLength(PICKER_LOG_LIMIT);
    expect(entries[0]?.beadId).toBe(`anton-${PICKER_LOG_LIMIT + 5}`);
  });
});
