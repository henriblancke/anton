"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  CircleCheckIcon,
  GitPullRequestIcon,
  InboxIcon,
  TriangleAlertIcon,
} from "lucide-react";

import type { EpicDetail, Ticket } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  STAGE_ACCENT_DOT,
  STAGE_LABELS,
  badgeVariant,
  isExternalUrl,
  ticketBadges,
} from "@/components/board/board-utils";
import { DependencyGraph } from "@/components/epic/dependency-graph";

type DescriptionBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "list"; items: string[] }
  | { type: "paragraph"; text: string };

/** Turns a bead's raw markdown-ish description into readable blocks — headings, bullet lists,
 * and paragraphs — without pulling in a markdown parser dependency. Pure, no side effects. */
function parseDescriptionBlocks(description: string): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
      paragraphLines = [];
    }
  };
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: "list", items: listItems });
      listItems = [];
    }
  };

  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.trim();
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);

    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
    } else if (bulletMatch) {
      flushParagraph();
      listItems.push(bulletMatch[1].trim());
    } else if (line === "") {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraphLines.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

function DescriptionBlocks({ description }: { description: string }) {
  const blocks = useMemo(() => parseDescriptionBlocks(description), [description]);
  if (blocks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return (
            <p
              key={`heading-${index}-${block.text}`}
              className={cn(
                "leading-snug font-medium",
                block.level <= 2 ? "text-sm text-foreground" : "text-xs text-muted-foreground uppercase tracking-wide",
              )}
            >
              {block.text}
            </p>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={`list-${index}-${block.items[0]}`} className="ml-4 list-disc text-sm leading-relaxed text-foreground/90">
              {block.items.map((item, itemIndex) => (
                <li key={`${index}-${itemIndex}-${item}`}>{item}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={`paragraph-${index}-${block.text.slice(0, 24)}`} className="text-sm leading-relaxed text-foreground/90">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

function BackLink({ slug }: { slug: string }) {
  return (
    <Link
      href={`/projects/${slug}`}
      className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
      Back to board
    </Link>
  );
}

function TicketListItem({ ticket }: { ticket: Ticket }) {
  const badges = ticketBadges(ticket);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border/70 bg-card p-3 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{ticket.id}</span>
          <Badge variant="outline" className="h-4 px-1.5 text-[0.65rem]">
            {STAGE_LABELS[ticket.stage]}
          </Badge>
        </div>
        <p className="truncate text-sm font-medium" title={ticket.title}>
          {ticket.title}
        </p>
        <p className="text-xs text-muted-foreground">{ticket.status}</p>
      </div>
      {badges.length > 0 && (
        <div className="flex flex-wrap gap-1 sm:shrink-0">
          {badges.map((badge) => (
            <Badge key={badge.key} variant={badgeVariant(badge)}>
              {badge.label}
            </Badge>
          ))}
        </div>
      )}
    </li>
  );
}

function EpicDetailSkeleton({ slug }: { slug: string }) {
  return (
    <div className="flex flex-1 flex-col gap-6" aria-busy="true" aria-label="Loading epic">
      <BackLink slug={slug} />
      <div className="flex flex-col gap-2">
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
        <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-24 animate-pulse rounded-xl bg-card/60 ring-1 ring-border/60" />
        <div className="h-24 animate-pulse rounded-xl bg-card/60 ring-1 ring-border/60" />
      </div>
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-card/60 ring-1 ring-border/60" />
        ))}
      </div>
      <div className="h-[520px] animate-pulse rounded-xl bg-card/60 ring-1 ring-border/60" />
    </div>
  );
}

export function EpicDetailView({ slug, epicId }: { slug: string; epicId: string }) {
  const [detail, setDetail] = useState<EpicDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/epics/${epicId}`);
        if (!res.ok) throw new Error(`Failed to load epic (${res.status})`);
        const data = (await res.json()) as { detail: EpicDetail };
        if (!cancelled) {
          setDetail(data.detail);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load epic");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, epicId, attempt]);

  if (error) {
    return (
      <div className="flex flex-1 flex-col gap-4">
        <BackLink slug={slug} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-destructive/30 p-8 text-center">
          <TriangleAlertIcon className="size-6 text-destructive" aria-hidden="true" />
          <p className="text-sm text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!detail) {
    return <EpicDetailSkeleton slug={slug} />;
  }

  const { epic, description, tickets, edges } = detail;

  return (
    <div className="flex flex-1 flex-col gap-6">
      <BackLink slug={slug} />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("size-1.5 rounded-full", STAGE_ACCENT_DOT[epic.stage])} aria-hidden="true" />
          <span className="text-xs text-muted-foreground">{STAGE_LABELS[epic.stage]}</span>
          {epic.approved && (
            <Badge variant="outline" className="gap-1">
              <CircleCheckIcon aria-hidden="true" />
              Approved
            </Badge>
          )}
          {epic.prRef &&
            (isExternalUrl(epic.prRef) ? (
              <a
                href={epic.prRef}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Badge variant="outline" className="gap-1">
                  <GitPullRequestIcon aria-hidden="true" />
                  PR
                </Badge>
              </a>
            ) : (
              <Badge variant="outline" className="gap-1">
                <GitPullRequestIcon aria-hidden="true" />
                {epic.prRef}
              </Badge>
            ))}
        </div>
        <h1 className="text-lg font-semibold leading-snug" title={epic.title}>
          {epic.title}
        </h1>
      </div>

      {(epic.goal || epic.acceptance) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {epic.goal && (
            <section className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-card p-4">
              <h2 className="text-sm font-medium">Goal</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{epic.goal}</p>
            </section>
          )}
          {epic.acceptance && (
            <section className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-card p-4">
              <h2 className="text-sm font-medium">Acceptance</h2>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">{epic.acceptance}</p>
            </section>
          )}
        </div>
      )}

      {description && (
        <section className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4">
          <h2 className="text-sm font-medium">Description</h2>
          <DescriptionBlocks description={description} />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Tickets</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{tickets.length}</span>
        </div>
        {tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border/70 px-3 py-8 text-center">
            <InboxIcon className="size-4 text-muted-foreground/60" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">No tickets</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {tickets.map((ticket) => (
              <TicketListItem key={ticket.id} ticket={ticket} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Dependency graph</h2>
        <DependencyGraph epic={epic} tickets={tickets} edges={edges} />
      </section>
    </div>
  );
}
