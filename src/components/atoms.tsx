import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { Stage } from "@/lib/types";
import { STAGE_ACCENT_DOT, STAGE_LABELS, STAGE_TEXT, agentDotClass } from "@/components/board/board-utils";

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

/** Agent chip — mono label with the agent's stable hue as a leading dot. */
export function AgentChip({ agent, className }: { agent: string; className?: string }) {
  return (
    <MetaChip dotClass={agentDotClass(agent)} className={className}>
      {agent}
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

/** Stage dot + label used in column headers and inline. */
export function StageDotLabel({
  stage,
  count,
  className,
}: {
  stage: Stage;
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span
        className={cn(
          "size-2.5 rounded-full",
          STAGE_ACCENT_DOT[stage],
          stage === "implementing" && "anton-pulse",
        )}
        aria-hidden="true"
      />
      <span className={cn("text-sm font-medium", STAGE_TEXT[stage])}>{STAGE_LABELS[stage]}</span>
      {count !== undefined && (
        <span className="ml-auto rounded-full bg-card px-2 py-0.5 font-mono text-[11px] text-subtle">
          {count}
        </span>
      )}
    </div>
  );
}
