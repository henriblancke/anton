import { LayersIcon, TriangleAlertIcon } from "lucide-react";

import {
  DIMENSION_CAUTIONS,
  MIN_COHORT,
  cohortDimension,
  type Cohort,
  type CohortSeries,
} from "@/lib/prompt-series";
import { SPEND_WINDOWS, type SpendWindow } from "@/lib/spend-breakdown";
import { CohortTable } from "./cohort-table";

/**
 * Project → Cohorts (anton-yp9tl): did the prompt, agent or skill change make anton better?
 *
 * ## The empty state is the headline case, not the edge case
 *
 * anton delivers a handful of features a week, and {@link MIN_COHORT} is five — so "not enough data
 * yet" is the honest reading of this page most of the time, and it is the one the page must render
 * WELL rather than apologise for. A view that rendered a blank panel there would read as "this
 * feature is broken"; what an operator actually needs is what has to accrue before the comparison
 * exists, which is a number they can count toward. So {@link NothingToCompare} names the floor, and
 * `spend-view.tsx`'s rule about never rendering an absence as a zero applies to a whole cohort here,
 * not just to a dollar figure.
 *
 * ## The guardrails are rendered, not merely respected
 *
 * `prompt-series.ts` makes the floor a TYPE — an underpowered cohort carries no `deltas` field at all
 * — so this view cannot draw an arrow it should not. But not drawing one is only half the job: a row
 * that silently omitted its arrow would be indistinguishable from a cohort that genuinely did not
 * move. So an underpowered row states its shortfall in place of the verdict, and a mixed-version row
 * wears its flag beside the key. The data layer prevents the lie; this layer says why the answer is
 * missing.
 *
 * A table, deliberately, and no charting library (ticket §out of scope). The question is comparative
 * across four metrics at once — cost, review rounds, touches, escalations — which is rows against
 * columns, and it is the same reasoning `spend-table.tsx` gives for its own shape. This surface
 * follows that table's idioms (mono numerals, `tabular-nums`, the qualifying counts on the label's
 * sub-line) so anton's measurement pages read as one product.
 *
 * Presentational and server-renderable: it takes a folded {@link CohortSeries} and adds no state, so
 * the page that will host it stays a Server Component the way `spend-view.tsx` does. The dimension
 * and window selectors belong to that page — they are query bounds on the fold, not view state.
 */
export function CohortView({
  window,
  series,
}: {
  /** Which window the series was folded over — named so the empty state can point at a wider one. */
  window: SpendWindow;
  series: CohortSeries;
}) {
  const dimension = cohortDimension(series.dimension);
  const windowLabel =
    SPEND_WINDOWS.find((option) => option.value === window)?.label.toLowerCase() ?? "this window";
  const caution = DIMENSION_CAUTIONS[series.dimension];
  const comparable = series.cohorts.filter((cohort) => cohort.comparable).length;

  return (
    <div className="flex flex-col gap-4">
      {series.cohorts.length > 0 ? (
        <>
          <CohortSummary
            cohorts={series.cohorts}
            comparable={comparable}
            windowLabel={windowLabel}
            dimensionLabel={dimension?.label ?? series.dimension}
          />

          {/* Before the numbers, never after: a caution read below the table is read after the
              conclusion it was supposed to qualify. */}
          {caution ? (
            <p
              role="status"
              className="flex gap-1.5 rounded-lg border border-risk-med/30 bg-risk-med/5 px-3 py-2 text-[11px] leading-relaxed text-risk-med"
            >
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              <span>{caution}</span>
            </p>
          ) : null}

          <CohortTable
            cohorts={series.cohorts}
            heading={dimension?.heading ?? "Key"}
          />
        </>
      ) : (
        <NothingToCompare
          windowLabel={windowLabel}
          allTime={window === "all"}
          dimensionLabel={dimension?.label ?? series.dimension}
        />
      )}
    </div>
  );
}

/**
 * What the series adds up to, and — more importantly — how much of it may be read as a verdict.
 *
 * `Comparable` sits beside `Cohorts` because the difference between the two is the page's actual
 * state: four cohorts of which none cleared the floor looks identical to four cohorts of which all
 * did, until this number says otherwise.
 */
