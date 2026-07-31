import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { EscalationsPanel, escalationAge, stuckFor } from "@/components/board/escalations-panel";
import type { EscalationView } from "@/lib/escalations";

// The panel is a Server Component; only its two decision buttons are a client leaf, and those need
// a router + toaster to import cleanly under a static render.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const HOUR = 3_600_000;

/**
 * `since` is anchored to the real clock because the panel ages a stall as of render time. Flooring
 * to whole seconds only ever makes the gap LARGER than 4h, so `stuckFor`'s whole-hour rounding can't
 * flake down to "3h".
 */
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

const render = (escalations: EscalationView[]) =>
  renderToStaticMarkup(<EscalationsPanel slug="anton" escalations={escalations} />);

describe("EscalationsPanel", () => {
  it("renders nothing at all on a healthy board", () => {
    // An empty "no escalations" card is the chrome that trains an operator to stop looking here.
    expect(render([])).toBe("");
  });

  it("leads with what stalled, for how long, and why", () => {
    const html = render([escalation()]);

    expect(html).toContain("Needs you");
    expect(html).toContain("Parked run");
    expect(html).toContain("stuck 4h");
    expect(html).toContain("parked 4h ago: agent exited 1");
    expect(html).toContain("1 stalled run"); // singular
  });

  it("counts multiple stalls in the plural", () => {
    const html = render([escalation(), escalation({ id: "esc-2", findingKey: "parked-run:r-2" })]);
    expect(html).toContain("2 stalled runs");
  });

  it("falls back to the sweep's frozen age when the finding recorded no start time", () => {
    expect(render([escalation({ since: undefined, ageMs: 2 * HOUR })])).toContain("stuck 2h");
  });

  it("links the epic a resume would target, and the PR when the stall is a review", () => {
    const html = render([
      escalation({
        kind: "stale-pr",
        reason: "PR #42 has had no activity for 3d",
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
      }),
    ]);

    expect(html).toContain("Stale PR");
    expect(html).toContain("/projects/anton/epics/anton-e1");
    expect(html).toContain("https://github.com/o/r/pull/42");
    expect(html).toContain("PR #42");
  });

  it("offers Dismiss instead of Resume on a stale PR — re-running the epic would change nothing", () => {
    // execute-epic short-circuits on an open PR, so a resume here settles the row and leaves the PR
    // exactly as stale; the next sweep raises it again. The founder's move is to review it.
    const html = render([
      escalation({ kind: "stale-pr", prNumber: 42, prUrl: "https://github.com/o/r/pull/42" }),
    ]);

    expect(html).toContain("Dismiss");
    expect(html).not.toContain("Resume");
    expect(html).toContain("Abandon"); // the work can still be called won't-do
  });

  it("offers both answers when the escalation names a target for each", () => {
    const html = render([escalation()]);
    expect(html).toContain("Resume");
    expect(html).toContain("Abandon");
  });

  it("hides Resume when no epic can be re-enqueued and Abandon when no bead can be closed", () => {
    expect(render([escalation({ epicBeadId: undefined })])).not.toContain("Resume");
    const noBead = render([escalation({ beadId: undefined })]);
    expect(noBead).not.toContain("Abandon");
    expect(noBead).toContain("Resume");
  });

  it("offers job-level answers for a stall that names no bead at all", () => {
    // An exhausted sync-push/run-health job strands no work item. Without these the row would show
    // no button that settles it and would sit on the board forever.
    const html = render([
      escalation({
        kind: "exhausted-job",
        reason: "sync-push job parked after 3/3 attempts",
        beadId: undefined,
        epicBeadId: undefined,
        runId: undefined,
        jobId: "j-1",
      }),
    ]);

    expect(html).toContain("Retry job");
    expect(html).toContain("Stop retrying");
  });

  it("says so when the board-native bd note has not landed yet", () => {
    // Without this the panel would silently imply the stall is recorded on the board when it isn't.
    const html = render([escalation({ noted: false })]);
    expect(html).toContain("hasn&#x27;t landed yet");
  });

  it("stays quiet about the note when there is no bead to write one on", () => {
    expect(render([escalation({ noted: false, beadId: undefined })])).not.toContain("landed yet");
  });

  it("is announced as its own labelled region", () => {
    const html = render([escalation()]);
    expect(html).toContain('aria-labelledby="escalations-heading"');
    expect(html).toContain('id="escalations-heading"');
  });
});

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
