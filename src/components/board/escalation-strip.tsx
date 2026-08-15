"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import { MetaChip } from "@/components/atoms";
import { EscalationActions } from "@/components/board/escalation-actions";
import { escalationAge } from "@/components/board/escalation-age";
import type { EscalationView, RunHealthFindingKind } from "@/lib/types";

/** What each stall class is, said the way a founder would say it. */
const ESCALATION_LABELS: Record<RunHealthFindingKind, string> = {
  "parked-run": "Parked run",
  "stale-pr": "Stale PR",
  "dead-lease": "Dead lease",
  "exhausted-job": "Retries spent",
  "needs-human": "Waiting on you",
};

/**
 * Work that has HALTED, worst-first, with the founder's only three answers to it: Resume, Dismiss,
 * Abandon (anton-ue90.1 / the health-page split). This used to be one band that also carried hygiene
 * findings, the worst review score, and the patrol's own housekeeping — they shared it because they
 * all answered "does the operator need to look at something", and that was the wrong test. The test
 * that actually earns a spot above the board is narrower: does this row need a DECISION about a card
 * in the columns below, right now? An escalation is the only signal that does — everything else
 * (hygiene, review trend, housekeeping, what the patrol applied on its own) moves an answer forward
 * on its own schedule and now lives on the project's Health page, one click away via the toolbar
 * pill.
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

  return (
    <section
      aria-labelledby={`${bodyId}-heading`}
      className="mb-3 overflow-hidden rounded-xl border border-destructive/25 bg-destructive/[0.04]"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        <TriangleAlertIcon className="size-3.5 text-destructive" aria-hidden="true" />
        <h2 id={`${bodyId}-heading`} className="text-xs font-medium text-foreground">
          Needs you
        </h2>
        <MetaChip tone="risk-high">
          {escalations.length} stopped
        </MetaChip>
      </div>

      <ul className="divide-y divide-border/50">
        {escalations.map((escalation) => (
          <li
            key={escalation.id}
            className="flex flex-wrap items-start gap-x-2.5 gap-y-1.5 px-3 py-2"
          >
            <span
              className="mt-0.5 w-0.5 shrink-0 self-stretch rounded-full bg-risk-high"
              aria-hidden="true"
            />
            <EscalationRow slug={slug} escalation={escalation} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Nothing to watch: the answer flips once, when React finishes hydrating, and never again. */
function subscribeToHydration(): () => void {
  return () => {};
}

/**
 * How long a stall has been stuck — the sweep's frozen age until the browser has hydrated, the live
 * age afterwards.
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
function StuckFor({ escalation }: { escalation: EscalationView }) {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const [mountedAt] = useState(() => Date.now());
  return <>stuck {escalationAge(escalation, hydrated ? mountedAt : undefined)}</>;
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
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <MetaChip tone="risk-high">
            {ESCALATION_LABELS[escalation.kind] ?? escalation.kind}
          </MetaChip>
          <MetaChip>
            <StuckFor escalation={escalation} />
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
        {/* The park reason is the whole point of the row — full text, never truncated: a founder
            deciding resume-vs-abandon is deciding on exactly this sentence. */}
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
