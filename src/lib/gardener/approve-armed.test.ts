/**
 * The approve verb applied UNATTENDED (anton-gmbz), with the real apply underneath the armed walk —
 * the one place the fence, the write and the walk's totality are asserted together.
 *
 * `armed.test.ts` stubs `applyProposal` whole, so it can prove the walk's cancel and publish
 * contracts but never what an approve actually does to a bead; `apply.test.ts` drives the real apply
 * but knows nothing of a pass. The property this file exists for spans both, and it is the one an
 * operator who armed the dearest verb is trusting: A REFUSAL IS THE BOARD DECLINING, NOT THE PASS
 * FAILING. The stale ask keeps its reason on its own bead and stays open, and the sound one behind
 * it is still approved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead } from "../beads/bd";
import {
  calls,
  cold,
  listBoard,
  planFor,
  proposalFor,
  record,
  REPO,
  resetSeam,
  setSnapshot,
  showBead,
  warm,
} from "./apply.fixture";
import { makeDetection, type GardenerDetection } from "./detections";
import { emptyTrackRecord, resolveProposalAutonomyPolicy } from "./autonomy";
import type { EmittedProposal } from "./emit";

// Every reference to the seam sits INSIDE a wrapper: vitest hoists this factory above the imports
// above, so touching one while building the object would read it before it is initialised.
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (_cwd: string, id: string) => showBead(id),
      list: (_cwd: string, extra: string[] = []) => listBoard(extra),
      note: (_cwd: string, id: string, text: string) => record("note", id, text),
      close: (_cwd: string, id: string, reason?: string) => record("close", id, reason ?? ""),
      approve: (_cwd: string, id: string) => record("approve", id),
      assign: (_cwd: string, id: string, actor: string) => record("assign", id, actor),
      unassign: (_cwd: string, id: string) => record("assign", id, ""),
      // The walk pulls before every apply and publishes once at the end; neither may reach a remote.
      pull: async () => undefined,
      push: async () => "synced" as const,
    },
  };
});

vi.mock("../operator", () => ({ resolveOperator: async () => "operator-1" }));

const { applyArmedProposals } = await import("./armed");

/** The ask the product master files: this target ranks next and nothing has approved it. */
function withheld(subject: string): GardenerDetection {
  return makeDetection({
    kind: "withheld-approval",
    move: "approve",
    subjects: [subject],
    summary: `${subject} is the board's next target and carries no approval`,
    evidence: [`${subject} ranks first among the run targets`],
  });
}

/** The proposal bead, and the filed shape the walk reads it through — one pair per subject. */
function ask(id: string, subject: string): { proposal: Bead; filed: EmittedProposal } {
  const detection = withheld(subject);
  const plan = planFor({ kind: detection.kind, move: detection.move, subjects: [subject] });
  return {
    proposal: proposalFor(plan, { id, labels: [plan.fingerprint, "domain:eng", "source:pm"] }),
    filed: { id, fingerprint: detection.fingerprint, detection },
  };
}

/** A run target clearing all four of approval's promises, untouched since the proposals were filed. */
const target = (id: string, extra: Partial<Bead> = {}): Bead =>
  cold(id, { acceptance_criteria: "- [ ] it ships", ...extra });

const log = vi.fn<(chunk: string) => Promise<void>>();
/** Everything the pass recorded, as one string — the record a founder reads on the jobs page. */
const recorded = (): string => log.mock.calls.map(([chunk]) => chunk).join("");

/** `withheld-approval` is a `history`-tier move, so its record has to clear the dearest bar. */
const trackRecord = { ...emptyTrackRecord(), "withheld-approval": { settled: 20, applied: 20 } };

function walk(created: EmittedProposal[]) {
  return applyArmedProposals({
    repo: REPO,
    created,
    policy: resolveProposalAutonomyPolicy({ "withheld-approval": "apply" }),
    record: trackRecord,
    producer: "[pm]",
    log,
    nudge: () => {},
  });
}

beforeEach(() => {
  resetSeam();
  log.mockReset();
  log.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("an armed pass that grants approvals", () => {
  it("refuses the stale ask, notes why on it, and approves the one behind it", async () => {
    const first = ask("anton-p1", "anton-a");
    const second = ask("anton-p2", "anton-b");
    // `anton-a` was rewritten after the pass judged it — the one thing no board read restates, and
    // the reason a months-old start must not be granted. `anton-b` is untouched and sound.
    setSnapshot([
      first.proposal,
      second.proposal,
      warm("anton-a", { acceptance_criteria: "- [ ] it ships" }),
      target("anton-b"),
    ]);

    const result = await walk([first.filed, second.filed]);

    expect(result.records.map((r) => r.outcome)).toEqual(["refused", "applied"]);
    // The refusal cost the pass nothing: the sound ask behind it was still approved, in order.
    expect(calls).toEqual([
      expect.stringContaining("note anton-p1 pm: apply FAILED —"),
      "assign anton-b operator-1",
      "approve anton-b",
      expect.stringContaining("note anton-p2 pm: applied by POLICY — approved anton-b"),
      "close anton-p2 applied by policy: approved anton-b, so a run can start on it",
    ]);
    // The stale ask stays OPEN, with its reason on its own bead rather than only in the log.
    expect(calls.some((c) => c.startsWith("close anton-p1"))).toBe(false);
    expect(calls[0]).toMatch(/no longer the bead whose contract this start was judged from/);
    // …and both readings agree about which is which.
    expect(recorded()).toMatch(/REFUSED[\s\S]*anton-p1/);
    expect(recorded()).toContain("APPLIED");
    expect(result.records[1]?.changed).toEqual(["anton-b"]);
  });

  it("refuses every ask without touching a bead when the board stopped offering the work", async () => {
    // The gate half of the same fence: both targets are untouched since the filing, and both have
    // since lost the Acceptance the run would have been judged by. Nothing is approved, nothing is
    // claimed, and the pass still finishes and reports both.
    const first = ask("anton-p1", "anton-a");
    const second = ask("anton-p2", "anton-b");
    setSnapshot([first.proposal, second.proposal, cold("anton-a"), cold("anton-b")]);

    const result = await walk([first.filed, second.filed]);

    expect(result.records.map((r) => r.outcome)).toEqual(["refused", "refused"]);
    expect(calls.filter((c) => !c.startsWith("note"))).toEqual([]);
    for (const call of calls) expect(call).toMatch(/is not work anton may start/);
  });
});
