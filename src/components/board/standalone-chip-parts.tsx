import type { StandaloneItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import {
  AbandonedChip,
  BlockedChip,
  MetaChip,
  PrChip,
  RiskChip,
  SnoozedChip,
  WorkingPulse,
  prLabel,
} from "@/components/atoms";
import { ReviewScoreChip } from "@/components/review-score";
import { NotNowChip } from "@/components/board/not-now-chip";
import { TYPE_TEXT, agentDotClass } from "@/components/board/board-utils";
import { TypeBadge, TypeIcon } from "@/components/board/type-language";
import { ContractChip } from "@/components/board/contract-mark";
import { ProvenanceBadges } from "@/components/board/provenance-badge";

/**
 * The read-only rows of a standalone chip. Both sit above the chip's full-bleed open trigger, so
 * each takes `hasOverlay` and stops eating pointer events for it — the few controls that must stay
 * clickable (PR link, copy) opt back in individually.
 */

/** Title line: type icon, unread marker, title, and the run's PR or its live "working" pulse. */
export function ChipHeader({ item, hasOverlay }: { item: StandaloneItem; hasOverlay: boolean }) {
  return (
    <div className={cn("relative z-[1] flex items-start gap-1.5", hasOverlay && "pointer-events-none")}>
      <TypeIcon type={item.type} className="mt-px" />
      {item.unread && (
        <span
          className={cn("mt-1 size-1.5 shrink-0 rounded-full", TYPE_TEXT[item.type], "bg-current")}
          title="Unread — a self-filed bug awaiting triage"
          aria-label="Unread"
        />
      )}
      <h4 className="min-w-0 flex-1 truncate text-[12.5px] leading-snug font-medium" title={item.title}>
        {item.title}
      </h4>
      {item.prRef && (
        // An abandoned item is closed (stage `done`) but nothing merged — never green-tint its PR.
        <PrChip
          href={item.prUrl}
          tone={item.stage === "done" && !item.abandoned ? "done" : "pr"}
          className={item.prUrl ? "pointer-events-auto" : undefined}
        >
          {prLabel(item.prRef)}
        </PrChip>
      )}
      {item.stage === "implementing" && !item.prRef && <WorkingPulse className="shrink-0" />}
    </div>
  );
}

/** Badge row: what this item is, who runs it, and every condition holding it back. */
export function ChipMeta({
  slug,
  item,
  deferred,
  hasOverlay,
}: {
  /** Project slug — the provenance badges link out to this project's evidence. */
  slug: string;
  item: StandaloneItem;
  /** Snooze as the chip currently shows it — the optimistic value, not always `item.deferred`. */
  deferred: boolean;
  hasOverlay: boolean;
}) {
  return (
    <div
      className={cn(
        "relative z-[1] flex flex-wrap items-center gap-1.5",
        hasOverlay && "pointer-events-none",
      )}
    >
      <TypeBadge type={item.type} />
      <CopyButton value={item.id} label="ticket id" className="pointer-events-auto font-mono text-[10px]">
        {item.id}
      </CopyButton>
      {/* Same grammar as the epic card's: an epic-of-one is still a card anton picked (anton-cqxd). */}
      <ProvenanceBadges slug={slug} beadId={item.id} provenance={item.provenance} />
      {item.agent && <MetaChip dotClass={agentDotClass(item.agent)}>{item.agent}</MetaChip>}
      {item.risk && <RiskChip risk={item.risk} />}
      {/* Renders only once a review has actually scored this target (anton-tprv). */}
      <ReviewScoreChip score={item.reviewScore} />
      {item.stage === "backlog" && <BlockedChip blockedBy={item.blockedBy} />}
      {/* A closed item's spec gaps are moot — nothing will run off them. */}
      {item.stage !== "done" && <ContractChip contract={item.contract} />}
      {item.abandoned && <AbandonedChip />}
      {deferred && <SnoozedChip />}
      {/* Vetoed, not vanished (anton-jqvy) — and its own chip, because a bounded hold anton lifts
          itself is not the same thing as the snooze a human has to undo. */}
      {item.notNowUntil !== undefined && <NotNowChip untilMs={item.notNowUntil} />}
    </div>
  );
}
