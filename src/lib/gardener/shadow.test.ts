/**
 * The shadow pass (anton-lmps) driven DIRECTLY: proposals in, one {@link ShadowRecord} each out,
 * over a stubbed board read.
 *
 * The jobs-layer suites prove the pass runs and that a real board comes back byte-identical. What
 * only this seam can hold is the CLASSIFICATION — the four outcomes an operator reads a week of
 * shadow output for, and which anton-zy7f is about to arm real writes on top of:
 *
 *   • EACH OUTCOME IS ITS OWN ANSWER. `apply`, `settled`, `refuse` and `error` say four different
 *     things to a founder deciding whether to arm a kind, and only `error` is anton failing to
 *     decide — folding it into `refuse` would report a board that declined a move nothing asked it.
 *   • A FALSIFIED PREMISE REFUSES, VERBATIM. A subject rewritten since the pass observed the board
 *     is the case shadow exists to surface, and the record carries `planApply`'s own reason rather
 *     than a paraphrase — an operator arms a kind on the strength of those words.
 *   • NOTHING IS WRITTEN. Asserted after EVERY case below (see the `afterEach`), because the one
 *     property this module exists to hold is the negative one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead } from "../beads/bd";
import {
  emptyTrackRecord,
  resolveProposalAutonomyPolicy,
  type ProposalTrackRecord,
} from "./autonomy";
import { makeDetection, planOf, type GardenerDetection } from "./detections";
import type { EmittedProposal } from "./emit";
import { readPassRecords } from "./record";
import type { ShadowInput, ShadowRecord } from "./shadow";

/**
 * Every bd seam call the shadow made that was addressed at a REPO — which is every call that would
 * have run the bd CLI. The seam's own convention is what tells them apart: a call that reaches bd
 * takes the repo path first, while the pure predicates `planApply` reads a board through
 * (`isAbandoned`, `parentOf`, `isRunLive`, …) take beads. Recording by that rule rather than by a
 * hand-kept list of verbs means a bd verb added later is covered the day it is added.
 */
const repoCalls: string[] = [];
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  const beads = Object.fromEntries(
    Object.entries(actual.beads).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            if (typeof args[0] === "string") repoCalls.push(`${name} ${args[0]}`);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  );
  return { ...actual, beads };
});

const loadMock = vi.fn<(cwd: string) => Promise<Bead[]>>();
vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: (...a: [string]) => loadMock(...a) };
});

/** The decision seam, delegating to the real planner — primed to throw only by the `error` case. */
const planApplyMock = vi.fn<typeof realPlanApply>();
vi.mock("./apply", async () => {
  const actual = await vi.importActual<typeof import("./apply")>("./apply");
  return {
    ...actual,
    planApply: (...a: Parameters<typeof actual.planApply>) => planApplyMock(...a),
  };
});

const { planApply: realPlanApply } = await vi.importActual<typeof import("./apply")>("./apply");
const { shadowProposals } = await import("./shadow");

const REPO = "/tmp/gardener-shadow";
/** When the pass READ the board its proposals describe — what every premise check dates against. */
const OBSERVED = Date.parse("2026-08-02T00:00:00Z");
/** When the shadow runs: the same pass, minutes later, against a board it re-reads. */
const NOW = Date.parse("2026-08-02T00:05:00Z");

/** Untouched since January, so no premise fence and no liveness signal stands in the way. */
const bead = (id: string, over: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  updated_at: "2025-01-01T00:00:00Z",
  ...over,
});

/** The simplest mechanical ask there is: park a bead nobody has touched in a year. */
const staleAsk = (subject: string): GardenerDetection =>
  makeDetection({
    kind: "stale",
    move: "retire",
    retireAs: "defer",
    subjects: [subject],
    summary: `${subject} has not moved since January`,
    evidence: [`${subject} was last written to 2025-01-01`],
  });

/** The same ask, filed — the shape the pass hands its shadow. */
const filed = (detection: GardenerDetection, id: string): EmittedProposal => ({
  id,
  fingerprint: detection.fingerprint,
  detection,
});

