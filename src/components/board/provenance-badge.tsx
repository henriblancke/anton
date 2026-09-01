import Link from "next/link";

import type { BeadProvenance, ProvenanceKind } from "@/lib/types";
import { criterionLabel, policyHref } from "@/lib/policy/href";
import { cn } from "@/lib/utils";
import { MetaChip } from "@/components/atoms";

/**
 * The mark every automated writer signs with. ONE glyph, so a card's provenance is scannable as a
 * class before it is read as a word — which is the whole reason three writers share a grammar
 * instead of each inventing an indicator (R3.7).
 */
const MARK = "◈";

/** How one writer introduces itself: the word after the mark, where it lands, and what it claims. */
interface ProvenanceGrammar {
  /** The badge's visible word — the only thing that differs between writers. */
  label: string;
  /** Concrete evidence for the claim. A badge that opened nothing would be decoration. */
  href: (slug: string, beadId: string, provenance: BeadProvenance) => string;
  title: (provenance: BeadProvenance) => string;
}

/**
 * The writers this surface has wording for.
 *
 * PARTIAL on purpose, and that is the extension point: `repaired` is a legal {@link ProvenanceKind}
 * with no entry here, so the repair passes can already stamp beads while the board stays quiet about
 * them (the kind is reserved, not rendered). Adding the badge later is one entry — never a second
 * component, a second glyph, or a second place a card decides what touched it.
 *
 * A kind with no entry renders NOTHING rather than throwing: provenance arrives over the board API
 * as data, so a machine running a newer anton than this tab must degrade to a missing badge, not to
 * a blank board.
 */
const GRAMMAR: Partial<Record<ProvenanceKind, ProvenanceGrammar>> = {
  policy: {
    label: "policy",
    // The bead rides along so the panel opens at THIS bead's evaluation, not at a list of forty.
    href: (slug, beadId, { ref }) => policyHref(slug, ref, beadId),
    title: ({ ref, detail }) =>
      ref
        ? `Admitted by the work policy at ${criterionLabel(ref)} — open the rule with this bead's evaluated criteria`
        : `Admitted by ${detail ?? "the work policy"} — open the policy with this bead's evaluated criteria`,
  },
  pm: {
    label: "PM",
    // Any run target's detail page answers for any bead id, and a proposal is an ordinary bead.
    href: (slug, _beadId, { ref }) => `/projects/${slug}/epics/${ref}`,
    title: ({ ref, detail }) =>
      `Product master proposed ${detail ?? "a move"} on this bead${ref ? ` (${ref})` : ""} — open the proposal and its evidence`,
  },
};

/**
 * One writer's mark on a bead — `◈ policy`, `◈ PM` — clickable through to what it decided from
 * (anton-cqxd / R3.7).
 *
 * Reads as a meta chip because that is what it is: the same shape as `agent:`, `risk:` and the PR
 * chip beside it, wrapped in a link the way `PrLink` wraps its own. `pointer-events-auto` is baked
 * in rather than passed, since every card that carries one puts a full-bleed open-link underneath —
 * a badge that quietly opened the card instead of the evidence would be worse than no badge.
 */
export function ProvenanceBadge({
  slug,
  beadId,
  provenance,
  className,
}: {
  slug: string;
  /** The bead the badge sits on — what `◈ policy` asks the policy panel to explain. */
  beadId: string;
  provenance: BeadProvenance;
  className?: string;
}) {
  const grammar = GRAMMAR[provenance.kind];
  if (!grammar) return null;

  return (
    <Link
      href={grammar.href(slug, beadId, provenance)}
      title={grammar.title(provenance)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "pointer-events-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      <MetaChip className="transition-colors hover:border-ring/40 hover:text-foreground">
        <span aria-hidden="true">{MARK}</span>
        {grammar.label}
      </MetaChip>
    </Link>
  );
}

/**
 * Every writer that touched this bead, in the order the board recorded them. Renders nothing at all
 * when there is none to show — including when the only entries are kinds this surface has no wording
 * for, so a reserved kind never leaves an empty gap in the meta row.
 */
export function ProvenanceBadges({
  slug,
  beadId,
  provenance,
  className,
}: {
  slug: string;
  beadId: string;
  provenance?: BeadProvenance[];
  className?: string;
}) {
  if (!provenance?.length) return null;
  return (
    <>
      {provenance.map((entry) => (
        <ProvenanceBadge
          key={`${entry.kind}:${entry.ref ?? ""}`}
          slug={slug}
          beadId={beadId}
          provenance={entry}
          className={className}
        />
      ))}
    </>
  );
}
