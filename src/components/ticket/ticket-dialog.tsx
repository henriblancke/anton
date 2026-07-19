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
import { MetaChip, PrLink, RelativeTime, StagePill } from "@/components/atoms";
import { ClaimControl, InheritedOwner, StaticOwner } from "@/components/board/claim-control";
import { PrLinkControl } from "@/components/board/pr-link-control";
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
  // Optimistic run/approve state, mirroring the standalone chip: flip the affordance to Force run
  // immediately on our own click and revert on failure. The board's own poll refreshes the truth.
  const [running, setRunning] = useState(false);
  const [optimisticApproved, setOptimisticApproved] = useState(false);

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

  // A standalone task/bug is its own run target, so approval is its run trigger — the same T2 route
  // an epic uses (validates the id is a real run target). Re-approving an already-approved target
  // re-triggers the run (Force run), resuming from where it stopped. A child ticket has no run of
  // its own (it runs via its epic's PR), so the affordance is hidden for it; the route 422s it too.
  async function run(wasApproved: boolean) {
    if (!detail) return;
    setRunning(true);
    setOptimisticApproved(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${ticketId}/approve`, { method: "POST" });
      if (!res.ok) {
        const { error: message } = await res.json().catch(() => ({ error: "Run failed" }));
        throw new Error(message ?? "Run failed");
      }
      toast.success(wasApproved ? `Re-running "${detail.title}"` : `Approved & running "${detail.title}"`);
    } catch (err) {
      setOptimisticApproved(false);
      toast.error(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setRunning(false);
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

  if (!detail || !draft) return <TicketDialogSkeleton />;

  const changed = hasTicketChanges(draftFromDetail(detail), draft);
  const set = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) =>
    setDraft({ ...draft, [key]: value });

  // Only a parentless task/bug is a run target of its own (mirrors `beads.isRunTarget`, which the
  // approve/claim routes gate on): a child ticket runs via its epic's PR, and a parentless
  // `learning`/`chore`/etc. is never runnable, so its controls would only ever 422.
  const isRunTarget = !detail.epicId && (detail.type === "task" || detail.type === "bug");
  const approved = detail.approved || optimisticApproved;
  // The run affordance is narrower than the claim control: a `done` (closed) standalone target has
  // already finished its run and produced its PR, so re-approving it would only enqueue duplicate/
  // no-op PR work. Hide the button there while keeping it for a still-runnable target — a fresh
  // backlog approval or a Force run that resumes an in-flight (implementing/in-review) run.
  const canRun = isRunTarget && detail.stage !== "done";

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
          {isRunTarget ? (
            // A standalone task/bug carries its own PR — let it be linked/relinked here (same
            // /epics/<id>/pr route the epic detail uses). Linking flips it to in-review.
            <PrLinkControl
              slug={slug}
              itemId={detail.id}
              prRef={detail.prRef}
              prUrl={detail.prUrl}
              onLinked={() => setAttempt((n) => n + 1)}
            />
          ) : (
            detail.prRef && (
              <PrLink href={detail.prUrl}>
                <MetaChip tone="pr">
                  <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
                  {detail.prUrl ? "PR" : detail.prRef}
                </MetaChip>
              </PrLink>
            )
          )}
        </div>
        {/* claimed-by + created — mirrors the epic detail + tickets list surfaces */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-subtle">
          <span className="inline-flex items-center gap-1.5">
            Claimed by{" "}
            {isRunTarget ? (
              // A parentless task/bug is a run target — claimable on its own (same isRunTarget gate
              // the claim route enforces).
              <ClaimControl
                slug={slug}
                itemId={detail.id}
                owner={detail.assignee}
                variant="row"
                readOnly={approved}
                canTakeOver={detail.stage === "backlog"}
                onChanged={() => setAttempt((n) => n + 1)}
              />
            ) : detail.epicId ? (
              // A child ticket inherits its epic's human claim and has no control of its own.
              <InheritedOwner owner={detail.epicAssignee ?? null} />
            ) : (
              // A parentless non-run-target (learning/chore/etc.) can't be claimed — the claim route
              // 422s it — so its owner shows read-only, matching the hidden Approve & run control.
              <StaticOwner owner={detail.assignee} />
            )}
          </span>
          <span>
            Created <RelativeTime iso={detail.createdAt} className="text-foreground/85" />
            {detail.createdBy && <> by {detail.createdBy}</>}
          </span>
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
          {canRun && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => run(approved)}
              disabled={running}
              title={
                approved
                  ? "Re-trigger the run (resumes from where it stopped)"
                  : "Approve and start the run"
              }
            >
              {running ? "Starting…" : approved ? "Force run" : "Approve & run"}
            </Button>
          )}
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
