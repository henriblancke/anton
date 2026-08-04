import { describe, expect, it } from "vitest";

import { escalationAge, stuckFor } from "@/components/board/escalation-age";
import type { EscalationView } from "@/lib/types";

const HOUR = 3_600_000;

function escalation(o: Partial<EscalationView> = {}): EscalationView {
  const startedAt = Date.now() - 4 * HOUR;
  return {
    id: "esc-1",
    findingKey: "parked-run:r-1",
    kind: "parked-run",
    reason: "parked 4h ago: agent exited 1",
    beadId: "anton-t9",
    epicBeadId: "anton-e1",
    runId: "r-1",
    since: Math.floor(startedAt / 1000),
    ageMs: 4 * HOUR,
    status: "open",
    noted: true,
    raisedAt: Math.floor(startedAt / 1000),
    ...o,
  };
}

describe("escalationAge", () => {
  const NOW = 1_700_000_000_000;
  const at = (o: Partial<EscalationView>) => escalationAge({ ...escalation(), ...o }, NOW);

  it("ages the stall as of NOW, not as of the sweep that found it", () => {
    // An escalation raised at 02:00 and still open at 09:00 has been stuck seven hours; showing the
    // twenty minutes the sweep saw would quietly under-report every stall the founder is judging.
    expect(at({ since: Math.floor((NOW - 7 * HOUR) / 1000), ageMs: 20 * 60_000 })).toBe("7h");
  });

  it("uses the sweep's frozen age only when nothing recorded a start time", () => {
    expect(at({ since: undefined, ageMs: 2 * HOUR })).toBe("2h");
  });
});

describe("stuckFor", () => {
  it("reads in whole units, coarsening as the stall ages", () => {
    expect(stuckFor(42 * 60_000)).toBe("42m");
    expect(stuckFor(90 * 60_000)).toBe("1h");
    expect(stuckFor(3 * 24 * HOUR)).toBe("3d");
  });

  it("clamps a clock skew to 0m rather than rendering a negative age", () => {
    expect(stuckFor(-5 * HOUR)).toBe("0m");
  });
});
