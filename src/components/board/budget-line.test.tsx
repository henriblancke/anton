/**
 * The budget line's two lane primitives (anton-vlom / R3.6): the dashed divider, and the waiting
 * treatment on the cards below it.
 *
 * The composition the lane performs is exercised here end-to-end — place the line with
 * `budgetLine`, split the queue on it — because the property that matters is not "a divider
 * renders" but "the divider lands where the governor's headroom says, and everything under it says
 * WHY it is waiting". Every defer reason is rendered, since a card holding for an unworded reason
 * is indistinguishable from one holding for no reason.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { budgetLine, RUN_JOB_TYPE, type BudgetSignal } from "@/lib/budget-line";
import type { DeferReason } from "@/lib/jobs/budget";
import { BudgetDivider, BudgetWaiting } from "@/components/board/budget-line";

function signal(sessionPct: number, sessionReason: DeferReason = "session-headroom"): BudgetSignal {
  return {
    headroom: {
      sessionPct,
      sessionReason: sessionReason as "session-headroom" | "daytime-reserve",
      weeklyPct: null,
      weeklyReason: "weekly-cap",
      weeklyInclusive: true,
    },
    burn: { [RUN_JOB_TYPE]: { sessionPct: 20, weeklyPct: 3, seeded: false } },
  };
}

/** What the lane does with a placement: affordable cards, the divider, then the waiting ones. */
function lane(sig: BudgetSignal | null, cards: readonly string[]) {
  const line = budgetLine(sig, cards.map(() => ({})));
  const affordable = line ? cards.slice(0, line.affordable) : cards;
  const waiting = line ? cards.slice(line.affordable) : [];
  return renderToStaticMarkup(
    <div>
      {affordable.map((id) => (
        <article key={id}>{id}</article>
      ))}
      {line && <BudgetDivider line={line} />}
      {waiting.map((id) => (
        <BudgetWaiting key={id} reason={line!.reason}>
          <article>{id}</article>
        </BudgetWaiting>
      ))}
    </div>,
  );
}

const CARDS = ["anton-a", "anton-b", "anton-c", "anton-d"];

describe("the budget line in a lane", () => {
  it("marks where the remaining headroom is exhausted, with the cards below it waiting", () => {
    // 40% headroom at 20% a run: the second card spends the last of it (the governor admits the
    // run that crosses), so two are affordable and two wait.
    const html = lane(signal(40), CARDS);

    expect(html).toContain("≈ budget · session headroom");
    expect(html).toContain('role="separator"');
    expect(html).toContain("border-dashed");
    // Two waiting cards, each saying so — not just the two below a divider.
    expect(html.match(/waiting · session headroom/g)).toHaveLength(2);
    // The divider sits between the affordable prefix and the first waiting card.
    expect(html.indexOf("anton-b")).toBeLessThan(html.indexOf("≈ budget"));
    expect(html.indexOf("≈ budget")).toBeLessThan(html.indexOf("anton-c"));
  });

  it("omits the line entirely when usage is unreadable — the governor fails open and so does this", () => {
    const html = lane(null, CARDS);

    expect(html).not.toContain("≈ budget");
    expect(html).not.toContain("waiting ·");
    for (const id of CARDS) expect(html).toContain(id);
  });

  it("omits the line when the whole queue is affordable", () => {
    expect(lane(signal(500), CARDS)).not.toContain("≈ budget");
  });

  it("puts the line above every card when the governor is already holding", () => {
    const html = lane(signal(0, "daytime-reserve"), CARDS);

    expect(html.indexOf("≈ budget")).toBeLessThan(html.indexOf("anton-a"));
    expect(html.match(/waiting · daytime reserve/g)).toHaveLength(4);
  });
});

describe("BudgetDivider", () => {
  const REASONS: Record<DeferReason, string> = {
    "session-headroom": "session headroom",
    "weekly-cap": "weekly cap",
    "weekly-on-track": "weekly pacing",
    "daytime-reserve": "daytime reserve",
  };

  for (const [reason, label] of Object.entries(REASONS) as [DeferReason, string][]) {
    it(`words the ${reason} hold, on the divider and on the card`, () => {
      const line = { affordable: 1, reason, seeded: false };
      expect(renderToStaticMarkup(<BudgetDivider line={line} />)).toContain(`≈ budget · ${label}`);

      const card = renderToStaticMarkup(
        <BudgetWaiting reason={reason}>
          <article>anton-a</article>
        </BudgetWaiting>,
      );
      expect(card).toContain(`waiting · ${label}`);
      // The reason is named for assistive tech too — never carried by the dimming alone.
      expect(card).toContain(`aria-label="Waiting — ${label}"`);
    });
  }

  it("presents the line as approximate — sampled averages, not a promise", () => {
    const measured = renderToStaticMarkup(
      <BudgetDivider line={{ affordable: 2, reason: "weekly-cap", seeded: false }} />,
    );
    expect(measured).toContain("Roughly where this project&#x27;s quota runs out");
    expect(measured).toContain("sampled per-run burn averages");

    const seeded = renderToStaticMarkup(
      <BudgetDivider line={{ affordable: 2, reason: "weekly-cap", seeded: true }} />,
    );
    expect(seeded).toContain("estimated from tier seeds");
  });
});

describe("BudgetWaiting", () => {
  it("keeps the card interactive — the line is advisory, not a brake", () => {
    const html = renderToStaticMarkup(
      <BudgetWaiting reason="weekly-cap">
        <button type="button">Release</button>
      </BudgetWaiting>,
    );
    expect(html).toContain("<button");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("pointer-events-none");
  });
});
