import type { AttentionItem } from "@/lib/attention";
import { MetaChip } from "@/components/atoms";
import { Disclosure } from "./disclosure";
import { HealthBeadLink } from "./bead-link";
import { HYGIENE_LABELS, findingBeadIds, housekeepingSummary, hygieneFindings } from "./hygiene-copy";

/**
 * The `housekeeping`-severity findings — real, but nothing downstream is wrong today (contract gaps,
 * staleness, shipped-not-closed, duplicates). Collapsed behind a summary line with a Show/Hide
 * disclosure: a surface where everything is loud is a surface an operator learns to skip, and this
 * page inherits that restraint from the board strip it came out of (anton-4qf3) rather than
 * un-folding everything just because it has more room.
 *
 * Renders nothing when there is none — the same "say nothing it hasn't earned" rule as every other
 * section here.
 */
export function HousekeepingSection({ items }: { items: AttentionItem[] }) {
  const findings = hygieneFindings(items).map((item) => item.finding);
  if (findings.length === 0) return null;

  return (
    <section
      aria-labelledby="housekeeping-heading"
      className="rounded-xl border border-border bg-card/60 text-xs"
    >
      <div className="border-b border-border/60 px-3 py-2">
        <h2 id="housekeeping-heading" className="text-xs font-medium text-foreground">
          Housekeeping
        </h2>
      </div>
      <div className="px-3 py-2.5">
        <Disclosure summary={housekeepingSummary(findings)}>
          <ul className="flex flex-col gap-1.5">
            {findings.map((finding) => (
              <li key={finding.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <MetaChip>{HYGIENE_LABELS[finding.kind]}</MetaChip>
                {findingBeadIds(finding).map((id) => (
                  <HealthBeadLink key={id} id={id} />
                ))}
                {finding.title ? (
                  <span className="text-xs text-foreground">{finding.title}</span>
                ) : null}
                <span className="text-xs text-muted-foreground">{finding.detail}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      </div>
    </section>
  );
}
