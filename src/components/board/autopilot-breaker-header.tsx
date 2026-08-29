import { PauseIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import { MetaChip } from "@/components/atoms";
import { ReArmButton } from "@/components/board/re-arm-button";
import {
  BREAKER_EFFECT,
  BREAKER_HEADLINE,
  BREAKER_KIND_LABEL,
  BREAKER_REASON_LABEL,
  HOLD_REASSURANCE,
  clearingCondition,
  investigateHref,
  isHold,
  type AutopilotBreaker,
} from "@/lib/autopilot-breaker";
import { cn } from "@/lib/utils";

/**
 * The Up Next lane's header when the lane has stopped filling (anton-5c8h / R4.1, R4.5): what
 * stopped it, and — always — what would start it again.
 *
 * It sits above the escalation strip, and not yet inside a lane, because the Up Next lane itself is
 * still unbuilt (anton-t9m4) — the band belongs at the head of that lane the moment it exists, and
 * moving it there is a change of parent, not of this component. Above the strip because it outranks
 * it either way: an escalation is one stalled card, a breaker is every card that would have started.
 *
 * It renders NOTHING when the autopilot is running, so the band's presence is itself the signal, and
 * the operator never has to open settings to find out whether anton is working (R4.5's "visible
 * without opening settings").
 *
 * The two states are drawn in different registers on purpose, and this is the whole design risk of
 * the feature. The board already has two: destructive red for "something broke", review-blue for
 * "your turn" (see escalation-strip.tsx). A disarm takes the red, because it IS a failure signal and
 * it needs a human. A hold takes a THIRD, quieter register — plain border, muted wash, a pause icon
 * — because it is neither: nothing broke and nothing is being asked of anyone. Drawing a
 * self-clearing flow limit in red would teach the operator to discount the band, and the state that
 * pays for that lesson is the one that actually matters.
 *
 * A hold carries no buttons at all, for the same reason. Every affordance on a self-clearing state
 * is an invitation to override a limit the operator set for themselves.
 */
export function AutopilotBreakerHeader({
  slug,
  breaker,
}: {
  slug: string;
  /** Undefined when the autopilot is running — the band renders nothing at all. */
  breaker?: AutopilotBreaker;
}) {
  if (!breaker) return null;
  const hold = isHold(breaker);

  return (
    <section
      aria-labelledby="autopilot-breaker-heading"
      className={cn(
        "mb-3 overflow-hidden rounded-xl border",
        hold ? "border-border bg-muted/30" : "border-destructive/25 bg-destructive/[0.04]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        {hold ? (
          <PauseIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        ) : (
          <TriangleAlertIcon className="size-3.5 text-destructive" aria-hidden="true" />
        )}
        <h2 id="autopilot-breaker-heading" className="text-xs font-medium text-foreground">
          {BREAKER_HEADLINE[breaker.kind]}
        </h2>
        {/* The word, beside the colour. Colour alone carries the hold/disarm distinction for nobody
            using a screen reader, and for nobody who has not yet learned this board's palette. */}
        <MetaChip tone={hold ? "neutral" : "risk-high"}>{BREAKER_KIND_LABEL[breaker.kind]}</MetaChip>
        <MetaChip tone={hold ? "neutral" : "risk-high"}>
          {BREAKER_REASON_LABEL[breaker.reason]}
        </MetaChip>
      </div>

      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-xs text-muted-foreground">{breaker.detail}</p>
          {/* The sentence R4.5 exists for. Emphasised over the detail above it: an operator reading
              this band wants to know what to DO, and on a hold the answer is "nothing". */}
          <p className="text-xs font-medium text-foreground">{clearingCondition(breaker)}</p>
          <p className="text-[11px] text-subtle">
            {hold ? `${HOLD_REASSURANCE} ${BREAKER_EFFECT}` : BREAKER_EFFECT}
          </p>
          {!hold && breaker.evidence.length > 0 ? (
            <div className="mt-1 flex flex-col gap-1">
              <h3 className="font-mono text-[10px] tracking-wide text-subtle uppercase">Evidence</h3>
              {/* Every line, never truncated — this list IS the decision the Re-arm button asks for,
                  and an operator clipping it would be re-arming on a summary of a summary. */}
              <ul className="flex flex-col gap-0.5">
                {breaker.evidence.map((line) => (
                  <li key={line} className="font-mono text-[11px] text-muted-foreground">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {!hold ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Link
              href={investigateHref(slug, breaker.reason)}
              className="inline-flex h-7 items-center rounded-lg border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Investigate
            </Link>
            <ReArmButton slug={slug} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
