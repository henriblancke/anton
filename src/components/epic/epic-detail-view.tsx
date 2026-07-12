"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckIcon, GitPullRequestIcon, TriangleAlertIcon } from "lucide-react";

import type { EpicDetail, Ticket } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { agentDotClass, isExternalUrl, ticketProgress } from "@/components/board/board-utils";
import { MetaChip, RiskChip, StagePill } from "@/components/atoms";
import { DependencyGraph } from "@/components/epic/dependency-graph";
import { TicketDialog } from "@/components/ticket/ticket-dialog";

type AcceptanceItem = { text: string; checked: boolean };

/** Split an acceptance blob into checklist items, honoring `- [x]` / `- [ ]` markers. */
function parseAcceptance(acceptance: string): AcceptanceItem[] {
  return acceptance
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(?:[-*]\s*)?\[( |x|X)\]\s*(.*)$/.exec(line);
      if (m) return { text: m[2].trim(), checked: m[1].toLowerCase() === "x" };
      return { text: line.replace(/^[-*]\s*/, ""), checked: false };
    });
}

function StatusCircle({ ticket }: { ticket: Ticket }) {
  if (ticket.stage === "done") {
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-stage-done">
        <CheckIcon className="size-2 text-[#0b0a09]" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (ticket.stage === "implementing") {
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-stage-implementing">
        <span className="size-1.5 rounded-full bg-stage-implementing anton-pulse" />
      </span>
    );
  }
  if (ticket.stage === "in-review") {
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-stage-in-review">
        <span className="size-1.5 rounded-full bg-stage-in-review" />
      </span>
    );
  }
  return <span className="size-3.5 shrink-0 rounded-full border-[1.5px] border-subtle" />;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">{children}</span>
  );
}

