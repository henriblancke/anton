import {
  COHORT_METRICS,
  MIN_COHORT,
  type Cohort,
  type CohortBasis,
  type CohortMetric,
  type CohortWindow,
  type MetricDelta,
} from "@/lib/prompt-series";
import { formatUsd } from "@/lib/spend-breakdown";
import { DISPLAY_LOCALE } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * The cohorts, as a table (anton-yp9tl): what each prompt, agent or skill actually delivered for.
 *
 * Rows because the question is comparative — an operator is not reading "this prompt cost $4.12",
 * they are reading "this prompt cost a dollar less than the last one" — and a card per cohort puts
 * the two figures being compared on different lines. The same reasoning `spend-table.tsx` gives, and
 * the same idioms, so anton's measurement surfaces read as one product. No chart: four metrics across
 * a handful of cohorts is rows against columns (ticket §out of scope).
 *
 * ## An underpowered row looks DIFFERENT from a flat one
 *
 * `prompt-series.ts` gives {@link Cohort} no `deltas` field below the floor, so this table cannot draw
 * an arrow it should not — the guardrail is a typecheck, not a condition here. What this table owns is
 * the other half: a row that merely omitted its arrow would read as "did not move", which is a
 * verdict, and the wrong one. So an underpowered row carries its shortfall where the arrows would be,
 * and its figures stay in mono grey rather than the foreground weight a verdict-bearing row gets.
 *
 * Absent figures render as a dash and never as `$0.00` or `0`, for `spend-breakdown`'s reason: an
 * unmeasured average and a genuinely-zero one are opposite facts, and the zero is the one believed.
 */
