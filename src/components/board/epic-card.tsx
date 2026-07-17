"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CircleCheckIcon, GitPullRequestIcon } from "lucide-react";

import type { Epic } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { cn } from "@/lib/utils";
import { STAGE_INSET_SHADOW, agentDotClass, ticketProgress } from "@/components/board/board-utils";
import { TypeBadge, TypeIcon } from "@/components/board/type-language";
import { BlockedChip, MetaChip, PrLink, RiskChip } from "@/components/atoms";
import { ClaimControl } from "@/components/board/claim-control";
import { CopyButton } from "@/components/ui/copy-button";

/** Short PR label from a bead external-ref: `gh-218` / a URL ending in `/218` → `#218`. */
function prLabel(ref: string): string {
  const m = /(\d+)\s*$/.exec(ref);
  return m ? `#${m[1]}` : ref;
}

export function EpicCard({
  slug,
  epic,
  overlay = false,
  onDeleted,
}: {
  slug: string;
  epic: Epic;
  overlay?: boolean;
  /** Fired after this epic is deleted so the board can drop it from its columns. */
  onDeleted?: (epicId: string) => void;
}) {
  const [approved, setApproved] = useState(epic.approved);
  const [approving, setApproving] = useState(false);

  async function handleDelete() {
    const res = await fetch(`/api/projects/${slug}/epics/${epic.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? `Delete failed (${res.status})`);
      return;
    }
    toast.success(`Deleted "${epic.title}"`);
    onDeleted?.(epic.id);
  }

  async function handleApprove() {
    setApproving(true);
    setApproved(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${epic.id}/approve`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Approve failed (${res.status})`);
      }
      toast.success(`Approved "${epic.title}"`);
    } catch (err) {
      setApproved(false);
      toast.error(err instanceof Error ? err.message : "Failed to approve epic");
    } finally {
      setApproving(false);
    }
  }

  // Gate approval on readiness, not just stage: approving enqueues execute-epic immediately, so a
  // blocked epic (open blockers) must not be startable before its blocker completes (mirrors the
  // approve route, which rejects a not-ready epic).
  const showApprove = epic.stage === "backlog" && !approved && epic.ready;
  const { done, total, pct } = ticketProgress(epic);
  const isDone = epic.stage === "done";

  if (isDone) {
    return (
      <CardShell epic={epic} overlay={overlay} slug={slug} muted>
        <div className="flex items-center gap-2">
          <TypeIcon type="epic" />
          <CopyButton value={epic.id} label="epic id" className="font-mono text-[10px]">
          {epic.id}
        </CopyButton>
          {epic.prRef && (
            <PrLink href={epic.prUrl} className="ml-auto">
              <MetaChip tone="done">merged {prLabel(epic.prRef)}</MetaChip>
            </PrLink>
          )}
        </div>
        <h4 className="text-[13px] leading-snug font-semibold" title={epic.title}>
          {epic.title}
        </h4>
        <div className="flex items-center gap-1.5">
          <CircleCheckIcon className="size-3 text-stage-done" aria-hidden="true" />
          <span className="font-mono text-[10px] text-subtle">
            {total > 0 ? `${done} / ${total} tickets` : "complete"}
          </span>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell epic={epic} overlay={overlay} slug={slug}>
      <div className="flex items-center gap-1.5">
        <TypeIcon type="epic" />
        <CopyButton value={epic.id} label="epic id" className="font-mono text-[10px]">
          {epic.id}
        </CopyButton>
        <span className="ml-auto flex items-center gap-1.5">
          {epic.stage === "in-review" && epic.prRef && (
            <PrLink href={epic.prUrl}>
              <MetaChip tone="pr">
                <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
                {prLabel(epic.prRef)}
              </MetaChip>
            </PrLink>
          )}
          {epic.stage === "implementing" && !epic.prRef && (
            <span className="inline-flex items-center gap-1 text-[10px] text-stage-implementing">
              <span className="size-1.5 rounded-full bg-stage-implementing anton-pulse" aria-hidden="true" />
              working
            </span>
          )}
        </span>
      </div>

      <h4 className="text-[13px] leading-snug font-semibold" title={epic.title}>
        {epic.title}
      </h4>
      {epic.goal && (
        <p className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground" title={epic.goal}>
          {epic.goal}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-subtle">
            {done} / {total}
          </span>
          {total > 0 && <span className="font-mono text-[10px] text-stage-done">{pct}%</span>}
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-secondary">
          <span
            className="block h-full rounded-full bg-stage-done transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <TypeBadge type="epic" />
        {epic.agent && <MetaChip dotClass={agentDotClass(epic.agent)}>{epic.agent}</MetaChip>}
        {epic.risk && <RiskChip risk={epic.risk} />}
        {epic.size && <MetaChip>size:{epic.size}</MetaChip>}
      </div>

      {epic.stage === "backlog" && !overlay && (
        <div className="mt-0.5 flex flex-col gap-2">
          <ClaimControl slug={slug} itemId={epic.id} owner={epic.assignee} readOnly={approved} />
          <div className="flex items-center gap-2">
          {showApprove && (
            <Button
              size="xs"
              onClick={handleApprove}
              disabled={approving}
              className="pointer-events-auto flex-1"
            >
              {approving ? "Approving…" : "Approve"}
            </Button>
          )}
          <ConfirmDeleteButton
            onConfirm={handleDelete}
            iconOnly
            size="xs"
            stopPropagation
            confirmLabel="Delete"
            title="Delete epic"
            className={cn("pointer-events-auto shrink-0", !showApprove && "ml-auto")}
          />
          </div>
        </div>
      )}
    </CardShell>
  );
}

function CardShell({
  epic,
  overlay,
  slug,
  muted = false,
  children,
}: {
  epic: Epic;
  overlay: boolean;
  slug: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  // Stage-hued left rail as the active-stage cue: orange for implementing, blue for in-review.
  // Backlog/done epics stay railless (the purple type rail was intentionally dropped).
  const inset =
    epic.stage === "implementing" || epic.stage === "in-review"
      ? STAGE_INSET_SHADOW[epic.stage]
      : undefined;

  // A blocked epic (open blockers) is dimmed in every column so it reads as "the runtime won't
  // pick this up yet", mirroring the "blocked by" chip. Done cards are never blocked in practice.
  const blocked = !epic.ready;

  return (
    <div
      className={cn(
        "group/card relative flex flex-col gap-2.5 rounded-[12px] border border-border bg-card p-[13px] text-card-foreground transition-colors",
        !overlay && "hover:border-ring/40",
        overlay && "rotate-1 shadow-lg ring-1 ring-ring/30",
        muted && "bg-card/70",
        blocked && "opacity-60",
        inset,
      )}
    >
      {!overlay && (
        <Link
          href={`/projects/${slug}/epics/${epic.id}`}
          className="absolute inset-0 z-0 rounded-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="sr-only">Open epic {epic.title}</span>
        </Link>
      )}
      <div className="pointer-events-none relative z-[1] flex flex-col gap-2.5">
        {blocked && <BlockedChip blockedBy={epic.blockedBy} />}
        {children}
      </div>
    </div>
  );
}
