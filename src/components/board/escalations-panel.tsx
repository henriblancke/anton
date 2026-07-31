import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";

import { MetaChip } from "@/components/atoms";
import { EscalationActions } from "@/components/board/escalation-actions";
import type { EscalationView } from "@/lib/escalations";
import type { RunHealthFindingKind } from "@/lib/run-health";

/** What each stall class is, said the way a founder would say it. */
const KIND_LABELS: Record<RunHealthFindingKind, string> = {
  "parked-run": "Parked run",
  "stale-pr": "Stale PR",
  "dead-lease": "Dead lease",
  "exhausted-job": "Retries spent",
};

/** Coarse, human duration: "42m" / "4h" / "3d". Whole units — minutes of precision read as noise. */
export function stuckFor(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * How long this has been stuck, as of NOW where the sweep recorded a start time, falling back to
 * the age the sweep froze into the finding. The live value is the honest one: an escalation raised
 * at 02:00 and still open at 09:00 has been stuck seven hours, not the twenty minutes the sweep saw.
 *
 * A plain function, not a prop default, so the clock read stays out of the component's render —
 * the page is `force-dynamic`, so this still evaluates once per request.
 */
export function escalationAge(escalation: EscalationView, nowMs = Date.now()): string {
  return stuckFor(escalation.since ? nowMs - escalation.since * 1000 : escalation.ageMs);
}

/**
 * The founder-facing escalation panel (anton-wvcy) — what anton stopped on and could not safely
 * restart by itself, above the board where the work is approved.
 *
 * A Server Component: the list, the evidence, and the age are all server state, so only the two
 * decision buttons cross into the client. It renders NOTHING when there are no open escalations —
 * a healthy board must not pay for this panel in vertical space or attention, and an empty
 * "no escalations" card is exactly the chrome that trains an operator to stop looking.
 */
export function EscalationsPanel({
  slug,
  escalations,
}: {
  slug: string;
  escalations: EscalationView[];
}) {
  if (escalations.length === 0) return null;

  return (
    <section
      aria-labelledby="escalations-heading"
      className="mb-3 rounded-xl border border-destructive/25 bg-destructive/[0.04]"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <TriangleAlertIcon className="size-4 text-destructive" aria-hidden="true" />
        <h2 id="escalations-heading" className="text-sm font-medium text-foreground">
          Needs you
        </h2>
        <span className="text-xs text-subtle">
          {escalations.length} stalled {escalations.length === 1 ? "run" : "runs"} anton could not
          safely restart on its own
        </span>
      </div>
      <ul className="divide-y divide-destructive/15">
        {escalations.map((escalation) => (
          <li
            key={escalation.id}
            className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <MetaChip tone="risk-high">{KIND_LABELS[escalation.kind] ?? escalation.kind}</MetaChip>
                <MetaChip>stuck {escalationAge(escalation)}</MetaChip>
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
              {/* The park reason is the whole point of the row — full text, never truncated: a
                  founder deciding resume-vs-abandon is deciding on exactly this sentence. */}
              <p className="mt-1 text-xs text-muted-foreground">{escalation.reason}</p>
              {!escalation.noted && escalation.beadId ? (
                <p className="mt-1 text-[11px] text-subtle">
                  The bd note for this escalation hasn&apos;t landed yet — anton retries it on the
                  next sweep.
                </p>
              ) : null}
            </div>
            <EscalationActions
              slug={slug}
              escalationId={escalation.id}
              canResume={escalation.epicBeadId !== undefined}
              canAbandon={escalation.beadId !== undefined}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
