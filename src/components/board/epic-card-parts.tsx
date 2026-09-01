import Link from "next/link";
import { CircleCheckIcon, CircleSlashIcon } from "lucide-react";

import type { Epic, EpicCrumb } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import {
  AbandonedChip,
  BlockedChip,
  MetaChip,
  PartiallyBlockedChip,
  PrChip,
  RiskChip,
  WorkingPulse,
  prLabel,
} from "@/components/atoms";
import { ReviewScoreChip } from "@/components/review-score";
import {
  STAGE_INSET_SHADOW,
  agentDotClass,
  childReadinessCounts,
  ticketProgress,
  typeWord,
} from "@/components/board/board-utils";
import { TypeBadge, TypeIcon } from "@/components/board/type-language";
import { ContractChip } from "@/components/board/contract-mark";
import { ProvenanceBadges } from "@/components/board/provenance-badge";
import { NotNowChip } from "@/components/board/not-now-chip";
import { EpicBadge, NoEpicBadge } from "@/components/board/epic-badge";

/**
 * The read-only pieces of a run-target card: the shell it sits in and the rows inside it. The card
 * itself (epic-card.tsx) picks which rows a stage gets, the backlog controls live in
 * epic-card-actions.tsx, and approval state lives in use-approve-run.ts.
 *
 * Everything here renders under the shell's full-bleed open link, so nothing takes pointer events
 * except the few controls that opt back in individually (epic badge, copy, PR link).
 */

/**
 * The card's product-epic line: the epic as a clickable badge, or the hollow legacy state when the
 * run target has none. Context, not structure — the board still groups by stage
 * (docs/design/2026-07-26-tier-and-linear-ux.md).
 */
export function EpicSlot({ slug, crumb }: { slug: string; crumb?: EpicCrumb }) {
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

/** The card's id line: what kind of work this is, and its copyable bead id. */
function CardIdentity({ epic }: { epic: Epic }) {
  return (
    <>
      <TypeIcon type={epic.type} />
      <CopyButton
        value={epic.id}
        label={`${typeWord(epic.type)} id`}
        className="font-mono text-[10px]"
      >
        {epic.id}
      </CopyButton>
    </>
  );
}

/**
 * Every condition the runtime holds this target under, stated once above the card's own content. A
 * fully blocked target reads as a dead stop; a partially-gated one as N/M ready, because its ready
 * tickets still run now.
 */
function CardReadiness({ epic }: { epic: Epic }) {
  const counts = childReadinessCounts(epic);
  return (
    <>
      {epic.childReadiness === "blocked" && <BlockedChip blockedBy={epic.blockedBy} />}
      {epic.childReadiness === "partially-blocked" && (
        <PartiallyBlockedChip ready={counts.ready} total={counts.total} held={epic.blockedChildren} />
      )}
    </>
  );
}

/** The full-bleed link that makes the whole card one valid target for "open this run". */
function CardOpenLink({ slug, epic }: { slug: string; epic: Epic }) {
  return (
    <Link
      href={`/projects/${slug}/epics/${epic.id}`}
      className="absolute inset-0 z-0 rounded-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="sr-only">
        Open {typeWord(epic.type)} {epic.title}
      </span>
    </Link>
  );
}

export function CardShell({
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
  return (
    <div
      className={cn(
        "group/card relative flex flex-col gap-2.5 rounded-[12px] border border-border bg-card p-[13px] text-card-foreground transition-colors",
        !overlay && "hover:border-ring/40",
        overlay && "rotate-1 shadow-lg ring-1 ring-ring/30",
        muted && "bg-card/70",
        epic.childReadiness === "blocked" && "opacity-60",
        inset,
      )}
    >
      {!overlay && <CardOpenLink slug={slug} epic={epic} />}
      <div className="pointer-events-none relative z-[1] flex flex-col gap-2.5">
        <CardReadiness epic={epic} />
        {children}
      </div>
    </div>
  );
}

/**
 * How a closed run target reports itself. An abandoned epic is closed like a shipped one — the done
 * column would otherwise read it as delivered — so it gets a slash, not a tick, and "won't be done",
 * not "complete".
 */
export function DoneCardBody({ slug, epic }: { slug: string; epic: Epic }) {
  const { done, total } = ticketProgress(epic);
  return (
    <>
      <EpicSlot slug={slug} crumb={epic.epic} />
      <div className="flex items-center gap-2">
        <CardIdentity epic={epic} />
        {epic.prRef && !epic.abandoned && (
          <PrChip href={epic.prUrl} tone="done" icon={false} className="ml-auto">
            merged {prLabel(epic.prRef)}
          </PrChip>
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
      <div className="flex items-center gap-1.5">
        {epic.abandoned ? (
          <CircleSlashIcon className="size-3 text-subtle" aria-hidden="true" />
        ) : (
          <CircleCheckIcon className="size-3 text-stage-done" aria-hidden="true" />
        )}
        <span className="font-mono text-[10px] text-subtle">{doneOutcome(epic, done, total)}</span>
        {/* A shipped card is where the score matters most: it is the last word on what this run
            actually delivered. */}
        <ReviewScoreChip score={epic.reviewScore} className="ml-auto" />
      </div>
    </>
  );
}

/** The one line a closed target gets: what happened to it, and how much of it was carried. */
function doneOutcome(epic: Epic, done: number, total: number): string {
  if (epic.abandoned) return total > 0 ? `abandoned · ${done} / ${total} tickets` : "abandoned";
  return total > 0 ? `${done} / ${total} tickets` : "complete";
}

/** Title line of a live card: what this is, and where its run currently is. */
export function ActiveCardHeader({ epic }: { epic: Epic }) {
  return (
    <div className="flex items-center gap-1.5">
      <CardIdentity epic={epic} />
      <span className="ml-auto flex items-center gap-1.5">
        {epic.stage === "in-review" && epic.prRef && (
          <PrChip href={epic.prUrl}>{prLabel(epic.prRef)}</PrChip>
        )}
        {epic.stage === "implementing" && !epic.prRef && <WorkingPulse />}
      </span>
    </div>
  );
}

/** How much of the run's work is closed, as a count and a bar. */
export function CardProgress({ epic }: { epic: Epic }) {
  const { done, total, pct } = ticketProgress(epic);
  return (
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
  );
}

/** Badge row: what this run is, who runs it, and how it has been judged so far. */
export function CardMetaRow({ slug, epic }: { slug: string; epic: Epic }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <TypeBadge type={epic.type} />
      {/* Who put this card here, and why — the same grammar on every card that renders, not only in
          Up Next (anton-cqxd). A done card carries none: the board attaches provenance only while
          the answer still bears on whether the target should run. */}
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
  );
}
