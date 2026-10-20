import Link from "next/link";

import type { DigestFeatureCard } from "@/lib/digest/feature-cards";
import { formatUsd } from "@/lib/spend-breakdown";
import { MetaChip, PrChip, RelativeTime, StagePill, prLabel } from "@/components/atoms";
import { ReviewScoreChip } from "@/components/review-score";

/**
 * One changed feature, exactly as the digest's grouped section renders it (anton-y1uxp): the
 * template headline (anton-qitea), its Why quoted, where it stands, and its own last five events.
 *
 * A Server Component — nothing here is interactive, so the client boundary stays at the leaf that
 * actually needs one (the housekeeping group's `Disclosure` toggle, in feature-groups.tsx).
 */
export function DigestFeatureCardView({ slug, card }: { slug: string; card: DigestFeatureCard }) {
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/projects/${slug}/epics/${card.id}`}
          className="min-w-0 truncate text-[13px] font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          title={card.title}
        >
          {card.title}
        </Link>
        <StagePill stage={card.stage} className="shrink-0" />
      </div>

      <p className="text-xs text-muted-foreground">{card.headline}</p>

      {card.why && (
        <p className="line-clamp-3 border-l-2 border-border pl-2 text-xs text-muted-foreground italic" title={card.why}>
          “{card.why}”
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {card.outcomeId && <MetaChip>outcome:{card.outcomeId}</MetaChip>}
        <ReviewScoreChip score={card.reviewScore} />
        {card.prRef && <PrChip href={card.prUrl}>{prLabel(card.prRef)}</PrChip>}
        <MetaChip>{formatUsd(card.costUsd)}</MetaChip>
      </div>

      <p className="text-xs font-medium text-foreground">{card.nextStep}</p>

      {card.events.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-border/60 pt-2">
          {card.events.map((event, i) => (
            <li
              key={`${event.kind}:${event.at}:${i}`}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <span>{event.label}</span>
              <span className="text-subtle">·</span>
              <RelativeTime iso={new Date(event.at * 1000).toISOString()} />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
