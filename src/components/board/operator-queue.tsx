import { UserRoundIcon } from "lucide-react";
import Link from "next/link";

import { MetaChip, RelativeTime, RiskChip } from "@/components/atoms";
import type { OperatorQueueItem } from "@/lib/types";

/**
 * The work anton hands back, in one list (anton-qfso.1).
 *
 * `agent:human` keeps a bead out of the claimable set and out of every dispatch (anton-mv70) — the
 * right call, because no agent can spend a credential, sign a thing, or make a taste call. But an
 * exclusion is not a destination: without this band the work simply stops appearing anywhere a
 * founder looks, which trades a wasted run for a lost ticket. Here it stays approved, ordered, and
 * one click from the bead that carries its controls.
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
export function OperatorQueue({ slug, items }: { slug: string; items: OperatorQueueItem[] }) {
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
            <QueueRow slug={slug} item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One ask, with what it costs to leave it: a run target no agent will ever start, or a ticket a live
 * run will stop on. The distinction is the row's first chip because it is the one thing that changes
 * what a founder does next — a held run is already burning a worktree, while a human target is
 * simply not moving.
 */
function QueueRow({ slug, item }: { slug: string; item: OperatorQueueItem }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <MetaChip tone={item.runTarget ? "pr" : "neutral"}>
          {item.runTarget ? "holds a run" : "no agent will start it"}
        </MetaChip>
        {item.risk ? <RiskChip risk={item.risk} /> : null}
        {item.size ? <MetaChip>size:{item.size}</MetaChip> : null}
        <MetaChip>
          asked <RelativeTime iso={item.createdAt} />
        </MetaChip>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {/* The bead itself — every control for editing, claiming or closing it already lives there,
            so this band links rather than reproducing them. */}
        <Link
          href={`/projects/${slug}/epics/${item.id}`}
          className="rounded-sm text-[13px] font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {item.title}
        </Link>
        <span className="font-mono text-[11px] text-subtle">{item.id}</span>
      </div>
      {/* The ask, not just its title: deciding whether to answer something now is deciding on what
          it actually wants. Clamped — the bead is one click away for the rest. */}
      {item.goal ? (
        <p className="line-clamp-2 text-xs text-muted-foreground" title={item.goal}>
          {item.goal}
        </p>
      ) : null}
      {item.runTarget ? (
        <p className="text-[11px] text-subtle">
          Holds{" "}
          <Link
            href={`/projects/${slug}/epics/${item.runTarget.id}`}
            className="rounded-sm font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {item.runTarget.id}
          </Link>{" "}
          — its run waits here until you close this.
        </p>
      ) : null}
    </div>
  );
}
