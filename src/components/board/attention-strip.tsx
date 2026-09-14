"use client";

import Link from "next/link";
import { EyeOffIcon, HandIcon, PauseIcon, TriangleAlertIcon } from "lucide-react";

import { MetaChip } from "@/components/atoms";
import { ArmWatcherButton } from "@/components/board/arm-watcher-button";
import { ReArmButton } from "@/components/board/re-arm-button";
import { buttonVariants } from "@/components/ui/button";
import {
  BREAKER_HEADLINE,
  BREAKER_REASON_LABEL,
  isDisarm,
  isHold,
  type AutopilotBreaker,
} from "@/lib/autopilot-breaker";
import type { EscalationView, UnwatchedParks } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A request is an open human gate — anton asking for thirty seconds, not anton being broken. */
function isRequest(escalation: EscalationView): boolean {
  return escalation.kind === "needs-human";
}

/** The three registers this board already uses, ranked: a failure outranks an ask outranks a hold. */
type Register = "failure" | "request" | "quiet";

const REGISTER_STYLE: Record<Register, string> = {
  failure: "border-destructive/25 bg-destructive/[0.04]",
  request: "border-stage-in-review/25 bg-stage-in-review/[0.04]",
  quiet: "border-border bg-muted/30",
};

/**
 * One line above the board saying what has stopped, and nothing more (anton-7gxs).
 *
 * It replaces three unbounded bands — the escalation strip, the autopilot breaker header, and the
 * unwatched-parks band — that between them could push the columns entirely off the screen. That is
 * not a hypothetical: one upstream 503 storm raised thirty identical `exhausted-job` escalations,
 * each rendering its full park message and its own pair of buttons, and the board underneath them
 * was unreachable without scrolling past all of it. A board that a bad night hides is not a board.
 *
 * So the trade this strip makes is deliberate: it gives up saying WHAT each alert is, and keeps
 * only how much and how bad. Its height does not move with the count — thirty stopped runs and one
 * read the same — and the detail, with every row's Resume/Dismiss/Abandon, lives one click away on
 * the Health page (`#needs-you`), which can be as long as the trouble is.
 *
 * Two actions stay here, and only two. Re-arm and Arm-watcher are each the WHOLE decision their
 * signal asks for — there is nothing to read first, and no row to pick — so sending the operator to
 * another page to click one button would be friction with no reading behind it. Every per-row verb
 * goes to the page, because choosing between resume and abandon means reading the park message,
 * which is exactly what this strip no longer shows.
 *
 * Renders NOTHING when nothing is wrong, the same honesty contract the three bands each kept: a
 * standing strip on a healthy board is an ornament, and an operator learns to skip an ornament in
 * precisely the week it finally has something to say.
 */
export function AttentionStrip({
  slug,
  escalations = [],
  breaker,
  parks,
  onArmed,
}: {
  slug: string;
  /** Open escalations — counted here, listed on the Health page. */
  escalations?: EscalationView[];
  /** Why the autopilot has stopped, if it has. Absent while it is running. */
  breaker?: AutopilotBreaker;
  /** Parked work nothing is watching. Absent when the watcher is armed or nothing is parked. */
  parks?: UnwatchedParks;
  /** Re-read the parks signal after the strip's own arm button writes. */
  onArmed: () => void;
}) {
  const requests = escalations.filter(isRequest).length;
  const failures = escalations.length - requests;
  if (escalations.length === 0 && !breaker && !parks) return null;

  // A hold is the only signal that is not a problem, so it is the only one that can leave the strip
  // quiet — and only when it is alone. Anything broken outranks an ask, which outranks both.
  const stopped = breaker !== undefined && !isHold(breaker);
  const register: Register =
    failures > 0 || stopped || parks ? "failure" : requests > 0 ? "request" : "quiet";

  return (
    <section
      aria-labelledby="attention-strip-heading"
      className={cn(
        "mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-xl border px-3 py-2",
        REGISTER_STYLE[register],
      )}
    >
      <RegisterIcon register={register} />
      <h2 id="attention-strip-heading" className="text-xs font-medium text-foreground">
        {register === "quiet" ? "On hold" : "Needs you"}
      </h2>

      {/* Counted apart, because one number covering both answers neither question a founder asks of
          this line: how much is broken, and how much is merely theirs to answer. */}
      {requests > 0 ? <MetaChip tone="pr">{requests} to answer</MetaChip> : null}
      {failures > 0 ? <MetaChip tone="risk-high">{failures} stopped</MetaChip> : null}
      {breaker ? (
        <MetaChip tone={isHold(breaker) ? "neutral" : "risk-high"}>
          {BREAKER_REASON_LABEL[breaker.reason]}
        </MetaChip>
      ) : null}
      {parks ? (
        <MetaChip tone="risk-med">
          <EyeOffIcon className="size-3" aria-hidden="true" />
          {parks.parkedCount} parked, unwatched
        </MetaChip>
      ) : null}

      {/* The breaker's headline, not its detail: "what would clear this" is a sentence, and a
          sentence is exactly what a fixed-height line cannot promise to fit. It is the first thing
          on the Health page's band. */}
      {breaker ? (
        <span className="min-w-0 truncate text-[11px] text-subtle">
          {BREAKER_HEADLINE[breaker.kind]}
        </span>
      ) : null}

      <span className="flex-1" />

      <div className="flex shrink-0 items-center gap-1.5">
        {breaker && isDisarm(breaker) ? <ReArmButton slug={slug} /> : null}
        {parks ? (
          <ArmWatcherButton slug={slug} disarmed={parks.disarmed} onArmed={onArmed} />
        ) : null}
        <Link
          href={`/projects/${slug}/health#needs-you`}
          className={buttonVariants({ size: "xs", variant: "outline" })}
        >
          Open
        </Link>
      </div>
    </section>
  );
}

/** The icon says what the colour says, for everyone the colour doesn't reach. */
function RegisterIcon({ register }: { register: Register }) {
  if (register === "failure") {
    return <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />;
  }
  if (register === "request") {
    return <HandIcon className="size-3.5 shrink-0 text-stage-in-review" aria-hidden="true" />;
  }
  return <PauseIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
}
