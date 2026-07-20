"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { TicketNote } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/atoms";

/**
 * The human steering channel on a ticket (anton-bfy4): the bead's append-only note history plus a
 * box to add to it. A note is not a gate — it changes no status and triggers no run; it is simply
 * read by the executor when it picks the ticket up, which the hint below states plainly so the
 * operator knows what leaving one actually does.
 *
 * anton's own machine notes share the same blob and are shown too (muted), because a run's blocked
 * reason is exactly the context a person needs before writing their steer.
 */
export function TicketNotes({
  slug,
  ticketId,
  notes,
  onAppended,
}: {
  slug: string;
  ticketId: string;
  notes: TicketNote[];
  onAppended: (notes: TicketNote[]) => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const canSubmit = text.trim().length > 0 && !saving;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${slug}/tickets/${ticketId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Failed to add note" }));
        throw new Error(error ?? "Failed to add note");
      }
      const data = (await res.json()) as { notes: TicketNote[] };
      onAppended(data.notes);
      setText("");
      toast.success("Note added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add note");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Notes">
      <span className="flex items-baseline gap-2">
        <span className="text-[11px] text-subtle">Notes</span>
        <span className="text-[10px] text-subtle/70">
          Steering the executor reads when it picks this ticket up
        </span>
      </span>

      {notes.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {notes.map((note, i) => (
            <li
              key={`${note.at ?? "system"}-${i}`}
              className={`rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${
                note.source === "human"
                  ? "border-border bg-card text-foreground"
                  : "border-border/60 bg-secondary/40 text-muted-foreground"
              }`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2 text-[10px] text-subtle">
                <span className="font-mono">{note.author}</span>
                {note.at && <RelativeTime iso={note.at} />}
              </span>
              <p className="mt-1 whitespace-pre-wrap">{note.text}</p>
            </li>
          ))}
        </ul>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        // ⌘/Ctrl+Enter submits — the note box sits inside a form-shaped dialog where plain Enter
        // must stay a newline.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        rows={2}
        placeholder="Leave a note for the executor…"
        aria-label="New note"
        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
      />
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={submit} disabled={!canSubmit}>
          {saving ? "Adding…" : "Add note"}
        </Button>
      </div>
    </section>
  );
}
