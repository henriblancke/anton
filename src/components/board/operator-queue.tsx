"use client";

import { UserRoundIcon } from "lucide-react";
import Link from "next/link";

import { MetaChip, RelativeTime, RiskChip } from "@/components/atoms";
import { STAGE_ACCENT_DOT } from "@/components/board/board-utils";
import type { OperatorQueueItem, Stage } from "@/lib/types";
import { cn } from "@/lib/utils";

const TITLE_CLASS =
  "rounded-sm text-[13px] font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

/**
 * The work anton hands back, in one list (anton-qfso.1).
 *
 * `agent:human` keeps a bead out of the claimable set and out of every dispatch (anton-mv70) — the
 * right call, because no agent can spend a credential, sign a thing, or make a taste call. But an
 * exclusion is not a destination: without this band the work simply stops appearing anywhere a
 * founder looks, which trades a wasted run for a lost ticket. Here it stays approved, ordered, and
 * one click from the surface that carries its controls.
 *
 * Quiet on purpose. This sits below the escalation strip and must not compete with it: an escalation
 * is work that STOPPED and hands you a button to unstick it, while every row here is work that is
 * simply yours and always was. Loud is a claim about urgency the queue has not earned, and a board
 * where two bands shout is a board where a founder learns to skip both.
 *
 * Renders NOTHING when there is no human work — not an empty state. "Nothing is waiting on you" is a
 * claim, and the honest version of it here is silence: the same rule `rankAttention`'s `reported`
 * flag encodes and the escalation strip restates.
 */
export function OperatorQueue({
  slug,
  items,
  onOpenTicket,
}: {
  slug: string;
  items: OperatorQueueItem[];
  /** Opens a parented ticket in the board's shared TicketDialog — see {@link QueueRow}. */
  onOpenTicket: (ticketId: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="operator-queue-heading"
      className="mb-3 overflow-hidden rounded-xl border border-border bg-secondary/40"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        <UserRoundIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <h2 id="operator-queue-heading" className="text-xs font-medium text-foreground">
          Yours to do
        </h2>
        <MetaChip>{items.length} waiting</MetaChip>
        {/* Says the rule rather than the count: a founder who doesn't know WHY these are here reads
            the band as a second backlog and ignores it. */}
        <span className="text-[11px] text-subtle">
          Approved work labelled <span className="font-mono">agent:human</span> — anton never
          dispatches it.
        </span>
      </div>

      <ul className="divide-y divide-border/50">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-start gap-x-2.5 gap-y-1.5 px-3 py-2">
            <span
              className="mt-0.5 w-0.5 shrink-0 self-stretch rounded-full bg-border"
              aria-hidden="true"
            />
            <QueueRow slug={slug} item={item} onOpenTicket={onOpenTicket} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Whether someone has already picked this ask up, said in the queue's own terms. `backlog` is every
 * untouched row and earns no chip — a badge on all of them says nothing. `done` never reaches here
 * (a closed bead leaves the queue), so only the two started shapes are nameable, and without them an
 * ask a person is mid-way through looks identical to one nobody has opened (PR #214 review).
 */
function startedLabel(stage: Stage): string | undefined {
  if (stage === "implementing") return "in progress";
  if (stage === "in-review") return "in review";
  return undefined;
}

/**
 * One ask, with what it costs to leave it: a ticket a run will stop on, or work no agent will start
 * at all — a human run target, or a ticket under one. The distinction is the row's first chip
 * because it is the one thing that changes what a founder does next: a held run is already burning
 * a worktree, while everything else is simply not moving.
 */
function QueueRow({
  slug,
  item,
  onOpenTicket,
}: {
  slug: string;
  item: OperatorQueueItem;
  onOpenTicket: (ticketId: string) => void;
}) {
  const started = startedLabel(item.stage);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <MetaChip tone={item.holdsRun ? "pr" : "neutral"}>
          {item.holdsRun ? "holds a run" : "no agent will start it"}
        </MetaChip>
        {started ? (
          <MetaChip
            dotClass={STAGE_ACCENT_DOT[item.stage]}
            dotPulse={item.stage === "implementing"}
          >
            {started}
          </MetaChip>
        ) : null}
        {item.risk ? <RiskChip risk={item.risk} /> : null}
        {item.size ? <MetaChip>size:{item.size}</MetaChip> : null}
        <MetaChip>
          asked <RelativeTime iso={item.createdAt} />
        </MetaChip>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {/* The bead itself — every control for editing, claiming or closing it already lives there,
            so this band opens it rather than reproducing them. WHERE it lives differs by shape, the
            same split the tickets table makes: a run target gets the epic page, whose actions
            (Approve, Force run) are exactly the ones it can take, while a PARENTED ticket has none
            of those — approving it is rejected outright — and belongs in the TicketDialog, which is
            the only surface carrying its editor and state controls. */}
        {item.runTarget ? (
          <button
            type="button"
            onClick={() => onOpenTicket(item.id)}
            className={cn(TITLE_CLASS, "text-left")}
          >
            {item.title}
          </button>
        ) : (
          <Link href={`/projects/${slug}/epics/${item.id}`} className={TITLE_CLASS}>
            {item.title}
          </Link>
        )}
        <span className="font-mono text-[11px] text-subtle">{item.id}</span>
      </div>
      {/* The ask, not just its title: deciding whether to answer something now is deciding on what
          it actually wants. Clamped — the bead is one click away for the rest. */}
      {item.goal ? (
        <p className="line-clamp-2 text-xs text-muted-foreground" title={item.goal}>
          {item.goal}
        </p>
      ) : null}
      {/* What actually releases the run, which is NOT closing this ticket (PR #214 review). The run
          holds an open human gate on it, and anton never resolves that gate itself — the operator
          answers it from the escalation strip above, and the resumed run is what closes the ticket.
          A row that said "close this" would leave the gate open and the run parked for good. */}
      {item.runTarget && item.holdsRun ? (
        <p className="text-[11px] text-subtle">
          Holds <TargetLink slug={slug} id={item.runTarget.id} /> — do the work, then{" "}
          <span className="text-muted-foreground">Resolve &amp; resume</span> on its &ldquo;Waiting
          on you&rdquo; row above. That is what restarts the run, and the run is what closes this
          ticket.
        </p>
      ) : null}
      {/* The target is a person's work too, so anton refuses the run at the target and never reaches
          this ticket. Pointing at a "Waiting on you" row here would send the operator after an
          escalation that was never armed (PR #214 review) — the target is what to do first. */}
      {item.runTarget && !item.holdsRun ? (
        <p className="text-[11px] text-subtle">
          Inside <TargetLink slug={slug} id={item.runTarget.id} />, which is yours as well — anton
          refuses that run at the target, so no run is held behind this one.
        </p>
      ) : null}
    </div>
  );
}

/** The run target a queued ticket rides on, linked to the page carrying its run controls. */
function TargetLink({ slug, id }: { slug: string; id: string }) {
  return (
    <Link
      href={`/projects/${slug}/epics/${id}`}
      className="rounded-sm font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {id}
    </Link>
  );
}
