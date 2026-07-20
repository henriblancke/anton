"use client";

import { useState } from "react";
import { toast } from "sonner";
import { GitPullRequestIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MetaChip, PrLink } from "@/components/atoms";

/**
 * Manually link (or relink) a GitHub PR to a run target — epic or standalone task/bug — from the
 * epic detail view and the ticket dialog. Posts to `/epics/<id>/pr`, which stamps the bead's
 * external-ref and moves a still-open target to stage:in-review so the review-fix sweep picks it up.
 * The accepted input mirrors the server's `normalizePrRef`: a bare number, #44, gh-44, or a PR url.
 *
 * When a PR is already linked (a resolvable `prUrl`) the clickable chip is shown alongside the
 * input, which is pre-filled with the current number so submitting acts as "relink".
 */
export function PrLinkControl({
  slug,
  itemId,
  prRef,
  prUrl,
  onLinked,
}: {
  slug: string;
  itemId: string;
  /** The bead's current external-ref (`gh-<n>` or a url), if any. */
  prRef?: string;
  /** Resolved browser URL for the PR, when the ref maps to one. */
  prUrl?: string;
  /** Fired after a successful link so the caller can refetch the detail. */
  onLinked?: () => void;
}) {
  const [value, setValue] = useState(prRef ? prRef.replace(/^gh-/i, "") : "");
  const [saving, setSaving] = useState(false);

  async function link() {
    const ref = value.trim();
    if (!ref || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${itemId}/pr`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "Link failed" }))) as {
          error?: string;
        };
        throw new Error(error ?? "Link failed");
      }
      toast.success(prRef ? "PR updated" : "PR linked", {
        description: "Moved to in-review — anton will pick up reviews on its next sweep.",
      });
      onLinked?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Link failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {prRef && (
        <PrLink href={prUrl}>
          <MetaChip tone="pr">
            <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
            {prUrl ? "PR" : prRef}
          </MetaChip>
        </PrLink>
      )}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void link();
          }
        }}
        placeholder="PR # or url"
        aria-label="PR number or url"
        inputMode="text"
        className="h-7 w-28 rounded-md border border-border bg-card px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
      />
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-[11px]"
        onClick={link}
        disabled={saving || value.trim() === "" || value.trim() === (prRef ? prRef.replace(/^gh-/i, "") : "")}
      >
        {saving ? "Linking…" : prRef ? "Update" : "Link"}
      </Button>
    </div>
  );
}
