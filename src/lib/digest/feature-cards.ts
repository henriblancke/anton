/**
 * The digest's per-feature card (anton-y1uxp): one changed feature's own window of timeline events,
 * folded into what a card renders — a headline, its quoted Why, where it stands, and what's next.
 *
 * Pure over inputs the caller already holds, the same discipline `attention.ts` and
 * `headline-template.ts` keep: no DB, no bd spawn, no `node:fs` here. `feature-cards-read.ts` is the
 * impure half that resolves a feature's cost (feature-ledger-read.ts) and its PR's browser URL
 * (git/remote.ts) before calling into this module — kept separate so this fold stays trivially
 * testable with plain fixtures, and so a client component could import it without dragging a
 * better-sqlite3 dependency along.
 */
import { beads, type Bead } from "../beads/bd";
import { CODEBASE_HEALTH_OUTCOME_ID, type ProjectOutcome } from "../outcomes";
import type { TimelineEvent, TimelineEventKind } from "../timeline";
import { labelValue, deriveStage, parseWhy, reviewScoreOf } from "../ticket-view";
import type { Stage } from "../types";
import { eventPhrase, templateHeadline } from "./headline-template";

/** How many of a card's own events it shows — the acceptance's "last 5 events", newest first. */
const RECENT_EVENT_LIMIT = 5;

/** One row of a card's recent-activity list. */
export interface DigestFeatureEvent {
  kind: TimelineEventKind;
  /** Epoch seconds, `TimelineEvent`'s own unit. */
  at: number;
  /** The event's template phrase (headline-template.ts) — no per-event LLM text, same as the headline. */
  label: string;
}

/** One changed feature, as the digest's card renders it. */
export interface DigestFeatureCard {
  id: string;
  title: string;
  /** The deterministic one-line summary of this feature's own events (anton-qitea). */
  headline: string;
  /** The feature's `## Why`, quoted verbatim — undefined when the bead never authored one. */
  why: string | undefined;
  /** The `outcome:<id>` label this feature serves, or undefined when it names none. */
  outcomeId: string | undefined;
  stage: Stage;
  prRef: string | undefined;
  /** Resolved browser URL for `prRef`, when the caller attached one (feature-cards-read.ts). */
  prUrl: string | undefined;
  reviewScore: number | undefined;
  /** What this feature has cost so far, in USD — undefined when nothing could be priced, never 0. */
  costUsd: number | undefined;
  /** What happens to this feature next, in the operator's words. */
  nextStep: string;
  /** This feature's own events from the window, newest first, capped at {@link RECENT_EVENT_LIMIT}. */
  events: DigestFeatureEvent[];
}

/**
 * What a reader is told to do about this feature next — derived from its stage alone, the same
 * signal the board card's own affordances key off (ticket-view.ts's `deriveStage`). A closed target
 * reads its outcome off `abandoned` the same way `DoneCardBody` does, so the digest never calls a
 * won't-do "shipped".
 */
function nextStepOf(bead: Bead, stage: Stage): string {
  if (stage === "done") return beads.isAbandoned(bead) ? "Abandoned — no further action" : "Shipped";
  if (stage === "in-review") return beads.getPrRef(bead) ? "Awaiting merge" : "Awaiting review";
  if (stage === "implementing") return "Running";
  return beads.isApproved(bead) ? "Queued to run" : "Needs approval to run";
}

/**
 * One feature's card, folded from its own slice of the window (`events` already filtered to this
 * feature by the caller — see {@link groupFeatureCards}'s sibling read) plus whatever cost
 * `feature-cards-read.ts` resolved for it.
 */
