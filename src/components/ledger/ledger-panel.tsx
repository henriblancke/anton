import { GaugeIcon, HandIcon, TimerIcon } from "lucide-react";

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
  // "this cost nothing" are opposite facts, and the zero is the one that gets believed.
  if (!totals.recorded) return <NothingRecorded />;

  return (
    <div className="flex flex-col gap-4">
      <PhaseTable totals={totals} />
      <DurationsSection timing={timing} />
      <FrictionSection friction={friction} />
    </div>
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
  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <td className="px-1.5 py-2 align-top sm:px-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[12px] text-foreground" title={PHASE_HINTS[phase]}>
            {PHASE_LABELS[phase]}
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
 * floor over a partly-priced bucket (`+`), and no figure at all (a dash — never `$0.00`, since a zero
 * is the reading that quietly understates a bill).
 */
function CostCell({ bucket, className }: { bucket: PhaseTotals; className?: string }) {
  const partial = bucket.usd !== undefined && bucket.unpricedRows > 0;

  return (
    <td
      className={cn(
        "px-1.5 py-2 text-right align-top font-mono text-[11.5px] tabular-nums whitespace-nowrap sm:px-2.5",
        className,
      )}
    >
      {bucket.usd === undefined ? (
        <span
          className="text-subtle"
          title="anton has no verified price for what served these calls, so their tokens are counted and their cost is not. Not free — unpriced."
        >
          —
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

  return (
    <td
      className={cn(
        "px-1.5 py-2 text-right align-top font-mono text-[11.5px] tabular-nums whitespace-nowrap sm:px-2.5",
        className,
      )}
      title={`What claude worked across ${bucket.runs} call${bucket.runs === 1 ? "" : "s"}${apiShare}. Not elapsed time — see the durations below.`}
    >
      {formatDuration(bucket.activeMs)}
    </td>
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
