import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { makeStandaloneItem } from "@/components/board/standalone-item.fixture";
import { ChipHeader, ChipMeta } from "@/components/board/standalone-chip-parts";

describe("ChipHeader", () => {
  it("goes inert under the chip's open trigger but keeps a linked PR clickable", () => {
    const html = renderToStaticMarkup(
      <ChipHeader
        item={makeStandaloneItem({ prRef: "gh-42", prUrl: "https://x/pull/42" })}
        hasOverlay
      />,
    );
    expect(html).toContain("pointer-events-none"); // the row itself must not eat the overlay's clicks
    expect(html).toContain("pointer-events-auto"); // …the PR link opts back in
    expect(html).toContain("https://x/pull/42");
  });

  it("keeps the row live when no overlay sits behind it", () => {
    const html = renderToStaticMarkup(<ChipHeader item={makeStandaloneItem()} hasOverlay={false} />);
    expect(html).not.toContain("pointer-events-none");
  });

  it("leaves an unlinked PR ref un-clickable rather than a dead link", () => {
    const html = renderToStaticMarkup(
      <ChipHeader item={makeStandaloneItem({ prRef: "gh-42" })} hasOverlay />,
    );
    expect(html).toContain("#42");
    expect(html).not.toContain("pointer-events-auto");
  });

  it("green-tints a shipped PR and never an abandoned one", () => {
    const shipped = makeStandaloneItem({ stage: "done", prRef: "gh-42" });
    expect(renderToStaticMarkup(<ChipHeader item={shipped} hasOverlay />)).toContain("text-stage-done");
    expect(
      renderToStaticMarkup(<ChipHeader item={{ ...shipped, abandoned: true }} hasOverlay />),
    ).not.toContain("text-stage-done");
  });

  it("pulses `working` only while implementing without a PR to point at", () => {
    const working = makeStandaloneItem({ stage: "implementing" });
    expect(renderToStaticMarkup(<ChipHeader item={working} hasOverlay />)).toContain("working");
    // Once the PR is up it speaks for the run; two live indicators would say the same thing twice.
    expect(
      renderToStaticMarkup(<ChipHeader item={{ ...working, prRef: "gh-42" }} hasOverlay />),
    ).not.toContain("working");
  });

  it("marks a self-filed bug that is still awaiting triage", () => {
    const html = renderToStaticMarkup(
      <ChipHeader item={makeStandaloneItem({ type: "bug", unread: true })} hasOverlay />,
    );
    expect(html).toContain('aria-label="Unread"');
  });
});

describe("ChipMeta", () => {
  it("carries the type, id, agent and risk of the item", () => {
    const html = renderToStaticMarkup(
      <ChipMeta
        slug="anton"
        item={makeStandaloneItem({ agent: "nextjs", risk: "high" })}
        deferred={false}
        hasOverlay
      />,
    );
    expect(html).toContain("t-1");
    expect(html).toContain("Task");
    expect(html).toContain("nextjs");
    expect(html).toContain("high");
  });

  it("shows blockers only in the backlog, where they still hold a run back", () => {
    const blocked = makeStandaloneItem({ ready: false, blockedBy: ["t-9"] });
    expect(renderToStaticMarkup(<ChipMeta slug="anton" item={blocked} deferred={false} hasOverlay />)).toContain(
      "blocked by t-9",
    );
    expect(
      renderToStaticMarkup(
        <ChipMeta slug="anton" item={{ ...blocked, stage: "implementing" }} deferred={false} hasOverlay />,
      ),
    ).not.toContain("blocked by t-9");
  });

  it("renders the snoozed chip from the passed (optimistic) value, not the item's own flag", () => {
    // The chip flips the moment the operator snoozes; `item.deferred` only catches up on the next poll.
    const html = renderToStaticMarkup(
      <ChipMeta slug="anton" item={makeStandaloneItem({ deferred: false })} deferred hasOverlay />,
    );
    expect(html).toContain("snoozed");
  });
});

describe("ChipMeta — a vetoed target", () => {
  const UNTIL = Date.now() + 5 * 60 * 60 * 1000;

  it("draws the picker's bounded hold as its own chip, beside bd's snooze", () => {
    // Two different things: `snoozed` is shared board state a human undoes, `not now` is anton's own
    // machine-local hold that expires. One chip for both would conflate them.
    const html = renderToStaticMarkup(
      <ChipMeta slug="anton" item={makeStandaloneItem({ notNowUntil: UNTIL })} deferred hasOverlay={false} />,
    );
    expect(html).toContain("not now");
    expect(html).toContain("snoozed");
  });

  it("says nothing about a target nobody vetoed", () => {
    const html = renderToStaticMarkup(
      <ChipMeta slug="anton" item={makeStandaloneItem()} deferred={false} hasOverlay={false} />,
    );
    expect(html).not.toContain("not now");
  });
});

/**
 * An epic-of-one is still a card anton picked, so it carries the same provenance grammar the epic
 * card does (anton-cqxd) — one badge vocabulary across every surface a bead renders on.
 */
describe("ChipMeta provenance", () => {
  it("marks the writer that put this chip here and links at its evidence", () => {
    const html = renderToStaticMarkup(
      <ChipMeta
        slug="anton"
        item={makeStandaloneItem({ provenance: [{ kind: "pm", ref: "anton-9", detail: "oversized" }] })}
        deferred={false}
        hasOverlay
      />,
    );

    expect(html).toContain("◈");
    expect(html).toContain("PM");
    expect(html).toContain("/projects/anton/epics/anton-9");
  });

  it("says nothing about a chip no unattended writer touched", () => {
    const html = renderToStaticMarkup(
      <ChipMeta slug="anton" item={makeStandaloneItem()} deferred={false} hasOverlay />,
    );
    expect(html).not.toContain("◈");
  });
});
