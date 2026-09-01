import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Bead } from "@/lib/beads/types";
import { contractStatusOf } from "@/lib/beads/contract";
import type { Epic } from "@/lib/types";
import { EpicCard } from "@/components/board/epic-card";

function makeEpic(over: Partial<Epic> = {}): Epic {
  const ready = over.ready ?? true;
  return {
    id: "anton-1",
    title: "Resumable crawl checkpoints",
    type: "feature",
    approved: false,
    stage: "backlog",
    assignee: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    createdBy: null,
    blockedBy: [],
    ready,
    // Mirrors toEpic's own fallback: a fixture that says only `ready: false` means fully blocked.
    childReadiness: ready ? "ready" : "blocked",
    readyChildren: [],
    blockedChildren: [],
    rank: 0,
    priority: 2,
    abandoned: false,
    tickets: [],
    ...over,
  };
}

describe("EpicCard type language", () => {
  it("presents a feature card as a feature, not an epic", () => {
    const html = renderToStaticMarkup(<EpicCard slug="anton" epic={makeEpic()} />);
    expect(html).toContain("Feature"); // the compact type badge
    expect(html).not.toContain("Epic");
    expect(html).toContain("feature id"); // copy affordance + delete/open wording
    expect(html).toContain("Delete feature");
    expect(html).toContain("Open feature");
  });

  it("still reads as an epic for a legacy run target", () => {
    const html = renderToStaticMarkup(<EpicCard slug="anton" epic={makeEpic({ type: "epic" })} />);
    expect(html).toContain("Epic");
    expect(html).toContain("epic id");
    expect(html).toContain("Delete epic");
  });

  it("carries the type onto a done card too", () => {
    const html = renderToStaticMarkup(
      <EpicCard slug="anton" epic={makeEpic({ stage: "done", tickets: [] })} />,
    );
    expect(html).toContain("feature id");
    expect(html).not.toContain("epic id");
  });
});

describe("EpicCard contract marking", () => {
  // Built through the shared validator rather than hand-written violations, so the card is tested
  // against the wording approve and the runner would use.
  const statusOf = (over: Partial<Bead>) =>
    contractStatusOf({
      id: "anton-1",
      title: "Resumable crawl checkpoints",
      status: "open",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      ...over,
    });

  const SHAPED = "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO\n\n## Verify\nV";

  it("marks a blocking gap and replaces Approve with an inert affordance naming it", () => {
    const html = renderToStaticMarkup(
      <EpicCard slug="anton" epic={makeEpic({ contract: statusOf({ description: SHAPED }) })} />,
    );
    // Visibly marked, by the section that is missing.
    expect(html).toContain("needs Acceptance");
    // The affordance stays, says what is missing, and can't be clicked into a 422.
    expect(html).toContain("Can&#x27;t approve — no Acceptance criteria");
    expect(html).toContain('disabled=""');
  });

  it("shows an advisory gap as a nudge and still offers Approve", () => {
    const html = renderToStaticMarkup(
      <EpicCard
        slug="anton"
        epic={makeEpic({
          contract: statusOf({
            description: "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO",
            acceptance_criteria: "- [ ] done",
          }),
        })}
      />,
    );
    expect(html).toContain("1 spec gap");
    // A nudge never withholds the run.
    expect(html).not.toContain("needs ");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Approve");
  });

  it("leaves a conformant card unmarked", () => {
    const html = renderToStaticMarkup(
      <EpicCard
        slug="anton"
        epic={makeEpic({
          contract: statusOf({ description: `${SHAPED}\n\n## Acceptance\n- [ ] done` }),
        })}
      />,
    );
    expect(html).not.toContain("spec gap");
    expect(html).not.toContain("needs ");
    expect(html).not.toContain('disabled=""');
  });
});

describe("EpicCard readiness (anton-zztt)", () => {
  // The partially-gated shape the executor now runs: one ticket held by a blocker outside the run,
  // two the run can dispatch immediately. `ready`/`blockedBy` still read the coarse target-level
  // rollup, so the card must be driven by the per-child verdict, not by them.
  const partial = () =>
    makeEpic({
      ready: false,
      blockedBy: ["anton-9"],
      childReadiness: "partially-blocked",
      readyChildren: ["anton-2", "anton-3"],
      blockedChildren: ["anton-4"],
    });

  it("reads a partially-gated target as N/M ready, keeps it lit, and still offers Approve", () => {
    const html = renderToStaticMarkup(<EpicCard slug="anton" epic={partial()} />);
    expect(html).toContain("partially blocked · 2/3 ready");
    // Named, so the operator knows which ticket is waiting rather than just that something is.
    expect(html).toContain("anton-4");
    expect(html).toContain(">Approve<");
    // Neither the dead-stop chip nor the dimming: this run starts now.
    expect(html).not.toContain("blocked by anton-9");
    expect(html).not.toContain("opacity-60");
  });

  it("still reads a fully blocked target as blocked, dimmed, with no Approve", () => {
    const html = renderToStaticMarkup(
      <EpicCard
        slug="anton"
        epic={makeEpic({
          ready: false,
          blockedBy: ["anton-9"],
          childReadiness: "blocked",
          blockedChildren: ["anton-4"],
        })}
      />,
    );
    expect(html).toContain("blocked by anton-9");
    expect(html).toContain("opacity-60");
    expect(html).not.toContain("partially blocked");
    expect(html).not.toContain(">Approve<");
  });
});

describe("EpicCard review score (anton-tprv)", () => {
  it("shows the target's latest score, tinted by what the band means", () => {
    const shipped = renderToStaticMarkup(
      <EpicCard slug="anton" epic={makeEpic({ reviewScore: 9 })} />,
    );
    expect(shipped).toContain("review 9/10");
    expect(shipped).toContain("ships as-is");

    const rework = renderToStaticMarkup(
      <EpicCard slug="anton" epic={makeEpic({ reviewScore: 3 })} />,
    );
    expect(rework).toContain("review 3/10");
    expect(rework).toContain("substantial rework");
  });

  it("carries the score onto a done card — the last word on what the run delivered", () => {
    const html = renderToStaticMarkup(
      <EpicCard slug="anton" epic={makeEpic({ stage: "done", reviewScore: 7 })} />,
    );
    expect(html).toContain("review 7/10");
  });

  it("shows nothing for a target no review has scored", () => {
    const html = renderToStaticMarkup(<EpicCard slug="anton" epic={makeEpic()} />);
    expect(html).not.toMatch(/review \d/);
    expect(html).not.toContain("0/10");
  });

  it("still renders a genuine zero — a run CAN score nothing usable", () => {
    const html = renderToStaticMarkup(
      <EpicCard slug="anton" epic={makeEpic({ reviewScore: 0 })} />,
    );
    expect(html).toContain("review 0/10");
  });
});

/**
 * A pick the operator vetoed stays on the board, drawn as set aside (anton-jqvy). A card that simply
 * stopped being offered would leave the operator wondering what they broke.
 */
describe("EpicCard — a vetoed target", () => {
  const UNTIL = Date.now() + 5 * 60 * 60 * 1000;

  it("shows the hold and how long is left on it", () => {
    const html = renderToStaticMarkup(
      <EpicCard slug="anton" epic={makeEpic({ notNowUntil: UNTIL })} />,
    );
    expect(html).toContain("not now");
    expect(html).toContain("Resumable crawl checkpoints");
  });

  it("says nothing about a target nobody vetoed", () => {
    expect(renderToStaticMarkup(<EpicCard slug="anton" epic={makeEpic()} />)).not.toContain(
      "not now",
    );
  });
});