/** One `stale` proposal about `anton-a`, filed as `anton-p1` — what nearly every case shadows. */
const oneAsk = (): EmittedProposal[] => [filed(staleAsk("anton-a"), "anton-p1")];

/** Only `stale` is shadowed; everything else stays a proposal. */
const policy = resolveProposalAutonomyPolicy({ stale: "shadow" });
/** The earned floor gates `apply` alone, so the shadow set is the same however the record reads. */
const NO_RECORD = emptyTrackRecord();

const log = vi.fn<(chunk: string) => Promise<void>>();
/** Everything the pass recorded, as one string — the record a founder reads on the jobs page. */
const recorded = (): string => log.mock.calls.map(([chunk]) => chunk).join("");

/** The board this case's shadow re-reads, held so the `afterEach` can prove it came back whole. */
let served: Bead[] | undefined;
let servedBytes: string | undefined;
function serve(board: Bead[]): Bead[] {
  served = board;
  servedBytes = JSON.stringify(board);
  loadMock.mockResolvedValue(board);
  return board;
}

function shadow(
  created: EmittedProposal[],
  over: Partial<ShadowInput> = {},
): Promise<ShadowRecord[]> {
  return shadowProposals({
    repo: REPO,
    created,
    policy,
    record: NO_RECORD,
    observedAtMs: OBSERVED,
    nowMs: NOW,
    producer: "[gardener]",
    log,
    ...over,
  });
}

/** The one record this pass produced — a shadow that recorded anything else is not this case. */
const only = (records: ShadowRecord[]): ShadowRecord => {
  expect(records).toHaveLength(1);
  return records[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  repoCalls.length = 0;
  served = undefined;
  servedBytes = undefined;
  log.mockResolvedValue(undefined);
  planApplyMock.mockImplementation(realPlanApply);
  serve([bead("anton-a")]);
});

// The negative the module exists for, asked of every case rather than of one: nothing the shadow
// did reached bd, and the board it was handed came back unmutated.
afterEach(() => {
  expect(repoCalls).toEqual([]);
  if (served) expect(JSON.stringify(served)).toBe(servedBytes);
});

describe("the four outcomes", () => {
  it("records apply for an ask whose preconditions all still hold", async () => {
    const record = only(await shadow(oneAsk()));

    expect(record).toEqual({
      proposal: "anton-p1",
      kind: "stale",
      move: "retire",
      retireAs: "defer",
      subjects: ["anton-a"],
      outcome: "apply",
      detail: "deferred anton-a out of the ready set",
    });
    expect(recorded()).toBe(
      "[gardener] SHADOW anton-p1 (stale) retire/defer anton-a — WOULD APPLY: " +
        "deferred anton-a out of the ready set\n",
    );
  });

  it("records settled when the board already reads as the ask wanted", async () => {
    serve([bead("anton-a", { status: "deferred" })]);

    const record = only(await shadow(oneAsk()));

    expect(record.outcome).toBe("settled");
    expect(record.detail).toBe("anton-a is already deferred");
    expect(recorded()).toContain("ALREADY SETTLED: anton-a is already deferred");
  });

  it("records refuse when the subject has left the board", async () => {
    serve([bead("anton-b")]);

    const record = only(await shadow(oneAsk()));

    expect(record.outcome).toBe("refuse");
    expect(record.detail).toContain("anton-a is no longer on the board");
    expect(recorded()).toContain("WOULD REFUSE:");
  });

  // `error` is anton failing to DECIDE, and it is the one outcome that says nothing about the board
  // — so a planner that throws must not be reported as a refusal, and must not cost the pass the
  // proposals filed beside it.
  it("records error when the decision itself throws, and shadows the rest of the pass anyway", async () => {
    planApplyMock.mockImplementationOnce(() => {
      throw new Error("indexBoard exploded");
    });
    serve([bead("anton-a"), bead("anton-b")]);

    const records = await shadow([
      filed(staleAsk("anton-a"), "anton-p1"),
      filed(staleAsk("anton-b"), "anton-p2"),
    ]);

    expect(records.map((r) => r.outcome)).toEqual(["error", "apply"]);
    expect(records[0].detail).toBe("indexBoard exploded");
    expect(recorded()).toContain("COULD NOT SHADOW: indexBoard exploded");
  });
});

