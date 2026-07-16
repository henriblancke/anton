import { BugIcon, LayersIcon, SquareCheckIcon } from "lucide-react";

import type { IssueType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TYPE_BADGE, TYPE_LABELS, TYPE_TEXT } from "@/components/board/board-utils";

/** The one icon per work type — an epic stacks tickets (Layers), a task is a checkable unit
 * (SquareCheck), a bug is a bug (Bug). Shared by epic cards and standalone chips. */
const TYPE_ICON: Record<IssueType, typeof BugIcon> = {
  epic: LayersIcon,
  task: SquareCheckIcon,
  bug: BugIcon,
};

/** The type-hued icon, used as the leading glyph on cards and chips. */
export function TypeIcon({ type, className }: { type: IssueType; className?: string }) {
  const Icon = TYPE_ICON[type];
  return <Icon className={cn("size-3.5 shrink-0", TYPE_TEXT[type], className)} aria-hidden="true" />;
}

/** The compact type badge — a tinted pill with the type icon + label, so the type reads even when
 * the card/chip is scanned quickly. */
export function TypeBadge({ type, className }: { type: IssueType; className?: string }) {
  const Icon = TYPE_ICON[type];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-none whitespace-nowrap",
        TYPE_BADGE[type],
        className,
      )}
    >
      <Icon className="size-2.5" aria-hidden="true" />
      {TYPE_LABELS[type]}
    </span>
  );
}
