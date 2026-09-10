"use client";

import { useState, useSyncExternalStore } from "react";
import { HandIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import { MetaChip } from "@/components/atoms";
import { Disclosure } from "@/components/health/disclosure";
import { DismissAllButton } from "@/components/health/dismiss-all-button";
import { EscalationActions } from "@/components/health/escalation-actions";
import { escalationAge } from "@/components/health/escalation-age";
import { isDismissable } from "@/lib/escalation-kinds";
import type { EscalationKind, EscalationView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** What each class is, said the way a founder would say it. */
export const ESCALATION_LABELS: Record<EscalationKind, string> = {
  "parked-run": "Parked run",
  "stale-pr": "Stale PR",
  "dead-lease": "Dead lease",
  "exhausted-job": "Retries spent",
  "needs-human": "Waiting on you",
  "autopilot-disarm": "Autopilot disarmed",
};

/**
 * Whether this row is a REQUEST rather than a failure — the difference between "anton needs thirty
 * seconds of your time" and "anton is broken and needs you to diagnose it".
 *
 * A `needs-human` row is an open human gate: work that is stopped BY DESIGN, waiting on a decision
 * the founder themselves asked to make. Nothing went wrong, so nothing about the row should read as
 * though something did — it gets the review-blue treatment (chip, accent, header) that says "your
 * turn" instead of the destructive red that the four accidental stalls earn. Rendering the two
 * identically, as this strip used to, taxes every glance with a diagnosis the colour should have
 * already made.
 */
function isRequest(escalation: EscalationView): boolean {
  return escalation.kind === "needs-human";
}

/**
 * Every alert that needs a decision, in full, with the founder's answers to each: Resume, Dismiss,
 * Abandon (anton-wvcy, moved here by anton-7gxs).
 *
 * This list used to sit above the board as a strip. It could not stay there: one upstream outage
 * raises one alert per stalled job, each carrying a park message that must be printed in full to be
 * decidable, and thirty of those pushed the columns off the screen. The board now carries a
 * one-line summary that links here, and this page is allowed to be as long as the trouble is —
 * which is the only place a list like this can honestly live.
 *
 * Two classes of row live here, and they are NOT the same errand (anton-mivh.2): a request — an open
 * human gate, work paused because a founder asked to be asked — and a failure, work that stopped by
 * accident. Requests lead, then failures, each group contiguous: interleaving them by raise time
 * buries the row that takes thirty seconds under rows that take an investigation, and a founder
 * scanning for "what can I clear right now" would have to read every row to find it. Cheap and
 * certain before expensive and uncertain. See {@link isRequest} for why the two look different.
 *
 * Failures are then GROUPED BY KIND, which the strip never did, for the same reason this list moved:
 * a burst is one event wearing thirty faces. Grouped, a storm reads as one block with one header and
 * one "Dismiss all", instead of thirty rows that must each be read to discover they say the same
 * thing. Requests are never grouped — each is a different person's different question.
 *
 * Renders nothing when nothing has stopped. This is NOT a "checked, clean" claim — that belongs to
 * the rail, which always renders and says what has and hasn't run.
 */
export function NeedsYouSection({
  slug,
  escalations,
}: {
  slug: string;
  escalations: EscalationView[];
}) {
  if (escalations.length === 0) return null;

  const requests = escalations.filter(isRequest);
  const failures = escalations.filter((escalation) => !isRequest(escalation));
  // Nothing broke — so nothing here is drawn as broken, down to the section itself and its icon.
  const broken = failures.length > 0;

  return (
    <section
      id="needs-you"
      aria-labelledby="needs-you-heading"
      className={cn(
        "overflow-hidden rounded-xl border",
        broken
          ? "border-destructive/25 bg-destructive/[0.04]"
          : "border-stage-in-review/25 bg-stage-in-review/[0.04]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        {broken ? (
          <TriangleAlertIcon className="size-3.5 text-destructive" aria-hidden="true" />
        ) : (
          <HandIcon className="size-3.5 text-stage-in-review" aria-hidden="true" />
        )}
        <h2 id="needs-you-heading" className="text-xs font-medium text-foreground">
          Needs you
        </h2>
        {/* Counted apart, because one number covering both would answer neither question a founder
            asks of this section: how much is broken, and how much is merely theirs to answer. */}
        {requests.length > 0 ? (
          <MetaChip tone="pr">{requests.length} to answer</MetaChip>
        ) : null}
        {failures.length > 0 ? (
          <MetaChip tone="risk-high">{failures.length} stopped</MetaChip>
        ) : null}
      </div>

      {/* Ungrouped: every ask is a different question from a different gate, so a header over them
          would group things that share only their shape. */}
      {requests.length > 0 ? (
        <ul className="divide-y divide-border/50">
          {requests.map((escalation) => (
            <AlertRow key={escalation.id} slug={slug} escalation={escalation} request tinted={broken} />
          ))}
        </ul>
      ) : null}

      {groupByKind(failures).map((group) => (
        <FailureGroup key={group.kind} slug={slug} group={group} />
      ))}
    </section>
  );
}

/** One kind's worth of failures — what a burst collapses into. */
interface FailureGroup {
  kind: EscalationKind;
  rows: EscalationView[];
}

/**
 * Failures bucketed by kind, each bucket in the order it arrived in.
 *
 * Kinds appear in the order their first row does rather than in a fixed ranking: the rows arrive
 * newest stall first, so this puts the freshest trouble at the top — which is what a founder opening
 * this page after a bad night is looking for.
 */
function groupByKind(failures: EscalationView[]): FailureGroup[] {
  const groups = new Map<EscalationKind, EscalationView[]>();
  for (const escalation of failures) {
    const rows = groups.get(escalation.kind);
    if (rows) rows.push(escalation);
    else groups.set(escalation.kind, [escalation]);
  }
  return [...groups].map(([kind, rows]) => ({ kind, rows }));
}

/** Past this many rows, a group folds: a storm should cost one line until someone opens it. */
const FOLD_ABOVE = 5;

/**
 * One kind of failure, with the one verb that answers all of it at once.
 *
 * "Dismiss all" is offered only where dismissing means something (see `isDismissable`): on a
 * `needs-human` or an `autopilot-disarm` it would settle rows that must not be settled, and the
 * server refuses it anyway — offering a button the server refuses is worse than not offering it.
 */
function FailureGroup({ slug, group }: { slug: string; group: FailureGroup }) {
  const label = ESCALATION_LABELS[group.kind] ?? group.kind;
  const rows = (
    <ul className="divide-y divide-border/50">
      {group.rows.map((escalation) => (
        <AlertRow key={escalation.id} slug={slug} escalation={escalation} named={false} />
      ))}
    </ul>
  );

  return (
    <div className="border-t border-border/50">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 bg-background/30 px-3 py-1.5">
        <h3 className="font-mono text-[11px] tracking-wide text-subtle uppercase">{label}</h3>
        <MetaChip tone="risk-high">{group.rows.length}</MetaChip>
        <span className="flex-1" />
        {isDismissable(group.kind) ? (
          <DismissAllButton slug={slug} ids={group.rows.map((row) => row.id)} label={label} />
        ) : null}
      </div>
      {group.rows.length > FOLD_ABOVE ? (
        <div className="px-3 py-1.5">
          <Disclosure
            summary={`${group.rows.length} alerts, all reporting ${label.toLowerCase()}`}
          >
            {rows}
          </Disclosure>
        </div>
      ) : (
        rows
      )}
    </div>
  );
}

/** One alert, with the founder's answer to it. */
function AlertRow({
  slug,
  escalation,
  request = false,
  tinted = false,
  named = true,
}: {
  slug: string;
  escalation: EscalationView;
  request?: boolean;
  /** Only worth tinting a request against failures: on an all-request list it reads as a highlight. */
  tinted?: boolean;
  /**
   * Whether this row names its own class. False inside a failure group, whose header already does:
   * repeating "Retries spent" on thirty consecutive rows under a header that says it once is exactly
   * the noise grouping was meant to remove.
   */
  named?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex flex-wrap items-start gap-x-2.5 gap-y-1.5 px-3 py-2",
        request && tinted && "bg-stage-in-review/[0.05]",
      )}
    >
      <span
        className={cn(
          "mt-0.5 w-0.5 shrink-0 self-stretch rounded-full",
          request ? "bg-stage-in-review" : "bg-risk-high",
        )}
        aria-hidden="true"
      />
      <EscalationRow slug={slug} escalation={escalation} named={named} />
    </li>
  );
}

