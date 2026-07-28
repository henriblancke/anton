import Link from "next/link";
import { MapIcon } from "lucide-react";

import type { RoadmapRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { boardEpicFilterHref, TYPE_BADGE } from "@/components/board/board-utils";
import { EpicRowActions } from "@/components/roadmap/epic-row-actions";
import { PRIORITY_LABELS } from "@/components/ticket/ticket-dialog-utils";

/**
 * The roadmap table — the epic tier's own page. Still a reading surface: the rollup counts and the
 * Linear ref are derived or last-written, never live lookups, and the work itself is operated on
 * the board (docs/design/2026-07-26-tier-and-linear-ux.md). The one exception is the per-row edit
 * button, which opens a dialog over the three fields this table displays and the roadmap owns —
 * title, priority, area. Everything else about an epic is still shaped, not typed here.
 */
export function RoadmapTable({ slug, rows }: { slug: string; rows: RoadmapRow[] }) {
  if (rows.length === 0) return <RoadmapEmpty slug={slug} />;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full min-w-[700px] border-collapse text-[13px]">
        <caption className="sr-only">
          Product epics: priority, area, feature rollup, and Linear reference
        </caption>
        <thead>
          <tr>
            <ColumnHead>Epic</ColumnHead>
            <ColumnHead>Priority</ColumnHead>
            <ColumnHead>Area</ColumnHead>
            <ColumnHead>Features</ColumnHead>
            <ColumnHead>Shipped</ColumnHead>
            <ColumnHead>Linear</ColumnHead>
            <ColumnHead>
              <span className="sr-only">Actions</span>
            </ColumnHead>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border transition-colors hover:bg-card/50">
              <td className="max-w-[28rem] px-3 py-2.5 align-middle">
                <Link
                  href={boardEpicFilterHref(slug, row.id)}
                  title={`Show the board filtered to "${row.title}"`}
                  className="block truncate rounded-sm font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {row.title}
                </Link>
                <span className="font-mono text-[10px] text-subtle">{row.id}</span>
              </td>
              <td className="px-3 py-2.5 align-middle">
                <PriorityChip priority={row.priority} />
              </td>
              <td className="px-3 py-2.5 align-middle">
                <AreaChip area={row.area} />
              </td>
              <td className={cn(NUM_CELL, row.features === 0 && "text-subtle")}>{row.features}</td>
              <td className={NUM_CELL}>
                {/* A legacy epic has no features yet — "0 / 0" would read as a stalled rollup
                    rather than an epic that has not been broken down. */}
                {row.features === 0 ? (
                  <span className="text-subtle">—</span>
                ) : (
                  `${row.shipped} / ${row.features}`
                )}
              </td>
              <td className="px-3 py-2.5 align-middle">
                <LinearCell row={row} />
              </td>
              <td className="px-3 py-2.5 text-right align-middle">
                <EpicRowActions slug={slug} row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NUM_CELL = "px-3 py-2.5 align-middle font-mono text-[12px] tabular-nums text-muted-foreground";

function ColumnHead({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="border-b border-border px-3 py-2 text-left font-mono text-[10px] font-medium tracking-[0.1em] text-subtle uppercase"
    >
      {children}
    </th>
  );
}

/**
 * Where the epic sits in the queue. P0/P1 borrow the risk hues — the roadmap is scanned for what is
 * urgent, and a flat monospace column makes that a reading exercise. P4 (bd's default for an epic
 * nobody prioritised) stays subtle so an explicit low priority and an unset one look alike, which
 * they are.
 */
function PriorityChip({ priority }: { priority: number }) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] tabular-nums",
        priority === 0
          ? "font-medium text-risk-high"
          : priority === 1
            ? "text-risk-med"
            : priority >= 4
              ? "text-subtle"
              : "text-muted-foreground",
      )}
      title={PRIORITY_LABELS[priority]}
    >
      {`P${priority}`}
    </span>
  );
}

/**
 * The engine designator, in the single iris epic hue — one hue for the tier, never one per area
 * value (.product/decisions/2026-07-26-engine-designator-prefix.md). An epic without one gets the
 * subtle hollow chip, matching the board's legacy badge.
 */
function AreaChip({ area }: { area?: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[12rem] items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-none font-medium",
        area ? TYPE_BADGE.epic : "border-border bg-muted/40 text-subtle",
      )}
    >
      <span className="truncate font-mono">{area ? `area:${area}` : "no area"}</span>
    </span>
  );
}

/**
 * Where the epic lives in Linear. A missing `area:` means bd's project routing has nothing to key
 * on, so the cell says why it can't sync rather than leaving the epic looking routable — the whole
 * point of the column (docs/design/2026-07-26-tier-and-linear-ux.md § Sync legibility).
 */
function LinearCell({ row }: { row: RoadmapRow }) {
  if (!row.linearRef) {
    return (
      <span className="font-mono text-[11px] text-subtle">
        {row.area ? "not synced" : "not synced — needs area:"}
      </span>
    );
  }
  // The ref is displayed exactly as the last sync wrote it. Only a full URL is clickable: an
  // identifier like `LIB-118` has no workspace in it, and guessing one would fabricate a dead link.
  const href = /^https?:\/\//i.test(row.linearRef) ? row.linearRef : undefined;
  const label = <span className="truncate">{row.linearRef}</span>;
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-block max-w-[16rem] rounded-sm font-mono text-[11px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {label}
    </a>
  ) : (
    <span className="inline-block max-w-[16rem] font-mono text-[11px] text-muted-foreground">
      {label}
    </span>
  );
}

/**
 * Instant frame while the roadmap RSC resolves its bead read. Mirrors the real page's header +
 * column heads so the table doesn't jump into place once the rollup lands.
 */
export function RoadmapPageFallback({ slug }: { slug?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{slug}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Roadmap</span>
        </div>
      </header>
      <div className="flex flex-col" aria-label="Loading roadmap">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border px-3 py-3">
            <span className="anton-shimmer h-3 w-2/5 rounded" />
            <span className="anton-shimmer h-2.5 w-6 rounded" />
            <span className="anton-shimmer h-3 w-20 rounded" />
            <span className="anton-shimmer ml-auto h-2.5 w-8 rounded" />
            <span className="anton-shimmer h-2.5 w-12 rounded" />
            <span className="anton-shimmer h-2.5 w-16 rounded" />
            <span className="anton-shimmer size-7 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

function RoadmapEmpty({ slug }: { slug: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl border border-dashed border-border">
        <MapIcon className="size-5 text-subtle" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold">No epics yet</p>
        <p className="max-w-sm text-xs leading-relaxed text-subtle">
          Shape an epic to give a product outcome a home. Tag it{" "}
          <span className="font-mono text-muted-foreground">area:&lt;surface&gt;</span> and it lands
          here — with its features, what shipped, and where it lives in Linear.
        </p>
      </div>
      <Link href={`/projects/${slug}`} className="font-mono text-xs text-primary hover:underline">
        → Go to board
      </Link>
    </div>
  );
}
