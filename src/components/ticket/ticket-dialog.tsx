"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GitPullRequestIcon, TriangleAlertIcon } from "lucide-react";

import type { TicketDetail } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { MetaChip, PrLink, StagePill } from "@/components/atoms";
import {
  AGENT_OPTIONS,
  PRIORITY_LABELS,
  PRIORITY_OPTIONS,
  RISK_OPTIONS,
  SIZE_OPTIONS,
  STATUS_LABELS,
  STATUS_OPTIONS,
  diffTicketPatch,
  draftFromDetail,
  hasTicketChanges,
  type TicketDraft,
} from "./ticket-dialog-utils";

export interface TicketDialogProps {
  slug: string;
  /** The ticket to inspect; the dialog fetches its detail when opened. */
  ticketId: string | null;
  open: boolean;
  onClose: () => void;
  /** Fired after a successful save, with the refreshed detail — so call sites can refetch lists. */
  onSaved?: (detail: TicketDetail) => void;
  /** Fired after a successful delete — so call sites can drop the ticket from their lists. */
  onDeleted?: (ticketId: string) => void;
}

/**
 * Controlled popup showing a ticket's full contract in ONE always-editable form: every field is
 * live (no view↔edit toggle), Save PATCHes only what changed, and Delete removes the bead behind
 * an inline confirm. Body is keyed on `ticketId` so switching tickets fully remounts it (fresh
 * fetch + fresh draft).
 */
