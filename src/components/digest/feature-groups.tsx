import type { DigestFeatureGroup } from "@/lib/digest/feature-cards";
import { MetaChip } from "@/components/atoms";
import { Disclosure } from "@/components/health/disclosure";
import { DigestFeatureCardView } from "@/components/digest/feature-card";

/**
 * The digest's feature cards, grouped by outcome (anton-y1uxp) — a named-outcome section per
 * `DigestFeatureGroup` the read produced, the unlinked catch-all carrying its own badge, and the
 * built-in codebase-health outcome collapsed behind a Show/Hide fold the same way
 * `HousekeepingSection` already folds hygiene findings (health/housekeeping-section.tsx):
 * codebase-health-only activity is real, but it is not what an operator should have to read first.
 *
 * Renders nothing when there are no groups — a window with no changed features earns no section,
 * same "say nothing it hasn't earned" rule every other digest/health surface follows.
 */
export function DigestFeatureGroups({ slug, groups }: { slug: string; groups: DigestFeatureGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) =>
        group.kind === "housekeeping" ? (
          <HousekeepingGroup key={group.key} slug={slug} group={group} />
        ) : (
          <FeatureGroupSection key={group.key} slug={slug} group={group} />
        ),
      )}
    </div>
  );
}

function FeatureGroupSection({ slug, group }: { slug: string; group: DigestFeatureGroup }) {
  return (
    <section aria-labelledby={`digest-group-${group.key}`} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <h3 id={`digest-group-${group.key}`} className="text-[13px] font-medium text-foreground">
          {group.label}
        </h3>
        {/* A card naming no outcome (or one PRODUCT.md no longer declares) still gets grouped
            somewhere — this badge is what tells it apart from a real named outcome at a glance. */}
        {group.kind === "unlinked" && <MetaChip>unlinked</MetaChip>}
      </div>
      <div className="flex flex-col gap-3">
        {group.cards.map((card) => (
          <DigestFeatureCardView key={card.id} slug={slug} card={card} />
        ))}
      </div>
    </section>
  );
}

function HousekeepingGroup({ slug, group }: { slug: string; group: DigestFeatureGroup }) {
  const count = group.cards.length;
  return (
    <section
      aria-labelledby="digest-housekeeping-heading"
      className="rounded-xl border border-border bg-card/60 p-3"
    >
      <h3 id="digest-housekeeping-heading" className="sr-only">
        {group.label}
      </h3>
      <Disclosure summary={`${group.label} · ${count} feature${count === 1 ? "" : "s"}`}>
        <div className="flex flex-col gap-3 pt-2">
          {group.cards.map((card) => (
            <DigestFeatureCardView key={card.id} slug={slug} card={card} />
          ))}
        </div>
      </Disclosure>
    </section>
  );
}
