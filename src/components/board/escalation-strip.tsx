"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { HandIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import { MetaChip } from "@/components/atoms";
import { EscalationActions } from "@/components/board/escalation-actions";
import { escalationAge } from "@/components/board/escalation-age";
import type { EscalationView, RunHealthFindingKind } from "@/lib/types";
import { cn } from "@/lib/utils";

/** What each class is, said the way a founder would say it. */
const ESCALATION_LABELS: Record<RunHealthFindingKind, string> = {
  "parked-run": "Parked run",
  "stale-pr": "Stale PR",
  "dead-lease": "Dead lease",
  "exhausted-job": "Retries spent",
  "needs-human": "Waiting on you",
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
 * Work that has HALTED, with the founder's only three answers to it: Resume, Dismiss, Abandon
 * (anton-ue90.1 / the health-page split). This used to be one band that also carried hygiene
 * findings, the worst review score, and the patrol's own housekeeping — they shared it because they
 * all answered "does the operator need to look at something", and that was the wrong test. The test
 * that actually earns a spot above the board is narrower: does this row need a DECISION about a card
 * in the columns below, right now? An escalation is the only signal that does — everything else
 * (hygiene, review trend, housekeeping, what the patrol applied on its own) moves an answer forward
 * on its own schedule and now lives on the project's Health page, one click away via the toolbar
 * pill.
 *
 * Two classes of row live here, and they are NOT the same errand (anton-mivh.2): a request — an open
 * human gate, work paused because a founder asked to be asked — and a failure, work that stopped by
 * accident. Requests lead, then failures, each group contiguous: interleaving them by raise time
 * buries the row that takes thirty seconds under rows that take an investigation, and a founder
 * scanning for "what can I clear right now" would have to read every row to find it. Cheap and
 * certain before expensive and uncertain. See {@link isRequest} for why the two look different.
 *
 * Renders nothing when nothing has stopped. This is NOT the "checked, clean" state the old merged
 * strip used to draw — that claim belonged to hygiene and review data this component no longer
 * receives, and repeating it here would just race the Health pill that already makes it correctly.
 * An escalation-only strip has exactly one thing to say: here is what needs you, or nothing does.
 *
 * Renamed from AttentionStrip: the old name described a strip that absorbed three producers into one
 * band. With two of those three gone, "attention" no longer says what this component is for — an
 * escalation is the one row on the board that both means something is stuck AND hands the founder a
 * button to unstick it. "Escalation" is what every sibling in this module (EscalationView,
 * EscalationActions, escalationAge) already calls it.
 */
export function EscalationStrip({
  slug,
  escalations,
}: {
  slug: string;
  escalations: EscalationView[];
}) {
  const bodyId = useId();
  if (escalations.length === 0) return null;

  const requests = escalations.filter(isRequest);
  const failures = escalations.filter((escalation) => !isRequest(escalation));
  // Nothing broke — so nothing here is drawn as broken, down to the band itself and the icon on it.
  const broken = failures.length > 0;

  return (
    <section
      aria-labelledby={`${bodyId}-heading`}
      className={cn(
        "mb-3 overflow-hidden rounded-xl border",
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
        <h2 id={`${bodyId}-heading`} className="text-xs font-medium text-foreground">
          Needs you
        </h2>
        {/* Counted apart, because one number covering both would answer neither question a founder
            asks of this band: how much is broken, and how much is merely mine to answer. */}
        {requests.length > 0 ? (
          <MetaChip tone="pr">{requests.length} to answer</MetaChip>
        ) : null}
        {failures.length > 0 ? (
          <MetaChip tone="risk-high">{failures.length} stopped</MetaChip>
        ) : null}
      </div>

      <ul className="divide-y divide-border/50">
        {[...requests, ...failures].map((escalation) => {
          const request = isRequest(escalation);
          return (
            <li
              key={escalation.id}
              className={cn(
                "flex flex-wrap items-start gap-x-2.5 gap-y-1.5 px-3 py-2",
                // Only worth tinting against a red band; on an all-requests strip the section
                // already carries this wash and a second one would just read as a highlight.
                request && broken && "bg-stage-in-review/[0.05]",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 w-0.5 shrink-0 self-stretch rounded-full",
                  request ? "bg-stage-in-review" : "bg-risk-high",
                )}
                aria-hidden="true"
              />
              <EscalationRow slug={slug} escalation={escalation} />
            </li>
          );
        })}
      </ul>
    </section>
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

/** One escalation, with the affordance the founder answers it with: Resume, Dismiss, or Abandon. */
function EscalationRow({ slug, escalation }: { slug: string; escalation: EscalationView }) {
  const request = isRequest(escalation);
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <MetaChip tone={request ? "pr" : "risk-high"}>
            {ESCALATION_LABELS[escalation.kind] ?? escalation.kind}
          </MetaChip>
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
        canAbandon={escalation.beadId !== undefined || escalation.jobId !== undefined}
        target={actionTarget(escalation)}
      />
    </>
  );
}
