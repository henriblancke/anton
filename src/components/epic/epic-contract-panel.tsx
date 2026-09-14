"use client";

import type { Epic, ReviewReport, Ticket } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { agentDotClass } from "@/components/board/board-utils";
import { MetaChip, RelativeTime, RiskChip } from "@/components/atoms";
import { ClaimControl } from "@/components/board/claim-control";
import { PrLinkControl } from "@/components/board/pr-link-control";
import { ReviewScorePanel } from "@/components/epic/review-score-panel";
import {
  DoneMark,
  LegendItem,
  SectionLabel,
  StatusCircle,
} from "@/components/epic/epic-detail-parts";
import type { EpicDetailSummary } from "@/components/epic/epic-detail-summary";

/** The target's id line, title, meta chips and PR link — who this bead is. */
function EpicIdentity({
  slug,
  epic,
  word,
  onChanged,
}: {
  slug: string;
  epic: Epic;
  word: string;
  onChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 font-mono text-[11px] text-subtle">
        <CopyButton value={epic.id} label={`${word} id`}>
          {epic.id}
        </CopyButton>
        · {word}
      </span>
      <h1
        className="font-display text-[22px] leading-tight font-bold tracking-[-0.01em]"
        title={epic.title}
      >
        {epic.title}
      </h1>
      {(epic.agent || epic.risk || epic.size) && (
        <div className="flex flex-wrap gap-1.5">
          {epic.agent && <MetaChip dotClass={agentDotClass(epic.agent)}>{epic.agent}</MetaChip>}
          {epic.risk && <RiskChip risk={epic.risk} />}
          {epic.size && <MetaChip>size:{epic.size}</MetaChip>}
        </div>
      )}
      <PrLinkControl
        slug={slug}
        itemId={epic.id}
        prRef={epic.prRef}
        prUrl={epic.prUrl}
        onLinked={onChanged}
      />
    </div>
  );
}

/** How much of the run landed: the done/total count, the split bar, and what each band means. */
function CompletionModule({ summary }: { summary: EpicDetailSummary }) {
  const { done, total, pct, inProgress, inProgressPct, todo, abandoned } = summary;

  return (
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
        {/* Abandoned tickets are out of the progress count — say so rather than let them
            silently vanish from the epic's arithmetic. */}
        {abandoned > 0 && <LegendItem className="bg-border" label={`${abandoned} abandoned`} />}
      </div>
    </div>
  );
}

/** Claimed-by + created — mirrors the ticket surfaces. */
function EpicMetaRows({
  slug,
  epic,
  onChanged,
}: {
  slug: string;
  epic: Epic;
  onChanged: () => void;
}) {
  return (
    <dl className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12.5px]">
        <dt className="w-20 shrink-0">
          <SectionLabel>Claimed by</SectionLabel>
        </dt>
        <dd>
          <ClaimControl
            slug={slug}
            itemId={epic.id}
            owner={epic.assignee}
            variant="row"
            readOnly={epic.approved}
            canTakeOver={epic.stage === "backlog"}
            onChanged={onChanged}
          />
        </dd>
      </div>
      <div className="flex items-baseline gap-2 text-[12.5px]">
        <dt className="w-20 shrink-0">
          <SectionLabel>Created</SectionLabel>
        </dt>
        <dd className="text-foreground/85">
          <RelativeTime iso={epic.createdAt} />
          {epic.createdBy && <span className="text-subtle"> by {epic.createdBy}</span>}
        </dd>
      </div>
    </dl>
  );
}

/** The acceptance criteria as the checklist the bead wrote them as. */
function AcceptanceSection({ items }: { items: EpicDetailSummary["acceptance"] }) {
  return (
    <div className="flex flex-col gap-2.5">
      <SectionLabel>Acceptance</SectionLabel>
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2.5">
          {item.checked ? (
            <DoneMark className="mt-px size-[15px] rounded" />
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
  );
}

/** The work under this target, each row opening the ticket dialog. */
function TicketList({
  tickets,
  onOpenTicket,
}: {
  tickets: Ticket[];
  onOpenTicket: (ticketId: string) => void;
}) {
  return (
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
                onClick={() => onOpenTicket(ticket.id)}
                title={ticket.title}
                className="flex w-full items-center gap-2.5 rounded-md py-2 text-left hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <StatusCircle ticket={ticket} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[12.5px]",
                    ticket.abandoned
                      ? "text-subtle line-through decoration-border"
                      : ticket.stage === "done"
                        ? "text-muted-foreground"
                        : "text-foreground",
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
  );
}

/** The detail page's left column: the contract this run answers to, top to bottom. */
export function EpicContractPanel({
  slug,
  epic,
  tickets,
  summary,
  review,
  reviewLoading,
  reviewError,
  onOpenTicket,
  onChanged,
}: {
  slug: string;
  epic: Epic;
  tickets: Ticket[];
  summary: EpicDetailSummary;
  review: ReviewReport | undefined;
  reviewLoading: boolean;
  reviewError: string | null;
  onOpenTicket: (ticketId: string) => void;
  onChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-5 overflow-y-auto border-border p-5 sm:p-6 lg:border-r">
      <EpicIdentity slug={slug} epic={epic} word={summary.word} onChanged={onChanged} />
      <CompletionModule summary={summary} />

      {/* Beside completion on purpose: how much of the run landed, then how well it scored. */}
      <ReviewScorePanel
        report={review}
        stage={epic.stage}
        loading={reviewLoading}
        error={reviewError}
      />

      <EpicMetaRows slug={slug} epic={epic} onChanged={onChanged} />

      {epic.goal && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Goal</SectionLabel>
          <p className="text-[13px] leading-relaxed text-foreground/85">{epic.goal}</p>
        </div>
      )}

      {summary.acceptance.length > 0 && <AcceptanceSection items={summary.acceptance} />}

      <TicketList tickets={tickets} onOpenTicket={onOpenTicket} />
    </div>
  );
}
