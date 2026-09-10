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
  total,
}: {
  slug: string;
  dismissed: EscalationView[];
  /** How many are dismissed in all. Defaults to the page's own length for callers with one page. */
  total?: number;
}) {
  const router = useRouter();
  const [older, setOlder] = useState<EscalationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<DismissedCursor | null | undefined>(undefined);
  // Deduped, because the two halves CAN overlap: restoring a row re-renders the server page, whose
  // first page then pulls one row up out of the range `older` already holds. Undeduped that is a
  // repeated React key and the same decision offered twice.
  const rows = dedupeById([...dismissed, ...older]);
  const all = total ?? dismissed.length;

  if (dismissed.length === 0) return null;

  /**
   * Forget a paged-in row once it has been restored. `router.refresh()` re-renders the server's
   * FIRST page, and nothing else — a row this component paged in lives in client state the refresh
   * never touches, so without this a restored row keeps rendering with a `Restore` that can only
   * 409. The server page needs no such help: the refresh drops the row from it.
   */
  function dropOlder(id: string) {
    setOlder((prev) => prev.filter((row) => row.id !== id));
  }

  async function showOlder() {
    setLoading(true);
    try {
      // A cursor survives concurrent insertions and restores; an offset can skip a suppression as
      // soon as one row shifts across its boundary.
      const before = cursor === undefined ? cursorFor(dismissed) : cursor;
      if (!before) return;
      const res = await fetch(
        `/api/projects/${slug}/escalations/dismissed?before=${before.dismissedAt}&beforeId=${encodeURIComponent(before.id)}`,
        {
        cache: "no-store",
        },
      );
      const body = (await res.json().catch(() => null)) as {
        dismissed?: EscalationView[];
        total?: number;
        nextCursor?: DismissedCursor | null;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setOlder((prev) => [...prev, ...(body?.dismissed ?? [])]);
      setCursor(body?.nextCursor ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load older dismissals");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      aria-labelledby="dismissed-heading"
      className="rounded-xl border border-border bg-card/60 text-xs"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        <h2 id="dismissed-heading" className="text-xs font-medium text-foreground">
          Dismissed
        </h2>
        <MetaChip>{all}</MetaChip>
      </div>
      <div className="px-3 py-2">
        <Disclosure
          summary="Put down by hand. Each stays down until its stall changes — restore one to bring it back now."
        >
          <ul className="divide-y divide-border/50">
            {rows.map((escalation) => (
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
                <RestoreButton
                  slug={slug}
                  escalationId={escalation.id}
                  onRestored={dropOlder}
                />
              </li>
            ))}
          </ul>
          {/* Every row still here is an active suppression, so "the rest" is not an archive — it is
              the only place those decisions can be undone. The button stays until the list is whole. */}
          {rows.length < all && (cursor === undefined ? cursorFor(dismissed) : cursor) ? (
            <div className="flex items-center gap-2 pt-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={loading}
                onClick={() => void showOlder()}
              >
                {loading ? "Loading…" : "Show older"}
              </Button>
              <span className="text-[11px] text-subtle">
                {rows.length} of {all} — the rest are still suppressed
              </span>
            </div>
          ) : null}
        </Disclosure>
      </div>
    </section>
  );
}

type DismissedCursor = { dismissedAt: number; id: string };

function cursorFor(rows: EscalationView[]): DismissedCursor | null {
  const last = rows.at(-1);
  return last?.dismissedAt == null ? null : { dismissedAt: last.dismissedAt, id: last.id };
}

/** First occurrence wins — the server-rendered page is fresher than anything paged in earlier. */
function dedupeById(rows: EscalationView[]): EscalationView[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

function isoSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** Bring one dismissed alert back to the list above. One click — restoring changes no work. */
function RestoreButton({
  slug,
  escalationId,
  onRestored,
}: {
  slug: string;
  escalationId: string;
  onRestored: (id: string) => void;
}) {
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
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        reason?: string;
      } | null;
      if (!res.ok) {
        // Only an explicit prior restoration means this row no longer belongs in the list. A live
        // escalation for the same finding leaves this dismissal intact, so it stays reachable.
        if (body?.reason === "not-dismissed") {
          onRestored(escalationId);
          toast.success("Already restored — it's back under Needs you");
          router.refresh();
          return;
        }
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      onRestored(escalationId);
      toast.success("Restored — it's back under Needs you");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restore the alert");
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