function CohortSummary({
  cohorts,
  comparable,
  windowLabel,
  dimensionLabel,
}: {
  cohorts: Cohort[];
  comparable: number;
  windowLabel: string;
  dimensionLabel: string;
}) {
  const delivered = cohorts.reduce((sum, cohort) => sum + cohort.n, 0);
  const mixed = cohorts.filter((cohort) => cohort.versions.mixed).length;

  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-border bg-card/40 px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <Stat
          label="Cohorts"
          value={String(cohorts.length)}
          hint={`Distinct ${dimensionLabel} values that delivered a feature ${windowLabel}`}
        />
        <Stat
          label="Delivered"
          value={String(delivered)}
          hint={`${delivered} delivered feature${delivered === 1 ? "" : "s"} across every cohort — only deliveries count toward the floor`}
        />
        <Stat
          label="Comparable"
          value={`${comparable} of ${cohorts.length}`}
          hint={`Cohorts at or above n=${MIN_COHORT}, the floor below which anton reports no verdict`}
        />
      </div>

      {/* The floor stated before the table, so a page full of dashes reads as a deliberate refusal
          rather than as missing data. */}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <LayersIcon className="size-3" aria-hidden="true" />
          Grouped by {dimensionLabel}
        </span>{" "}
        — every figure is a per-delivered-feature average, and abandoned and failed runs stay in the
        numerator. A cohort under n={MIN_COHORT} reports its size and no verdict: the floor is what
        may be <em>shown</em>, not a significance test, and clearing it does not make a move
        significant.
      </p>

      {comparable < 2 && cohorts.length > 1 ? (
        <p role="status" className="text-[11px] leading-relaxed text-risk-med">
          {comparable === 0
            ? `No cohort has reached n=${MIN_COHORT} yet, so nothing here carries a verdict — the figures are real measurements, but none of them may be read as a move.`
            : `Only one cohort has reached n=${MIN_COHORT}, and a move needs two: a comparison is only as sound as its weaker side, so a delta against an underpowered predecessor is not shown at all.`}
        </p>
      ) : null}

      {mixed > 0 ? (
        <p role="status" className="text-[11px] leading-relaxed text-risk-med">
          {mixed} of {cohorts.length} cohort{cohorts.length === 1 ? "" : "s"} span more than one anton
          version, so whatever moved there moved for at least two candidate reasons. Their figures
          stand; the attribution does not.
        </p>
      ) : null}
    </section>
  );
}

/** One headline figure. `tabular-nums` so the row does not reflow as the dimension changes. */
function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9.5px] tracking-[0.11em] text-subtle uppercase">{label}</span>
      <span className="font-mono text-[17px] tabular-nums text-foreground" title={hint}>
        {value}
      </span>
    </div>
  );
}

/**
 * No cohorts at all (ticket §acceptance): what has to ACCRUE, rather than an empty panel.
 *
 * This is the state anton is in most of the time, so it says three separate things an operator can
 * act on — that deliveries are the unit, how many of them a verdict needs, and that two cohorts are
 * needed for a comparison rather than one. A narrower window at least has a wider one to try, which
 * is the one case where the fix is on this page.
 */
function NothingToCompare({
  windowLabel,
  allTime,
  dimensionLabel,
}: {
  windowLabel: string;
  allTime: boolean;
  dimensionLabel: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl border border-dashed border-border">
        <LayersIcon className="size-5 text-subtle" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold">
          No cohorts to compare {allTime ? "yet" : windowLabel}
        </p>
        <p className="max-w-md text-xs leading-relaxed text-subtle">
          {allTime
            ? `A cohort is the delivered features that ran under one ${dimensionLabel}, so this comparison accrues as features are DELIVERED — a run in flight, parked or abandoned contributes nothing to it.`
            : `Nothing was delivered in this window, so there is no cohort to group. That is an empty comparison, not a flat one — try a wider window.`}
        </p>
        <ul className="mx-auto flex max-w-md flex-col gap-1 text-left text-[11px] leading-relaxed text-subtle">
          <li className="flex gap-1.5">
            <span aria-hidden="true">·</span>
            <span>
              <span className="font-medium text-muted-foreground">
                {MIN_COHORT} delivered features
              </span>{" "}
              under one {dimensionLabel} before that cohort may carry a verdict.
            </span>
          </li>
          <li className="flex gap-1.5">
            <span aria-hidden="true">·</span>
            <span>
              <span className="font-medium text-muted-foreground">Two such cohorts</span> before
              anything can be compared — the first has nothing to move against.
            </span>
          </li>
          <li className="flex gap-1.5">
            <span aria-hidden="true">·</span>
            <span>
              Until then anton shows each cohort&rsquo;s <span className="font-mono">n</span> and its
              figures, and draws no arrow.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
