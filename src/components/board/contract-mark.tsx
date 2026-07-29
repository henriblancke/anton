/**
 * How a run target's bead contract reads on the board (anton-gyed).
 *
 * The gap is cheap to fix before Approve and expensive after it: without Acceptance the run has no
 * definition of done, so approval refuses it. Both marks below derive from `item.contract` — the
 * SAME validator (lib/beads/contract.ts) the approve route and the runner judge with — so the board
 * can never advertise as approvable a bead approval would reject.
 *
 * Severity is the whole point of the split: blocking reads as an error that withholds the run,
 * advisory as a nudge that never stands in the way.
 */
import { CircleAlertIcon, PencilLineIcon } from "lucide-react";

import type { ContractStatus, ContractViolation } from "@/lib/types";
import { MetaChip } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The gaps as a hover/screen-reader sentence — one clause per missing piece, fix included. */
function reasonOf(violations: ContractViolation[]): string {
  return violations.map((v) => v.message).join("; ");
}

/** The missing pieces, deduped: a target and two of its tickets can all lack Acceptance, and
 * "needs Acceptance + Acceptance" names the same fix twice. The reason sentence still lists each. */
function sectionsOf(violations: ContractViolation[]): string {
  return [...new Set(violations.map((v) => v.section))].join(" + ");
}

/**
 * The contract marks for a card or chip: what blocks the run (red, named) and what merely thins it
 * (grey, counted). Both render when both apply — the founder fixes the blocker to run at all and the
 * nudge to run well. Renders nothing for a conformant or never-judged bead.
 */
export function ContractChip({
  contract,
  className,
}: {
  contract?: ContractStatus;
  className?: string;
}) {
  if (!contract) return null;
  const { blocking, advisory } = contract;
  if (blocking.length === 0 && advisory.length === 0) return null;
  return (
    <>
      {blocking.length > 0 && (
        <MetaChip tone="risk-high" className={className}>
          <CircleAlertIcon className="size-2.5" aria-hidden="true" />
          <span title={`Can't run as shaped — ${reasonOf(blocking)}`}>
            needs {sectionsOf(blocking)}
          </span>
        </MetaChip>
      )}
      {advisory.length > 0 && (
        <MetaChip className={className}>
          <PencilLineIcon className="size-2.5" aria-hidden="true" />
          <span title={`Runs as shaped, but thinner than it could be — ${reasonOf(advisory)}`}>
            {advisory.length === 1 ? "1 spec gap" : `${advisory.length} spec gaps`}
          </span>
        </MetaChip>
      )}
    </>
  );
}

/**
 * The Approve affordance for a target the contract blocks: kept in place, inert, and saying what is
 * missing — a click that 422s teaches nothing, a button that names the missing section does. The
 * title rides on the wrapper because a disabled button takes no pointer events.
 */
export function ApproveBlocked({
  violations,
  label = "Approve",
  size = "xs",
  className,
}: {
  violations: ContractViolation[];
  /** The wording the enabled button would have used ("Approve", "Approve & run", "Run feature"). */
  label?: string;
  /** Match the surface's own button scale — `xs` on a board card, `sm` in a detail header. */
  size?: "xs" | "sm";
  className?: string;
}) {
  if (violations.length === 0) return null;
  const reason = `Can't approve — ${reasonOf(violations)}`;
  return (
    <span className={cn("pointer-events-auto inline-flex", className)} title={reason}>
      <Button size={size} variant="outline" disabled aria-label={`${label}: ${reason}`}>
        <CircleAlertIcon className="text-risk-high" aria-hidden="true" />
        {label}
      </Button>
    </span>
  );
}
