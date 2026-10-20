/**
 * `featureCardOf`/`groupFeatureCards` (anton-y1uxp): the pure fold behind the digest's feature
 * cards — every field a card carries, and the three-way split a group of cards lands in.
 */
import { describe, expect, it } from "vitest";

import type { Bead } from "../beads/bd";
import { CODEBASE_HEALTH_OUTCOME_ID, type ProjectOutcome } from "../outcomes";
import type { TimelineEvent, TimelineEventKind } from "../timeline";
import { featureCardOf, groupFeatureCards, type DigestFeatureCard } from "./feature-cards";

function makeBead(overrides: Partial<Bead> & { id: string }): Bead {
  return { title: overrides.id, status: "open", issue_type: "feature", labels: [], ...overrides };
}

let seq = 0;
function eventOf(kind: TimelineEventKind, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    at: seq,
    projectId: "proj-1",
    featureId: "feat-1",
    kind,
    data: {},
    sourceRefs: [`src-${seq}`],
    ...overrides,
  };
}

describe("featureCardOf", () => {
  it("carries the bead's own id/title and the window's headline", () => {
    const bead = makeBead({ id: "feat-1", title: "Reports are shareable" });
    const card = featureCardOf(bead, [eventOf("run.finished")], undefined);
    expect(card.id).toBe("feat-1");
    expect(card.title).toBe("Reports are shareable");
    expect(card.headline).toBe("1 event: run finished");
  });

  it("quotes the Why verbatim, and is undefined when the bead authored none", () => {
    const withWhy = makeBead({ id: "feat-1", description: "## Why\n\nServes oriented-operator." });
    expect(featureCardOf(withWhy, [], undefined).why).toBe("Serves oriented-operator.");

    const withoutWhy = makeBead({ id: "feat-1" });
    expect(featureCardOf(withoutWhy, [], undefined).why).toBeUndefined();
  });

  it("reads the outcome id off the outcome: label, undefined when absent", () => {
    const linked = makeBead({ id: "feat-1", labels: ["outcome:reports-are-shareable"] });
    expect(featureCardOf(linked, [], undefined).outcomeId).toBe("reports-are-shareable");

    const unlinked = makeBead({ id: "feat-1", labels: [] });
    expect(featureCardOf(unlinked, [], undefined).outcomeId).toBeUndefined();
  });

  it("passes the resolved cost straight through, including the unpriced undefined", () => {
    const bead = makeBead({ id: "feat-1" });
    expect(featureCardOf(bead, [], 12.5).costUsd).toBe(12.5);
    expect(featureCardOf(bead, [], undefined).costUsd).toBeUndefined();
  });

  it("keeps the last five events, newest first", () => {
    const events = [
      eventOf("run.started"),
      eventOf("run.pr_opened"),
      eventOf("escalation.raised"),
      eventOf("escalation.resolved"),
      eventOf("run.finished"),
      eventOf("pr.merged"),
    ];
    const card = featureCardOf(makeBead({ id: "feat-1" }), events, undefined);
    expect(card.events).toHaveLength(5);
    expect(card.events.map((e) => e.kind)).toEqual([
      "pr.merged",
      "run.finished",
      "escalation.resolved",
      "escalation.raised",
      "run.pr_opened",
    ]);
    expect(card.events[0]).toEqual({ kind: "pr.merged", at: events[5]!.at, label: "PR merged" });
  });

  describe("nextStep", () => {
    it("backlog: approval is what's missing until it is granted", () => {
      const notApproved = makeBead({ id: "feat-1", status: "open", labels: [] });
      expect(featureCardOf(notApproved, [], undefined).nextStep).toBe("Needs approval to run");

      const approved = makeBead({ id: "feat-1", status: "open", labels: ["approved"] });
      expect(featureCardOf(approved, [], undefined).nextStep).toBe("Queued to run");
    });

    it("implementing: running", () => {
      const bead = makeBead({ id: "feat-1", status: "in_progress" });
      expect(featureCardOf(bead, [], undefined).nextStep).toBe("Running");
    });

    it("in-review: PR open means awaiting merge, otherwise awaiting review", () => {
      const withPr = makeBead({ id: "feat-1", labels: ["stage:in-review"], external_ref: "gh-218" });
      expect(featureCardOf(withPr, [], undefined).nextStep).toBe("Awaiting merge");

      const withoutPr = makeBead({ id: "feat-1", labels: ["stage:in-review"] });
      expect(featureCardOf(withoutPr, [], undefined).nextStep).toBe("Awaiting review");
    });

    it("done: shipped, or abandoned when closed as won't-do", () => {
      const shipped = makeBead({ id: "feat-1", status: "closed" });
      expect(featureCardOf(shipped, [], undefined).nextStep).toBe("Shipped");

      const abandoned = makeBead({ id: "feat-1", status: "closed", labels: ["abandoned"] });
      expect(featureCardOf(abandoned, [], undefined).nextStep).toBe("Abandoned — no further action");
    });
  });
});

