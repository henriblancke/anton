"use client";

/**
 * Native checkbox — keyboard-reachable and indeterminate-capable for free, which is the whole
 * requirement here. `indeterminate` is DOM-only state, so it is written through a ref. Shared by
 * the jobs list's select-all header and its rows, so it belongs to neither.
 */
export function SelectCheckbox({
  id,
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  id?: string;
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      id={id}
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={(event) => onChange(event.target.checked)}
      className="size-3.5 shrink-0 cursor-pointer accent-destructive outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    />
  );
}