/** Nothing to watch: the answer flips once, when React finishes hydrating, and never again. */
function subscribeToHydration(): () => void {
  return () => {};
}

/**
 * How long this has been waiting — the sweep's frozen age until the browser has hydrated, the live
 * age afterwards. The verb is the caller's: a failure is "stuck", a request is "waiting", and the
 * age means something different in each (elapsed damage vs. how long someone has been held up).
 *
 * This strip is a Client Component, so every row renders twice: once in the server prerender and
 * once in the browser's hydration pass. Reading the clock in both would give two different answers
 * for any stall that crossed a minute (or hour, or day) boundary between them, and React resolves a
 * subtree that hydrates to different text by throwing it away. The sweep's `ageMs` is server data
 * and so reads identically on both sides.
 *
 * `useSyncExternalStore` with a server snapshot — the shape `useActiveSection` uses in the settings
 * form — rather than an effect that seeds state: React reads `getServerSnapshot` on BOTH sides of
 * hydration by construction, so there is no render where the two can disagree.
 *
 * The clock is read once per mount rather than on every render: an age that changed mid-render
 * would make this component impure, and the value is printed in units no finer than a minute, so a
 * strip that re-renders is not a strip that needs a new reading.
 */
function HowLong({ escalation, verb }: { escalation: EscalationView; verb: string }) {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const [mountedAt] = useState(() => Date.now());
  return (
    <>
      {verb} {escalationAge(escalation, hydrated ? mountedAt : undefined)}
    </>
  );
}

