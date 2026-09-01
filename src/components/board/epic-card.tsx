"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CircleCheckIcon, CircleSlashIcon, GitPullRequestIcon } from "lucide-react";

import type { Epic, EpicCrumb } from "@/lib/types";
// The predicate itself, not a card-local copy: approve and the runner ask the same one.
import { contractBlocks } from "@/lib/beads/contract";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { cn } from "@/lib/utils";
import {
  STAGE_INSET_SHADOW,
  TYPE_LABELS,
  agentDotClass,
  canStartRun,
  childReadinessCounts,
  isPickerPick,
  ticketProgress,
} from "@/components/board/board-utils";
import { TypeBadge, TypeIcon } from "@/components/board/type-language";
import { toastContractAdvisory } from "@/components/board/contract-advisory";
import { ApproveBlocked, ContractChip } from "@/components/board/contract-mark";
import { EpicBadge, NoEpicBadge } from "@/components/board/epic-badge";
import { ProvenanceBadges } from "@/components/board/provenance-badge";
import { ReleaseAction } from "@/components/board/release-action";
import {
  AbandonedChip,
  BlockedChip,
  MetaChip,
  NotNowChip,
  PartiallyBlockedChip,
  PrLink,
  RiskChip,
} from "@/components/atoms";
import { ReviewScoreChip } from "@/components/review-score";
import { ClaimControl } from "@/components/board/claim-control";
import { CopyButton } from "@/components/ui/copy-button";

/** Short PR label from a bead external-ref: `gh-218` / a URL ending in `/218` → `#218`. */
function prLabel(ref: string): string {
  const m = /(\d+)\s*$/.exec(ref);
  return m ? `#${m[1]}` : ref;
}

/** The card's work type in sentence case — "feature", "epic", "task" — for ids, titles and
 * confirmations. A feature is the tier anton runs, so a card must never call itself an epic. */
const typeWord = (epic: Epic): string => TYPE_LABELS[epic.type].toLowerCase();

