"use client";

import { useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { PRIORITY_LABELS, PRIORITY_OPTIONS } from "@/components/ticket/ticket-dialog-utils";

/**
 * Set an epic's priority (P0–P4) from the epic detail header — the epic mirror of the ticket
 * dialog's Priority select. PATCHes `/epics/<id>` with `{ priority }` (validated server-side by
 * parseEpicPatch) and hands the refreshed detail back via onChanged so the caller re-sorts. The
 * board/backlog already order by priority, so the change surfaces there on the next read.
 */
export function EpicPriorityControl({
  slug,
  epicId,
  priority,
  disabled = false,
  onChanged,
}: {
  slug: string;
  epicId: string;
  /** The epic's current priority (0=critical … 4=backlog). */
  priority: number;
  disabled?: boolean;
  /** Fired after a successful save so the caller can refetch/re-sort. */
  onChanged?: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function save(next: number) {
    if (next === priority || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${epicId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: next }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "Save failed" }))) as {
          error?: string;
        };
        throw new Error(error ?? "Save failed");
      }
      toast.success(`Priority set to ${PRIORITY_LABELS[next]}`);
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[11px] text-subtle">Priority</span>
      <div
        className={cn(
          "relative flex items-center rounded-lg border border-border bg-card text-[12px] focus-within:border-primary/60",
          (disabled || saving) && "opacity-60",
        )}
      >
        <select
          value={String(priority)}
          onChange={(e) => save(Number(e.target.value))}
          disabled={disabled || saving}
          aria-label="Priority"
          className="appearance-none rounded-lg bg-transparent py-1.5 pr-7 pl-3 font-mono text-foreground outline-none disabled:cursor-not-allowed"
        >
          {PRIORITY_OPTIONS.map((p) => (
            <option key={p} value={String(p)}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2.5 text-subtle">▾</span>
      </div>
    </label>
  );
}
