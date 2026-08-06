/**
 * The hygiene-finding vocabulary — the words an operator reads for each of the six
 * {@link HygieneFindingKind}s, and the summary line that folds them into a count.
 *
 * This module is the ONLY owner of that copy. The board used to carry a second, hand-synced set in
 * its attention strip; the health-page split (anton-4qf3) left the board with escalations alone, so
 * hygiene wording no longer has a second home to drift against. Anything that grows a hygiene
 * surface later imports from here rather than restating the labels.
 *
 * Copy only — severity and order belong to `rankAttention` (lib/attention.ts), which decides what is
 * worth a look and what is housekeeping. This file never re-ranks anything.
 */
import type { AttentionItem } from "@/lib/attention";
import type { HygieneFinding, HygieneFindingKind } from "@/lib/types";

/** What each class of board rot is, in the same voice the board uses. */
export const HYGIENE_LABELS: Record<HygieneFindingKind, string> = {
  lint: "Contract gap",
  "stale-open": "Stale",
  "stale-in-progress": "Abandoned run",
  orphan: "Shipped, not closed",
  "dep-cycle": "Dependency cycle",
  duplicate: "Duplicate",
};

/** The noun each kind counts, for the folded housekeeping line: "3 contract gaps · 5 stale". */
const HYGIENE_NOUNS: Record<HygieneFindingKind, [singular: string, plural: string]> = {
  lint: ["contract gap", "contract gaps"],
  "stale-open": ["stale", "stale"],
  "stale-in-progress": ["abandoned run", "abandoned runs"],
  orphan: ["shipped, not closed", "shipped, not closed"],
  "dep-cycle": ["dependency cycle", "dependency cycles"],
  duplicate: ["duplicate", "duplicates"],
};

/** Summary order for the folded line — the order the kinds are declared above. */
const HYGIENE_KIND_ORDER = Object.keys(HYGIENE_LABELS) as HygieneFindingKind[];

/** Every bead a finding concerns — one for a per-bead finding, the whole ring/group otherwise. */
export function findingBeadIds(finding: HygieneFinding): string[] {
  if (finding.ids?.length) return finding.ids;
  return finding.beadId ? [finding.beadId] : [];
}

/** "3 contract gaps · 5 stale · 2 shipped, not closed" — the folded line, in declaration order. */
export function housekeepingSummary(findings: HygieneFinding[]): string {
  const counts = new Map<HygieneFindingKind, number>();
  for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  const parts = HYGIENE_KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => {
    const n = counts.get(kind) ?? 0;
    const [singular, plural] = HYGIENE_NOUNS[kind];
    return `${n} ${n === 1 ? singular : plural}`;
  });
  return parts.join(" · ");
}

/** Narrows an {@link AttentionItem} list to its hygiene-sourced findings — every list this page
 * builds from `rankAttention` mixes in a review-band item, and only the hygiene rows carry a kind. */
export function hygieneFindings(
  items: AttentionItem[],
): Extract<AttentionItem, { source: "hygiene" }>[] {
  return items.filter((item): item is Extract<AttentionItem, { source: "hygiene" }> =>
    item.source === "hygiene",
  );
}