export function featureCardOf(
  bead: Bead,
  events: readonly TimelineEvent[],
  costUsd: number | undefined,
): DigestFeatureCard {
  const stage = deriveStage(bead);
  // `events` arrives in `foldTimeline`'s own chronological order — oldest first — so the last N are
  // the newest, and reversing them is what puts the newest on top for the card's own list.
  const recent = events.slice(-RECENT_EVENT_LIMIT).reverse();
  return {
    id: bead.id,
    title: bead.title,
    headline: templateHeadline(events),
    why: parseWhy(bead),
    outcomeId: labelValue(bead.labels, "outcome"),
    stage,
    prRef: beads.getPrRef(bead),
    prUrl: undefined,
    reviewScore: reviewScoreOf(bead),
    costUsd,
    nextStep: nextStepOf(bead, stage),
    events: recent.map((event) => ({ kind: event.kind, at: event.at, label: eventPhrase(event.kind) })),
  };
}

export type DigestGroupKind = "outcome" | "unlinked" | "housekeeping";

/** One section of the grouped digest — a named outcome, the unlinked catch-all, or the collapsed
 * housekeeping group. Dropped entirely by {@link groupFeatureCards} when it would hold no cards. */
export interface DigestFeatureGroup {
  key: string;
  kind: DigestGroupKind;
  /** Present only for `kind: "outcome"` — the outcome this group's cards serve. */
  outcomeId?: string;
  /** What the group's header reads — the outcome's own summary, or a fixed label for the other two kinds. */
  label: string;
  cards: DigestFeatureCard[];
}

/** The unlinked group's fixed header — a feature with no `outcome:<id>` label at all. */
const UNLINKED_LABEL = "No outcome linked";

/** The housekeeping group's fixed header — every card the board's always-present built-in outcome serves. */
const HOUSEKEEPING_LABEL = "Housekeeping";

/**
 * Group cards by the outcome they serve (anton-y1uxp): one section per named outcome, in the order
 * `outcomes` declares them (founder-authored order, same as the rest of the product surface); an
 * "unlinked" catch-all for a card naming no outcome, or one naming an id `outcomes` doesn't carry
 * (a retired outcome dropped from PRODUCT.md entirely); and the built-in `codebase-health` outcome
 * folded into its own group last, collapsed by the caller the way `HousekeepingSection` already
 * collapses hygiene findings (health/housekeeping-section.tsx) — codebase-health-only work is real,
 * but it is not what the digest is for the operator to read first.
 *
 * A group with no cards is OMITTED, not rendered empty — the same "say nothing it hasn't earned"
 * rule every other digest/health section follows.
 */
export function groupFeatureCards(
  cards: readonly DigestFeatureCard[],
  outcomes: readonly ProjectOutcome[],
): DigestFeatureGroup[] {
  const knownIds = new Set(outcomes.map((o) => o.id));
  const byOutcome = new Map<string, DigestFeatureCard[]>();
  const unlinked: DigestFeatureCard[] = [];
  const housekeeping: DigestFeatureCard[] = [];

  for (const card of cards) {
    if (card.outcomeId === CODEBASE_HEALTH_OUTCOME_ID) {
      housekeeping.push(card);
      continue;
    }
    if (card.outcomeId && knownIds.has(card.outcomeId)) {
      const list = byOutcome.get(card.outcomeId);
      if (list) list.push(card);
      else byOutcome.set(card.outcomeId, [card]);
      continue;
    }
    unlinked.push(card);
  }

  const groups: DigestFeatureGroup[] = [];
  for (const outcome of outcomes) {
    if (outcome.id === CODEBASE_HEALTH_OUTCOME_ID) continue;
    const list = byOutcome.get(outcome.id);
    if (!list || list.length === 0) continue;
    groups.push({ key: `outcome:${outcome.id}`, kind: "outcome", outcomeId: outcome.id, label: outcome.summary, cards: list });
  }
  if (unlinked.length > 0) {
    groups.push({ key: "unlinked", kind: "unlinked", label: UNLINKED_LABEL, cards: unlinked });
  }
  if (housekeeping.length > 0) {
    groups.push({ key: "housekeeping", kind: "housekeeping", label: HOUSEKEEPING_LABEL, cards: housekeeping });
  }
  return groups;
}