export function TicketDialog({ slug, ticketId, open, onClose, onSaved, onDeleted }: TicketDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogTitle className="sr-only">{ticketId ? `Ticket ${ticketId}` : "Ticket"}</DialogTitle>
        <DialogDescription className="sr-only">
          View and edit this ticket&apos;s fields.
        </DialogDescription>
        {open && ticketId ? (
          <TicketDialogBody
            key={ticketId}
            slug={slug}
            ticketId={ticketId}
            onSaved={onSaved}
            onDeleted={onDeleted}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TicketDialogBody({
  slug,
  ticketId,
  onSaved,
  onDeleted,
  onClose,
}: {
  slug: string;
  ticketId: string;
  onSaved?: (detail: TicketDetail) => void;
  onDeleted?: (ticketId: string) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/tickets/${ticketId}`);
        if (!res.ok) throw new Error(`Failed to load ticket (${res.status})`);
        const data = (await res.json()) as { detail: TicketDetail };
        if (!cancelled) {
          setDetail(data.detail);
          setDraft(draftFromDetail(data.detail));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load ticket");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, ticketId, attempt]);

  async function save() {
    if (!detail || !draft) return;
    const patch = diffTicketPatch(draftFromDetail(detail), draft);
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${slug}/tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const { error: message } = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(message ?? "Save failed");
      }
      const data = (await res.json()) as { detail: TicketDetail };
      setDetail(data.detail);
      setDraft(draftFromDetail(data.detail));
      toast.success("Ticket updated");
      onSaved?.(data.detail);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const res = await fetch(`/api/projects/${slug}/tickets/${ticketId}`, { method: "DELETE" });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: "Delete failed" }));
      toast.error(message ?? "Delete failed");
      return;
    }
    toast.success("Ticket deleted");
    onDeleted?.(ticketId);
    onClose();
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl border border-risk-high/30 bg-risk-high/10">
          <TriangleAlertIcon className="size-5 text-risk-high" aria-hidden="true" />
        </span>
        <p className="text-sm text-risk-high">{error}</p>
        <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  if (!detail || !draft) return <TicketDialogSkeleton />;

  const changed = hasTicketChanges(draftFromDetail(detail), draft);
  const set = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) =>
    setDraft({ ...draft, [key]: value });

  return (
    <div className="flex flex-col gap-4">
      {/* header — read-only identity */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2 pr-8">
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-subtle">
            <CopyButton value={detail.id} label="ticket id">
              {detail.id}
            </CopyButton>
            · {detail.type}
          </span>
          <StagePill stage={detail.stage} />
          {detail.prRef && (
            <PrLink href={detail.prUrl}>
              <MetaChip tone="pr">
                <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
                {detail.prUrl ? "PR" : detail.prRef}
              </MetaChip>
            </PrLink>
          )}
        </div>
      </div>

      {/* editable form */}
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] text-subtle">Title</span>
        <input
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          aria-label="Title"
          className="rounded-lg border border-border bg-card px-3 py-2 text-[14px] font-medium text-foreground outline-none focus:border-primary/60"
        />
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select label="Status" value={draft.status} onChange={(v) => set("status", v)}>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s] ?? s}
            </option>
          ))}
        </Select>

        <Select
          label="Priority"
          value={draft.priority === undefined ? "" : String(draft.priority)}
          onChange={(v) => set("priority", v === "" ? undefined : Number(v))}
        >
          {draft.priority === undefined && <option value="">—</option>}
          {PRIORITY_OPTIONS.map((p) => (
            <option key={p} value={String(p)}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>

        <Select label="Agent" value={draft.agent} onChange={(v) => set("agent", v)}>
          {draft.agent === "" && <option value="">none</option>}
          {AGENT_OPTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>

        <Select label="Risk" value={draft.risk} onChange={(v) => set("risk", v)}>
          {draft.risk === "" && <option value="">none</option>}
          {RISK_OPTIONS.map((r) => (
            <option key={r} value={r}>
              risk:{r}
            </option>
          ))}
        </Select>

        <Select label="Size" value={draft.size} onChange={(v) => set("size", v)}>
          {draft.size === "" && <option value="">none</option>}
          {SIZE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              size:{s}
            </option>
          ))}
        </Select>
      </div>

      <ContractField
        label="Goal"
        value={draft.goal}
        onChange={(v) => set("goal", v)}
        rows={3}
        placeholder="What this ticket accomplishes."
      />

      <ContractField
        label="Acceptance"
        value={draft.acceptance}
        onChange={(v) => set("acceptance", v)}
        rows={5}
        placeholder={"One criterion per line, e.g.\n- [ ] Edit mode gains contract editing"}
      />

      <ContractField
        label="Description"
        hint="Context, Out of scope, Verify — the rest of the contract"
        value={draft.body}
        onChange={(v) => set("body", v)}
        rows={6}
        placeholder="The remaining contract markdown."
      />

      <DialogFooter className="sm:justify-between">
        <ConfirmDeleteButton onConfirm={remove} label="Delete ticket" />
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft(draftFromDetail(detail))}
            disabled={saving || !changed}
          >
            Reset
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !changed}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogFooter>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle">{label}</span>
      <div className="relative flex items-center rounded-lg border border-border bg-card text-[12.5px] focus-within:border-primary/60">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="w-full appearance-none rounded-lg bg-transparent px-3 py-2 pr-8 font-mono text-foreground outline-none"
        >
          {children}
        </select>
        <span className="pointer-events-none absolute right-3 text-subtle">▾</span>
      </div>
    </label>
  );
}

function ContractField({
  label,
  hint,
  value,
  onChange,
  rows,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-2">
        <span className="text-[11px] text-subtle">{label}</span>
        {hint && <span className="text-[10px] text-subtle/70">{hint}</span>}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        aria-label={label}
        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
      />
    </label>
  );
}

function TicketDialogSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading ticket">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <span className="anton-shimmer h-3 w-24 rounded" />
          <span className="anton-shimmer h-6 w-20 rounded-full" />
        </div>
        <span className="anton-shimmer h-5 w-3/4 rounded" />
        <div className="flex gap-1.5">
          <span className="anton-shimmer h-4 w-16 rounded-md" />
          <span className="anton-shimmer h-4 w-16 rounded-md" />
        </div>
      </div>
      <span className="anton-shimmer h-3 w-1/4 rounded" />
      <span className="anton-shimmer h-14 w-full rounded" />
    </div>
  );
}