/**
 * What the row's buttons act on. A wait on a person is answered on its GATE — that is the stall, and
 * closing it is a settling move whether or not anton has a run to re-queue behind it.
 */
function actionTarget(escalation: EscalationView): "work" | "job" | "gate" {
  if (escalation.kind === "needs-human" && escalation.gateId) return "gate";
  if (escalation.beadId === undefined && escalation.epicBeadId === undefined) return "job";
  return "work";
}

/**
 * Whether the row's primary verb has anything to act on. A gate wait needs only the gate: it may
 * block work anton doesn't run at all (a molecule step, someone else's bead), and the person is
 * being waited on either way.
 */
function canResume(escalation: EscalationView): boolean {
  if (escalation.kind === "needs-human") return escalation.gateId !== undefined;
  // A stale PR waits on a reviewer, so a resume would settle the row and change nothing.
  if (escalation.kind === "stale-pr") return false;
  return escalation.epicBeadId !== undefined || escalation.jobId !== undefined;
}

/**
 * Whether the row's abandon has anything to act on. Same rule as {@link canResume} for a gate wait,
 * and for the same reason: "I'm not going to do this" ends the wait even when the gate blocks work
 * anton never runs, because closing the gate is the whole answer there.
 */
function canAbandon(escalation: EscalationView): boolean {
  if (escalation.kind === "needs-human" && escalation.gateId !== undefined) return true;
  return escalation.beadId !== undefined || escalation.jobId !== undefined;
}

