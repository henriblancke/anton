"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UndoIcon } from "lucide-react";

import { MetaChip, RelativeTime } from "@/components/atoms";
import { Disclosure } from "@/components/health/disclosure";
import { ESCALATION_LABELS } from "@/components/health/needs-you-section";
import { Button } from "@/components/ui/button";
import type { EscalationView } from "@/lib/types";

/**
 * The alerts a human put down, and the way back (anton-7gxs).
 *
 * Dismissing is durable: a dismissed stall is not raised again while it is unchanged, which is what
 * makes clearing a storm worth doing at all. A durable decision with no undo is a trap, though —
 * the operator who dismisses the wrong group, or changes their mind an hour later, would otherwise
 * be waiting on the stall to mutate before anton mentioned it again. This section is the undo, and
 * its existence is also the disclosure that dismissal is not deletion.
 *
 * Folded by default and rendered only when there IS something dismissed: it is a record of past
 * decisions, not work, and it must never compete with the "Needs you" list above it.
 *
 * A restore can legitimately fail — the sweep may have re-raised the same finding while this list
 * was on screen, in which case the alert is already back where the operator wanted it. Reported as
 * such rather than as an error.
 */
export function DismissedSection({
  slug,
  dismissed,
}: {
  slug: string;
  dismissed: EscalationView[];
}) {
  if (dismissed.length === 0) return null;

  return (
    <section
      aria-labelledby="dismissed-heading"
      className="rounded-xl border border-border bg-card/60 text-xs"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        <h2 id="dismissed-heading" className="text-xs font-medium text-foreground">
          Dismissed
        </h2>
        <MetaChip>{dismissed.length}</MetaChip>
      </div>
      <div className="px-3 py-2">
        <Disclosure
          summary="Put down by hand. Each stays down until its stall changes — restore one to bring it back now."
        >
          <ul className="divide-y divide-border/50">
            {dismissed.map((escalation) => (
              <li
                key={escalation.id}
                className="flex flex-wrap items-start gap-x-2.5 gap-y-1 py-2"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <MetaChip>{ESCALATION_LABELS[escalation.kind] ?? escalation.kind}</MetaChip>
                    {escalation.dismissedAt ? (
                      <span className="text-[11px] text-subtle">
                        dismissed <RelativeTime iso={isoSeconds(escalation.dismissedAt)} />
                      </span>
                    ) : null}
                  </div>
                  {/* Full text, like the live row: an operator deciding whether to bring one back is
                      deciding on exactly this sentence. */}
                  <p className="text-muted-foreground">{escalation.reason}</p>
                </div>
                <RestoreButton slug={slug} escalationId={escalation.id} />
              </li>
            ))}
          </ul>
        </Disclosure>
      </div>
    </section>
  );
}

function isoSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** Bring one dismissed alert back to the list above. One click — restoring changes no work. */
function RestoreButton({ slug, escalationId }: { slug: string; escalationId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function restore() {
    setPending(true);
    try {
      const res = await fetch(`/api/projects/${slug}/escalations/${escalationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore" }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      toast.success("Restored — it's back under Needs you");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restore the alert");
      // Either way the list is stale from here: a refused restore usually means the sweep raised it
      // again, which is the outcome the click wanted.
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={pending}
      onClick={() => void restore()}
    >
      <UndoIcon aria-hidden="true" />
      {pending ? "Restoring…" : "Restore"}
    </Button>
  );
}
