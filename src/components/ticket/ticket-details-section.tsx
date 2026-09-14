"use client";

import { Select } from "./ticket-dialog-fields";
import {
  AGENT_OPTIONS,
  PRIORITY_LABELS,
  PRIORITY_OPTIONS,
  RISK_OPTIONS,
  SIZE_OPTIONS,
  STATUS_LABELS,
  STATUS_OPTIONS,
  detailsSummary,
  type TicketDraft,
} from "./ticket-dialog-utils";

/** Sets one draft field, keeping its value bound to its key. */
type SetField = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) => void;

/**
 * The label/scalar fields, folded away by default so the contract + notes lead (anton-q02q).
 * Collapsed shows a live summary; open reveals the grid. Native <details> so the toggle needs no JS
 * and stays keyboard-accessible.
 */
export function TicketDetailsSection({
  draft,
  deferred,
  set,
}: {
  draft: TicketDraft;
  /** Snoozed — the state bar owns that status, so it's shown here read-only. */
  deferred: boolean;
  set: SetField;
}) {
  return (
    <details className="group overflow-hidden rounded-xl border border-border bg-card/40 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-[12.5px] font-medium text-foreground select-none">
        <span>
          Details <span className="font-normal text-subtle">· {detailsSummary(draft, deferred)}</span>
        </span>
        <span className="text-subtle transition-transform group-open:rotate-90" aria-hidden="true">
          ▸
        </span>
      </summary>
      <div className="grid grid-cols-1 gap-3 border-t border-border px-3.5 py-3.5 sm:grid-cols-2">
        <StatusSelect value={draft.status} deferred={deferred} onChange={(v) => set("status", v)} />
        <PrioritySelect value={draft.priority} onChange={(v) => set("priority", v)} />
        <LabelSelect
          label="Agent"
          value={draft.agent}
          options={AGENT_OPTIONS}
          onChange={(v) => set("agent", v)}
        />
        <LabelSelect
          label="Risk"
          value={draft.risk}
          options={RISK_OPTIONS}
          format={(r) => `risk:${r}`}
          onChange={(v) => set("risk", v)}
        />
        <LabelSelect
          label="Size"
          value={draft.size}
          options={SIZE_OPTIONS}
          format={(s) => `size:${s}`}
          onChange={(v) => set("size", v)}
        />
      </div>
    </details>
  );
}

/**
 * Snooze IS the raw bead status `deferred`, and it's owned by the state bar's segment, not picked
 * here. A snoozed ticket shows it read-only so it reads coherently; un-snooze (→ open) to change
 * status.
 */
function StatusSelect({
  value,
  deferred,
  onChange,
}: {
  value: string;
  deferred: boolean;
  onChange: (value: string) => void;
}) {
  if (deferred) {
    return (
      <Select label="Status" value="deferred" onChange={() => {}} disabled>
        <option value="deferred">{STATUS_LABELS.deferred}</option>
      </Select>
    );
  }
  return (
    <Select label="Status" value={value} onChange={onChange}>
      {STATUS_OPTIONS.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABELS[s] ?? s}
        </option>
      ))}
    </Select>
  );
}

/** Priority is the one numeric field; an unset bead keeps an em-dash option until it's picked. */
function PrioritySelect({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <Select
      label="Priority"
      value={value === undefined ? "" : String(value)}
      onChange={(v) => onChange(v === "" ? undefined : Number(v))}
    >
      {value === undefined && <option value="">—</option>}
      {PRIORITY_OPTIONS.map((p) => (
        <option key={p} value={String(p)}>
          {PRIORITY_LABELS[p]}
        </option>
      ))}
    </Select>
  );
}

/**
 * An optional label field (agent/risk/size). "none" is offered only while the label is unset,
 * because the API can set a label but not clear one — see `diffTicketPatch`.
 */
function LabelSelect<T extends string>({
  label,
  value,
  options,
  format = (option) => option,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly T[];
  format?: (option: T) => string;
  onChange: (value: string) => void;
}) {
  return (
    <Select label={label} value={value} onChange={onChange}>
      {value === "" && <option value="">none</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {format(option)}
        </option>
      ))}
    </Select>
  );
}
