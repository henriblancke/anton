import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { UsageSnapshot } from "@/lib/usage";
import { UsageMeter, UsagePill, UsageRow } from "@/components/usage/usage-pill";

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    sessionPct: 0,
    weeklyPct: 0,
    sessionResetAt: null,
    weeklyResetAt: null,
    plan: null,
    ...over,
  };
}

describe("UsageMeter", () => {
  it("summarizes the tightest limit with an ok tone when usage is low", () => {
    const html = renderToStaticMarkup(
      <UsageMeter usage={snapshot({ sessionPct: 12, weeklyPct: 30 })} />,
    );
    expect(html).toContain("30%"); // the tighter of the two limits
    expect(html).toContain("text-usage-ok");
    expect(html).not.toContain("text-usage-crit");
  });

  it("warns when the tightest limit crosses the warn threshold", () => {
    const html = renderToStaticMarkup(
      <UsageMeter usage={snapshot({ sessionPct: 72, weeklyPct: 40 })} />,
    );
    expect(html).toContain("72%");
    expect(html).toContain("text-usage-warn");
  });

  it("escalates to crit when the tightest limit is near the ceiling", () => {
    const html = renderToStaticMarkup(
      <UsageMeter usage={snapshot({ sessionPct: 20, weeklyPct: 94 })} />,
    );
    expect(html).toContain("94%");
    expect(html).toContain("text-usage-crit");
  });
});

describe("UsageRow", () => {
  it("renders the label, rounded % used, and an accessible progressbar", () => {
    const html = renderToStaticMarkup(
      <UsageRow label="Session · 5h" pct={66.6} resetAt={null} />,
    );
    expect(html).toContain("Session · 5h");
    expect(html).toContain("67% used");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="67"');
  });

  it("shows both a relative countdown and an absolute reset time", () => {
    const resetAt = new Date(Date.now() + 2 * 3600_000 + 15 * 60_000).toISOString();
    const html = renderToStaticMarkup(<UsageRow label="Weekly" pct={10} resetAt={resetAt} />);
    expect(html).toMatch(/resets in 2h \d+m/); // relative countdown
    expect(html).toContain("·"); // separates relative from the absolute stamp
    // Derive the year from resetAt (local, matching the component's formatting) so the assertion
    // isn't pinned to 2026 — a hard-coded year breaks once the clock passes it or near a boundary.
    expect(html).toContain(String(new Date(resetAt).getFullYear())); // absolute reset stamp
  });
});

describe("UsagePill", () => {
  it("renders nothing before usage resolves — no reserved slot, no layout shift", () => {
    // The fetch effect never runs during static rendering, so the pill starts hidden. This is
    // also the API-returns-null state: the pill collapses to empty output rather than a shell.
    expect(renderToStaticMarkup(<UsagePill />)).toBe("");
  });
});
