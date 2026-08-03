"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

import {
  MAX_REWORK_INSTRUCTIONS_CHARS,
  MAX_REWORK_SUMMARY_CHARS,
  type ReviewFinding,
  type ReviewReport,
  type ReworkMode,
  type ReworkResult,
  type Ticket,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ReworkDialogProps {
  slug: string;
  /** The run target whose review report this decision is made from. */
  targetId: string;
  /** The tickets that run covers — what may be sent back. */
  tickets: Ticket[];
  open: boolean;
  onClose: () => void;
  /** Fired after a successful submit, so the page can refetch. */
  onReworked?: (result: ReworkResult) => void;
}

/**
 * Send a ticket back with instructions (anton-4ocm) — the founder's one action on a bad review.
 *
 * The two outcomes are presented as an explicit choice rather than inferred, because they say
 * different things about the work: Reopen means the ticket claimed to be done and wasn't (the same
 * bead runs again), Follow-up means it WAS done and the founder wants more (a new bead, linked back
 * to it). Getting that wrong rewrites history — a reopen re-scores work that already shipped — so
 * the dialog states the consequence of each next to the control.
 *
 * The reviewer's own findings are listed to be ticked rather than retyped: they are the most precise
 * fix instructions available, and they are already gone from the worktree by the time anyone reads
 * this.
 */
export function ReworkDialog({ slug, targetId, tickets, open, onClose, onReworked }: ReworkDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg md:max-w-xl">
        <DialogTitle className="font-display text-[15px]">Send a ticket back</DialogTitle>
        <DialogDescription className="text-[12.5px]">
          Attach fix instructions to one ticket of {targetId} and put it back in the pipeline.
        </DialogDescription>
        {open && (
          <ReworkForm
            slug={slug}
            targetId={targetId}
            tickets={tickets}
            onClose={onClose}
            onReworked={onReworked}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReworkForm({
  slug,
  targetId,
  tickets,
  onClose,
  onReworked,
}: {
  slug: string;
  targetId: string;
  tickets: Ticket[];
  onClose: () => void;
  onReworked?: (result: ReworkResult) => void;
}) {
  // Abandoned tickets are out of every run, so sending one back would produce work nothing picks up.
  const candidates = tickets.filter((t) => !t.abandoned);
  const [ticketId, setTicketId] = useState(candidates[0]?.id ?? "");
  const [mode, setMode] = useState<ReworkMode>("reopen");
  const [summary, setSummary] = useState("");
  const [instructions, setInstructions] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ids = useId();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/epics/${targetId}/rework`);
        if (!res.ok) throw new Error(`Couldn't load the review report (${res.status})`);
        const data = (await res.json()) as { report: ReviewReport };
        if (!cancelled) setReport(data.report);
      } catch (err) {
        // A missing report never blocks the action — the founder can still write instructions by
        // hand, which is exactly what this replaces.
        if (!cancelled) setReportError(err instanceof Error ? err.message : "Couldn't load the review report");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, targetId]);

  const findings = report?.findings ?? [];
  const canSubmit = !!ticketId && summary.trim().length > 0 && instructions.trim().length > 0 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${targetId}/rework`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticketId,
          mode,
          summary: summary.trim(),
          instructions: instructions.trim(),
          findings: findings.filter((f) => selected.has(findingKey(f))),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Sending it back failed (${res.status})`);
      }
      const { result } = (await res.json()) as { result: ReworkResult };
      toast.success(
        !result.applied
          ? `Already sent back — ${result.reworkedId} carries these instructions`
          : result.mode === "reopen"
            ? `${result.ticketId} reopened with instructions`
            : `Follow-up ${result.reworkedId} created from ${result.ticketId}`,
        result.warning ? { description: result.warning } : undefined,
      );
      onReworked?.(result);
      onClose();
    } catch (err) {
      // Stay open on failure so the typed instructions survive a retry (a 409 clears on its own).
      toast.error(err instanceof Error ? err.message : "Sending it back failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (candidates.length === 0) {
    return (
      <p className="py-2 text-[12.5px] text-muted-foreground">
        This run has no live tickets to send back.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {report && report.score !== undefined && (
        <p className="text-[12px] text-muted-foreground">
          Latest self-review: <span className="font-mono text-foreground">{report.score}/10</span> over{" "}
          {report.rounds.length} round{report.rounds.length === 1 ? "" : "s"}.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-ticket`} className="text-[11px] text-subtle">
          Ticket
        </label>
        <select
          id={`${ids}-ticket`}
          value={ticketId}
          onChange={(e) => setTicketId(e.target.value)}
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus:border-primary/60"
        >
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} — {t.title}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-[11px] text-subtle">What happened</legend>
        <ModeOption
          name={`${ids}-mode`}
          value="reopen"
          checked={mode === "reopen"}
          onSelect={setMode}
          title="Acceptance not met"
          detail="The same ticket reopens and runs again, carrying a reason. Its earlier scores stay on the rounds that produced them."
        />
        <ModeOption
          name={`${ids}-mode`}
          value="follow-up"
          checked={mode === "follow-up"}
          onSelect={setMode}
          title="Acceptance met — iterate"
          detail="A new ticket is created, linked discovered-from this one, so the work that shipped keeps its score."
        />
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-summary`} className="text-[11px] text-subtle">
          {mode === "reopen" ? "Reason (one line)" : "Follow-up title"}
        </label>
        <input
          id={`${ids}-summary`}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={MAX_REWORK_SUMMARY_CHARS}
          placeholder={
            mode === "reopen" ? "Why this isn't actually done" : "What the next pass should deliver"
          }
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-instructions`} className="text-[11px] text-subtle">
          Fix instructions
        </label>
        <textarea
          id={`${ids}-instructions`}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          maxLength={MAX_REWORK_INSTRUCTIONS_CHARS}
          rows={4}
          placeholder="What the implementer should do differently…"
          className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
        />
        <span className="text-[10px] text-subtle">
          Lands as a note on the bead — the implementer reads it when it picks the ticket up.
        </span>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-[11px] text-subtle">Findings to attach</legend>
        {findings.length === 0 ? (
          <p className="text-[11.5px] text-subtle">
            {reportError ?? "This run's review left no findings on the board."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {findings.map((f) => {
              const key = findingKey(f);
              return (
                <li key={key}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-2 text-[12px] leading-snug hover:border-border">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.has(key)}
                      onChange={() => setSelected((prev) => toggle(prev, key))}
                    />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "mr-1.5 font-mono text-[10px] uppercase",
                          f.severity === "blocking" ? "text-risk-high" : "text-subtle",
                        )}
                      >
                        {f.severity}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">{f.location}</span>
                      <span className="block text-foreground/85">{f.note}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={!canSubmit}
          title={canSubmit ? undefined : "A reason and fix instructions are required"}
        >
          {submitting ? "Sending back…" : "Send back"}
        </Button>
      </div>
    </div>
  );
}

function ModeOption({
  name,
  value,
  checked,
  onSelect,
  title,
  detail,
}: {
  name: string;
  value: ReworkMode;
  checked: boolean;
  onSelect: (mode: ReworkMode) => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2",
        checked ? "border-primary/60 bg-card" : "border-border/60 bg-card hover:border-border",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-foreground">{title}</span>
        <span className="block text-[11.5px] leading-snug text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
}

/** Stable identity for a finding across renders — location + note, which is what makes two distinct. */
function findingKey(f: ReviewFinding): string {
  return `${f.severity} ${f.location} ${f.note}`;
}

function toggle(prev: Set<string>, key: string): Set<string> {
  const next = new Set(prev);
  if (!next.delete(key)) next.add(key);
  return next;
}
