/**
 * The hygiene-finding vocabulary the Health page's sections share (anton-ue90.1 split), copied
 * rather than imported from `components/board/attention-strip.tsx`: that file is owned by the board
 * split and its labels are private to it, so the wording is kept in step by hand — both surfaces
 * describe the same six {@link HygieneFindingKind}s and must read the same way wherever a finding
 * shows up.
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
