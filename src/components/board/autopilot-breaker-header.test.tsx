// @vitest-environment jsdom
/**
 * The hold/disarm distinction (anton-5c8h / R4.1, R4.5) — the whole UX risk of the brakes, so these
 * cases assert the DIFFERENCE between the two states rather than each one in isolation: a hold drawn
 * and worded like a disarm trains the operator to ignore the disarm that matters.
 *
 * What each state owes the operator:
 *   • both — a reason and a clearing condition, on the board, without opening settings.
 *   • hold — the calm register, the self-clearing promise, and NO buttons.
 *   • disarm — the failure register, the evidence it tripped on, `Investigate`, and `Re-arm`.
 */
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  AutopilotBreakerBand,
  AutopilotBreakerHeader,
} from "@/components/board/autopilot-breaker-header";
import type { AutopilotDisarm, AutopilotHold } from "@/lib/autopilot-breaker";

const refresh = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => success(...a),
    error: (...a: unknown[]) => error(...a),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function hold(o: Partial<AutopilotHold> = {}): AutopilotHold {
  return { kind: "hold", reason: "wip-limit", detail: "3 of 3 PRs are open in review.", ...o };
}

const SERIES = ["anton-abc1 · 8.5", "anton-def2 · 6.0", "anton-ghi3 · 5.5"];

function disarm(o: Partial<AutopilotDisarm> = {}): AutopilotDisarm {
  return {
    kind: "disarm",
    reason: "score-regression",
    detail: "The rolling review score fell below the floor of 7.",
    evidence: SERIES,
    ...o,
  };
}

/** The band itself, so "does the hold offer buttons" is asked of the band and not of the document. */
function band(): HTMLElement {
  return screen.getByRole("region", { name: /Autopilot is (holding|disarmed)/ });
}