/**
 * The case shadow is worth shipping for: the pass filed the ask against one board and the shadow
 * decides it against another. An `apply` here would promise an operator a move the approval would
 * refuse.
 */
describe("a premise the board has since falsified", () => {
  it("refuses a subject written to since the pass observed the board, in planApply's own words", async () => {
    const rewritten = bead("anton-a", { updated_at: "2026-08-02T00:02:00Z" });
    serve([rewritten]);

    const record = only(await shadow(oneAsk()));

    expect(record.outcome).toBe("refuse");
    expect(record.detail).toContain("anton-a has been written to since this proposal was filed");
    expect(record.detail).toContain("deferring it now would park work somebody has since picked back up");
    // Verbatim, not paraphrased: the string the armed pass would have refused with.
    const refusal = realPlanApply(planOf(staleAsk("anton-a")), [rewritten], {
      nowMs: NOW,
      observedAtMs: OBSERVED,
    });
    expect(refusal.status).toBe("refuse");
    expect(record.detail).toBe(refusal.status === "refuse" ? refusal.reason : undefined);
  });

  // The same board, shadowed as of the moment the pass READ it, is the ask the founder was shown.
  it("would have applied the very same ask against the board the pass observed", async () => {
    serve([bead("anton-a")]);

    expect(only(await shadow(oneAsk())).outcome).toBe("apply");
  });
});

describe("which proposals a pass shadows", () => {
  /** A record that clears every tier's bar, so an `apply` kind resolves to `apply` and not `propose`. */
  const EARNED: ProposalTrackRecord = { ...NO_RECORD, stale: { settled: 30, applied: 30 } };

  it.each([
    ["propose", NO_RECORD],
    // An armed kind is armed.ts's to write, not the shadow's to describe — the two levels are
    // disjoint, or one proposal would be both reported as hypothetical and applied for real.
    ["apply", EARNED],
  ] as const)("shadows nothing when the kind is set to %s", async (level, record) => {
    const records = await shadow(oneAsk(), {
      policy: resolveProposalAutonomyPolicy({ stale: level }),
      record,
    });

    expect(records).toEqual([]);
    expect(recorded()).toBe("");
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("shadows only the shadow-armed kinds a pass filed, in the order they were filed", async () => {
    const shipped = makeDetection({
      kind: "shipped-orphan",
      move: "retire",
      retireAs: "close",
      subjects: ["anton-b"],
      summary: "anton-b shipped in abc1234",
      evidence: ["anton-b names commit abc1234"],
    });
    serve([bead("anton-a"), bead("anton-b"), bead("anton-c")]);

    const records = await shadow([
      filed(staleAsk("anton-c"), "anton-p1"),
      filed(shipped, "anton-p2"),
      filed(staleAsk("anton-a"), "anton-p3"),
    ]);

    expect(records.map((r) => r.proposal)).toEqual(["anton-p1", "anton-p3"]);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});

describe("a shadow that cannot run", () => {
  it("says so and records nothing when the board will not read", async () => {
    served = undefined;
    loadMock.mockRejectedValue(new Error("bd list exploded"));

    expect(await shadow(oneAsk())).toEqual([]);
    // A note, not a record: a pass whose board would not read must not read as one that found
    // nothing to shadow (record.ts `isCleanPass`).
    const { records, notes } = readPassRecords(recorded());
    expect(records).toEqual([]);
    expect(notes).toEqual([
      "SHADOW could not read the board — bd list exploded; nothing shadowed",
    ]);
  });

  it("stops before the board read when the pass was already cancelled", async () => {
    expect(await shadow(oneAsk(), { signal: AbortSignal.abort() })).toEqual([]);
    expect(loadMock).not.toHaveBeenCalled();
    expect(recorded()).toBe("");
  });

  // Best-effort, never silent: a log store that will not take a write must not fail the pass it
  // describes, and must not leave the shadow looking like it decided nothing.
  it("keeps deciding when the log will not take the line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.mockRejectedValue(new Error("log is gone"));

    expect(only(await shadow(oneAsk())).outcome).toBe("apply");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not record a shadow"));
    warn.mockRestore();
  });
});
