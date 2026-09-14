import { CheckIcon, CircleSlashIcon } from "lucide-react";

import type { Ticket } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The marks and labels the epic detail page repeats across its sections. The columns that arrange
 * them live in epic-contract-panel.tsx and epic-graph-panel.tsx.
 */

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">{children}</span>
  );
}

/** The shipped tick — the ticket status circle and the acceptance checkbox wear the same one. */
export function DoneMark({ className }: { className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center bg-stage-done", className)}>
      <CheckIcon className="size-2 text-[#0b0a09]" strokeWidth={3} aria-hidden="true" />
    </span>
  );
}

/** The two live stages read as a ringed dot; only the tone and the implementing pulse differ. */
function RingDot({ tone, pulse = false }: { tone: "implementing" | "in-review"; pulse?: boolean }) {
  // Written out rather than interpolated — Tailwind only sees literal class names.
  const ring =
    tone === "implementing" ? "border-stage-implementing" : "border-stage-in-review";
  const fill = tone === "implementing" ? "bg-stage-implementing" : "bg-stage-in-review";
  return (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px]",
        ring,
      )}
    >
      <span className={cn("size-1.5 rounded-full", fill, pulse && "anton-pulse")} />
    </span>
  );
}

export function StatusCircle({ ticket }: { ticket: Ticket }) {
  // Checked BEFORE done: an abandoned ticket is closed, so its stage says done — the slash is what
  // keeps a dropped ticket from wearing the shipped tick.
  if (ticket.abandoned) {
    return <CircleSlashIcon className="size-3.5 shrink-0 text-subtle" aria-label="abandoned" />;
  }
  if (ticket.stage === "done") return <DoneMark className="size-3.5 rounded-full" />;
  if (ticket.stage === "implementing") return <RingDot tone="implementing" pulse />;
  if (ticket.stage === "in-review") return <RingDot tone="in-review" />;
  return <span className="size-3.5 shrink-0 rounded-full border-[1.5px] border-subtle" />;
}

export function LegendItem({
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

export function EpicDetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true" aria-label="Loading epic">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-6">
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
