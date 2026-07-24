import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { ShapingSignal } from "@/lib/usage";
import { ShapingNudge, ShapingNudgePill } from "@/components/usage/shaping-nudge";

/** A signal with all three starvation conditions satisfied; override one field to break a case. */
function signal(over: Partial<ShapingSignal> = {}): ShapingSignal {
  return {
    behindPace: true,
    headroomAvailable: true,
    readyCount: 1,
    weeklyRemainingPct: 62,
    ...over,
  };
}

describe("ShapingNudge", () => {
  it("renders the nudge only when all three conditions hold", () => {
    const html = renderToStaticMarkup(<ShapingNudge signal={signal()} />);
    expect(html).toContain("62%");
    expect(html).toContain("weekly left, backlog low");
    expect(html).toContain("shape more?");
    expect(html).toContain('role="status"');
  });

  it("hides when not behind pace", () => {
    expect(renderToStaticMarkup(<ShapingNudge signal={signal({ behindPace: false })} />)).toBe("");
  });

  it("hides when no quota headroom is available", () => {
    expect(
      renderToStaticMarkup(<ShapingNudge signal={signal({ headroomAvailable: false })} />),
    ).toBe("");
  });

  it("hides when the ready backlog is at or above the threshold", () => {
    expect(renderToStaticMarkup(<ShapingNudge signal={signal({ readyCount: 3 })} />)).toBe("");
  });

  it("hides when the ready count is unknown — never nags on a guess", () => {
    expect(renderToStaticMarkup(<ShapingNudge signal={signal({ readyCount: null })} />)).toBe("");
  });
});

describe("ShapingNudgePill", () => {
  it("renders nothing before a signal resolves — no reserved slot, no layout shift", () => {
    // The fetch effect never runs during static rendering, so the nudge starts hidden. This is
    // also the API-returns-204 state: it collapses to empty output rather than a shell.
    expect(renderToStaticMarkup(<ShapingNudgePill />)).toBe("");
  });
});
