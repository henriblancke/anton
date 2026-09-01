"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePickDecision } from "@/components/board/pick-decision";
import { criterionLabel, policyHref } from "@/lib/policy/href";
import { formatCountdown } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * The two ways to disagree with a pick (anton-jqvy / R3.9), side by side on the target anton chose.
 *
 * They are the same write and differ in what they teach. `✕ not now` sets THIS target aside for a
 * bounded window — pacing, not judgement, and nothing about the rule that offered it changes. `Never`
 * records the same decline and then hands the operator the criterion that admitted the bead, in the
 * policy editor, because the alternative to changing the rule is re-litigating the same pick every
 * week.
 *
 * `Never` does not edit anything. It navigates. An action that quietly narrowed a standing policy off
 * one card would be anton writing the operator's rules for them, which is the one thing the whole
 * approval design refuses.
 *
 * Where `Never` lands — the policy panel, at the criterion the server named — is `policyHref`'s
 * (`lib/policy/href.ts`), shared with the `◈ policy` badge that opens the same rule to read it.
 *
 * A leaf, and deliberately the smallest one: the surrounding card is server-rendered, and only these
 * two controls need to be interactive.
 */
export function VetoActions({
  slug,
  beadId,
  title,
  notNowUntil,
  className,
  onVetoed,
}: {
  slug: string;
  beadId: string;
  /** The target's title, for the confirmation — the operator set a thing aside, not an id. */
  title: string;
  /** When the target's current hold expires (epoch ms), when one is already running. */
  notNowUntil?: number;
  className?: string;
  /** Fired with the new expiry so the surface can hold the card back before the next poll. */
  onVetoed?: (untilMs: number) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"not-now" | "never" | undefined>(undefined);
  // A veto and a `[Release]` are two answers to one pick, and the card renders both. The lock is
  // what makes them exclusive; a click that cannot take it is not a queued veto, it is no veto.
  const decision = usePickDecision();

  async function veto(action: "not-now" | "never") {
    if (!decision.claim()) return;
    setPending(action);
    try {
      const res = await fetch(`/api/projects/${slug}/picker/veto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beadId, action }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; deferredUntil?: number; criterion?: string | null }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);

      const until = body?.deferredUntil;
      if (typeof until === "number") onVetoed?.(until);

      if (action === "not-now") {
        decision.settle();
        toast.success("Set aside", {
          description: `anton offers "${title}" again in ${formatCountdown(new Date(until ?? Date.now()).toISOString())}.`,
        });
        // The hold is server state the card reads, so a refresh is what draws it as deferred.
        router.refresh();
        setPending(undefined);
        return;
      }

      // The criterion is the SERVER's answer — it needs the board and the stored policy — and a
      // project whose policy narrows nothing has none, which opens the panel rather than a control.
      const criterion = body?.criterion ?? undefined;
      decision.settle();
      toast.success("Declined — tighten the rule", {
        description: criterion
          ? `Opening the policy at ${criterionLabel(criterion)}.`
          : "No criterion admits this yet — the policy admits every claimable target.",
      });
      router.push(policyHref(slug, criterion));
      setPending(undefined);
    } catch (err) {
      // Nothing was recorded, so the pick goes back on offer — including to `[Release]`.
      decision.abandon();
      toast.error(err instanceof Error ? err.message : "Failed to record that");
      setPending(undefined);
    }
  }

  // Presence IS the hold: the server serves only deferrals still in force (`activeDeferrals`), so
  // the expiry is never re-judged here against a clock this component would have to read at render.
  if (notNowUntil !== undefined) {
    return (
      <span className={cn("font-mono text-[10px] text-subtle", className)}>
        set aside · back in {formatCountdown(new Date(notNowUntil).toISOString())}
      </span>
    );
  }

  return (
    <span className={cn("flex items-center gap-1", className)}>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={pending !== undefined || decision.state !== "open"}
        title="Set this one target aside — anton offers it again after a day, and nothing else changes"
        onClick={() => void veto("not-now")}
      >
        <XIcon aria-hidden="true" />
        {pending === "not-now" ? "…" : "not now"}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={pending !== undefined || decision.state !== "open"}
        title="Set it aside and open the policy at the rule that admitted it, so work like this stops being offered"
        onClick={() => void veto("never")}
      >
        {pending === "never" ? "…" : "Never"}
      </Button>
    </span>
  );
}
