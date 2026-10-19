/**
 * `templateHeadline` (anton-qitea): the one-line summary a feature card or the project digest
 * reads above its event list — "4 events: 2 runs finished, 1 PR opened, 1 escalation raised".
 *
 * Deliberately template-only, no LLM (that is a later feature, per the digest epic's "Out of
 * scope"): a fixed phrase per {@link TimelineEventKind}, grouped and counted, in the kind's
 * canonical declaration order so the same event set always reads the same way regardless of the
 * order its events arrived in. The template never quotes an id — not `featureId`, not
 * `sourceRefs`, not a bead id pulled from `data` — so there is nothing in the text that could name
 * an id absent from the events it was built from.
 */
import type { TimelineEvent, TimelineEventKind } from "../timeline";

interface Phrase {
  readonly one: string;
  readonly many: string;
}

// Canonical order the headline lists kinds in — the declaration order of TimelineEventKind in
// timeline.ts — so two event sets with the same kinds always read the same way. A Record over the
// full union, same exhaustiveness trick timeline.ts uses: a kind added there fails typecheck here
// until it gets a phrase.
const PHRASE: Readonly<Record<TimelineEventKind, Phrase>> = Object.freeze({
  "run.started": { one: "run started", many: "runs started" },
  "run.pr_opened": { one: "PR opened", many: "PRs opened" },
  "run.parked": { one: "run parked", many: "runs parked" },
  "run.finished": { one: "run finished", many: "runs finished" },
  "run.failed": { one: "run failed", many: "runs failed" },
  "escalation.raised": { one: "escalation raised", many: "escalations raised" },
  "escalation.resolved": { one: "escalation resolved", many: "escalations resolved" },
  "picker.started": { one: "picker run", many: "picker runs" },
  "picker.verdict": { one: "picker verdict", many: "picker verdicts" },
  "autopilot.disarmed": { one: "autopilot disarmed", many: "autopilot disarmed" },
  "proposal.filed": { one: "proposal filed", many: "proposals filed" },
  "proposal.applied": { one: "proposal applied", many: "proposals applied" },
  "proposal.refused": { one: "proposal refused", many: "proposals refused" },
  "scan.summary": { one: "scan summary", many: "scan summaries" },
  "bead.closed": { one: "bead closed", many: "beads closed" },
  "pr.merged": { one: "PR merged", many: "PRs merged" },
});

const KIND_ORDER = Object.keys(PHRASE) as readonly TimelineEventKind[];

/** One event's own phrase, singular — what a feature card's "last 5 events" list reads per row
 * (anton-y1uxp). Same template, same no-LLM rule as {@link templateHeadline}; just not folded by count. */
export function eventPhrase(kind: TimelineEventKind): string {
  return PHRASE[kind].one;
}

/**
 * One deterministic line for either a single feature's events or a whole project's — the caller
 * decides which by what it filters `events` to before calling. Order and wording never depend on
 * anything but the kinds present and how many of each.
 */
export function templateHeadline(events: readonly TimelineEvent[]): string {
  if (events.length === 0) return "No new activity";

  const counts = new Map<TimelineEventKind, number>();
  for (const { kind } of events) counts.set(kind, (counts.get(kind) ?? 0) + 1);

  const parts = KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => {
    const count = counts.get(kind)!;
    const phrase = PHRASE[kind];
    return count === 1 ? phrase.one : `${count} ${phrase.many}`;
  });

  const total = events.length;
  return `${total} event${total === 1 ? "" : "s"}: ${parts.join(", ")}`;
}
