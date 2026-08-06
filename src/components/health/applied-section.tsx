import { hasAppliedActions } from "@/lib/attention";
import type { HygieneReport } from "@/lib/types";
import { HealthBeadLink } from "./bead-link";

/**
 * What the patrol CHANGED on its own authority this pass — as opposed to what it found and left for
 * a human (that's "Worth a look"/"Housekeeping"). A count of what changed is not a report an operator
 * can act on, so this names the epics it closed rather than just how many.
 *
 * The board used to carry this as a line in its attention strip; the health-page split (anton-4qf3)
 * left the board with escalations alone, so this section is now the only place the patrol's own
 * writes are reported. If it doesn't say a bead changed under the operator, nothing does.
 *
 * Renders nothing when the patrol neither closed anything nor repaired a blocked row — "applied
 * nothing" is not worth a panel of its own.
 */
export function AppliedSection({ hygiene }: { hygiene: HygieneReport | undefined }) {
  if (!hygiene || !hasAppliedActions(hygiene)) return null;
  const { closedEpics, rowsRecomputed } = hygiene.actions;

  return (
    <section
      aria-labelledby="applied-heading"
      className="rounded-xl border border-border bg-card/60 text-xs"
    >
      <div className="border-b border-border/60 px-3 py-2">
        <h2 id="applied-heading" className="text-xs font-medium text-foreground">
          Applied this pass
        </h2>
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5 text-xs text-muted-foreground">
        {closedEpics.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-foreground">Applied</span>
            <span>every child was closed, so the patrol closed:</span>
            {closedEpics.map((id) => (
              <HealthBeadLink key={id} id={id} />
            ))}
          </div>
        ) : null}
        {rowsRecomputed > 0 ? (
          <p
            title={`The patrol rebuilt ${rowsRecomputed} stale is_blocked row(s) from the dependency graph — bd ready trusts that flag.`}
          >
            repaired {rowsRecomputed} blocked {rowsRecomputed === 1 ? "row" : "rows"}
          </p>
        ) : null}
      </div>
    </section>
  );
}
