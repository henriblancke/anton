// @vitest-environment jsdom
/**
 * The one band above the board (anton-ue90.1). It absorbed the escalation panel and the hygiene
 * panel, so it carries their coverage: every decision affordance an escalation had, every link a
 * finding had, and — the claim that matters most — the difference between "checked, clean" and
 * "never checked".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AttentionStrip } from "@/components/board/attention-strip";
import type {
  EscalationView,
  HygieneFinding,
  HygieneFindingKind,
  HygieneReport,
  ReviewTrajectory,
} from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const HOUR = 3_600_000;

/**
 * `since` is anchored to the real clock because the strip ages a stall as of render time. Flooring
 * to whole seconds only ever makes the gap LARGER than 4h, so the whole-hour rounding can't flake
 * down to "3h".
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

function finding(
  kind: HygieneFindingKind,
  id: string,
  o: Partial<HygieneFinding> = {},
): HygieneFinding {
  return { kind, key: `${kind}:${id}`, detail: `${kind} on ${id}`, beadId: id, ...o };
}

function report(findings: HygieneFinding[], o: Partial<HygieneReport> = {}): HygieneReport {
  const counts = {
    lint: 0,
    "stale-open": 0,
    "stale-in-progress": 0,
    orphan: 0,
    "dep-cycle": 0,
    duplicate: 0,
  };
  for (const f of findings) counts[f.kind] += 1;
  return {
    id: "h-1",
    projectId: "p1",
    generatedAt: Math.floor(Date.now() / 1000) - 6 * 3600,
    actions: { closedEpics: [], rowsRecomputed: 0 },
    findings,
    counts,
    ...o,
  };
}

function renderStrip({
  escalations = [],
  hygiene,
  trajectory,
  onOpenBead = vi.fn(),
}: {
  escalations?: EscalationView[];
  hygiene?: HygieneReport;
  trajectory?: ReviewTrajectory;
  onOpenBead?: (id: string) => void;
} = {}) {
  return render(
    <AttentionStrip
      slug="anton"
      escalations={escalations}
      hygiene={hygiene}
      trajectory={trajectory}
      onOpenBead={onOpenBead}
    />,
  );
}

describe("AttentionStrip", () => {
  describe("what it claims when there is nothing to answer", () => {
    it("renders nothing at all for a project that has never been patrolled or scored", () => {
      // The old panels each rendered nothing in this case, and merging them must not invent an
      // empty state: "clean" is a claim, and nothing has earned it.
      const { container } = renderStrip();
      expect(container.innerHTML).toBe("");
    });

    it("says the board is clean once a patrol has actually looked", () => {
      renderStrip({ hygiene: report([]) });
      expect(screen.getByText("board clean")).toBeTruthy();
      expect(screen.getByText(/patrolled/)).toBeTruthy();
    });

    it("still shows the applied tier when the patrol changed something but found nothing", () => {
      // Closing two epics is not "nothing happened", so it doesn't collapse to the clean one-liner.
      renderStrip({
        hygiene: report([], { actions: { closedEpics: ["anton-e1", "anton-e2"], rowsRecomputed: 4 } }),
      });
      expect(screen.getByText(/patrol closed 2 epics/)).toBeTruthy();
      expect(screen.getByText(/repaired 4 blocked rows/)).toBeTruthy();
    });
  });

  /**
   * The patrol writes to the board on its own authority. A count of what it changed is not a report
   * an operator can act on — the retired hygiene panel named every epic it closed, and that is the
   * part they need to go and check. Compact when folded, complete when opened.
   */
  describe("what the patrol closed", () => {
    const closed = { closedEpics: ["anton-e1", "anton-e2"], rowsRecomputed: 0 };

    it("names the epics it closed, behind the disclosure, on an otherwise clean board", () => {
      renderStrip({ hygiene: report([], { actions: closed }) });
      // Folded: the count only.
      expect(screen.queryByText("anton-e1")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /show/i }));
      expect(screen.getByText("anton-e1")).toBeTruthy();
      expect(screen.getByText("anton-e2")).toBeTruthy();
    });

    it("keeps them alongside the housekeeping list when there is one", () => {
      renderStrip({
        hygiene: report([finding("lint", "anton-t1")], { actions: closed }),
      });
      fireEvent.click(screen.getByRole("button", { name: /show/i }));
      expect(screen.getByText("anton-e1")).toBeTruthy();
      expect(screen.getByText("lint on anton-t1")).toBeTruthy();
    });

    it("keeps them reachable when something more urgent is holding the rows", () => {
      // Escalations push housekeeping into the folded tail; the closed epics ride along with it
      // rather than disappearing because the strip had a stall to show instead.
      renderStrip({
        escalations: [escalation()],
        // Not anton-e1: the stall already links that epic, and this asserts the disclosure's copy.
        hygiene: report([], { actions: { closedEpics: ["anton-e7"], rowsRecomputed: 0 } }),
      });
      fireEvent.click(screen.getByRole("button", { name: /show/i }));
      expect(screen.getByText("anton-e7")).toBeTruthy();
    });

    it("opens the ticket dialog for a closed epic, like every other bead the strip names", () => {
      const onOpenBead = vi.fn();
      renderStrip({ hygiene: report([], { actions: closed }), onOpenBead });
      fireEvent.click(screen.getByRole("button", { name: /show/i }));
      fireEvent.click(screen.getByText("anton-e1"));
      expect(onOpenBead).toHaveBeenCalledWith("anton-e1");
    });

    it("offers no disclosure when the patrol neither changed nor found anything", () => {
      renderStrip({ hygiene: report([]) });
      expect(screen.queryByRole("button", { name: /show/i })).toBeNull();
    });
  });

  describe("escalations — everything the old panel offered", () => {
    it("leads with what stalled, for how long, and why", () => {
      renderStrip({ escalations: [escalation()] });
      expect(screen.getByText("Needs you")).toBeTruthy();
      expect(screen.getByText("Parked run")).toBeTruthy();
      expect(screen.getByText("stuck 4h")).toBeTruthy();
      expect(screen.getByText("parked 4h ago: agent exited 1")).toBeTruthy();
      expect(screen.getByText("1 stopped")).toBeTruthy();
    });

    it("falls back to the sweep's frozen age when the finding recorded no start time", () => {
      renderStrip({ escalations: [escalation({ since: undefined, ageMs: 2 * HOUR })] });
      expect(screen.getByText("stuck 2h")).toBeTruthy();
    });

    it("shows the frozen age until hydration, so the two renders can't disagree", () => {
      // The strip is a Client Component: it renders once on the server and again when the browser
      // hydrates. Reading the clock in both would print two different ages for any stall sitting on
      // a minute boundary, and React discards a subtree that hydrates to different text. The first
      // render therefore has to use server data — the age the sweep froze — and only reach for the
      // live clock in the effect that runs after hydration.
      const sweptAt = Date.now() - 9 * HOUR;
      const { rerender } = render(
        <AttentionStrip
          slug="anton"
          escalations={[escalation({ since: Math.floor(sweptAt / 1000), ageMs: 2 * HOUR })]}
          hygiene={undefined}
          trajectory={undefined}
          onOpenBead={vi.fn()}
        />,
      );
      // Effects have flushed by now, so this is the post-hydration value: aged as of NOW (9h), not
      // the 2h the sweep recorded. The pre-hydration value is asserted through the pure helper in
      // escalation-age.test.ts, which is where the two-clock rule actually lives.
      expect(screen.getByText("stuck 9h")).toBeTruthy();
      rerender(
        <AttentionStrip
          slug="anton"
          escalations={[escalation({ since: Math.floor(sweptAt / 1000), ageMs: 2 * HOUR })]}
          hygiene={undefined}
          trajectory={undefined}
          onOpenBead={vi.fn()}
        />,
      );
      expect(screen.getByText("stuck 9h")).toBeTruthy();
    });

    it("links the epic a resume would target, and the PR when the stall is a review", () => {
      renderStrip({
        escalations: [
          escalation({
            kind: "stale-pr",
            reason: "PR #42 has had no activity for 3d",
            prNumber: 42,
            prUrl: "https://github.com/o/r/pull/42",
          }),
        ],
      });

      expect(screen.getByText("Stale PR")).toBeTruthy();
      expect(screen.getByRole("link", { name: "anton-e1" }).getAttribute("href")).toBe(
        "/projects/anton/epics/anton-e1",
      );
      expect(screen.getByRole("link", { name: "PR #42" }).getAttribute("href")).toBe(
        "https://github.com/o/r/pull/42",
      );
    });

    it("offers Dismiss instead of Resume on a stale PR — re-running the epic would change nothing", () => {
      renderStrip({ escalations: [escalation({ kind: "stale-pr", prNumber: 42 })] });
      expect(screen.getByText("Dismiss")).toBeTruthy();
      expect(screen.queryByText("Resume")).toBeNull();
      expect(screen.getByText("Abandon")).toBeTruthy();
    });

    it("hides Resume when no epic can be re-enqueued and Abandon when no bead can be closed", () => {
      const { unmount } = renderStrip({ escalations: [escalation({ epicBeadId: undefined })] });
      expect(screen.queryByText("Resume")).toBeNull();
      unmount();

      renderStrip({ escalations: [escalation({ beadId: undefined })] });
      expect(screen.queryByText("Abandon")).toBeNull();
      expect(screen.getByText("Resume")).toBeTruthy();
    });

    it("offers job-level answers for a stall that names no bead at all", () => {
      renderStrip({
        escalations: [
          escalation({
            kind: "exhausted-job",
            beadId: undefined,
            epicBeadId: undefined,
            runId: undefined,
            jobId: "j-1",
          }),
        ],
      });
      expect(screen.getByText("Retry job")).toBeTruthy();
      expect(screen.getByText("Stop retrying")).toBeTruthy();
    });

    it("says so when the board-native bd note has not landed yet, and only when there is a bead", () => {
      const { unmount } = renderStrip({ escalations: [escalation({ noted: false })] });
      expect(screen.getByText(/hasn't landed yet/)).toBeTruthy();
      unmount();

      renderStrip({ escalations: [escalation({ noted: false, beadId: undefined })] });
      expect(screen.queryByText(/landed yet/)).toBeNull();
    });
  });

  describe("hygiene — everything the old panel offered", () => {
    it("shows a board-lying finding as its own row, with its detail in full", () => {
      renderStrip({
        hygiene: report([
          finding("dep-cycle", "anton-a", {
            detail: "anton-a → anton-b → anton-a",
            ids: ["anton-a", "anton-b"],
          }),
        ]),
      });

      expect(screen.getByText("Dependency cycle")).toBeTruthy();
      expect(screen.getByText("anton-a → anton-b → anton-a")).toBeTruthy();
      // Every bead in the ring is linked, not just the first.
      expect(screen.getByTitle("Open anton-a")).toBeTruthy();
      expect(screen.getByTitle("Open anton-b")).toBeTruthy();
    });

    it("opens the ticket dialog for the bead a finding names", () => {
      const onOpenBead = vi.fn();
      renderStrip({ hygiene: report([finding("dep-cycle", "anton-a")]), onOpenBead });

      fireEvent.click(screen.getByTitle("Open anton-a"));
      expect(onOpenBead).toHaveBeenCalledWith("anton-a");
    });

    it("reports a housekeeping-only board as one line, folded", () => {
      // Nothing has stopped and nothing is untrustworthy, so tidy-up does not get rows of its own —
      // and the heading must not claim otherwise.
      renderStrip({
        hygiene: report([
          finding("lint", "anton-a"),
          finding("lint", "anton-b"),
          finding("stale-open", "anton-c"),
        ]),
      });

      expect(screen.getByText("2 contract gaps · 1 stale")).toBeTruthy();
      expect(screen.queryByText("Needs you")).toBeNull();
      // Folded: the individual details are not on screen until asked for.
      expect(screen.queryByText("lint on anton-a")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Show/ }));
      expect(screen.getByText("lint on anton-a")).toBeTruthy();
    });

    it("keeps housekeeping folded under the rows when something does need answering", () => {
      renderStrip({
        escalations: [escalation()],
        hygiene: report([finding("lint", "anton-a"), finding("stale-open", "anton-c")]),
      });

      expect(screen.getByText("Needs you")).toBeTruthy();
      expect(screen.getByText("1 contract gap · 1 stale")).toBeTruthy();
      expect(screen.queryByText("lint on anton-a")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Show/ }));
      expect(screen.getByText("lint on anton-a")).toBeTruthy();
    });

    it("titles itself by the worst thing in it", () => {
      renderStrip({ hygiene: report([finding("dep-cycle", "anton-a")]) });
      // A cycle is not "Needs you" — overclaiming is how an operator learns to skip the strip.
      expect(screen.getByText("Worth a look")).toBeTruthy();
      expect(screen.queryByText("Needs you")).toBeNull();
    });
  });

  describe("review scores", () => {
    const trajectory = (score: number): ReviewTrajectory => {
      const worst = { id: "anton-bad", title: "the bad one", score };
      return { recent: [worst], average: score, worst, scored: 1 };
    };

    it("promotes a rework-band worst score into a row of its own", () => {
      renderStrip({ hygiene: report([]), trajectory: trajectory(3) });
      expect(screen.getByText("Substantial rework")).toBeTruthy();
      expect(screen.getByText("review 3/10")).toBeTruthy();
      expect(screen.getByRole("link", { name: "anton-bad" }).getAttribute("href")).toBe(
        "/projects/anton/epics/anton-bad",
      );
    });

    it("leaves a healthy trend to the toolbar pill", () => {
      renderStrip({ hygiene: report([]), trajectory: trajectory(8) });
      expect(screen.queryByText("Substantial rework")).toBeNull();
      expect(screen.getByText("board clean")).toBeTruthy();
    });
  });

  it("is announced as its own labelled region", () => {
    const { container } = renderStrip({ escalations: [escalation()] });
    const section = container.querySelector("section");
    expect(section?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
  });
});
