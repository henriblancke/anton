import { GaugeIcon } from "lucide-react";

import {
  formatExactTokens,
  formatTokens,
  formatUsd,
  SPEND_WINDOWS,
  type SpendBreakdown,
  type SpendWindow,
} from "@/lib/spend-breakdown";
import type { DivergenceSummary } from "@/lib/model-divergence";
import { PRICES_AS_OF } from "@/lib/model-pricing";
import { SpendWindowTabs } from "./spend-window-tabs";
import { SpendTable } from "./spend-table";

/**
 * Project → Spend (anton-1kdm): where the money and the tokens went, by model and by task.
 *
 * The page's whole claim is that these figures are MEASURED — derived from the token counts each
 * result event reported, at prices anton states — and it is the reason nothing here carries the `≈`
 * marker the quota-share panel carries. That panel's numbers are sampled attribution and stay
 * approximations; these are a ledger. A page that marked both the same way would leave an operator
 * unable to tell which one they could reconcile against a bill, which is the entire point of having
 * recorded any of it.
 *
 * Both breakdowns are folds of the same rows over the same window, so their totals agree by
 * construction — see `spendBreakdowns`, which reads once for exactly that reason.
 */
export function SpendView({
  slug,
  window,
  model,
  task,
  divergence,
}: {
  slug: string;
  window: SpendWindow;
  model: SpendBreakdown;
  task: SpendBreakdown;
  divergence: DivergenceSummary;
}) {
  const windowLabel =
    SPEND_WINDOWS.find((option) => option.value === window)?.label.toLowerCase() ?? "this window";

  return (
    <div className="flex flex-col gap-4">
      <SpendWindowTabs slug={slug} window={window} />

      {model.recorded ? (
        <>
          <SpendSummary breakdown={model} windowLabel={windowLabel} divergence={divergence} />

          <div className="flex flex-col gap-4 min-[1100px]:flex-row min-[1100px]:items-start">
            <SpendSection
              title="By model"
              hint="What each model was actually served for, at anton's own prices."
              className="min-w-0 flex-1"
            >
              <SpendTable
                breakdown={model}
                caption="Model"
                emptyLabel="No calls recorded in this window."
              />
            </SpendSection>

            <SpendSection
              title="By task"
              hint="The pipeline step that spent it, or the job type for passes outside the ticket pipeline."
              className="min-w-0 flex-1"
            >
              <SpendTable
                breakdown={task}
                caption="Task"
                emptyLabel="No calls recorded in this window."
              />
            </SpendSection>
          </div>
        </>
      ) : (
        <NothingRecorded windowLabel={windowLabel} allTime={window === "all"} />
      )}
    </div>
  );
}

/**
 * The window's headline: what it cost, what it consumed, and what the figure does NOT cover.
 *
 * The unpriced remainder sits beside the total rather than under it, because a total that hides it
 * reads as complete when it is partial — and a routed project is exactly the case where that
 * difference decides whether the number means anything.
 */
function SpendSummary({
  breakdown,
  windowLabel,
  divergence,
}: {
  breakdown: SpendBreakdown;
  windowLabel: string;
  divergence: DivergenceSummary;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-border bg-card/40 px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <Stat
          label="Cost"
          value={formatUsd(breakdown.usd)}
          hint={
            breakdown.usd === undefined
              ? "No call in this window used a model anton has a price for."
              : `Derived from measured tokens · prices as of ${PRICES_AS_OF}`
          }
        />
        <Stat
          label="Tokens"
          value={formatTokens(breakdown.tokens.total)}
          hint={`${formatExactTokens(breakdown.tokens.total)} in + out + cache, ${windowLabel}`}
        />
        <Stat
          label="Cache read"
          value={formatTokens(breakdown.tokens.cacheRead)}
          hint="Billed at the cache-read rate, an order of magnitude below fresh input."
        />
        <Stat
          label="Calls"
          value={String(divergence.invocations)}
          hint={`${breakdown.rows} recorded row${breakdown.rows === 1 ? "" : "s"} across ${divergence.invocations} invocation${divergence.invocations === 1 ? "" : "s"}`}
        />
      </div>

      {/* The line that separates this page from the quota-share panel. Load-bearing, not decoration:
          without it an operator has no way to know which of the two numbers is reconcilable. */}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <GaugeIcon className="size-3" aria-hidden="true" />
          Measured, not sampled
        </span>{" "}
        — every figure here comes from the token counts each call reported, priced from anton&rsquo;s
        own table. Unlike the quota shares in Settings, none of it is an estimate, so none of it is
        marked <span className="font-mono">≈</span>.
      </p>

      {breakdown.unpriced > 0 && (
        <p role="status" className="text-[11px] leading-relaxed text-risk-med">
          {breakdown.unpriced} of {breakdown.rows} row{breakdown.rows === 1 ? "" : "s"} could not be
          priced, so the cost above is a floor rather than a total
          {breakdown.unpricedModels.length > 0 ? (
            <>
              {" "}
              — no price for{" "}
              <span className="font-mono">{breakdown.unpricedModels.join(", ")}</span>. Their tokens
              are counted; their dollars are not, and they are not free.
            </>
          ) : (
            " — those calls reported no usage at all, so there is nothing to price."
          )}
        </p>
      )}

      {/* A per-model figure attributed to a model that did not serve the call is worse than no
          figure, and it is not a question anyone thinks to ask before reading the table. */}
      {divergence.diverged > 0 && (
        <p role="status" className="text-[11px] leading-relaxed text-risk-med">
          {divergence.diverged} of {divergence.invocations} call
          {divergence.invocations === 1 ? "" : "s"} were served by a model other than the one anton
          asked for, so the per-model split below is what ANSWERED, not what was requested:{" "}
          {divergence.substitutions
            .slice(0, 3)
            .map((swap) => `${swap.requested} → ${swap.served.join(", ")}`)
            .join(" · ")}
        </p>
      )}
    </section>
  );
}

/** One headline figure. `tabular-nums` so the row does not reflow as the window changes. */
function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9.5px] tracking-[0.11em] text-subtle uppercase">
        {label}
      </span>
      <span className="font-mono text-[17px] tabular-nums text-foreground" title={hint}>
        {value}
      </span>
    </div>
  );
}

function SpendSection({
  title,
  hint,
  className,
  children,
}: {
  title: string;
  hint: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <div className="flex flex-col gap-0.5 pb-2">
        <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
        <p className="text-[11px] text-subtle">{hint}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * A project with nothing recorded in the window (anton-1kdm).
 *
 * It reads as EMPTY, never as `$0.00`. "Nothing has been measured here" and "this cost nothing" are
 * opposite facts about a project, and a zero is the one that gets believed — an operator who reads
 * `$0.00` concludes the runs were free rather than that the meter has not seen them. The all-time
 * case says so outright, since a narrower window at least has a wider one to try.
 */
function NothingRecorded({ windowLabel, allTime }: { windowLabel: string; allTime: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl border border-dashed border-border">
        <GaugeIcon className="size-5 text-subtle" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold">No calls recorded {allTime ? "yet" : windowLabel}</p>
        <p className="max-w-sm text-xs leading-relaxed text-subtle">
          {allTime
            ? "anton meters every claude invocation it dispatches, and none has been recorded for this project. That is an empty ledger, not zero spend — nothing has been measured here yet."
            : "Nothing was metered in this window. That is an empty ledger, not zero spend — try a wider window."}
        </p>
      </div>
    </div>
  );
}