export function EpicCard({
  slug,
  epic,
  overlay = false,
  budgetAware = false,
  onDeleted,
}: {
  slug: string;
  epic: Epic;
  overlay?: boolean;
  /**
   * Project budget-aware flag (anton-y2ue): on → the backlog approval splits into "Approve"
   * (immediate) and "Queue" (paced for optimal usage); off → a single "Approve" button.
   */
  budgetAware?: boolean;
  /** Fired after this epic is deleted so the board can drop it from its columns. */
  onDeleted?: (epicId: string) => void;
}) {
  // Optimistic override only — the source of truth is `epic.approved`, which a later board poll
  // refreshes. Deriving from the prop (rather than seeding local state once) keeps the controls in
  // sync when another operator approves the same epic between polls; the flag just locks it
  // immediately on our own click and reverts on failure.
  const [optimisticApproved, setOptimisticApproved] = useState(false);
  const [approving, setApproving] = useState(false);
  const approved = epic.approved || optimisticApproved;
  const word = typeWord(epic);

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

  async function handleApprove(immediate = true) {
    // `immediate` is the run-directly choice (anton-y2ue): true → run now (bypass budget pacing),
    // false → queue for optimal usage. Defaults true so the single (non-budget-aware) button runs now.
    setApproving(true);
    setOptimisticApproved(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${epic.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ immediate }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Approve failed (${res.status})`);
      }
      toast.success(
        immediate ? `Approved & running "${epic.title}"` : `Queued "${epic.title}" for optimal usage`,
      );
      // The run starts with whatever thin sections it has; say so once, here.
      await toastContractAdvisory(res);
    } catch (err) {
      setOptimisticApproved(false);
      toast.error(err instanceof Error ? err.message : `Failed to approve ${word}`);
    } finally {
      setApproving(false);
    }
  }

  // Gate approval on readiness, not just stage: approving enqueues execute-epic immediately, so a
  // fully blocked epic (nothing it would dispatch can run) must not be startable before its blocker
  // completes. A partially-gated one still is — mirrors the approve route, which gates on the same
  // verdict.
  const showApprove = epic.stage === "backlog" && !approved && canStartRun(epic);
  // A contract gap is the other reason a run can't start. It differs from a blocker in what it asks
  // of the founder — a blocker needs waiting, this needs a one-line edit — so the affordance stays in
  // place and names the missing section instead of disappearing (or 422ing on click).
  const contractBlocked = contractBlocks(epic.contract);
  // The picker chose this target, so shadow mode offers it as a release rather than a plain approve.
  // A target the operator has set aside keeps its plain Approve: [Release] on a card that reads "set
  // aside · back in 4h" would offer the very start the veto just declined.
  const picked = isPickerPick(epic.provenance) && epic.notNowUntil === undefined;
  const { done, total, pct } = ticketProgress(epic);
  const isDone = epic.stage === "done";

  if (isDone) {
    return (
      <CardShell epic={epic} overlay={overlay} slug={slug} muted>
        <EpicSlot slug={slug} crumb={epic.epic} />
        <div className="flex items-center gap-2">
          <TypeIcon type={epic.type} />
          <CopyButton value={epic.id} label={`${word} id`} className="font-mono text-[10px]">
            {epic.id}
          </CopyButton>
          {epic.prRef && !epic.abandoned && (
            <PrLink href={epic.prUrl} className="ml-auto">
              <MetaChip tone="done">merged {prLabel(epic.prRef)}</MetaChip>
            </PrLink>
          )}
          {epic.abandoned && <AbandonedChip className="ml-auto" />}
        </div>
        <h4
          className={cn(
            "text-[13px] leading-snug font-semibold",
            epic.abandoned && "text-subtle line-through decoration-border",
          )}
          title={epic.title}
        >
          {epic.title}
        </h4>
        {/* An abandoned epic is closed like a shipped one — the done column would otherwise read it
            as delivered. Slash, not tick; "won't be done", not "complete". */}
        <div className="flex items-center gap-1.5">
          {epic.abandoned ? (
            <CircleSlashIcon className="size-3 text-subtle" aria-hidden="true" />
          ) : (
            <CircleCheckIcon className="size-3 text-stage-done" aria-hidden="true" />
          )}
          <span className="font-mono text-[10px] text-subtle">
            {epic.abandoned
              ? total > 0
                ? `abandoned · ${done} / ${total} tickets`
                : "abandoned"
              : total > 0
                ? `${done} / ${total} tickets`
                : "complete"}
          </span>
          {/* A shipped card is where the score matters most: it is the last word on what this run
              actually delivered. */}
          <ReviewScoreChip score={epic.reviewScore} className="ml-auto" />
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell epic={epic} overlay={overlay} slug={slug}>
      <EpicSlot slug={slug} crumb={epic.epic} />
      <div className="flex items-center gap-1.5">
        <TypeIcon type={epic.type} />
        <CopyButton value={epic.id} label={`${word} id`} className="font-mono text-[10px]">
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
        <TypeBadge type={epic.type} />
        {/* Who put this card here, and why — the same grammar on every card that renders, not only
            in Up Next (anton-cqxd). A done card carries none: the board attaches provenance only
            while the answer still bears on whether the target should run. */}
        <ProvenanceBadges slug={slug} beadId={epic.id} provenance={epic.provenance} />
        {epic.agent && <MetaChip dotClass={agentDotClass(epic.agent)}>{epic.agent}</MetaChip>}
        {epic.risk && <RiskChip risk={epic.risk} />}
        {epic.size && <MetaChip>size:{epic.size}</MetaChip>}
        {/* Renders only once a review has actually scored this target (anton-tprv). */}
        <ReviewScoreChip score={epic.reviewScore} />
        <ContractChip contract={epic.contract} />
        {/* A pick the operator set aside is SHOWN set aside — the veto's whole point is that
            disagreeing does not make the card disappear (anton-jqvy). */}
        {epic.notNowUntil !== undefined && <NotNowChip untilMs={epic.notNowUntil} />}
      </div>

      {epic.stage === "backlog" && !overlay && (
        <ClaimControl
          slug={slug}
          itemId={epic.id}
          owner={epic.assignee}
          variant="stack"
          readOnly={approved}
          canTakeOver={epic.stage === "backlog"}
          className="mt-0.5"
        >
          {showApprove &&
            (contractBlocked ? (
              <ApproveBlocked violations={epic.contract?.blocking ?? []} />
            ) : (
              <span className="pointer-events-auto flex items-center gap-1">
                {/* Budget-aware: the operator can still hand this run to the governor's pace-line
                    instead of starting it. Release is always the immediate half, so the two never
                    make the same promise twice. */}
                {budgetAware && (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => handleApprove(false)}
                    disabled={approving}
                    title="Queue this run for the budget governor to pace against the weekly plan"
                  >
                    Queue
                  </Button>
                )}
                {/* A card the picker chose is started with [Release], not Approve (anton-d2h6 /
                    R3.5): same route, same gates, same run — plus the accept that turns the
                    operator's agreement into evidence. One button, never two, so the card never
                    offers two answers to "start this". */}
                {picked ? (
                  <ReleaseAction
                    slug={slug}
                    beadId={epic.id}
                    title={epic.title}
                    disabled={approving}
                    onReleased={() => setOptimisticApproved(true)}
                  />
                ) : (
                  <Button
                    size="xs"
                    onClick={() => handleApprove(true)}
                    disabled={approving}
                    title="Approve and run now, bypassing budget pacing (the session limit still applies)"
                  >
                    {approving ? "Approving…" : "Approve"}
                  </Button>
                )}
              </span>
            ))}
          <ConfirmDeleteButton
            onConfirm={handleDelete}
            iconOnly
            size="xs"
            stopPropagation
            confirmLabel="Delete"
            title={`Delete ${word}`}
            className="pointer-events-auto ml-auto shrink-0"
          />
        </ClaimControl>
      )}
    </CardShell>
  );
}

/**
 * The card's product-epic line: the epic as a clickable badge, or the hollow legacy state when the
 * run target has none. Context, not structure — the board still groups by stage
 * (docs/design/2026-07-26-tier-and-linear-ux.md).
 */
function EpicSlot({ slug, crumb }: { slug: string; crumb?: EpicCrumb }) {
  return (
    <div className="flex min-w-0">
      {crumb ? (
        <EpicBadge slug={slug} epic={crumb} className="pointer-events-auto" />
      ) : (
        <NoEpicBadge />
      )}
    </div>
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

  // A fully blocked epic — nothing this run would dispatch can start — is dimmed in every column so
  // it reads as "the runtime won't pick this up yet", mirroring the "blocked by" chip. Done cards are
  // never blocked in practice. A PARTIALLY-gated one keeps full contrast and gets its own N/M chip
  // instead: its ready tickets run now, so dimming it would read as stalled work that isn't.
  const blocked = epic.childReadiness === "blocked";
  const partial = epic.childReadiness === "partially-blocked";
  const counts = childReadinessCounts(epic);

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
          <span className="sr-only">
            Open {typeWord(epic)} {epic.title}
          </span>
        </Link>
      )}
      <div className="pointer-events-none relative z-[1] flex flex-col gap-2.5">
        {blocked && <BlockedChip blockedBy={epic.blockedBy} />}
        {partial && (
          <PartiallyBlockedChip
            ready={counts.ready}
            total={counts.total}
            held={epic.blockedChildren}
          />
        )}
        {children}
      </div>
    </div>
  );
}
