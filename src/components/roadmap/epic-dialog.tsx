"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { RoadmapRow } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { PRIORITY_LABELS, PRIORITY_OPTIONS } from "@/components/ticket/ticket-dialog-utils";

/** The editable slice of an epic. Mirrors the fields parseEpicPatch accepts. */
export interface EpicDraft {
  title: string;
  priority: number;
  area: string;
}

export function draftFromRow(row: RoadmapRow): EpicDraft {
  return { title: row.title, priority: row.priority, area: row.area ?? "" };
}

/**
 * The PATCH body: only the fields that actually changed, so an untouched field is never sent and
 * therefore never rewritten. Returns null when nothing changed — the caller skips the request
 * rather than round-tripping a no-op through bd.
 *
 * Clearing `area` is deliberately NOT expressible: `buildUpdateArgs` treats an empty managed-label
 * value as "untouched" so a partial patch can't wipe a prefix, which means an epic's area can be
 * changed here but not removed. Sending `area: ""` would silently no-op, so it is filtered out.
 */
export function diffEpicPatch(
  draft: EpicDraft,
  original: EpicDraft,
): Partial<EpicDraft> | null {
  const patch: Partial<EpicDraft> = {};
  const title = draft.title.trim();
  const area = draft.area.trim();
  if (title && title !== original.title) patch.title = title;
  if (draft.priority !== original.priority) patch.priority = draft.priority;
  if (area && area !== (original.area ?? "")) patch.area = area;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Edit an epic from the roadmap: its title, its place in the queue, and its product surface. Those
 * three are what the roadmap displays, which is why they are what it edits — the epic's outcome and
 * success criteria are shaped, not typed into a table row.
 *
 * Controlled by the caller (`open`/`onClose`) and keyed on the row id there, so switching epics
 * remounts with a fresh draft instead of carrying the previous epic's edits across.
 */
export function EpicDialog({
  slug,
  row,
  open,
  onClose,
  onSaved,
}: {
  slug: string;
  row: RoadmapRow | null;
  open: boolean;
  onClose: () => void;
  /** Fired after a successful save so the caller can refresh the table. */
  onSaved?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        {row && <EpicDialogBody key={row.id} slug={slug} row={row} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function EpicDialogBody({
  slug,
  row,
  onClose,
  onSaved,
}: {
  slug: string;
  row: RoadmapRow;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const original = draftFromRow(row);
  const [draft, setDraft] = useState<EpicDraft>(original);
  const [saving, setSaving] = useState(false);

  const patch = diffEpicPatch(draft, original);
  const titleEmpty = draft.title.trim() === "";

  async function save() {
    if (!patch || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "Save failed" }))) as {
          error?: string;
        };
        throw new Error(error ?? "Save failed");
      }
      toast.success("Epic updated");
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-sm">Edit epic</DialogTitle>
        <DialogDescription className="font-mono text-[11px] text-subtle">{row.id}</DialogDescription>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="epic-title" className="text-[11px] text-subtle">
          Title
        </Label>
        <Input
          id="epic-title"
          value={draft.title}
          onChange={(event) => setDraft((d) => ({ ...d, title: event.target.value }))}
          placeholder="The outcome several features add up to"
          className="text-[13px]"
        />
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="epic-priority" className="text-[11px] text-subtle">
            Priority
          </Label>
          <select
            id="epic-priority"
            value={String(draft.priority)}
            onChange={(event) =>
              setDraft((d) => ({ ...d, priority: Number(event.target.value) }))
            }
            className="h-9 rounded-lg border border-border bg-card px-2.5 font-mono text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p} value={String(p)}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="epic-area" className="text-[11px] text-subtle">
            Area
          </Label>
          <Input
            id="epic-area"
            value={draft.area}
            onChange={(event) => setDraft((d) => ({ ...d, area: event.target.value }))}
            placeholder="board"
            className="font-mono text-[12px]"
          />
        </div>
      </div>
      {/* The one thing a user cannot undo here, said before they try it rather than after. */}
      <p className="text-[11px] leading-relaxed text-subtle">
        The area routes this epic to its Linear project. An area can be changed but not cleared from
        this dialog.
      </p>

      <DialogFooter>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!patch || titleEmpty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
