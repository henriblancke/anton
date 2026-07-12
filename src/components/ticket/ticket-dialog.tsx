"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckIcon, GitPullRequestIcon, PencilIcon, TriangleAlertIcon } from "lucide-react";

import type { TicketDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { MetaChip, RiskChip, StagePill } from "@/components/atoms";
import { agentDotClass, isExternalUrl } from "@/components/board/board-utils";
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
}

/**
 * Controlled popup to view a ticket's contract and edit its scalar/label fields. Body is keyed
 * on `ticketId` so switching tickets fully remounts it (fresh fetch + view mode). Contract-markdown
 * (Goal/Acceptance/description) editing is out of scope here — a later ticket layers it on.
 */
export function TicketDialog({ slug, ticketId, open, onClose, onSaved }: TicketDialogProps) {
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
          <TicketDialogBody key={ticketId} slug={slug} ticketId={ticketId} onSaved={onSaved} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TicketDialogBody({
  slug,
  ticketId,
  onSaved,
}: {
  slug: string;
  ticketId: string;
  onSaved?: (detail: TicketDetail) => void;
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<"view" | "edit">("view");
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

  function startEdit() {
    if (!detail) return;
    setDraft(draftFromDetail(detail));
    setMode("edit");
  }

  function cancelEdit() {
    setMode("view");
    setDraft(null);
  }

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
      setMode("view");
      setDraft(null);
      toast.success("Ticket updated");
      onSaved?.(data.detail);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
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

  if (!detail) return <TicketDialogSkeleton />;

  if (mode === "edit" && draft) {
    const changed = hasTicketChanges(draftFromDetail(detail), draft);
    return (
      <EditForm
        detail={detail}
        draft={draft}
        onDraft={setDraft}
        onCancel={cancelEdit}
        onSave={save}
        saving={saving}
        changed={changed}
      />
    );
  }

  return <ViewMode detail={detail} onEdit={startEdit} />;
}

// ── View mode ──────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">{children}</span>
  );
}

type AcceptanceItem = { text: string; checked: boolean };

/** Split an acceptance blob into checklist items, honoring `- [x]` / `- [ ]` markers. */
function parseAcceptance(acceptance: string): AcceptanceItem[] {
  return acceptance
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(?:[-*]\s*)?\[( |x|X)\]\s*(.*)$/.exec(line);
      if (m) return { text: m[2].trim(), checked: m[1].toLowerCase() === "x" };
      return { text: line.replace(/^[-*]\s*/, ""), checked: false };
    });
}

function ViewMode({ detail, onEdit }: { detail: TicketDetail; onEdit: () => void }) {
  const acceptance = detail.acceptance ? parseAcceptance(detail.acceptance) : [];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5 pr-8">
          <span className="font-mono text-[11px] text-subtle">
            {detail.id} · {detail.type}
          </span>
          <StagePill stage={detail.stage} />
          <Button variant="outline" size="sm" className="ml-auto" onClick={onEdit}>
            <PencilIcon aria-hidden="true" />
            Edit
          </Button>
        </div>

        <h2
          className="font-display text-[18px] leading-tight font-bold tracking-[-0.01em]"
          title={detail.title}
        >
          {detail.title}
        </h2>

        {(detail.agent || detail.risk || detail.size || detail.prRef) && (
          <div className="flex flex-wrap gap-1.5">
            {detail.agent && <MetaChip dotClass={agentDotClass(detail.agent)}>{detail.agent}</MetaChip>}
            {detail.risk && <RiskChip risk={detail.risk} />}
            {detail.size && <MetaChip>size:{detail.size}</MetaChip>}
            {detail.prRef &&
              (isExternalUrl(detail.prRef) ? (
                <a
                  href={detail.prRef}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="focus-visible:outline-none"
                >
                  <MetaChip tone="pr">
                    <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
                    PR
                  </MetaChip>
                </a>
              ) : (
                <MetaChip tone="pr">
                  <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
                  {detail.prRef}
                </MetaChip>
              ))}
          </div>
        )}
      </div>

      {detail.goal && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Goal</SectionLabel>
          <p className="text-[13px] leading-relaxed text-foreground/85">{detail.goal}</p>
        </div>
      )}

      {acceptance.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <SectionLabel>Acceptance</SectionLabel>
          {acceptance.map((item, i) => (
            <div key={i} className="flex items-start gap-2.5">
              {item.checked ? (
                <span className="mt-px flex size-[15px] shrink-0 items-center justify-center rounded bg-stage-done">
                  <CheckIcon className="size-2 text-[#0b0a09]" strokeWidth={3} aria-hidden="true" />
                </span>
              ) : (
                <span className="mt-px size-[15px] shrink-0 rounded border-[1.5px] border-border" />
              )}
              <span
                className={cn(
                  "text-[12.5px] leading-snug",
                  item.checked ? "text-muted-foreground" : "text-foreground/85",
                )}
              >
                {item.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Edit mode ──────────────────────────────────────────────────────────────

function EditForm({
  detail,
  draft,
  onDraft,
  onCancel,
  onSave,
  saving,
  changed,
}: {
  detail: TicketDetail;
  draft: TicketDraft;
  onDraft: (next: TicketDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  changed: boolean;
}) {
  const set = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) =>
    onDraft({ ...draft, [key]: value });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5 pr-8">
        <span className="font-mono text-[11px] text-subtle">
          {detail.id} · {detail.type}
        </span>
        <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
          editing
        </span>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] text-subtle">Title</span>
        <input
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          aria-label="Title"
          className="rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/60"
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

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving || !changed}>
          {saving ? "Saving…" : "Save"}
        </Button>
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
