import { GaugeIcon, HandIcon, LayersIcon, TimerIcon } from "lucide-react";

import {
  FEATURE_PHASES,
  waitingMs,
  type LedgerFriction,
  type LedgerPhase,
  type LedgerTiming,
  type LedgerTokens,
  type LedgerTotals,
  type PhaseTotals,
} from "@/lib/feature-ledger";
import { formatExactTokens, formatTokens, formatUsd } from "@/lib/spend-breakdown";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * One feature's ledger, rendered (anton-1u6lm): what each PHASE of it cost, how long it took in the
 * three senses that differ, and how much attention it took.
 *
 * ## The phase split is the first thing on the page, because it is the answer
 *
 * "What did this feature cost" is almost never asked about the total — the total is one number an
 * operator already half-knows. What they cannot get anywhere else is the SPLIT: whether the money
 * went into making the change, into anton reviewing its own work, or into correcting a PR after it
 * opened. So the phases are rows above the total rather than a breakdown beneath it, and the total
 * sits in the footer where a table's total belongs.
 *
 * Rows, not cards, for the reason `spend-table.tsx` gives: the question is comparative, and a card
 * per phase puts the two figures being compared on different lines. This panel follows that table's
 * idioms deliberately (mono numerals, `tabular-nums`, the label's sub-line carrying the counts that
 * qualify the row) so the two spend surfaces read as one product.
 *
 * ## What could not be attributed or priced is shown, never hidden (anton-524h1)
 *
 * The fold deliberately refuses to invent numbers, and a renderer that quietly drops those refusals
 * spends the honesty without buying anything with it. So each one has a place on the page:
 *
 *  - An unpriced bucket shows its TOKENS beside an explicit `no price` marker. Never `$0.00`, and
 *    never a bare dash either — on a surface that already omits absent phases, a lone dash is
 *    indistinguishable from "nothing here", and "unpriced" and "free" are the two readings this
 *    whole feature exists to keep apart.
 *  - The unattributed remainder is a ROW IN the table, inside the total it genuinely is part of
 *    (see {@link LedgerTotals.totals}) and labelled as spend anton cannot place. Inside, because the
 *    feature really did spend it; labelled, because a row that reads as a phase would claim anton
 *    knows what it bought.
 *  - Board overhead is a line BELOW the table, outside the feature's bill entirely (design §D4) —
 *    visible and unallocated. Splitting a board-wide pass across the features it served would move
 *    real money onto work that did not spend it, and the figures would still add up afterwards,
 *    which is what makes the error unfindable. An unallocated remainder is a visible gap instead.
 *
 * ## Three durations, never merged into one
 *
 * `active` and `lead` differ by ORDERS of magnitude on any feature that parked on a usage limit —
 * ~20min worked against ~14h elapsed — and `waiting` is the difference that says whether to buy more
 * quota. Reporting one of them alone hides whichever question is being asked, so all three carry
 * their own label and their own explanation. There is deliberately no fourth "duration" figure and
 * no wall time: see `feature-ledger.ts` for why that one is absent rather than approximated.
 *
 * ## Friction is labelled as observed signals, every time it is shown
 *
 * Design §D3 accepts that these counters are a PROXY for quality and not a measure of it, on the
 * condition that no surface presents them as a score. That condition is this panel's job: the
 * section says what the numbers are before it says what they were, and no count here is summed into
 * a rating, given a colour ramp, or compared against a target.
 *
 * Nothing at any breakpoint scrolls horizontally. The phase table has no minimum width and the two
 * stat sections wrap, so a narrow viewport reflows rather than clipping figures out of reach —
 * unlike the wider `spend-table`, which can afford a scroller because it is never the whole answer.
 */
