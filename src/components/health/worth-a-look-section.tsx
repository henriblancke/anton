import Link from "next/link";

import type { AttentionItem } from "@/lib/attention";
import { MetaChip } from "@/components/atoms";
import { ReviewScoreChip } from "@/components/review-score";
import { HealthBeadLink } from "./bead-link";
import { HYGIENE_LABELS, findingBeadIds } from "./hygiene-copy";

/**
 * What the attention band promoted off the board and onto this page (anton-ue90.1 split): the
 * `attention`-severity items `rankAttention` produced — a dependency cycle or an abandoned run that
 * makes the board misreport itself, and a run target whose worst review score landed in the rework
 * band. `rankAttention` still owns severity and order; this file owns only the words, same as the
 * board's own attention strip.
 *
 * Escalations never reach this list (the page's `getProjectHealth` never feeds them to
 * `rankAttention` — see lib/health.ts), so every item here is a hygiene finding or a review score,
 * never a stopped run: those stay on the board, answered inline.
 *
 * Renders nothing when there is nothing to look at — an empty section here is not a "clean" claim,
 * it is simply not drawn; the clean-vs-never-checked distinction is the right rail's job (it always
 * says what has and hasn't run).
 */
export function WorthALookSection({ slug, items }: { slug: string; items: AttentionItem[] }) {
  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="worth-a-look-heading"
      className="rounded-xl border border-border bg-card/60 text-xs"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        <h2 id="worth-a-look-heading" className="text-xs font-medium text-foreground">
          Worth a look
        </h2>
        <MetaChip tone="risk-med">{items.length} to look at</MetaChip>
      </div>
      <ul className="divide-y divide-border/50">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2">
            {item.source === "review" ? (
              <>
                <MetaChip tone="risk-med">Substantial rework</MetaChip>
                <Link
                  href={`/projects/${slug}/epics/${item.target.id}`}
                  className="rounded-sm font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  title={item.target.title}
                >
                  {item.target.id}
                </Link>
                <span className="text-xs text-foreground">{item.target.title}</span>
                <span className="text-xs text-muted-foreground">
                  the lowest self-review score on the board — the work did not satisfy its contract
                </span>
                <span className="ml-auto">
                  <ReviewScoreChip score={item.target.score} />
                </span>
              </>
            ) : item.source === "hygiene" ? (
              <>
                <MetaChip tone="risk-med">{HYGIENE_LABELS[item.finding.kind]}</MetaChip>
                {findingBeadIds(item.finding).map((id) => (
                  <HealthBeadLink key={id} id={id} />
                ))}
                {item.finding.title ? (
                  <span className="text-xs text-foreground">{item.finding.title}</span>
                ) : null}
                {/* Full text, never truncated — it is the sentence a human judges the finding on. */}
                <span className="text-xs text-muted-foreground">{item.finding.detail}</span>
              </>
            ) : null /* escalations never reach this list — see the module docblock */}
          </li>
        ))}
      </ul>
    </section>
  );
}