const OUTCOMES: ProjectOutcome[] = [
  { id: CODEBASE_HEALTH_OUTCOME_ID, summary: "Tests, types, and lint stay green.", retired: false },
  { id: "reports-are-shareable", summary: "Anyone can share a report outside the app.", retired: false },
  { id: "oriented-operator", summary: "The operator always knows what anton did.", retired: false },
];

function cardOf(overrides: Partial<DigestFeatureCard> & { id: string }): DigestFeatureCard {
  return {
    title: overrides.id,
    headline: "1 event: run finished",
    why: undefined,
    outcomeId: undefined,
    stage: "implementing",
    prRef: undefined,
    prUrl: undefined,
    reviewScore: undefined,
    costUsd: undefined,
    nextStep: "Running",
    events: [],
    ...overrides,
  };
}

describe("groupFeatureCards", () => {
  it("groups by outcome, in the order outcomes declares them", () => {
    const cards = [
      cardOf({ id: "feat-a", outcomeId: "oriented-operator" }),
      cardOf({ id: "feat-b", outcomeId: "reports-are-shareable" }),
    ];
    const groups = groupFeatureCards(cards, OUTCOMES);
    expect(groups.map((g) => g.outcomeId)).toEqual(["reports-are-shareable", "oriented-operator"]);
    expect(groups[0]!.kind).toBe("outcome");
    expect(groups[0]!.label).toBe("Anyone can share a report outside the app.");
    expect(groups[0]!.cards.map((c) => c.id)).toEqual(["feat-b"]);
  });

  it("collects every feature with no outcome label into its own unlinked group", () => {
    const cards = [cardOf({ id: "feat-a", outcomeId: undefined })];
    const groups = groupFeatureCards(cards, OUTCOMES);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "unlinked", label: "No outcome linked" });
    expect(groups[0]!.cards.map((c) => c.id)).toEqual(["feat-a"]);
  });

  it("treats an outcome id PRODUCT.md no longer declares as unlinked, not as a dropped card", () => {
    const cards = [cardOf({ id: "feat-a", outcomeId: "a-retired-and-removed-outcome" })];
    const groups = groupFeatureCards(cards, OUTCOMES);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("unlinked");
  });

  it("folds codebase-health-only work into its own housekeeping group, ordered last", () => {
    const cards = [
      cardOf({ id: "feat-housekeeping", outcomeId: CODEBASE_HEALTH_OUTCOME_ID }),
      cardOf({ id: "feat-named", outcomeId: "oriented-operator" }),
      cardOf({ id: "feat-unlinked", outcomeId: undefined }),
    ];
    const groups = groupFeatureCards(cards, OUTCOMES);
    expect(groups.map((g) => g.kind)).toEqual(["outcome", "unlinked", "housekeeping"]);
    const housekeeping = groups.at(-1)!;
    expect(housekeeping.label).toBe("Housekeeping");
    expect(housekeeping.cards.map((c) => c.id)).toEqual(["feat-housekeeping"]);
  });

  it("omits a group entirely when it would hold no cards", () => {
    const cards = [cardOf({ id: "feat-a", outcomeId: "oriented-operator" })];
    const groups = groupFeatureCards(cards, OUTCOMES);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.outcomeId).toBe("oriented-operator");
  });

  it("returns nothing for an empty card list", () => {
    expect(groupFeatureCards([], OUTCOMES)).toEqual([]);
  });
});