export function LedgerPanel({
  totals,
  timing,
  friction,
}: {
  totals: LedgerTotals;
  timing: LedgerTiming;
  /** The intervention counters — proxies, rendered as such. */
  friction: LedgerFriction;
}) {
  // An unrecorded scope reads as EMPTY, never as a wall of zeros: "nothing was measured here" and
  // "this cost nothing" are opposite facts, and the zero is the one that gets believed. But a job
  // cancelled (or escalated, or sent back) before its first dispatch records friction with no
  // invocation rows behind it — `totals.recorded` reflects invocation rows only, so falling back to
  // the full empty state here would hide a recorded human touch and read the feature as untouched.
  if (!totals.recorded && !frictionRecorded(friction)) return <NothingRecorded />;

  return (
    <div className="flex flex-col gap-4">
      {totals.recorded ? (
        <>
          <PhaseTable totals={totals} />
          {/* Below the table and outside its footer, because it is not this feature's bill (§D4). */}
          {totals.overhead ? <UnallocatedSection overhead={totals.overhead} /> : null}
        </>
      ) : (
        <NoCostRecorded />
      )}
      <DurationsSection timing={timing} />
      <FrictionSection friction={friction} />
    </div>
  );
}

/** Whether any friction counter recorded something — see the early return above. */
function frictionRecorded(friction: LedgerFriction): boolean {
  return (
    friction.reviewRounds > 0 ||
    friction.prFixRounds > 0 ||
    friction.escalations > 0 ||
    friction.sendBacks > 0 ||
    friction.cancels > 0 ||
    friction.quotaParks > 0 ||
    friction.failureParks > 0
  );
}

/** The phases that recorded something, in pipeline order. Absent phases are omitted, not zeroed. */
function recordedPhases(totals: LedgerTotals): [LedgerPhase, PhaseTotals][] {
  return FEATURE_PHASES.flatMap((phase) => {
    const bucket = totals.phases.get(phase);
    return bucket ? [[phase, bucket] as [LedgerPhase, PhaseTotals]] : [];
  });
}

/**
 * What the tokens column shows.
 *
 * `thinking` is deliberately NOT added: it is a subset of `output` (see {@link LedgerTokens}), so
 * including it would double-count every thinking model's reasoning. The fold publishes no `total`
 * field precisely so this choice is made once, in the one place that displays it.
 */