export function EpicDetailView({ slug, epicId }: { slug: string; epicId: string }) {
  const [detail, setDetail] = useState<EpicDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

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
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load epic");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, epicId, attempt]);

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl border border-risk-high/30 bg-risk-high/10">
          <TriangleAlertIcon className="size-5 text-risk-high" aria-hidden="true" />
        </span>
        <p className="text-sm text-risk-high">{error}</p>
        <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  if (!detail) return <EpicDetailSkeleton />;

  const { epic, tickets, edges } = detail;
  const { done, total, pct } = ticketProgress({ tickets });
  const inProgress = tickets.filter((t) => t.stage === "implementing").length;
  const inProgressPct = total === 0 ? 0 : Math.round((inProgress / total) * 100);
  const todo = Math.max(0, total - done - inProgress);
  const acceptance = epic.acceptance ? parseAcceptance(epic.acceptance) : [];

  return (
    <div className="flex flex-1 flex-col">
      {/* header */}
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <Link
            href={`/projects/${slug}`}
            className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Board
          </Link>
          <span className="text-subtle">/</span>
          <span className="truncate font-medium text-foreground" title={epic.title}>
            {epic.title}
          </span>
        </div>
        <StagePill stage={epic.stage} className="ml-1" />
        <div className="ml-auto flex shrink-0 gap-2">
          <Button size="sm" variant="outline">
            {epic.stage === "implementing" ? "Pause run" : "Run epic"}
          </Button>
          <Button size="sm" variant="secondary">
            Open worktree
          </Button>
        </div>
      </header>

      {/* body: contract | graph */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[400px_1fr]">
        {/* LEFT — contract */}
        <div className="flex flex-col gap-5 overflow-y-auto border-border p-5 sm:p-6 lg:border-r">
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[11px] text-subtle">{epic.id} · epic</span>
            <h1 className="font-display text-[22px] leading-tight font-bold tracking-[-0.01em]" title={epic.title}>
              {epic.title}
            </h1>
            {(epic.agent || epic.risk || epic.size || epic.prRef) && (
              <div className="flex flex-wrap gap-1.5">
                {epic.agent && <MetaChip dotClass={agentDotClass(epic.agent)}>{epic.agent}</MetaChip>}
                {epic.risk && <RiskChip risk={epic.risk} />}
                {epic.size && <MetaChip>size:{epic.size}</MetaChip>}
                {epic.prRef &&
                  (isExternalUrl(epic.prRef) ? (
                    <a href={epic.prRef} target="_blank" rel="noopener noreferrer" className="focus-visible:outline-none">
                      <MetaChip tone="pr">
                        <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
                        PR
                      </MetaChip>
                    </a>
                  ) : (
                    <MetaChip tone="pr">
                      <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
                      {epic.prRef}
                    </MetaChip>
                  ))}
              </div>
            )}
          </div>

          {/* completion module */}
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-end gap-2.5">
              <span className="font-display text-[30px] leading-none font-bold tracking-[-0.02em]">
                {done}
                <span className="text-[20px] text-subtle"> / {total}</span>
              </span>
              <span className="mb-0.5 text-xs text-muted-foreground">tickets complete</span>
              <span className="mb-0.5 ml-auto font-mono text-xs text-stage-done">{pct}%</span>
            </div>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
              <span className="bg-stage-done" style={{ width: `${pct}%` }} />
              <span className="bg-stage-implementing" style={{ width: `${inProgressPct}%` }} />
            </div>
            <div className="flex flex-wrap gap-3.5">
              <LegendItem className="bg-stage-done" label={`${done} done`} />
              <LegendItem className="bg-stage-implementing" label={`${inProgress} in progress`} />
              <LegendItem className="bg-subtle" label={`${todo} to do`} />
            </div>
          </div>

          {epic.goal && (
            <div className="flex flex-col gap-2">
              <SectionLabel>Goal</SectionLabel>
              <p className="text-[13px] leading-relaxed text-foreground/85">{epic.goal}</p>
            </div>
          )}

          {acceptance.length > 0 && (
            <div className="flex flex-col gap-2.5">
              <SectionLabel>Acceptance</SectionLabel>
              {acceptance.map((item, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  {item.checked ? (
                    <span className="mt-px flex size-[15px] shrink-0 items-center justify-center rounded bg-stage-done">
                      <CheckIcon className="size-2 text-[#0b0a09]" strokeWidth={3} aria-hidden="true" />
                    </span>
                  ) : (
                    <span className="mt-px size-[15px] shrink-0 rounded border-[1.5px] border-border" />
                  )}
                  <span
                    className={cn(
                      "text-[12.5px] leading-snug",
                      item.checked ? "text-muted-foreground" : "text-foreground/85",
                    )}
                  >
                    {item.text}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <SectionLabel>Tickets · {tickets.length}</SectionLabel>
            {tickets.length === 0 ? (
              <p className="py-2 text-xs text-subtle">No linked tickets yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border/60">
                {tickets.map((ticket) => (
                  <li key={ticket.id}>
                    <button
                      type="button"
                      onClick={() => setOpenTicketId(ticket.id)}
                      title={ticket.title}
                      className="flex w-full items-center gap-2.5 rounded-md py-2 text-left hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <StatusCircle ticket={ticket} />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-[12.5px]",
                          ticket.stage === "done" ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {ticket.title}
                      </span>
                      {ticket.size && (
                        <span className="shrink-0 font-mono text-[10px] text-subtle">{ticket.size}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* RIGHT — dependency graph */}
        <div className="flex min-h-[440px] flex-col">
          <div className="flex items-center gap-2.5 border-b border-border px-5 py-3.5 sm:px-6">
            <span className="text-[13px] font-semibold">Dependency graph</span>
            <span className="font-mono text-[11px] text-subtle">dagre · left → right</span>
            <div className="ml-auto hidden gap-3 sm:flex">
              <LegendItem className="bg-stage-done" label="done" small />
              <LegendItem className="bg-stage-implementing" label="active" small />
              <LegendItem className="bg-stage-backlog" label="todo" small />
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <DependencyGraph
              epic={epic}
              tickets={tickets}
              edges={edges}
              fill
              onSelectTicket={setOpenTicketId}
            />
          </div>
        </div>
      </div>

      <TicketDialog
        slug={slug}
        ticketId={openTicketId}
        open={openTicketId !== null}
        onClose={() => setOpenTicketId(null)}
        onSaved={() => setAttempt((n) => n + 1)}
      />
    </div>
  );
}

function LegendItem({
  className,
  label,
  small = false,
}: {
  className: string;
  label: string;
  small?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-muted-foreground",
        small ? "text-[11px] text-subtle" : "text-[11px]",
      )}
    >
      <span className={cn("size-2 rounded-[3px]", className)} aria-hidden="true" />
      {label}
    </span>
  );
}

function EpicDetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true" aria-label="Loading epic">
      <div className="flex h-14 items-center gap-3 border-b border-border px-6">
        <span className="anton-shimmer h-3 w-40 rounded" />
        <span className="anton-shimmer h-6 w-24 rounded-full" />
      </div>
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[400px_1fr]">
        <div className="flex flex-col gap-5 border-border p-6 lg:border-r">
          <span className="anton-shimmer h-6 w-3/4 rounded" />
          <span className="anton-shimmer h-24 w-full rounded-xl" />
          <span className="anton-shimmer h-3 w-1/3 rounded" />
          <span className="anton-shimmer h-16 w-full rounded" />
        </div>
        <div className="anton-shimmer m-6 rounded-xl" />
      </div>
    </div>
  );
}
