"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Put a whole group of identical alerts down in one gesture (anton-7gxs).
 *
 * The reason this exists at all is the failure mode the feature was built for: one upstream outage
 * raises one alert per stalled job, thirty of them saying the same sentence about the same 503. A
 * list you can only clear a row at a time is a list nobody clears, and an uncleared list is one an
 * operator learns to scroll past — including on the night it says something new.
 *
 * Two-step, unlike the single-row Dismiss beside it. Dismissing is durable now (the stall stays down
 * until it changes), and doing that to thirty rows at once on one click is a lot of silence to buy
 * by accident. The count is in the confirm label so the second click is made against the number.
 *
 * Failures are reported per row by the server and summarised here rather than thrown: a group can
 * contain one row someone else settled a second ago, and failing all thirty over it would make the
 * button useless exactly when it matters.
 */
export function DismissAllButton({
  slug,
  ids,
  label,
}: {
  slug: string;
  ids: string[];
  /** The group's own name ("Retries spent"), so the toast says what was put down. */
  label: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [armed, setArmed] = useState(false);

  async function dismissAll() {
    setPending(true);
    try {
      const res = await fetch(`/api/projects/${slug}/escalations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", ids }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; dismissed?: number; skipped?: { id: string }[] }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      const skipped = body?.skipped?.length ?? 0;
      toast.success(`${body?.dismissed ?? 0} ${label.toLowerCase()} alerts dismissed`, {
        description: skipped
          ? `${skipped} left alone — already settled, or not something that can be dismissed.`
          : "They stay down until the stall changes. Restore them from Dismissed below.",
      });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to dismiss the alerts");
      router.refresh();
    } finally {
      setPending(false);
      setArmed(false);
    }
  }

  if (!armed) {
    return (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={pending}
        title="Dismiss every alert in this group — they stay down until the stall itself changes"
        onClick={() => setArmed(true)}
      >
        <CheckCheckIcon aria-hidden="true" />
        Dismiss all
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={pending}
        onClick={() => void dismissAll()}
      >
        <CheckCheckIcon aria-hidden="true" />
        {pending ? "Dismissing…" : `Dismiss all ${ids.length}`}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={pending}
        onClick={() => setArmed(false)}
      >
        Cancel
      </Button>
    </>
  );
}
