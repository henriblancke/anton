import type { ReactNode } from "react";
import { CircleSlashIcon, GitPullRequestIcon, LockIcon, LockOpenIcon, MoonIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Stage } from "@/lib/types";
import { formatExactTime, formatRelativeTime } from "@/lib/time";
import { STAGE_ACCENT_DOT, STAGE_LABELS } from "@/components/board/board-utils";

type ChipTone = "neutral" | "risk-high" | "risk-med" | "partial" | "blocked" | "pr" | "done";

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: "border-border bg-secondary text-muted-foreground",
  "risk-high": "border-risk-high/30 bg-risk-high/10 text-risk-high",
  "risk-med": "border-risk-med/28 bg-risk-med/10 text-risk-med",
  // Amber, deliberately not the blocked rose: a partially-gated run still starts.
  partial: "border-risk-med/30 bg-risk-med/10 text-risk-med",
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
      // Collapsed to the chip it wraps for the same reason the provenance badge is: a link around a
      // chip must add no line box of its own, or it renders 24px tall around 16px of chip and drags
      // its row with it (anton-ssks).
      className={cn("pointer-events-auto inline-flex leading-none focus-visible:outline-none", className)}
      title="Open pull request"
    >
      {children}
    </a>
  );
}

/** Short PR label from a bead external-ref: `gh-218` / a URL ending in `/218` → `#218`. */
export function prLabel(ref: string): string {
  const m = /(\d+)\s*$/.exec(ref);
  return m ? `#${m[1]}` : ref;
}

/**
 * The linked-PR chip every run-target surface shows — feature card, standalone chip, ticket header,
 * PR link control. One shape so a PR reads the same wherever it appears: a new-tab link (inert
 * without a url) around a tinted meta chip. `tone` follows what the PR now means — `pr` while it is
 * under review, `done` once merged — and `icon` drops the glyph where the label already carries the
 * meaning (the done card's "merged #218").
 */
export function PrChip({
  href,
  tone = "pr",
  icon = true,
  className,
  children,
}: {
  href?: string;
  tone?: "pr" | "done";
  icon?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <PrLink href={href} className={className}>
      <MetaChip tone={tone}>
        {icon && <GitPullRequestIcon className="size-2.5" aria-hidden="true" />}
        {children}
      </MetaChip>
    </PrLink>
  );
}

/**
 * The live "working" marker a run target shows while it is implementing and has no PR yet — the one
 * place on a card that says a run is moving right now. Pulsing dot plus the word, never a chip: it
 * is a state, not metadata.
 */
export function WorkingPulse({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] text-stage-implementing",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-stage-implementing anton-pulse" aria-hidden="true" />
      working
    </span>
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

/**
 * "partially blocked · N/M ready" chip — a run target whose work is only part-held (anton-zztt). The
 * run starts on the M−N tickets nothing holds and parks the rest, so this is a progress signal, not
 * a stop: an open padlock in amber, never the blocked rose, and the card it sits on stays lit and
 * approvable. The held ticket ids ride in the title. Renders nothing once nothing is held.
 */
export function PartiallyBlockedChip({
  ready,
  total,
  held,
}: {
  ready: number;
  total: number;
  held: string[];
}) {
  if (held.length === 0) return null;
  return (
    <MetaChip tone="partial">
      <LockOpenIcon className="size-2.5" aria-hidden="true" />
      <span title={`held by a blocker outside this run: ${held.join(", ")}`}>
        {`partially blocked · ${ready}/${total} ready`}
      </span>
    </MetaChip>
  );
}

/** "snoozed" chip — a ticket deliberately deferred out of the ready queue (anton-ywi8). Reads as
 * paused rather than blocked: nothing is waiting on a dependency, a human parked it. */
export function SnoozedChip({ className }: { className?: string }) {
  return (
    <MetaChip className={className}>
      <MoonIcon className="size-2.5" aria-hidden="true" />
      <span title="Snoozed — kept out of the ready queue until un-snoozed">snoozed</span>
    </MetaChip>
  );
}

/** "abandoned" chip — a won't-do outcome (anton-6xj0). Deliberately grey and never `done`-tinted:
 * an abandoned bead is closed, so every stage derivation reads it as done — this chip is the only
 * thing standing between a dropped decision and a shipped one. */
export function AbandonedChip({ className }: { className?: string }) {
  return (
    <MetaChip className={className}>
      <CircleSlashIcon className="size-2.5" aria-hidden="true" />
      <span title="Abandoned — closed as won't-do, not delivered">abandoned</span>
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

/**
 * The project breadcrumb bar every project section renders above its tabs — `<project> / <section>`.
 * `children` is an optional trailing slot (settings hangs its unsaved-count and Save button there),
 * so a section with extra header controls no longer has to re-copy the bar and drift from the rest.
 */
export function PageHeader({
  project,
  section,
  children,
}: {
  project: string;
  section: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-6">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted-foreground">{project}</span>
        <span className="text-subtle">/</span>
        <span className="font-medium text-foreground">{section}</span>
      </div>
      {children}
    </header>
  );
}
