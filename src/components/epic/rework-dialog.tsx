"use client";

import { useId } from "react";

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
import { findingKey } from "@/components/epic/rework-draft";
import { useReworkForm, type ReworkFormOptions } from "@/components/epic/use-rework-form";

export interface ReworkDialogProps {
  slug: string;
  /** The run target whose review report this decision is made from. */
  targetId: string;
  /** The tickets that run covers — what may be sent back. */
  tickets: Ticket[];
  /**
   * The target's self-review report, when the surface opening this dialog already holds it (the
   * epic page loads it for its score series). Absent → the dialog reads it itself.
   */
  report?: ReviewReport;
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
export function ReworkDialog({
  slug,
  targetId,
  tickets,
  report,
  open,
  onClose,
  onReworked,
}: ReworkDialogProps) {
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
            report={report}
            onClose={onClose}
            onReworked={onReworked}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A render of `useReworkForm` — the behaviour lives there, the consequences are spelled out here. */
function ReworkForm(options: ReworkFormOptions) {
  const form = useReworkForm(options);
  const ids = useId();

  if (form.candidates.length === 0) {
    return (
      <p className="py-2 text-[12.5px] text-muted-foreground">
        This run has no live tickets to send back.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ScoreLine report={form.report} />

      <TicketField
        id={`${ids}-ticket`}
        value={form.draft.ticketId}
        candidates={form.candidates}
        onChange={(ticketId) => form.patch({ ticketId })}
      />

      <ModeField
        name={`${ids}-mode`}
        mode={form.draft.mode}
        onSelect={(mode) => form.patch({ mode })}
      />

      <SummaryField
        id={`${ids}-summary`}
        mode={form.draft.mode}
        value={form.draft.summary}
        onChange={(summary) => form.patch({ summary })}
      />

      <InstructionsField
        id={`${ids}-instructions`}
        value={form.draft.instructions}
        onChange={(instructions) => form.patch({ instructions })}
      />

      <FindingsField
        findings={form.findings}
        emptyNote={
          form.reportError ??
          (form.reportLoading
            ? "Loading findings…"
            : "This run's review left no findings on the board.")
        }
        isSelected={form.isSelected}
        onToggle={form.toggleFinding}
      />

      <FormActions
        canSubmit={form.canSubmit}
        submitting={form.submitting}
        onCancel={options.onClose}
        onSubmit={form.submit}
      />
    </div>
  );
}

/** What the self-review settled on — the context that makes sending it back a considered call. */
function ScoreLine({ report }: { report: ReviewReport | null }) {
  if (!report || report.score === undefined) return null;
  return (
    <p className="text-[12px] text-muted-foreground">
      Latest self-review: <span className="font-mono text-foreground">{report.score}/10</span> over{" "}
      {report.rounds.length} round{report.rounds.length === 1 ? "" : "s"}.
    </p>
  );
}

function TicketField({
  id,
  value,
  candidates,
  onChange,
}: {
  id: string;
  value: string;
  candidates: Ticket[];
  onChange: (ticketId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[11px] text-subtle">
        Ticket
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus:border-primary/60"
      >
        {candidates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.id} — {t.title}
          </option>
        ))}
      </select>
    </div>
  );
}

function ModeField({
  name,
  mode,
  onSelect,
}: {
  name: string;
  mode: ReworkMode;
  onSelect: (mode: ReworkMode) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-[11px] text-subtle">What happened</legend>
      <ModeOption
        name={name}
        value="reopen"
        checked={mode === "reopen"}
        onSelect={onSelect}
        title="Acceptance not met"
        detail="The same ticket reopens and runs again, carrying a reason. Its earlier scores stay on the rounds that produced them."
      />
      <ModeOption
        name={name}
        value="follow-up"
        checked={mode === "follow-up"}
        onSelect={onSelect}
        title="Acceptance met — iterate"
        detail="A new ticket is created, linked discovered-from this one, so the work that shipped keeps its score."
      />
    </fieldset>
  );
}

/** One line: a reopen's reason, or the follow-up's title — the mode decides which it becomes. */
function SummaryField({
  id,
  mode,
  value,
  onChange,
}: {
  id: string;
  mode: ReworkMode;
  value: string;
  onChange: (summary: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[11px] text-subtle">
        {mode === "reopen" ? "Reason (one line)" : "Follow-up title"}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={MAX_REWORK_SUMMARY_CHARS}
        placeholder={
          mode === "reopen" ? "Why this isn't actually done" : "What the next pass should deliver"
        }
        className="h-8 rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
      />
    </div>
  );
}

function InstructionsField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (instructions: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[11px] text-subtle">
        Fix instructions
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={MAX_REWORK_INSTRUCTIONS_CHARS}
        rows={4}
        placeholder="What the implementer should do differently…"
        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
      />
      <span className="text-[10px] text-subtle">
        Lands as a note on the bead — the implementer reads it when it picks the ticket up.
      </span>
    </div>
  );
}

function FindingsField({
  findings,
  emptyNote,
  isSelected,
  onToggle,
}: {
  findings: ReviewFinding[];
  emptyNote: string;
  isSelected: (key: string) => boolean;
  onToggle: (key: string) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-[11px] text-subtle">Findings to attach</legend>
      {findings.length === 0 ? (
        <p className="text-[11.5px] text-subtle">{emptyNote}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {findings.map((f) => {
            const key = findingKey(f);
            return (
              <li key={key}>
                <FindingOption
                  finding={f}
                  checked={isSelected(key)}
                  onToggle={() => onToggle(key)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

function FindingOption({
  finding,
  checked,
  onToggle,
}: {
  finding: ReviewFinding;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-2 text-[12px] leading-snug hover:border-border">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={onToggle} />
      <span className="min-w-0">
        <span
          className={cn(
            "mr-1.5 font-mono text-[10px] uppercase",
            finding.severity === "blocking" ? "text-risk-high" : "text-subtle",
          )}
        >
          {finding.severity}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{finding.location}</span>
        <span className="block text-foreground/85">{finding.note}</span>
      </span>
    </label>
  );
}

function FormActions({
  canSubmit,
  submitting,
  onCancel,
  onSubmit,
}: {
  canSubmit: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={onSubmit}
        disabled={!canSubmit}
        title={canSubmit ? undefined : "A reason and fix instructions are required"}
      >
        {submitting ? "Sending back…" : "Send back"}
      </Button>
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
