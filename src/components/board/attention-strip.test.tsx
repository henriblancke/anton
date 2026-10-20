// @vitest-environment jsdom
/**
 * The board's one alert line (anton-7gxs).
 *
 * The property under test is the one the whole change exists for: this strip's height does not grow
 * with the trouble. Three unbounded bands used to stack here, and a burst of identical failures —
 * one alert per stalled job, each printing its park message and its own buttons — pushed the columns
 * off the screen entirely. So the cases below assert what the strip SAYS (counts, register, the two
 * whole-decision buttons) and what it deliberately does NOT (rows, reasons, per-row verbs).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AttentionStrip, DigestBanner } from "@/components/board/attention-strip";
import type { DigestNeedsYouSummary } from "@/lib/attention";
import type { AutopilotBreaker } from "@/lib/autopilot-breaker";
import type { EscalationView, UnwatchedParks } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const HOUR = 3_600_000;

function escalation(o: Partial<EscalationView> = {}): EscalationView {
  return {
    id: "esc-1",
    findingKey: "exhausted-job:j-1",
    kind: "exhausted-job",
    reason: "claude exited 1: API Error 503 — this request would exceed your rate limit",
    beadId: "anton-t9",
    epicBeadId: "anton-e1",
    ageMs: 4 * HOUR,
    status: "open",
    noted: true,
    raisedAt: 0,
    ...o,
  };
}

/** A storm: `n` alerts that differ only in which job produced them. */
const storm = (n: number) =>
  Array.from({ length: n }, (_, i) => escalation({ id: `esc-${i}`, findingKey: `k-${i}` }));

const disarm: AutopilotBreaker = {
  kind: "disarm",
  reason: "consecutive-failures",
  detail: "7 runs in a row ended without delivering",
  evidence: ["run 1 failed", "run 2 failed"],
};

const hold: AutopilotBreaker = {
  kind: "hold",
  reason: "wip-limit",
  detail: "3 of 3 review slots are full",
};

const parks: UnwatchedParks = {
  parkedCount: 13,
  oldestAgeMs: 7 * 24 * HOUR,
  disarmed: ["run-health"],
};

function mount(props: Partial<Parameters<typeof AttentionStrip>[0]> = {}) {
  return render(<AttentionStrip slug="anton" onArmed={vi.fn()} {...props} />);
}

describe("AttentionStrip", () => {
  it("renders nothing when nothing is stopped, held, or unwatched", () => {
    const { container } = mount();
    expect(container.innerHTML).toBe("");
  });

  it("counts failures and requests apart — they are not the same errand", () => {
    mount({
      escalations: [
        escalation(),
        escalation({ id: "esc-2", kind: "needs-human", gateId: "g-1" }),
      ],
    });
    expect(screen.getByText("1 stopped")).toBeTruthy();
    expect(screen.getByText("1 to answer")).toBeTruthy();
  });

  it("does not grow with the count — thirty alerts read as one line, same as one", () => {
    // The whole point of the strip. Thirty rows of park messages is what buried the board.
    const { container } = mount({ escalations: storm(30) });
    expect(screen.getByText("30 stopped")).toBeTruthy();
    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(screen.queryByText(/API Error 503/)).toBeNull();
    // And no per-row verb: choosing between them means reading the message, which is on the page.
    expect(screen.queryByText("Resume")).toBeNull();
    expect(screen.queryByText("Abandon")).toBeNull();
  });

  it("sends the operator to the list, anchored at the section that holds it", () => {
    mount({ escalations: [escalation()] });
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      "/projects/anton/health#needs-you",
    );
  });

  it("keeps the two whole-decision buttons inline, and only those", () => {
    // Re-arm and Arm-watcher each answer their signal completely — nothing to read first, no row to
    // pick — so routing them through another page would be friction with no reading behind it.
    mount({ breaker: disarm, parks });
    expect(screen.getByText("Re-arm")).toBeTruthy();
    expect(screen.getByText("Turn on the watcher")).toBeTruthy();
  });

  it("offers no re-arm for a hold, which clears itself", () => {
    const { container } = mount({ breaker: hold });
    expect(screen.getByText("Review queue is full")).toBeTruthy();
    expect(screen.queryByText("Re-arm")).toBeNull();
    expect(screen.getByRole("heading", { name: "On hold" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Needs you" })).toBeNull();
    // A hold is not a failure and must not be drawn as one: red here would teach the operator to
    // discount the band, and the state that pays for that lesson is the disarm.
    expect(container.querySelector("section")?.className).not.toContain("destructive");
  });

  it("draws a disarm as a failure even with nothing else stopped", () => {
    const { container } = mount({ breaker: disarm });
    expect(container.querySelector("section")?.className).toContain("destructive");
    expect(screen.getByText("Runs failing one after another")).toBeTruthy();
  });

  it("draws an all-requests board in the review register, not the failure one", () => {
    const { container } = mount({
      escalations: [escalation({ kind: "needs-human", gateId: "g-1" })],
    });
    expect(container.querySelector("section")?.className).toContain("stage-in-review");
    expect(container.querySelector("section")?.className).not.toContain("destructive");
  });

  it("says how much is parked, and that nothing is watching it", () => {
    mount({ parks });
    expect(screen.getByText("13 parked, unwatched")).toBeTruthy();
  });
});

const EMPTY_COUNTS: DigestNeedsYouSummary["counts"] = {
  breaker: 0,
  "parked-ask": 0,
  "merge-ready-pr": 0,
  proposal: 0,
  "human-ticket": 0,
};

function needsYou(o: Partial<DigestNeedsYouSummary["counts"]> = {}, total?: number): DigestNeedsYouSummary {
  const counts = { ...EMPTY_COUNTS, ...o };
  return { items: [], counts, total: total ?? Object.values(counts).reduce((a, b) => a + b, 0) };
}

describe("DigestBanner", () => {
  it("renders nothing when nothing changed and nothing needs you", () => {
    const { container } = render(
      <DigestBanner slug="anton" needsYou={needsYou()} activityCount={0} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("states both counts in the acceptance's own format, and links to the digest", () => {
    render(<DigestBanner slug="anton" needsYou={needsYou({ "parked-ask": 2 })} activityCount={5} />);
    expect(screen.getByText("5 things since you looked · 2 need you")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open digest" }).getAttribute("href")).toBe(
      "/projects/anton/digest",
    );
  });

  it("stays visible on substantial activity with nothing actionable, unlike digestNeedsYou alone", () => {
    render(<DigestBanner slug="anton" needsYou={needsYou()} activityCount={12} />);
    expect(screen.getByText("12 things since you looked · 0 need you")).toBeTruthy();
  });

  it("stays visible with nothing new but something needing you", () => {
    render(
      <DigestBanner slug="anton" needsYou={needsYou({ "parked-ask": 1 })} activityCount={0} />,
    );
    expect(screen.getByText("0 things since you looked · 1 need you")).toBeTruthy();
  });

  it("breaks out stale PRs, proposals and a stopped autopilot apart from the total", () => {
    render(
      <DigestBanner
        slug="anton"
        needsYou={needsYou({ "merge-ready-pr": 1, proposal: 2, breaker: 1 })}
        activityCount={3}
      />,
    );
    // "stale", not "to merge" (PR #350 review): the underlying finding only knows the PR is idle,
    // not that it's actually mergeable — see attention-strip.tsx.
    expect(screen.getByText("1 stale PR")).toBeTruthy();
    expect(screen.getByText("2 proposals")).toBeTruthy();
    expect(screen.getByText("autopilot stopped")).toBeTruthy();
  });
});
