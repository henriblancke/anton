// @vitest-environment jsdom
/**
 * The `not now` chip's countdown (anton-jqvy).
 *
 * The window it counts down is a DAY, and the board it sits on is left open for one — so the thing
 * worth pinning is that the label moves on its own. A poll answers 304 for as long as the deferral
 * set is unchanged, which is the whole hold, so nothing else on the board re-renders this chip
 * (PR #212 review): a label computed once at render would read `23h` until tomorrow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { NotNowChip } from "@/components/board/not-now-chip";
import { formatExactTime } from "@/lib/time";

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the hold's remaining time", () => {
  it("counts down without anything else re-rendering the board", async () => {
    render(<NotNowChip untilMs={Date.now() + 2 * HOUR + 30 * 60 * 1000} />);
    expect(screen.getByText("not now · 2h 30m")).toBeTruthy();

    // Nothing polls, nothing re-renders — only the clock moves.
    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
    });

    expect(screen.getByText("not now · 1h 59m")).toBeTruthy();
  });

  it("names the exact expiry too, which needs no clock at all", () => {
    render(<NotNowChip untilMs={Date.now() + 5 * HOUR} />);
    const title = screen.getByText(/not now/).getAttribute("title") ?? "";
    expect(title).toContain("in 5h 0m");
    expect(title).toContain(formatExactTime(new Date(Date.now() + 5 * HOUR).toISOString()));
  });

  it("drops the counter once the window has run out, rather than saying `now`", async () => {
    render(<NotNowChip untilMs={Date.now() + 60 * 1000} />);
    expect(screen.getByText("not now · 1m")).toBeTruthy();

    // The next poll drops the chip entirely; until it lands, the hold is stated without a countdown
    // that has nothing left to count.
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });

    expect(screen.getByText("not now")).toBeTruthy();
  });
});

describe("the pass before the browser has a clock", () => {
  it("states the hold without a relative label, so both sides of hydration agree", () => {
    // A server render and the hydration pass that follows it read the same snapshot by construction
    // — a countdown computed in each would differ by however long the round trip took.
    const until = Date.now() + 5 * HOUR;
    const html = renderToStaticMarkup(<NotNowChip untilMs={until} />);
    expect(html).toContain("not now");
    expect(html).not.toContain("5h");
    expect(html).toContain(formatExactTime(new Date(until).toISOString()));
  });
});
