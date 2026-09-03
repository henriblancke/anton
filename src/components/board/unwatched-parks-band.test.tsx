// @vitest-environment jsdom
/**
 * The unwatched-park band (anton-kh98).
 *
 * What is under test is the band's whole reason to exist: it names the cost (how much is parked,
 * how long the worst of it has waited), it names what is off, and it hands over the switch — so an
 * operator who lands on the board learns all three without opening settings. Plus the silence rule,
 * which is the other half of the design: a band that stood on a healthy board would be trained out
 * of the operator's eye before the week it mattered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { UnwatchedParksBand } from "@/components/board/unwatched-parks-band";
import type { UnwatchedParks } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The band's re-read of its own signal — what the arm button asks for once its writes settle. */
const onArmed = vi.fn();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  onArmed.mockClear();
});

const HOUR = 3_600_000;

function parks(o: Partial<UnwatchedParks> = {}): UnwatchedParks {
  return {
    parkedCount: 13,
    oldestAgeMs: 7 * 24 * HOUR,
    disarmed: ["run-health"],
    ...o,
  };
}

const renderBand = (value?: UnwatchedParks) =>
  render(<UnwatchedParksBand slug="anton" parks={value} onArmed={onArmed} />);

const armButton = () => screen.getByRole("button", { name: /turn on the watcher/i });

describe("UnwatchedParksBand", () => {
  it("renders nothing when there is no unwatched parked work", () => {
    const { container } = renderBand(undefined);
    expect(container.firstChild).toBeNull();
  });

  it("names the cost: how many are parked and how long the oldest has waited", () => {
    renderBand(parks());
    expect(screen.getByText("13 parked jobs")).toBeTruthy();
    expect(screen.getByText("oldest waiting 7d")).toBeTruthy();
  });

  it("counts one parked job in the singular", () => {
    renderBand(parks({ parkedCount: 1, oldestAgeMs: 90 * 60_000 }));
    expect(screen.getByText("1 parked job")).toBeTruthy();
    expect(screen.getByText("oldest waiting 1h")).toBeTruthy();
  });

  // The consequence, not the config: "run-health is disabled" only means something to an operator
  // who already knows what run-health does, and they are exactly the operator who never had this
  // problem.
  it("says what the disarmed half stops from happening", () => {
    renderBand(parks({ disarmed: ["run-health"] }));
    expect(screen.getByText(/no stall is ever detected/)).toBeTruthy();
    expect(screen.getByText(/it will not escalate on its own/)).toBeTruthy();
  });

  // Arming turns on a pass that RESUMES quota and dead-lease stalls, so the copy that sits above
  // the button has to say so — a click off "detect and escalate" copy would spend quota unannounced.
  it("names the auto-resume the arm button grants, not just the detection", () => {
    renderBand(parks());
    expect(screen.getByText(/usage limit has since reopened/)).toBeTruthy();
    expect(screen.getByText(/spend quota when they resume/)).toBeTruthy();
  });

  it("names both halves when both are off, and pluralises with them", () => {
    renderBand(parks({ disarmed: ["run-health", "unstick"] }));
    const sentence = screen.getByText(/no stall is ever detected/);
    expect(sentence.textContent).toContain("nothing acts on what is detected");
    expect(sentence.textContent).toContain("these will not escalate on their own");
  });

  it("says the sweep never acts on its findings when only the consumer is off", () => {
    renderBand(parks({ disarmed: ["unstick"] }));
    expect(screen.getByText(/nothing acts on what is detected/)).toBeTruthy();
    expect(screen.queryByText(/no stall is ever detected/)).toBeNull();
  });

  it("offers the parked jobs themselves, so the count can be checked", () => {
    renderBand(parks());
    const link = screen.getByRole("link", { name: /see parked jobs/i });
    expect(link.getAttribute("href")).toBe("/projects/anton/jobs?status=parked");
  });

  // The acceptance criterion this band exists for: arming is reachable HERE, not only from a
  // settings panel the operator had no reason to open.
  it("arms every disarmed half from the band itself", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ schedule: {} }), { status: 200 }));

    renderBand(parks({ disarmed: ["run-health", "unstick"] }));
    fireEvent.click(armButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies).toEqual([
      { type: "run-health", enabled: true },
      { type: "unstick", enabled: true },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/anton/schedules");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
    // The band is a read of the rows just written, so a re-read is what clears it.
    await waitFor(() => expect(onArmed).toHaveBeenCalled());
    // And the click releases the button on the way out: a re-read that never lands must not leave
    // the operator holding a dead switch on the band it was supposed to clear.
    expect(armButton().hasAttribute("disabled")).toBe(false);
  });

  it("only turns on the half that is off", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    renderBand(parks({ disarmed: ["unstick"] }));
    fireEvent.click(armButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: "unstick",
      enabled: true,
    });
  });

  // A refused write must not leave a band claiming a state the server never took.
  it("re-reads rather than pretending the watcher came on when the write fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
    );

    renderBand(parks());
    fireEvent.click(armButton());

    await waitFor(() => expect(onArmed).toHaveBeenCalled());
    expect(armButton().hasAttribute("disabled")).toBe(false);
  });
});
