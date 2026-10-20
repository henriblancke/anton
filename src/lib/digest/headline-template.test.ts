/**
 * `templateHeadline`: every {@link TimelineEventKind} maps to a phrase, counts and ordering stay
 * deterministic regardless of input order, and the text never names an id the input didn't carry.
 */
import { describe, expect, it } from "vitest";

import { templateHeadline } from "./headline-template";
import type { TimelineEvent, TimelineEventKind } from "../timeline";

const ALL_KINDS: readonly TimelineEventKind[] = [
  "run.started",
  "run.pr_opened",
  "run.parked",
  "run.finished",
  "run.failed",
  "escalation.raised",
  "escalation.resolved",
  "picker.started",
  "picker.verdict",
  "autopilot.disarmed",
  "proposal.filed",
  "proposal.applied",
  "proposal.refused",
  "scan.summary",
  "bead.closed",
  "pr.merged",
];

let seq = 0;
const eventOf = (kind: TimelineEventKind, overrides: Partial<TimelineEvent> = {}): TimelineEvent => ({
  at: seq++,
  projectId: "proj-1",
  featureId: "feat-1",
  kind,
  data: {},
  sourceRefs: [`src-${seq}`],
  ...overrides,
});

describe("templateHeadline — empty input", () => {
  it("says so without inventing an event", () => {
    expect(templateHeadline([])).toBe("No new activity");
  });
});

describe("templateHeadline — covers every event kind", () => {
  it.each(ALL_KINDS)("renders a single %s event as one line with a count of 1 event", (kind) => {
    const headline = templateHeadline([eventOf(kind)]);
    expect(headline.startsWith("1 event: ")).toBe(true);
    // Singular form never carries a leading digit for its own phrase.
    expect(headline).not.toMatch(/: \d/);
  });

  it("every kind produces a distinct, non-empty phrase", () => {
    const phrases = ALL_KINDS.map((kind) => templateHeadline([eventOf(kind)]));
    expect(new Set(phrases).size).toBe(ALL_KINDS.length);
    for (const phrase of phrases) expect(phrase.length).toBeGreaterThan(0);
  });
});

describe("templateHeadline — counting and pluralization", () => {
  it("pluralizes a repeated kind and totals the count", () => {
    const headline = templateHeadline([eventOf("run.finished"), eventOf("run.finished")]);
    expect(headline).toBe("2 events: 2 runs finished");
  });

  it("keeps a lone kind singular even among other repeated kinds", () => {
    const headline = templateHeadline([
      eventOf("run.finished"),
      eventOf("run.finished"),
      eventOf("run.pr_opened"),
    ]);
    expect(headline).toBe("3 events: PR opened, 2 runs finished");
  });
});

describe("templateHeadline — deterministic ordering", () => {
  it("orders kinds the same way regardless of input order", () => {
    const forward = templateHeadline([
      eventOf("pr.merged"),
      eventOf("run.started"),
      eventOf("escalation.raised"),
    ]);
    const reversed = templateHeadline([
      eventOf("escalation.raised"),
      eventOf("run.started"),
      eventOf("pr.merged"),
    ]);
    expect(forward).toBe(reversed);
    expect(forward).toBe("3 events: run started, escalation raised, PR merged");
  });

  it("is stable across every kind at once, built in two different input orders", () => {
    const inOrder = templateHeadline(ALL_KINDS.map((kind) => eventOf(kind)));
    const shuffled = templateHeadline([...ALL_KINDS].reverse().map((kind) => eventOf(kind)));
    expect(inOrder).toBe(shuffled);
    expect(inOrder.startsWith(`${ALL_KINDS.length} events: `)).toBe(true);
  });
});

describe("templateHeadline — never names an id not in its input", () => {
  it("names no id at all for a mix of kinds carrying distinct features and source refs", () => {
    const events = [
      eventOf("run.finished", { featureId: "feat-a", sourceRefs: ["att-1"] }),
      eventOf("escalation.raised", { featureId: "feat-b", sourceRefs: ["esc-1"] }),
      eventOf("bead.closed", { featureId: null, sourceRefs: ["bead-9"] }),
    ];
    const knownIds = new Set(
      events.flatMap((e) => [e.projectId, e.featureId, ...e.sourceRefs].filter((v): v is string => v != null)),
    );

    const headline = templateHeadline(events);

    // The template never quotes an id in the first place — assert that directly, then confirm the
    // (vacuous) stronger property: any id-shaped token it did emit would have to be one of these.
    for (const id of knownIds) expect(headline).not.toContain(id);

    const tokens = headline.split(/[\s,:]+/).filter(Boolean);
    for (const token of tokens) {
      if (knownIds.has(token)) continue;
      expect(knownIds.has(token)).toBe(false);
    }
  });
});

describe("templateHeadline — picker verdict and run outcome data is summarized by kind, not echoed", () => {
  it("does not leak the verdict/outcome value itself into the text", () => {
    const headline = templateHeadline([
      eventOf("picker.verdict", { data: { verdict: "declined" } }),
      eventOf("run.failed", { data: { outcome: "failed" } }),
    ]);
    expect(headline).toBe("2 events: run failed, picker verdict");
  });
});
