import { GitPullRequestIcon } from "lucide-react";

import type { StandaloneItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import {
  AbandonedChip,
  BlockedChip,
  MetaChip,
  NotNowChip,
  PrLink,
  RiskChip,
  SnoozedChip,
} from "@/components/atoms";
import { ReviewScoreChip } from "@/components/review-score";
import { TYPE_TEXT, agentDotClass } from "@/components/board/board-utils";
import { TypeBadge, TypeIcon } from "@/components/board/type-language";
import { ContractChip } from "@/components/board/contract-mark";

/**
 * The read-only rows of a standalone chip. Both sit above the chip's full-bleed open trigger, so
 * each takes `hasOverlay` and stops eating pointer events for it — the few controls that must stay
 * clickable (PR link, copy) opt back in individually.
 */

/** Short PR label from a bead external-ref: `gh-218` / a URL ending in `/218` → `#218`. */
export function prLabel(ref: string): string {
  const m = /(\d+)\s*$/.exec(ref);
  return m ? `#${m[1]}` : ref;
}

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
        <PrLink href={item.prUrl} className={item.prUrl ? "pointer-events-auto" : undefined}>
          {/* An abandoned item is closed (stage `done`) but nothing merged — never green-tint its PR. */}
          <MetaChip tone={item.stage === "done" && !item.abandoned ? "done" : "pr"}>
            <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
            {prLabel(item.prRef)}
          </MetaChip>
        </PrLink>
      )}
      {item.stage === "implementing" && !item.prRef && (
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-stage-implementing">
          <span className="size-1.5 rounded-full bg-stage-implementing anton-pulse" aria-hidden="true" />
          working
        </span>
      )}
    </div>
  );
}

/** Badge row: what this item is, who runs it, and every condition holding it back. */
export function ChipMeta({
  item,
  deferred,
  hasOverlay,
}: {
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
