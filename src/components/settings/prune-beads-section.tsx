"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { Project } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";

/** Mirrors the route's accepted ages; "all" maps to `bd prune --pattern '*'` server-side. */
type PruneAge = "30d" | "90d" | "all";

const AGE_OPTIONS: { value: PruneAge; label: string }[] = [
  { value: "30d", label: "Older than 30 days" },
  { value: "90d", label: "Older than 90 days" },
  { value: "all", label: "All closed" },
];

/**
 * Manual "Prune closed beads" command (anton-uobe): pick an age window, preview how many closed
 * beads it matches, then confirm to permanently delete them. Safe by construction — the delete
 * affordance only exists behind a non-zero preview, and bd itself only ever touches closed,
 * non-ephemeral, non-pinned beads. Rendered inside the Settings danger zone.
 */
export function PruneBeadsSection({ project }: { project: Project }) {
  const router = useRouter();
  const [age, setAge] = useState<PruneAge>("30d");
  // null = no preview yet (or invalidated by an age change) — the delete affordance is hidden.
  const [preview, setPreview] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  async function runPrune(force: boolean): Promise<number> {
    const res = await fetch(`/api/projects/${project.slug}/prune`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ age, ...(force ? { force: true } : {}) }),
    });
    const data = (await res.json().catch(() => null)) as { count?: number; error?: string } | null;
    if (!res.ok) throw new Error(data?.error ?? `Prune failed (${res.status})`);
    return data?.count ?? 0;
  }

  async function handlePreview() {
    setPreviewing(true);
    try {
      setPreview(await runPrune(false));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    try {
      const count = await runPrune(true);
      toast.success(`Pruned ${count} closed bead${count === 1 ? "" : "s"}`);
      setPreview(null);
      // Board/backlog counts are server-rendered off the beads snapshot — refresh so they reflect
      // the prune without a manual reload.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Prune failed");
    }
  }

  if (!project.hasBeads) {
    return (
      <p className="text-xs text-subtle">beads is not connected for this project.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <div className="relative flex items-center rounded-lg border border-border bg-card text-[12.5px] focus-within:border-primary/60">
          <select
            value={age}
            onChange={(e) => {
              setAge(e.target.value as PruneAge);
              // A preview counts one scope only — a stale count must never gate a wider delete.
              setPreview(null);
            }}
            aria-label="Prune age"
            className="appearance-none rounded-lg bg-transparent px-3 py-2 pr-8 text-foreground outline-none"
          >
            {AGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-3 text-subtle">▾</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handlePreview}
          disabled={previewing}
        >
          {previewing ? "Previewing…" : "Preview"}
        </Button>
      </div>

      {preview !== null &&
        (preview === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing to prune — no closed beads match.</p>
        ) : (
          <div className="flex items-center gap-2.5">
            <span className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{preview}</span> closed bead
              {preview === 1 ? "" : "s"} would be permanently deleted.
            </span>
            <ConfirmDeleteButton
              onConfirm={handleConfirm}
              label={`Prune ${preview} bead${preview === 1 ? "" : "s"}`}
              confirmLabel={`Confirm — delete ${preview}`}
              pendingLabel="Pruning…"
            />
          </div>
        ))}
    </div>
  );
}
