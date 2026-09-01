"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
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
 * A leaf, and deliberately the smallest one: the surrounding card is server-rendered, and only these
 * two controls need to be interactive.
 */
export function VetoActions({
  slug,
  beadId,
  notNowUntil,
  className,
  onVetoed,
}: {
  slug: string;
  beadId: string;
  /** When the target's current hold expires (epoch ms), when one is already running. */
  notNowUntil?: number;
  className?: string;
  /** Fired with the new expiry so the surface can hold the card back before the next poll. */
  onVetoed?: (untilMs: number) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"not-now" | "never" | undefined>(undefined);

  async function veto(action: "not-now" | "never") {
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
        toast.success("Set aside", {
          description: `anton offers ${beadId} again in ${formatCountdown(new Date(until ?? Date.now()).toISOString())}.`,
        });
        // The hold is server state the card reads, so a refresh is what draws it as deferred.
        router.refresh();
        setPending(undefined);
        return;
      }

      // The criterion is the SERVER's answer — it needs the board and the stored policy — and a
      // project whose policy narrows nothing has none, which opens the panel rather than a control.
      const criterion = body?.criterion ?? undefined;
      toast.success("Declined — tighten the rule", {
        description: criterion
          ? `Opening the policy at ${criterionLabel(criterion)}.`
          : "No criterion admits this yet — the policy admits every claimable target.",
      });
      router.push(policyHref(slug, criterion));
    } catch (err) {
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
        disabled={pending !== undefined}
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
        disabled={pending !== undefined}
        title="Set it aside and open the policy at the rule that admitted it, so work like this stops being offered"
        onClick={() => void veto("never")}
      >
        {pending === "never" ? "…" : "Never"}
      </Button>
    </span>
  );
}

/**
 * Where `Never` lands: the settings page's policy panel, with the criterion to tighten named in the
 * query so the editor can highlight the control rather than the operator hunting for it.
 *
 * The panel itself is selected by the HASH, which is how every settings section is addressed
 * (`useActiveSection`); the criterion rides beside it as a search param because a hash holds one id.
 */
export function policyHref(slug: string, criterion?: string): string {
  const base = `/projects/${slug}/settings`;
  return criterion ? `${base}?criterion=${encodeURIComponent(criterion)}#policy` : `${base}#policy`;
}

/** A criterion key as the editor labels it — `severity:`, not `labels:severity`. */
export function criterionLabel(criterion: string): string {
  return criterion.startsWith("labels:") ? `${criterion.slice("labels:".length)}:` : criterion;
}
