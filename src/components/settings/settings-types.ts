import type { Policy } from "@/components/settings/policy-draft-section";

/**
 * The shapes the settings form works in. Every one of them is MIRRORED from a server type rather
 * than imported: this whole module tree is client-side, and importing the server's settings code to
 * get a type would drag its runtime into the bundle. Keep in sync with src/lib/projects.ts.
 */

/** One label→formula mapping (anton-aa3m), mirrored from the server's FormulaVariant. */
export interface FormulaVariant {
  label: string;
  formula: string;
}

/** A variant row being edited: the mapping plus a stable local id used only as the React key. */
export interface VariantRow extends FormulaVariant {
  id: string;
}

/**
 * A `ns:` group of the labels this project's board actually uses (anton-prng), mirrored from the
 * server's LabelNamespace. `namespace` is `""` for bare labels like `approved`.
 */
export interface LabelNamespace {
  namespace: string;
  labels: { label: string; count: number }[];
}

/** One nominated value label, with a stable local id so reordering never moves the operator's cursor. */
export interface ValueLabelRow {
  id: string;
  label: string;
}

/** Settings the UI can edit today. */
export interface EditableSettings {
  model?: string;
  seedPrompt?: string;
  reviewFixPrompt?: string;
  productMasterPrompt?: string;
  /** Pre-PR self-review gate (anton-3apm); absent = ON. The knobs below only apply when on. */
  reviewEnabled?: boolean;
  reviewAgent?: string;
  reviewPrompt?: string;
  reviewMaxRounds?: number;
  /** Score-regression alarm (anton-i98r): park after `reviewLowScoreRounds` rounds below this. */
  reviewMinScore?: number;
  reviewLowScoreRounds?: number;
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  buildCommand?: string;
  /** Per-label pipeline variants (anton-aa3m), in precedence order — first matching label wins. */
  formulaVariants?: FormulaVariant[];
  concurrency?: number;
  jobTimeoutMinutes?: number;
  ticketTimeoutMinutes?: number;
  maxRetries?: number;
  agents?: string[];
  autonomy?: boolean;
  conventionalCommits?: boolean;
  /**
   * How far a pass may go with the proposals it files, per detection kind (anton-nbyy). Only the
   * kinds moved off `propose` are stored. Typed loosely on purpose: this mirror must survive a blob
   * a human hand-edited or an older anton wrote, and `resolveProposalAutonomy` floors anything it
   * can't read back to `propose` rather than rendering it.
   */
  proposalAutonomy?: Record<string, string>;
  /** Budget-aware execution master-switch (anton-7mpv.1); off by default. Gates the knobs below. */
  budgetAware?: boolean;
  /** Operator budget policy (anton-egrg); only the two exposed knobs round-trip through this form. */
  budgetPolicy?: {
    daytimeReservePct?: number;
    weeklyTargetPct?: number;
  };
  /** Nominated value labels (anton-prng), highest tier first. Absent/empty = rank on age alone. */
  valueLabels?: string[];
  /** The armed work policy (anton-c7iv). Absent = never armed, which is what makes the panel
   *  propose a calibrated draft instead of an empty form. */
  pickerPolicy?: Policy;
}

/** Per-automation schedule state from the server; a missing row means "not scheduled yet". */
export interface AutomationSchedule {
  type: string;
  enabled: boolean;
  cron: string;
  /** Epoch SECONDS; absent while the schedule is disabled. */
  nextRunAt?: number;
  /** Epoch SECONDS of the last fire; absent until it has run once. */
  lastRunAt?: number;
}

/** One discoverable agent (anton-dvo.1), mirrored from the server's DiscoveredAgent. */
export interface DiscoveredAgent {
  id: string;
  source: "project" | "global" | "bundled" | "plugin";
  description?: string;
}
