import {
  formatExactTokens,
  formatTokens,
  formatUsd,
  hasMeasuredTokens,
  isCompletelyPriced,
  type SpendBreakdown,
  type SpendGroup,
} from "@/lib/spend-breakdown";
import { cn } from "@/lib/utils";

/**
 * One breakdown, as a table (anton-1kdm): what each model — or each task — spent over the window.
 *
 * Rows because the question is comparative. An operator is not reading "opus cost $4.12"; they are
 * reading "opus cost four times what sonnet did", and a card per model puts the two numbers being
 * compared on different lines. The share bar behind each row's label is the only chart here, and it
 * earns its place by making that ratio readable without arithmetic — the ticket's "no charts beyond
 * what the numbers need".
 *
 * Every figure is MEASURED, and none of them wears the `≈` the quota-share panel wears. That marker
 * means "sampled from runs that happened to have the machine to themselves"; these come from counts
 * the result event reported. Borrowing it would erase the only thing this page adds.
 *
 * A group anton has no price for shows its TOKENS and a dash for dollars — never `$0.00`. The two
 * are opposite facts, and a zero is the one that quietly understates a bill.
 */
export function SpendTable({
  breakdown,
  caption,
  emptyLabel,
}: {
  breakdown: SpendBreakdown;
  /** What the first column holds — "Model" or "Task". */
  caption: string;
  /** Shown in place of the table when the window recorded nothing on this dimension. */
  emptyLabel: string;
}) {
  if (!breakdown.recorded) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-subtle">
        {emptyLabel}
      </p>
    );
  }

  // The denominator for the share bars. Tokens rather than dollars: it is the one measure EVERY
  // group has, so an unpriced model still gets a bar rather than dropping out of the comparison.
  const maxTokens = Math.max(...breakdown.groups.map((group) => group.tokens.total), 1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-border">
            {[caption, "Tokens", "In / out", "Cache read", "Cost"].map((heading, index) => (
              <th
                key={heading}
                scope="col"
                className={cn(
                  "px-2.5 pb-1.5 font-mono text-[9.5px] tracking-[0.11em] font-normal text-subtle uppercase whitespace-nowrap",
                  index > 0 && "text-right",
                )}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {breakdown.groups.map((group) => (
            <SpendTableRow key={group.key} group={group} maxTokens={maxTokens} />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border">
            <th scope="row" className="px-2.5 pt-2 text-left text-[12px] font-medium">
              Total
            </th>
            <td
              className="px-2.5 pt-2 text-right font-mono text-[11.5px] tabular-nums"
              title={`${formatExactTokens(breakdown.tokens.total)} tokens`}
            >
              {formatTokens(breakdown.tokens.total)}
            </td>
            <td className="px-2.5 pt-2 text-right font-mono text-[11px] tabular-nums text-subtle">
              {formatTokens(breakdown.tokens.input)} / {formatTokens(breakdown.tokens.output)}
            </td>
            <td className="px-2.5 pt-2 text-right font-mono text-[11px] tabular-nums text-subtle">
              {formatTokens(breakdown.tokens.cacheRead)}
            </td>
            <td className="px-2.5 pt-2 text-right font-mono text-[12px] tabular-nums font-medium">
              {formatUsd(breakdown.usd)}
              {breakdown.unpriced > 0 && breakdown.usd !== undefined ? (
                <span className="text-subtle"> +</span>
              ) : null}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * One group's row.
 *
 * The dollar cell carries three distinct states, and conflating any two of them is the failure this
 * feature exists to prevent: a complete figure, a figure that covers only part of the group (`+`,
 * because the real number is at least this), and no figure at all (a dash, with the tokens still
 * shown beside it so the row is evidence rather than a gap).
 */
function SpendTableRow({ group, maxTokens }: { group: SpendGroup; maxTokens: number }) {
  const share = Math.round((group.tokens.total / maxTokens) * 100);
  const partial = group.usd !== undefined && !isCompletelyPriced(group);

  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <td className="px-2.5 py-2 align-middle">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-mono text-[12px] text-foreground" title={group.label}>
            {group.label}
          </span>
          {/* The comparison the table is read for, as a bar rather than a second number. */}
          <span
            className="h-0.5 w-full max-w-40 overflow-hidden rounded-full bg-border"
            aria-hidden="true"
          >
            <span
              className="block h-full rounded-full bg-primary/60"
              style={{ width: `${Math.max(share, 1)}%` }}
            />
          </span>
          <span className="font-mono text-[10px] text-subtle">
            {group.rows} row{group.rows === 1 ? "" : "s"}
            {group.usd === undefined && hasMeasuredTokens(group) ? " · pricing unverified" : ""}
            {group.usd === undefined && !hasMeasuredTokens(group)
              ? " · reported no usage"
              : ""}
            {partial ? ` · ${group.unpriced} unpriced` : ""}
          </span>
        </div>
      </td>

      <td
        className="px-2.5 py-2 text-right align-middle font-mono text-[11.5px] tabular-nums whitespace-nowrap"
        title={`${formatExactTokens(group.tokens.total)} tokens`}
      >
        {formatTokens(group.tokens.total)}
      </td>

      <td className="px-2.5 py-2 text-right align-middle font-mono text-[11px] tabular-nums whitespace-nowrap text-muted-foreground">
        {formatTokens(group.tokens.input)} / {formatTokens(group.tokens.output)}
      </td>

      <td className="px-2.5 py-2 text-right align-middle font-mono text-[11px] tabular-nums whitespace-nowrap text-muted-foreground">
        {formatTokens(group.tokens.cacheRead)}
      </td>

      <td className="px-2.5 py-2 text-right align-middle font-mono text-[11.5px] tabular-nums whitespace-nowrap">
        {group.usd === undefined ? (
          <span
            className="text-subtle"
            title={
              hasMeasuredTokens(group)
                ? "Anton cannot verify billing for this model and route, so its tokens are counted and its cost is not. Not free — unpriced."
                : "This invocation reported no usage at all, so there is nothing to price."
            }
          >
            —
          </span>
        ) : (
          <span
            className={partial ? "text-muted-foreground" : "text-foreground"}
            title={
              partial
                ? `At least this — anton cannot verify billing for ${group.unpriced} of ${group.rows} rows.`
                : "Derived from the measured token counts and anton's own price table."
            }
          >
            {formatUsd(group.usd)}
            {partial ? <span className="text-subtle"> +</span> : null}
          </span>
        )}
      </td>
    </tr>
  );
}
