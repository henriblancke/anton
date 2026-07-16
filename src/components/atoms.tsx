import type { ReactNode } from "react";
import { LockIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Stage } from "@/lib/types";
import { formatExactTime, formatRelativeTime } from "@/lib/time";
import { STAGE_ACCENT_DOT, STAGE_LABELS } from "@/components/board/board-utils";

type ChipTone = "neutral" | "risk-high" | "risk-med" | "blocked" | "pr" | "done";

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: "border-border bg-secondary text-muted-foreground",
  "risk-high": "border-risk-high/30 bg-risk-high/10 text-risk-high",
  "risk-med": "border-risk-med/28 bg-risk-med/10 text-risk-med",
  blocked: "border-blocked/30 bg-blocked/10 text-blocked",
  pr: "border-stage-in-review/30 bg-stage-in-review/10 text-stage-in-review",
  done: "border-stage-done/30 bg-stage-done/10 text-stage-done",
};

/** A compact monospace metadata chip (agent / risk / size / PR), matching the design's
 * `Geist Mono 10–11px` label chips. Optionally shows a leading colored dot. */
export function MetaChip({
  tone = "neutral",
  dotClass,
  dotPulse = false,
  className,
  children,
}: {
  tone?: ChipTone;
  dotClass?: string;
  dotPulse?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] leading-none whitespace-nowrap",
        CHIP_TONE[tone],
        className,
      )}
    >
      {dotClass && (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", dotClass, dotPulse && "anton-pulse")}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

/**
 * Wraps a PR chip in a new-tab link when a URL is known, otherwise renders the chip inert. Safe
 * inside clickable cards/rows: `pointer-events-auto` + `stopPropagation` keep the click on the link
 * (opening the PR) instead of bubbling to a parent card link. `href` comes from an entity's `prUrl`.
 */
export function PrLink({
  href,
  className,
  children,
}: {
  href?: string;
  className?: string;
  children: ReactNode;
}) {
  if (!href) {
    return className ? <span className={className}>{children}</span> : <>{children}</>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn("pointer-events-auto focus-visible:outline-none", className)}
      title="Open pull request"
    >
      {children}
    </a>
  );
}

/** "blocked by <id>" chip — marks a run target (epic or standalone) the runtime's bd-ready won't
 * pick up yet. Shows the first open blocker with a "+N" when there are several; the full list rides
 * in the title. Renders nothing when there are no open blockers. */
export function BlockedChip({ blockedBy }: { blockedBy: string[] }) {
  if (blockedBy.length === 0) return null;
  const [first, ...rest] = blockedBy;
  const label = rest.length > 0 ? `blocked by ${first} +${rest.length}` : `blocked by ${first}`;
  return (
    <MetaChip tone="blocked">
      <LockIcon className="size-2.5" aria-hidden="true" />
      <span title={`blocked by ${blockedBy.join(", ")}`}>{label}</span>
    </MetaChip>
  );
}

/** Risk chip — tinted by severity. */
export function RiskChip({ risk, className }: { risk: string; className?: string }) {
  const tone: ChipTone = risk === "high" ? "risk-high" : risk === "med" ? "risk-med" : "neutral";
  return (
    <MetaChip tone={tone} className={className}>
      risk:{risk}
    </MetaChip>
  );
}

/** The rounded stage pill (dot + label), tinted by stage. Used in headers/detail. */
export function StagePill({ stage, className }: { stage: Stage; className?: string }) {
  const tinted: Record<Stage, string> = {
    backlog: "border-stage-backlog/28 bg-stage-backlog/10 text-stage-backlog",
    implementing: "border-stage-implementing/28 bg-stage-implementing/10 text-stage-implementing",
    "in-review": "border-stage-in-review/28 bg-stage-in-review/10 text-stage-in-review",
    done: "border-stage-done/28 bg-stage-done/10 text-stage-done",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        tinted[stage],
        className,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          STAGE_ACCENT_DOT[stage],
          stage === "implementing" && "anton-pulse",
        )}
        aria-hidden="true"
      />
      {STAGE_LABELS[stage]}
    </span>
  );
}

/** A small controlled toggle switch matching the design's 32×18 iris pill. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[18px] w-8 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        checked ? "bg-primary" : "bg-secondary",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3.5 rounded-full transition-[left]",
          checked ? "left-4 bg-primary-foreground" : "left-0.5 bg-subtle",
        )}
      />
    </button>
  );
}

/**
 * Relative "created" time ("3m ago") with the exact timestamp on hover, as a semantic `<time>`.
 * Shared by every surface that shows when a ticket/epic was created so wording never diverges.
 * Falls back to "unknown" when the timestamp is missing or unparseable.
 */
export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const relative = formatRelativeTime(iso);
  const exact = formatExactTime(iso);
  if (!relative) return <span className={className}>unknown</span>;
  return (
    <time dateTime={iso ?? undefined} title={exact ?? undefined} className={className}>
      {relative}
    </time>
  );
}
