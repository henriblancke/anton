"use client";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

export type FilterSelectOption = { value: string; label: string };

/**
 * Keeps an active facet selectable even when nothing in the current result set carries it any more
 * — otherwise a shared link to a since-emptied value reads as "All" over an empty list.
 */
export function withActive(
  options: FilterSelectOption[],
  active?: string,
): FilterSelectOption[] {
  if (!active || options.some((option) => option.value === active)) return options;
  return [...options, { value: active, label: active }];
}

const selectClassName = cn(
  "h-8 min-w-24 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none transition-colors",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

/**
 * The native select every filter bar (board, jobs, tickets) narrows with. Deliberately not the
 * base-ui popup in `./select.tsx`: these bars are dense toolbars where the platform control is the
 * cheaper, more accessible answer. The label is sr-only because the empty option names the facet.
 */
export function FilterSelect({
  idPrefix,
  field,
  label,
  value,
  options,
  emptyLabel,
  onChange,
  className,
  wrapperClassName,
}: {
  /** Namespaces the DOM id per surface: `${idPrefix}-${field}`. */
  idPrefix: string;
  field: string;
  label: string;
  value: string;
  options: FilterSelectOption[];
  /** Text of the leading `value=""` option. Omit when the option list already carries its own. */
  emptyLabel?: string;
  onChange: (value: string) => void;
  className?: string;
  /** Wrapper around label + select; omit to emit them as bare siblings of the bar's own layout. */
  wrapperClassName?: string;
}) {
  const id = `${idPrefix}-${field}`;
  const control = (
    <>
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(selectClassName, className)}
      >
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );

  return wrapperClassName ? <div className={wrapperClassName}>{control}</div> : control;
}