/** One escalation, with the affordance the founder answers it with: Resume, Dismiss, or Abandon. */
function EscalationRow({
  slug,
  escalation,
  named = true,
}: {
  slug: string;
  escalation: EscalationView;
  named?: boolean;
}) {
  const request = isRequest(escalation);
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {named ? (
            <MetaChip tone={request ? "pr" : "risk-high"}>
              {ESCALATION_LABELS[escalation.kind] ?? escalation.kind}
            </MetaChip>
          ) : null}
          <MetaChip>
            <HowLong escalation={escalation} verb={request ? "waiting" : "stuck"} />
          </MetaChip>
          {escalation.epicBeadId ? (
            <Link
              href={`/projects/${slug}/epics/${escalation.epicBeadId}`}
              className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {escalation.epicBeadId}
            </Link>
          ) : null}
          {escalation.prUrl && escalation.prNumber ? (
            <a
              href={escalation.prUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              PR #{escalation.prNumber}
            </a>
          ) : null}
        </div>
        {/* The park reason — or, on a request, the ask the founder wrote on the gate — is the whole
            point of the row. Full text, never truncated: a founder deciding resume-vs-abandon, or
            remembering what they wanted to check, is deciding on exactly this sentence. Clipping it
            would leave a row that can only be answered by going and reading it somewhere else. */}
        <p className="text-xs text-muted-foreground">{escalation.reason}</p>
        {/* Where an ANSWER goes, on the one row that can have one. Resume closes the gate and
            re-queues the work — it carries nothing back — so an ask that is a decision ("A or B?")
            resolves into a session with the same inputs, which asks it again. The channel that does
            reach that session is the ticket's notes, which anton inlines into the dispatch as
            binding steering; without this line the founder answers into a loop.

            The ticket is NAMED whenever the gate recorded it: on a feature with several children
            "the ticket" is ambiguous, and a note left on the feature reaches no dispatch at all. */}
        {request ? (
          <p className="text-[11px] text-subtle">
            Answering with information — a decision, a value, which option — belongs on{" "}
            {escalation.askBeadId ? (
              <span className="font-mono text-foreground">{escalation.askBeadId}</span>
            ) : (
              "the ticket"
            )}{" "}
            as a note before you resume: the resumed session reads notes as binding steering, while
            resolving the gate carries no answer back.
          </p>
        ) : null}
        {/* A disarm is the one row whose case does not fit in its reason: the operator is being
            asked to judge a series, and a judgment needs what it was made on. Printed in full, for
            the same reason the lane header prints it — see autopilot-breaker.ts. */}
        {escalation.kind === "autopilot-disarm" && escalation.evidence?.length ? (
          <ul className="font-mono text-[11px] text-subtle">
            {escalation.evidence.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {escalation.kind === "autopilot-disarm" ? (
          <p className="text-[11px] text-subtle">
            Re-arm anton in the banner above to clear this — no button here does, because starting
            work again is the whole decision.
          </p>
        ) : null}
        {!escalation.noted && escalation.beadId ? (
          <p className="text-[11px] text-subtle">
            The bd note for this escalation hasn&apos;t landed yet — anton retries it on the next
            sweep.
          </p>
        ) : null}
      </div>
      {/* A finding that names no bead at all (an exhausted sync-push/run-health job) is answered
          on the JOB instead — otherwise the row would show no way to settle it and sit here
          forever. A stale PR gets Dismiss instead of Resume: its work is already delivered and
          open for review, so re-running the epic changes nothing about the PR (execute-epic
          short-circuits on an open one) — the row would settle and the next sweep would raise it
          again. What it needs is a reviewer, which is the founder's move, and the PR link above
          is how they take it. Dismiss is offered THERE and nowhere else: a wait on a person is
          not something to acknowledge and leave open, so its answers are resolve-and-resume (the
          founder did the thing) or abandon (they won't). */}
      <EscalationActions
        slug={slug}
        escalationId={escalation.id}
        canResume={canResume(escalation)}
        canDismiss={escalation.kind === "stale-pr"}
        canAbandon={canAbandon(escalation)}
        target={actionTarget(escalation)}
      />
    </>
  );
}
