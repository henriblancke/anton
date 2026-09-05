/**
 * Provenance badges (anton-cqxd / R3.7), tested at the promise they make: every badge OPENS the
 * evidence behind the claim it prints, and a writer this build has no wording for prints nothing.
 *
 * The second half is the load-bearing one. Provenance crosses the board API as data, so a kind
 * reserved for a writer that has not landed — and a kind from a machine running a newer anton — must
 * degrade to a missing badge rather than to a thrown render that takes the whole board with it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { BeadProvenance } from "@/lib/types";
import { CHIP_WRAPPER } from "@/components/atoms";
import { ProvenanceBadge, ProvenanceBadges } from "@/components/board/provenance-badge";

const render = (provenance: BeadProvenance) =>
  renderToStaticMarkup(<ProvenanceBadge slug="anton" beadId="anton-1" provenance={provenance} />);

describe("◈ policy", () => {
  it("opens the rule that matched, carrying the bead whose criteria to show", () => {
    const html = render({ kind: "policy", ref: "labels:severity", detail: "the work policy" });

    expect(html).toContain("◈");
    expect(html).toContain("policy");
    // The criterion anchors the panel; the bead makes it open at THIS bead's evaluation.
    expect(html).toContain("criterion=labels%3Aseverity");
    expect(html).toContain("bead=anton-1");
    expect(html).toContain("#policy");
    expect(html).toContain("severity:"); // the criterion, named the way the editor labels it
  });

  it("still opens the policy when no criterion admitted it — the panel, not a broken link", () => {
    const html = render({ kind: "policy", detail: "any claimable run target" });

    expect(html).toContain('href="/projects/anton/settings?bead=anton-1#policy"');
    // The rule the picker recorded is the tooltip's own words when there is no control to open at.
    expect(html).toContain("any claimable run target");
  });
});

describe("◈ PM", () => {
  it("opens the product-master proposal and its evidence", () => {
    const html = render({ kind: "pm", ref: "anton-9", detail: "mispriority" });

    expect(html).toContain("◈");
    expect(html).toContain("PM");
    expect(html).toContain('href="/projects/anton/epics/anton-9"');
    // What the pass claimed rides in the title, so the badge says why before it is clicked.
    expect(html).toContain("mispriority");
  });

  it("renders nothing without a proposal to open — never a link built from a missing ref", () => {
    // `ref` is optional on the wire. The proposal IS this badge's evidence, so an entry missing one
    // degrades to no badge rather than to a link that navigates off the board.
    expect(render({ kind: "pm", detail: "mispriority" })).toBe("");
  });
});

describe("the badge's own shape", () => {
  it("wraps its chip in a link that adds no line box of its own", () => {
    // The meta row it sits in is a stretching flex row, and a flex item blockifies: a link left at
    // its inherited metrics would be 24px tall (16px/1.5) around a 16px chip, set the flex line's
    // cross size, and grow every chip beside it by 8px. A badged card would then wear taller chips
    // than an unbadged one for no reason but having been badged (anton-ssks).
    const html = render({ kind: "policy", ref: "types" });
    const anchorClass = /<a[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";

    // The same shape the PR link wears — one collapse, shared, not two class strings that can drift.
    expect(anchorClass).toContain(CHIP_WRAPPER);
  });
});

describe("a writer this build has no wording for", () => {
  it("renders nothing for the RESERVED repair kind — the grammar is extended, not forked", () => {
    expect(render({ kind: "repaired", ref: "anton-9" })).toBe("");
  });

  it("renders nothing (and does not throw) for a kind from a newer anton", () => {
    const unknown = { kind: "wormhole", ref: "anton-9" } as unknown as BeadProvenance;
    expect(() => render(unknown)).not.toThrow();
    expect(render(unknown)).toBe("");
  });
});

describe("every writer that touched one bead", () => {
  it("renders them in the order the board recorded, one grammar apiece", () => {
    const html = renderToStaticMarkup(
      <ProvenanceBadges
        slug="anton"
        beadId="anton-1"
        provenance={[
          { kind: "policy", ref: "types" },
          { kind: "pm", ref: "anton-9", detail: "low-value" },
        ]}
      />,
    );

    expect(html.indexOf("policy")).toBeLessThan(html.indexOf("PM"));
    expect(html).toContain("criterion=types");
    expect(html).toContain("/projects/anton/epics/anton-9");
  });

  it("renders nothing when nothing automated claims the bead", () => {
    expect(
      renderToStaticMarkup(<ProvenanceBadges slug="anton" beadId="anton-1" />),
    ).toBe("");
    expect(
      renderToStaticMarkup(<ProvenanceBadges slug="anton" beadId="anton-1" provenance={[]} />),
    ).toBe("");
  });

  it("leaves no empty gap when every entry is a kind it cannot render", () => {
    expect(
      renderToStaticMarkup(
        <ProvenanceBadges slug="anton" beadId="anton-1" provenance={[{ kind: "repaired" }]} />,
      ),
    ).toBe("");
  });
});
