import Link from "next/link";

import type { EpicCrumb } from "@/lib/types";
import { cn } from "@/lib/utils";
import { boardEpicFilterHref, TYPE_BADGE } from "@/components/board/board-utils";
import { TypeIcon } from "@/components/board/type-language";

/**
 * A run target's product epic, as a clickable badge that narrows the board to that epic. One iris
 * hue for the whole tier rather than one per `area:` — iris is the only palette hue no `agent:`
 * token uses, so the badge never reads as an agent chip
 * (.product/decisions/2026-07-26-engine-designator-prefix.md).
 */
export function EpicBadge({
  slug,
  epic,
  className,
}: {
  slug: string;
  epic: EpicCrumb;
  className?: string;
}) {
  return (
    <Link
      href={boardEpicFilterHref(slug, epic.id)}
      title={`Show the board filtered to "${epic.title}"`}
      className={cn(
        "inline-flex min-w-0 max-w-[16rem] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none font-medium transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        TYPE_BADGE.epic,
        className,
      )}
    >
      <TypeIcon type="epic" className="size-2.5" />
      <span className="truncate">{epic.title}</span>
    </Link>
  );
}