function totalTokens(tokens: LedgerTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

const PHASE_LABELS: Readonly<Record<LedgerPhase, string>> = {
  implement: "Implement",
  "self-review": "Self-review",
  describe: "Describe",
  "pr-fix": "PR fix",
  overhead: "Overhead",
};

const PHASE_HINTS: Readonly<Record<LedgerPhase, string>> = {
  implement: "Making the change: the formula's implement, verify, commit and PR steps.",
  "self-review": "anton reviewing its own diff before the PR opened.",
  describe: "Writing the PR description from the finished diff.",
  "pr-fix": "Correcting the work after its PR opened, on review feedback or red CI.",
  overhead: "A scheduled pass serving the whole board — never billed to one feature.",
};

/** The phase split, with the feature's own bill in the footer. */
function PhaseTable({ totals }: { totals: LedgerTotals }) {
  const phases = recordedPhases(totals);

  return (
    <section aria-label="By phase" className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[13px] font-medium text-foreground">By phase</h2>
        <p className="text-[11px] text-subtle">
          Where the work went: making the change, reviewing it, describing it, correcting it.
        </p>
      </div>

      {/* No `min-w-*` and no scroller: this table is the answer, so it must reflow rather than
          clip its right-hand columns out of reach on a narrow viewport. */}
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border">
            {["Phase", "Tokens", "Cost", "Active"].map((heading, index) => (
              <th
                key={heading}
                scope="col"
                className={cn(
                  "px-1.5 pb-1.5 font-mono text-[9.5px] font-normal tracking-[0.11em] whitespace-nowrap text-subtle uppercase sm:px-2.5",
                  index > 0 && "text-right",
                )}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {phases.map(([phase, bucket]) => (
            <PhaseRow key={phase} phase={phase} bucket={bucket} />
          ))}
          {/* Last, after the phases it could not be placed among — and only when there is some. */}
          {totals.unattributed ? <UnattributedRow bucket={totals.unattributed} /> : null}
        </tbody>
        <tfoot>
          <tr className="border-t border-border">
            <th scope="row" className="px-1.5 pt-2 text-left text-[12px] font-medium sm:px-2.5">
              Total
              <span
                aria-hidden="true"
                className="block font-mono text-[10px] font-normal text-subtle"
              >
                this feature&rsquo;s own bill
              </span>
            </th>
            <TokensCell tokens={totals.totals.tokens} className="pt-2 font-medium" />
            <CostCell bucket={totals.totals} className="pt-2 font-medium" />
            <ActiveCell bucket={totals.totals} className="pt-2 font-medium" />
          </tr>
        </tfoot>
      </table>

      {/* Which models to add to the price table — the only part of an unpriced total an operator can
          act on. Same line `spend-view` carries, for the same reason. */}
      {totals.unpricedModels.length > 0 ? (
        <p role="status" className="text-[11px] leading-relaxed text-risk-med">
          anton has no verified price for{" "}
          <span className="font-mono">{totals.unpricedModels.join(", ")}</span>, so every cost above
          that covers one is a floor rather than a total. Their tokens are counted; their dollars are
          not, and they are not free.
        </p>
      ) : null}
    </section>
  );
}

/**
 * One phase's row.
 *
 * The sub-line under the label carries every count that QUALIFIES the three figures beside it — how
 * many invocations produced them, how many turns those took, how many failed, and how many rows anton
 * could not price. They belong under the label rather than in columns of their own because they are
 * read only when a figure looks surprising, and four more columns is what would force the scroller
 * this panel exists without.
 */
function PhaseRow({ phase, bucket }: { phase: LedgerPhase; bucket: PhaseTotals }) {
  return <BucketRow label={PHASE_LABELS[phase]} hint={PHASE_HINTS[phase]} bucket={bucket} />;
}

/**
 * The remainder: spend this feature really made, on work anton cannot name.
 *
 * In the table and in the footer's total, because the money was genuinely this feature's — dropping
 * it would understate the bill, which is the same failure as pricing an unpriced row at zero. But
 * labelled, and labelled as an absence of knowledge rather than as a kind of work: a row that read
 * like a sixth phase would claim anton knows what it bought. The alternative D4 rules out is
 * dividing it across the phases above, where it would land on work that did not spend it and still
 * add up afterwards.
 */
function UnattributedRow({ bucket }: { bucket: PhaseTotals }) {
  return (
    <BucketRow
      label="Unattributed"
      hint="Spend this feature made that classifies to no phase — a job type this anton no longer defines, or a call recorded before anton logged which step it served. Counted in the total, because the money was real; left unsplit, because anton cannot say what it bought."
      bucket={bucket}
      labelClassName="italic text-muted-foreground"
    />
  );
}

/**
 * One row of the phase table: a label, the counts that qualify it, and the three figures.
 *
 * The sub-line under the label carries every count that QUALIFIES those figures — how many
 * invocations produced them, how many turns those took, how many failed, and how many rows anton
 * could not price. They belong under the label rather than in columns of their own because they are
 * read only when a figure looks surprising, and four more columns is what would force the scroller
 * this panel exists without.
 */
function BucketRow({
  label,
  hint,
  bucket,
  labelClassName,
}: {
  label: string;
  hint: string;
  bucket: PhaseTotals;
  /** Set where the row is not a phase, so it cannot be read as one. */
  labelClassName?: string;
}) {
  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <td className="px-1.5 py-2 align-top sm:px-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={cn("text-[12px] text-foreground", labelClassName)} title={hint}>
            {label}
          </span>
          <span className="font-mono text-[10px] leading-relaxed text-subtle">
            {bucket.runs} call{bucket.runs === 1 ? "" : "s"}
            {bucket.turns > 0 ? ` · ${bucket.turns} turns` : ""}
            {bucket.errors > 0 ? ` · ${bucket.errors} errored` : ""}
            {bucket.unpricedRows > 0 ? ` · ${bucket.unpricedRows} unpriced` : ""}
          </span>
        </div>
      </td>
      <TokensCell tokens={bucket.tokens} />
      <CostCell bucket={bucket} />
      <ActiveCell bucket={bucket} />
    </tr>
  );
}

function TokensCell({ tokens, className }: { tokens: LedgerTokens; className?: string }) {
  const total = totalTokens(tokens);
  return (
    <td
      className={cn(
        "px-1.5 py-2 text-right align-top font-mono text-[11.5px] tabular-nums whitespace-nowrap sm:px-2.5",
        className,
      )}
      title={`${formatExactTokens(total)} tokens — ${formatExactTokens(tokens.input)} in, ${formatExactTokens(tokens.output)} out, ${formatExactTokens(tokens.cacheRead)} cache read, ${formatExactTokens(tokens.cacheWrite)} cache write`}
    >
      {formatTokens(total)}
    </td>
  );
}

/**
 * A bucket's dollars, in the three states `spend-table` already keeps apart: a complete figure, a
 * floor over a partly-priced bucket (`+`), and no figure at all — a dash under an explicit `no price`
 * marker, never `$0.00`, since a zero is the reading that quietly understates a bill.
 */
function CostCell({ bucket, className }: { bucket: PhaseTotals; className?: string }) {
  const partial = bucket.usd !== undefined && bucket.unpricedRows > 0;
  // Two different reasons for an absent figure, and only the first is a gap in the price table: a
  // model anton cannot price, versus a crashed invocation that measured nothing to price.
  const hasMeasuredTokens = totalTokens(bucket.tokens) > 0;

  return (
    <td
      className={cn(
        "px-1.5 py-2 text-right align-top font-mono text-[11.5px] tabular-nums whitespace-nowrap sm:px-2.5",
        className,
      )}
    >
      {bucket.usd === undefined ? (
        // A dash and a WORD, not a dash alone. This table omits the phases that recorded nothing, so
        // a lone dash in a cost column reads as "no calls here" — while the tokens cell beside it
        // says calls happened. The word is what makes the cell mean "unpriced" instead of "free" or
        // "absent", and it survives the hover title being unreachable on a touch device.
        <span
          className="flex flex-col items-end gap-0.5"
          title={
            hasMeasuredTokens
              ? "anton has no verified price for what served these calls, so their tokens are counted and their cost is not. Not free — unpriced."
              : "These calls reported no usage at all, so there is nothing to price."
          }
        >
          <span className="text-subtle">—</span>
          <span className="text-[9.5px] leading-none font-normal text-risk-med">
            {hasMeasuredTokens ? "no price" : "no usage"}
          </span>
        </span>
      ) : (
        <span
          className={partial ? "text-muted-foreground" : "text-foreground"}
          title={
            partial
              ? `At least this — anton could not price ${bucket.unpricedRows} of ${bucket.rows} rows.`
              : "Derived from the measured token counts and anton's own price table."
          }
        >
          {formatUsd(bucket.usd)}
          {partial ? <span className="text-subtle"> +</span> : null}
        </span>
      )}
    </td>
  );
}

/**
 * A bucket's active time — what claude worked, summed over its invocations.
 *
 * Marked as a FLOOR when fewer invocations reported a duration than the bucket holds, the same
 * discipline the dollar cell applies to an unpriced row: a partly-measured span that reads as a total
 * is the one number here nobody could catch afterwards.
 */
function ActiveCell({ bucket, className }: { bucket: PhaseTotals; className?: string }) {
  const apiShare =
    bucket.activeMs > 0 ? ` · ${Math.round((bucket.apiMs / bucket.activeMs) * 100)}% in the API` : "";
  const partial = bucket.timedRuns < bucket.runs;

  return (
    <td
      className={cn(
        "px-1.5 py-2 text-right align-top font-mono text-[11.5px] tabular-nums whitespace-nowrap sm:px-2.5",
        className,
      )}
      title={`What claude worked across ${bucket.runs} call${bucket.runs === 1 ? "" : "s"}${apiShare}. Not elapsed time — see the durations below.${
        partial
          ? ` A FLOOR: only ${bucket.timedRuns} of ${bucket.runs} call${bucket.runs === 1 ? "" : "s"} reported a duration.`
          : ""
      }`}
    >
      {formatDuration(bucket.activeMs)}
      {partial ? <span className="text-subtle"> +</span> : null}
    </td>
  );
}

/**
 * Board overhead: real money, spent on this project, deliberately NOT billed to this feature (§D4).
 *
 * The scheduled passes — gardener, product-master, board-picker, nightly-stringer — serve the whole
 * board. Dividing their spend across the features they looked at would be a fabricated number, and
 * the specific danger is that a fabricated split still ADDS UP: every feature's bill would be
 * slightly wrong, all the totals would reconcile, and nothing afterwards could find the error. So
 * the figure is shown whole, in one place, labelled as belonging to none of them.
 *
 * Below the table rather than a row in it, because a row inside the table is inside the footer's
 * total — which is exactly the claim being refused. The alternative to this line is not a cleaner
 * page; it is dropping the money silently, which is the failure `spend-breakdown`'s unpriced rule
 * already rejected once.
 */
function UnallocatedSection({ overhead }: { overhead: PhaseTotals }) {
  // Same distinction `CostCell` draws: an absent dollar figure is either a genuine price-table gap
  // or a pass that measured no usage at all to price, and only the first is "no price" (PR #329 review).
  const hasMeasuredTokens = totalTokens(overhead.tokens) > 0;
  // Same floor discipline `ActiveCell` applies: fewer timed runs than runs means `activeMs` is a
  // partial sum, not the exact total the plain duration otherwise implies (PR #329 review).
  const partlyTimed = overhead.timedRuns < overhead.runs;

  return (
    <section
      aria-label="Unallocated"
      className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border px-3.5 py-3"
    >
      <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <LayersIcon className="size-3 text-subtle" aria-hidden="true" />
        Unallocated — not billed to this feature
      </h2>

      <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <OverheadFigure
          label="Cost"
          value={formatUsd(overhead.usd)}
          qualifier={
            overhead.usd === undefined
              ? hasMeasuredTokens
                ? "no price"
                : "no usage"
              : overhead.unpricedRows > 0
                ? "floor"
                : undefined
          }
          hint={
            overhead.usd === undefined
              ? hasMeasuredTokens
                ? "anton has no verified price for what served these passes. Their tokens are counted; their cost is not."
                : "These passes reported no usage at all, so there is nothing to price."
              : `What the scheduled passes touching this feature's beads cost the project${overhead.unpricedRows > 0 ? ` — a FLOOR: ${overhead.unpricedRows} of ${overhead.rows} rows could not be priced.` : "."}`
          }
        />
        <OverheadFigure
          label="Tokens"
          value={formatTokens(totalTokens(overhead.tokens))}
          hint={`${formatExactTokens(totalTokens(overhead.tokens))} tokens across ${overhead.runs} call${overhead.runs === 1 ? "" : "s"}.`}
        />
        <OverheadFigure
          label="Active"
          value={formatDuration(overhead.activeMs)}
          qualifier={partlyTimed ? "floor" : undefined}
          hint={`What claude worked in those passes. Outside this feature's own active time above.${
            partlyTimed
              ? ` A FLOOR: only ${overhead.timedRuns} of ${overhead.runs} call${overhead.runs === 1 ? "" : "s"} reported a duration.`
              : ""
          }`}
        />
      </dl>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        A scheduled pass — grooming the board, picking work, scanning the repo — served the whole
        project while it touched this feature. That spend is reported here and{" "}
        <span className="font-medium text-foreground">divided into no feature at all</span>: a split
        would move real money onto work that did not spend it, and every total would still reconcile
        afterwards, so nothing could find the error later.
      </p>
    </section>
  );
}

/** One overhead figure. Same name/value/qualifier shape as {@link Stat}, at the smaller scale this
 *  section's subordinate position calls for — it is context for the bill above, not a headline. */
function OverheadFigure({
  label,
  value,
  qualifier,
  hint,
}: {
  label: string;
  value: string;
  qualifier?: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[9.5px] tracking-[0.11em] text-subtle uppercase">{label}</dt>
      <dd className="flex items-baseline gap-1.5">
        <span className="font-mono text-[13px] tabular-nums text-foreground" title={hint}>
          {value}
        </span>
        {qualifier ? (
          <span className="font-mono text-[9.5px] text-risk-med" title={hint}>
            {qualifier}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * The three durations, each with its own label and its own explanation.
 *
 * Stats rather than a table row, because they are not comparable the way the phases are — they are
 * three different questions about the same feature, and a shared column heading would invite reading
 * them as three measurements of one thing.
 */
function DurationsSection({ timing }: { timing: LedgerTiming }) {
  const waiting = waitingMs(timing);
  const partlyTimed = timing.timedInvocations < timing.invocations;

  return (
    <section
      aria-label="Durations"
      className="flex flex-col gap-2.5 rounded-xl border border-border bg-card/40 px-3.5 py-3"
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <TimerIcon className="size-3 text-subtle" aria-hidden="true" />
          Durations
        </h2>
        <p className="text-[11px] text-subtle">
          Three spans, not one. A feature that parked overnight on a usage limit worked for minutes
          and took hours, and either figure alone is the wrong answer to half the questions.
        </p>
      </div>

      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
        <Stat
          label="Active"
          value={formatDuration(timing.activeMs)}
          qualifier={partlyTimed ? "floor" : undefined}
          hint={
            partlyTimed
              ? `What claude worked — a FLOOR: only ${timing.timedInvocations} of ${timing.invocations} calls reported a duration.`
              : `What claude worked, across ${timing.invocations} call${timing.invocations === 1 ? "" : "s"}.`
          }
        />
        <Stat
          label="Lead"
          value={timing.leadMs === undefined ? "—" : formatDuration(timing.leadMs)}
          qualifier={timing.leadMs === undefined ? "not delivered" : undefined}
          hint={
            timing.leadMs === undefined
              ? "First call to last delivery — there is no span to report until this feature has delivered."
              : "First call to last delivery, including every park in between."
          }
        />
        <Stat
          label="Waiting"
          value={waiting === undefined ? "—" : formatDuration(waiting)}
          qualifier={waiting === undefined ? (timing.splitAmbiguous ? "not split" : "no span") : undefined}
          hint={
            waiting === undefined
              ? timing.splitAmbiguous
                ? "Lead minus active — refused here: a call ended in the same second as the delivery, so anton cannot say which came first, and either answer would be a guess."
                : "Lead minus active — there is no span to divide until this feature has delivered."
              : "Lead minus active: elapsed time nobody was working. This is the figure that says whether to buy more quota."
          }
        />
      </dl>

      {/* The absent fourth figure, stated rather than left as a gap an operator reads as an oversight. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        There is no wall-clock figure here. Time including retries is not recoverable for the runs
        already recorded, and a plausible wrong number would outlive every comparison it entered.
      </p>
    </section>
  );
}

/**
 * One headline figure, as a name/value pair — three questions about the feature, each named.
 *
 * The qualifier beside the value is what keeps a partial figure from reading as a total: a `floor`
 * over a partly-measured span, `not delivered` where there is no span yet, `not split` where the
 * fold refuses to divide one. Same discipline as the `+` on a partly-priced dollar figure.
 */
function Stat({
  label,
  value,
  qualifier,
  hint,
}: {
  label: string;
  value: string;
  /** What the figure is NOT, when it is not a plain total — "floor", "not delivered", "not split". */
  qualifier?: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[9.5px] tracking-[0.11em] text-subtle uppercase">{label}</dt>
      <dd className="flex items-baseline gap-1.5">
        <span className="font-mono text-[17px] tabular-nums text-foreground" title={hint}>
          {value}
        </span>
        {qualifier ? (
          <span className="font-mono text-[10px] text-risk-med" title={hint}>
            {qualifier}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * The friction counters, under the labelling design §D3 requires of every surface that shows them.
 *
 * The heading says what these ARE before it says what they were, and the sentence under it is
 * load-bearing rather than decoration: three review rounds may mean a weak implementation, an
 * ambitious scope, or a strict reviewer, and nothing anton records tells the three apart. A count
 * shown without that caveat is read as a grade, which is exactly what the design refuses.
 *
 * The grouping carries the arithmetic the fold is careful about. `humanTouches` is the one figure
 * that sums the others, so it is stated with its terms beside it; `quotaParks` sits in its own group
 * BELOW that sum, labelled as outside it, because folding a usage limit into "times a person had to
 * intervene" would degrade the metric every time anton is used more.
 */
function FrictionSection({ friction }: { friction: LedgerFriction }) {
  return (
    <section
      aria-label="Friction"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card/40 px-3.5 py-3"
    >
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <HandIcon className="size-3 text-subtle" aria-hidden="true" />
          Friction — observed signals, not a quality score
        </h2>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Every count here is a <span className="font-medium text-foreground">proxy</span> for how
          much attention this feature took, counted from what anton already records. None of them
          measures how well the work was done: three review rounds may mean a weak implementation, an
          ambitious scope, or a strict reviewer, and nothing recorded tells those apart.
        </p>
      </div>

      <FrictionGroup
        title="anton's own passes"
        hint="Its own correction loops — not a person's doing, and outside the touch count below."
        counts={[
          {
            label: "Review rounds",
            value: friction.reviewRounds,
            hint: "Rounds the self-review took to reach a clean verdict. A round is the gate working, not a failure.",
          },
          {
            label: "PR fixes",
            value: friction.prFixRounds,
            hint: "Times a PR of this feature's had to be corrected after it opened.",
          },
        ]}
      />

      <FrictionGroup
        title={`Human touches — ${friction.humanTouches}`}
        hint="The one figure that sums the others, each gate counted exactly once. It says how many interruptions this feature cost a person, not that it went badly."
        counts={[
          {
            label: "Escalations",
            value: friction.escalations,
            hint: `Every time anton stopped and said something, for any reason — the gates included. ${friction.humanGates} of them were gates; the two are never added to each other.`,
          },
          {
            label: "Human gates",
            value: friction.humanGates,
            hint: "An open ask only a person could answer. A subset of the escalations beside it, not a sibling of them.",
          },
          {
            label: "Send-backs",
            value: friction.sendBacks,
            hint: "Times a human sent work in this feature back. Read from free-text notes, so a proxy in the strongest sense here.",
          },
          {
            label: "Cancels",
            value: friction.cancels,
            hint: "Jobs an operator terminally killed. The one counter here that rests on no heuristic.",
          },
        ]}
      />

      <FrictionGroup
        title="Parks — outside the touch count"
        hint="A park is not a person intervening. Counting a usage limit as friction would make this number grow every time anton is used more, which is the opposite of what it is for."
        counts={[
          {
            label: "Quota parks",
            value: friction.quotaParks,
            hint: "Times this feature's work paused on an exhausted usage limit. anton resumes on its own; nobody is asked anything.",
          },
          {
            label: "Failure parks",
            value: friction.failureParks,
            hint: "Parks a human has to clear — the half of the split that IS anton failing. Still nobody touching anything, so still outside the sum.",
          },
        ]}
      />
    </section>
  );
}

function FrictionGroup({
  title,
  hint,
  counts,
}: {
  title: string;
  hint: string;
  counts: readonly { label: string; value: number; hint: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="font-mono text-[9.5px] tracking-[0.11em] text-subtle uppercase" title={hint}>
        {title}
      </h3>
      {/* Wraps rather than scrolls: a narrow viewport gets fewer counters per line, never a
          counter it cannot reach. */}
      <dl className="flex flex-wrap gap-x-5 gap-y-2">
        {counts.map((count) => (
          <div key={count.label} className="flex items-baseline gap-1.5">
            <dt className="text-[11.5px] text-muted-foreground" title={count.hint}>
              {count.label}
            </dt>
            <dd
              className="font-mono text-[13px] tabular-nums text-foreground"
              title={count.hint}
            >
              {count.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The cost side alone, empty — a scope with friction to show (a cancel, an escalation, a send-back)
 * but no invocation rows behind it, so there is no bill to render above the Friction section that
 * follows. Distinct from {@link NothingRecorded}: that one covers a scope with nothing recorded at
 * all, which this component's caller has already ruled out.
 */
function NoCostRecorded() {
  return (
    <section
      aria-label="By phase"
      className="flex flex-col gap-0.5 rounded-xl border border-dashed border-border px-3.5 py-3"
    >
      <h2 className="text-[13px] font-medium text-foreground">By phase</h2>
      <p className="text-[11px] text-subtle">
        No cost recorded — nothing was dispatched for this feature, though it still cost attention
        (see Friction below).
      </p>
    </section>
  );
}

/**
 * A feature with nothing in the ledger.
 *
 * Reads as EMPTY, never as `$0.00` and a wall of `0s` — the fold's own second honesty rule, and the
 * one a reader is most likely to get wrong on their own: an operator who sees zeros concludes the
 * work was free rather than that the meter never saw it.
 */
function NothingRecorded() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl border border-dashed border-border">
        <GaugeIcon className="size-5 text-subtle" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold">Nothing recorded for this feature yet</p>
        <p className="max-w-sm text-xs leading-relaxed text-subtle">
          anton meters every claude invocation it dispatches, and none is on record against this
          feature or its tickets. That is an empty ledger, not zero spend — nothing has been measured
          here.
        </p>
      </div>
    </div>
  );
}