describe("AutopilotBreakerHeader", () => {
  it("renders nothing while the autopilot is running", () => {
    // The band's PRESENCE is the signal. An "all clear" row would be one more thing to read on every
    // board load, saying what the absence of a stopped state already says.
    const { container } = render(<AutopilotBreakerHeader slug="anton" />);
    expect(container.innerHTML).toBe("");
  });

  describe("hold", () => {
    it("names the kind, the limit, and what would release it", () => {
      render(<AutopilotBreakerHeader slug="anton" breaker={hold()} />);
      expect(screen.getByText("Autopilot is holding")).toBeTruthy();
      expect(screen.getByText("Review queue is full")).toBeTruthy();
      expect(screen.getByText("3 of 3 PRs are open in review.")).toBeTruthy();
      // R4.5's sentence: what would start anton again, read off the board.
      expect(
        screen.getByText("Releases itself when one PR merges or closes — nothing for you to do."),
      ).toBeTruthy();
    });

    it("reads as a limit being respected, not as a failure", () => {
      render(<AutopilotBreakerHeader slug="anton" breaker={hold()} />);
      expect(screen.getByText(/Nothing is wrong/)).toBeTruthy();
      // The word beside the colour: the two kinds must be distinguishable without the palette.
      expect(within(band()).getByText("hold")).toBeTruthy();
      expect(within(band()).queryByText("disarm")).toBeNull();
      // The destructive wash is reserved for the state that actually needs a human.
      expect(band().className).not.toMatch(/destructive/);
    });

    it("says in-flight work is unaffected", () => {
      // "Autopilot is stopped" reads as "everything is stopped" unless something says otherwise.
      render(<AutopilotBreakerHeader slug="anton" breaker={hold()} />);
      expect(screen.getByText(/only starting new work is stopped/)).toBeTruthy();
    });

    it("offers no buttons at all", () => {
      // Every affordance on a self-clearing state is an invitation to override a limit the operator
      // set for themselves — and there is nothing here for a human to do.
      render(<AutopilotBreakerHeader slug="anton" breaker={hold()} />);
      expect(within(band()).queryByRole("button")).toBeNull();
      expect(within(band()).queryByRole("link")).toBeNull();
    });
  });

  describe("disarm", () => {
    it("says why, in the failure register", () => {
      render(<AutopilotBreakerHeader slug="anton" breaker={disarm()} />);
      expect(screen.getByText("Autopilot is disarmed")).toBeTruthy();
      expect(screen.getByText("Review scores fell below the floor")).toBeTruthy();
      expect(screen.getByText("The rolling review score fell below the floor of 7.")).toBeTruthy();
      expect(within(band()).getByText("disarm")).toBeTruthy();
      expect(within(band()).queryByText("hold")).toBeNull();
      expect(band().className).toMatch(/destructive/);
    });

    it("promises no automatic clearing", () => {
      // An operator waiting on a machine that is waiting on them is a stopped autopilot nobody comes
      // back to — so a disarm names the human act and nothing else.
      render(<AutopilotBreakerHeader slug="anton" breaker={disarm()} />);
      expect(
        screen.getByText("Stays off until you re-arm it. Nothing re-arms it automatically."),
      ).toBeTruthy();
      expect(screen.queryByText(/Releases itself/)).toBeNull();
    });

    it("shows every evidence line it tripped on", () => {
      // This list IS the decision Re-arm asks for; clipping it would re-arm on a summary.
      render(<AutopilotBreakerHeader slug="anton" breaker={disarm()} />);
      for (const line of SERIES) expect(within(band()).getByText(line)).toBeTruthy();
    });

    it("sends Investigate to where that kind of evidence lives", () => {
      const { unmount } = render(<AutopilotBreakerHeader slug="anton" breaker={disarm()} />);
      expect(screen.getByRole("link", { name: "Investigate" }).getAttribute("href")).toBe(
        "/projects/anton/health",
      );
      unmount();

      render(
        <AutopilotBreakerHeader
          slug="anton"
          breaker={disarm({ reason: "consecutive-failures", evidence: [] })}
        />,
      );
      expect(screen.getByRole("link", { name: "Investigate" }).getAttribute("href")).toBe(
        "/projects/anton/runs",
      );
    });

    it("re-arms only after an explicit confirm, and reports the actor the server recorded", async () => {
      const fetchMock = stubFetch({ rearmedBy: "Henri Blancke", rearmedAt: 1_800_000_000 });
      render(<AutopilotBreakerHeader slug="anton" breaker={disarm()} />);

      // Resuming unattended execution after a quality signal is not a one-click act.
      fireEvent.click(screen.getByRole("button", { name: "Re-arm" }));
      expect(fetchMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Confirm re-arm" }));

      await waitFor(() => expect(refresh).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith("/api/projects/anton/autopilot/re-arm", {
        method: "POST",
      });
      // The author is the SERVER's answer, shown back at the moment the decision is made.
      expect(success).toHaveBeenCalledWith("Autopilot re-armed", {
        description: "Recorded as Henri Blancke.",
      });
    });

    it("surfaces a refused re-arm and re-reads the state", async () => {
      stubFetch({ error: "This project's autopilot is already armed — nothing was changed" }, 409);
      render(<AutopilotBreakerHeader slug="anton" breaker={disarm()} />);

      fireEvent.click(screen.getByRole("button", { name: "Re-arm" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm re-arm" }));

      await waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          "This project's autopilot is already armed — nothing was changed",
        ),
      );
      // Someone else lifted it: re-read rather than leave a band that errors on every click.
      expect(refresh).toHaveBeenCalled();
    });
  });
});

/**
 * The band is decided by a read that spawns `gh` per in-review PR, so the page hands it over
 * unresolved and it suspends on its own. What that buys — and what these cases hold — is that the
 * cards render on GitHub's schedule for nobody.
 */
describe("streamed, not awaited by the page", () => {
  it("leaves the board around it rendered while the read is still outstanding", () => {
    // The whole point of the arrangement: a GitHub read that never answers costs a missing band,
    // not a missing board.
    render(
      <Suspense fallback={<p>the board, already rendered</p>}>
        <AutopilotBreakerBand slug="anton" breaker={new Promise<undefined>(() => {})} />
      </Suspense>,
    );

    expect(screen.getByText("the board, already rendered")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("fills the band in once the read answers", async () => {
    const read = Promise.resolve(hold());
    await act(async () => {
      render(
        <Suspense fallback={<p>the board, already rendered</p>}>
          <AutopilotBreakerBand slug="anton" breaker={read} />
        </Suspense>,
      );
    });

    expect(screen.getByText("Autopilot is holding")).toBeTruthy();
  });

  it("renders no band at all once the read answers that nothing is stopped", async () => {
    await act(async () => {
      render(
        <Suspense fallback={<p>pending</p>}>
          <AutopilotBreakerBand slug="anton" breaker={Promise.resolve(undefined)} />
        </Suspense>,
      );
    });

    expect(screen.queryByText("pending")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });
});