export function CohortTable({ cohorts, heading }: { cohorts: Cohort[]; heading: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-border">
            {[heading, "n", "$ / feature", "Review rounds", "Touches", "Escalations"].map(
              (label, index) => (
                <th
                  key={label}
                  scope="col"
                  className={cn(
                    "px-2.5 pb-1.5 font-mono text-[9.5px] font-normal tracking-[0.11em] whitespace-nowrap text-subtle uppercase",
                    index > 0 && "text-right",
                  )}
                >
                  {label}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <CohortRow key={cohort.key ?? "__unstamped__"} cohort={cohort} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One cohort's row: what identifies it, how big it is, and its four averages — with a delta under
 * each one only where the cohort earned the right to claim a move.
 */
function CohortRow({ cohort }: { cohort: Cohort }) {
  const deltas = cohort.comparable ? cohort.deltas : [];
  const byMetric = new Map(deltas.map((delta) => [delta.metric, delta]));

  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <td className="px-2.5 py-2 align-top">
        <div className="flex min-w-0 flex-col gap-1">
          <CohortKey cohort={cohort} />
          <span className="font-mono text-[10px] leading-relaxed text-subtle">
            {cohort.window ? formatCohortWindow(cohort.window) : "no delivery time recorded"}
          </span>
          {cohort.versions.mixed ? <MixedVersionFlag cohort={cohort} /> : null}
        </div>
      </td>

      {/* The n sits beside the key rather than only in the sub-line: below the floor it IS the
          answer, so it gets a column of its own on every row. */}
      <td className="px-2.5 py-2 text-right align-top whitespace-nowrap">
        <span className="font-mono text-[12px] tabular-nums text-foreground">{cohort.n}</span>
        {cohort.comparable ? null : (
          <span className="block font-mono text-[9.5px] leading-relaxed text-risk-med">
            +{cohort.shortfall} to compare
          </span>
        )}
      </td>

      {COHORT_METRICS.map((metric) => (
        <MetricCell
          key={metric}
          metric={metric}
          value={cohort.metrics[metric]}
          delta={byMetric.get(metric)}
          comparable={cohort.comparable}
          unpricedFeatures={metric === "usdPerFeature" ? cohort.basis.unpricedFeatures : 0}
        />
      ))}
    </tr>
  );
}

/**
 * What names the cohort — or the fact that nothing did.
 *
 * A `null` key is the PRE-INSTRUMENTATION cohort: real deliveries that recorded no stamp, kept as
 * their own group rather than folded into a named one. It is labelled rather than rendered as an empty
 * cell, because an unlabelled blank in the identity column reads as a rendering bug.
 */
function CohortKey({ cohort }: { cohort: Cohort }) {
  if (cohort.key === null) {
    return (
      <span
        className="text-[12px] italic text-muted-foreground"
        title="Delivered features that recorded no stamp on this dimension — work that predates the instrumentation. Its own cohort, because mixing it into a named one would credit that name with deliveries it never produced."
      >
        Unstamped
      </span>
    );
  }
  return (
    <span className="truncate font-mono text-[12px] text-foreground" title={cohort.key}>
      {cohort.key}
    </span>
  );
}

/**
 * The flag a cohort spanning two antons must wear (anton-0itcy).
 *
 * On the row rather than in a page-level banner, because the reader is looking at one cohort's numbers
 * when they need it — and unlike the floor, this does NOT suppress the figures: a mixed cohort has
 * measured plenty, it simply cannot attribute what it measured. Suppressing it would throw away a real
 * finding; flagging it hands the reader an ambiguity only they can resolve.
 */
function MixedVersionFlag({ cohort }: { cohort: Cohort }) {
  const { versions, unstamped } = cohort.versions;
  const named = versions.length > 0 ? versions.join(", ") : "none recorded";

  return (
    <span
      role="status"
      className="inline-flex w-fit items-center gap-1 rounded border border-risk-med/40 bg-risk-med/10 px-1.5 py-0.5 font-mono text-[9.5px] leading-none text-risk-med"
      title={`This cohort's deliveries ran under more than one anton, so anything that moved here moved for at least two candidate reasons: ${named}${unstamped > 0 ? `, plus ${unstamped} delivery/deliveries that recorded no version` : ""}. The figures stand; the attribution does not.`}
    >
      mixed anton versions
      <span className="font-normal opacity-80">
        {versions.slice(0, 2).join(" · ") || "unversioned"}
        {versions.length > 2 ? ` +${versions.length - 2}` : ""}
        {unstamped > 0 ? ` · ${unstamped} unstamped` : ""}
      </span>
    </span>
  );
}

const METRIC_FORMAT = new Intl.NumberFormat(DISPLAY_LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * One metric's average, with its move under it where there is one to show.
 *
 * Four states for `usdPerFeature`, kept apart on purpose: a figure with a verdict, a figure without
 * one (either the cohort is underpowered or there was no comparable baseline to subtract), a figure
 * that is only a FLOOR because {@link CohortBasis.unpricedFeatures} is non-zero, and no figure at
 * all — a dash, because a cohort anton could price none of has no `$ / feature`, which
 * `spend-breakdown`'s rule says is reported as missing and never as `0`. A cohort partly priced is
 * neither of the extremes: rendering its average as an ordinary, complete-looking number is exactly
 * the failure `spend-table.tsx` refuses for its own groups — a partial figure that reads as a total.
 */
function MetricCell({
  metric,
  value,
  delta,
  comparable,
  unpricedFeatures = 0,
}: {
  metric: CohortMetric;
  value: number | undefined;
  delta: MetricDelta | undefined;
  comparable: boolean;
  /** Only meaningful for `usdPerFeature` — see {@link CohortBasis.unpricedFeatures}. */
  unpricedFeatures?: CohortBasis["unpricedFeatures"];
}) {
  const partial = metric === "usdPerFeature" && value !== undefined && unpricedFeatures > 0;

  return (
    <td className="px-2.5 py-2 text-right align-top whitespace-nowrap">
      {value === undefined ? (
        <span
          className="font-mono text-[11.5px] text-subtle"
          title={
            metric === "usdPerFeature"
              ? "anton could price none of this cohort's rows, so it has no cost per feature. Unpriced, not free."
              : "This cohort recorded nothing for this metric."
          }
        >
          —
        </span>
      ) : (
        <span
          className={cn(
            "font-mono text-[12px] tabular-nums",
            comparable && !partial ? "text-foreground" : "text-muted-foreground",
          )}
          title={
            partial
              ? `At least this — anton could not price ${unpricedFeatures} of this cohort's features. Unpriced, not free, so the average is a floor.`
              : undefined
          }
        >
          {metric === "usdPerFeature" ? formatUsd(value) : METRIC_FORMAT.format(value)}
          {partial ? <span className="text-subtle"> +</span> : null}
        </span>
      )}
      {delta ? <DeltaBadge delta={delta} metric={metric} /> : null}
    </td>
  );
}

const DIRECTION_ARROW: Readonly<Record<MetricDelta["direction"], string>> = {
  better: "↓",
  worse: "↑",
  flat: "→",
};

const DIRECTION_CLASS: Readonly<Record<MetricDelta["direction"], string>> = {
  better: "text-usage-ok",
  worse: "text-risk-med",
  flat: "text-subtle",
};

/**
 * The arrow, and the number under it.
 *
 * The magnitude rides beside the arrow rather than behind a hover, because an arrow alone invites the
 * reader to supply their own magnitude — and the move being trivial is exactly what a bare arrow
 * hides. `prompt-series.ts` draws no noise band for the same reason.
 *
 * The percentage is omitted where the baseline was 0: a fall from zero has no percentage, and
 * rendering one as `∞` or `100%` would invent a figure. The absolute delta is always there.
 */
function DeltaBadge({ delta, metric }: { delta: MetricDelta; metric: CohortMetric }) {
  const magnitude = Math.abs(delta.delta);
  const formatted =
    metric === "usdPerFeature" ? formatUsd(magnitude) : METRIC_FORMAT.format(magnitude);
  const percent =
    delta.ratio === undefined ? undefined : `${Math.abs(Math.round(delta.ratio * 100))}%`;

  return (
    <span
      className={cn(
        "block font-mono text-[10px] tabular-nums leading-relaxed",
        DIRECTION_CLASS[delta.direction],
      )}
      title={`${formatted} ${delta.direction === "flat" ? "unchanged" : delta.direction} than the previous comparable cohort (${metric === "usdPerFeature" ? formatUsd(delta.baseline) : METRIC_FORMAT.format(delta.baseline)}). Shown because both cohorts cleared n=${MIN_COHORT} — a floor on what may be shown, not a significance test.`}
    >
      <span aria-hidden="true">{DIRECTION_ARROW[delta.direction]}</span>{" "}
      <span className="sr-only">{delta.direction} by </span>
      {delta.direction === "flat" ? "no change" : formatted}
      {percent && delta.direction !== "flat" ? ` · ${percent}` : ""}
    </span>
  );
}

const WINDOW_FORMAT = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  month: "short",
  day: "numeric",
});

const WINDOW_FORMAT_WITH_YEAR = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * The span the cohort's averages are averages OVER — "Aug 2 – Sep 4", per the design's sketch.
 *
 * A single-day cohort renders one date rather than "Sep 4 – Sep 4", which reads as a formatting
 * failure. The year is included whenever either endpoint isn't in the CURRENT calendar year, not just
 * when the two endpoints disagree with each other (PR #331 review) — the "all" window has no fixed
 * length, so a cohort can span "Dec 20 – Jan 5" (needs a year or it reads as reversed) or sit entirely
 * within one past year like "Aug 2 – Sep 4, 2024" (needs a year or it reads as this year). A
 * recent-window cohort never leaves the current year, so it keeps the terser, year-free form.
 */
function formatCohortWindow(window: CohortWindow): string {
  const firstDate = new Date(window.firstDeliveryMs);
  const lastDate = new Date(window.lastDeliveryMs);
  const currentYear = new Date().getFullYear();
  const sameYear =
    firstDate.getFullYear() === lastDate.getFullYear() && firstDate.getFullYear() === currentYear;
  const format = sameYear ? WINDOW_FORMAT : WINDOW_FORMAT_WITH_YEAR;
  const first = format.format(firstDate);
  const last = format.format(lastDate);
  return first === last ? first : `${first} – ${last}`;
}
