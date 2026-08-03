/**
 * How anton reads a stringer signal (anton-bz1w): what CLASS of problem it is, how SEVERE it is,
 * and — from that severity — the `risk:`/priority a triaged bead must carry.
 *
 * stringer's JSON has no severity field of its own: a signal carries its collector (`Source`), its
 * kind, and sometimes a `Priority`. So severity is DERIVED here, in one place, because two readers
 * depend on it and must agree — the per-scan health record (lib/scan-health.ts) counts signals by
 * severity, and /scan-triage labels the beads it creates from it. A mapping that lived only in the
 * triage prompt would make the chart and the board disagree about the same scan.
 *
 * The severity → `risk:`/priority half is per-project adjustable (`ProjectSettings.scanSeverity`)
 * and injected into the triage prompt by the nightly-stringer job: a project where a stale dep is a
 * P1 and one where it is a P3 are both legitimate, and neither should have to fork the skill.
 * The signal → severity half is NOT a knob — it is a reading of stringer's own output, and a
 * project that could redefine it would make its own trend incomparable with its history.
 */

/** Severity as anton ranks it, worst first. The order is the chart's stacking order. */
export const SCAN_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number];

/**
 * What KIND of problem a signal is — the second axis of the health record. Derived from the
 * collector, so the six classes stay legible where stringer's fifteen collectors would not.
 */
export const SIGNAL_CLASSES = [
  "security",
  "dependencies",
  "debt",
  "risk",
  "docs",
  "other",
] as const;
export type SignalClass = (typeof SIGNAL_CLASSES)[number];

/**
 * The shape anton reads out of a stringer scan file. stringer emits PascalCase keys; the lowercase
 * aliases are tolerated so a hand-written fixture (or a future casing change) still classifies
 * rather than silently landing in `other`/`medium`.
 */
export interface ScanSignal {
  Source?: string | null;
  source?: string | null;
  Kind?: string | null;
  kind?: string | null;
  Priority?: number | string | null;
  priority?: number | string | null;
  /** Not emitted today; read first if a future stringer adds it, rather than guessing around it. */
  Severity?: string | null;
  severity?: string | null;
  Tags?: string[] | null;
  tags?: string[] | null;
}

/** Which class each stringer collector reports on (`stringer collectors list`). */
const CLASS_BY_COLLECTOR: Record<string, SignalClass> = {
  vuln: "security",
  githygiene: "security", // committed secrets, merge-conflict markers, large binaries
  dephealth: "dependencies",
  todos: "debt",
  deadcode: "debt",
  duplication: "debt",
  complexity: "debt",
  patterns: "debt", // large files, missing tests, low test ratio
  coupling: "risk",
  lotteryrisk: "risk",
  gitlog: "risk", // churn, reverts, stale branches
  configdrift: "risk",
  apidrift: "risk",
  docstale: "docs",
  github: "other", // imported issues/PRs — someone else's triage, not a code signal
};

/**
 * Default severity per collector, for signals whose kind says nothing more specific. A collector
 * anton doesn't know is `medium`, deliberately: a new collector should surface on the trend at a
 * weight that gets looked at, not be buried at `low` or scream at `critical`.
 */
const SEVERITY_BY_COLLECTOR: Record<string, ScanSeverity> = {
  vuln: "critical",
  githygiene: "medium",
  dephealth: "medium",
  apidrift: "medium",
  configdrift: "medium",
  coupling: "medium",
  todos: "low",
  deadcode: "low",
  duplication: "low",
  complexity: "low",
  patterns: "low",
  docstale: "low",
  lotteryrisk: "low",
  gitlog: "low",
  github: "low",
};

const UNKNOWN_COLLECTOR_SEVERITY: ScanSeverity = "medium";

/**
 * Kind/tag patterns that outrank the collector's default, in order. Deliberately narrow and
 * security-shaped: a signal that names a secret or a CVE is critical whatever emitted it, while a
 * generic word like "high" is NOT matched — `high-churn` is a churn signal, not a high-severity one.
 */
const KIND_SEVERITY_RULES: [pattern: RegExp, severity: ScanSeverity][] = [
  [/secret|credential|password|private[-_]?key|api[-_]?key/i, "critical"],
  [/\bcve\b|vulnerab|osv-/i, "critical"],
  [/merge[-_]?conflict|conflict[-_]?marker/i, "high"],
  [/deprecat|yanked|archived/i, "medium"],
];

function text(...values: (string | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

function firstString(...values: (string | null | undefined)[]): string {
  return (values.find((v) => typeof v === "string" && v) ?? "").toLowerCase();
}

/** stringer's `Priority` is a bd priority (0 = critical … 4 = backlog) when a collector sets one. */
function severityFromPriority(raw: unknown): ScanSeverity | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n)) return undefined;
  if (n <= 0) return "critical";
  if (n === 1) return "high";
  if (n === 2) return "medium";
  return "low";
}

function normalizeSeverity(raw: string): ScanSeverity | undefined {
  const value = raw.toLowerCase();
  return (SCAN_SEVERITIES as readonly string[]).includes(value)
    ? (value as ScanSeverity)
    : undefined;
}

/** The collector that produced a signal, lowercased; "" when the scan file didn't say. */
export function collectorOf(signal: ScanSignal): string {
  return firstString(signal.Source, signal.source);
}

/** The class of problem a signal reports — `other` for a collector anton doesn't know. */
export function classOfSignal(signal: ScanSignal): SignalClass {
  return CLASS_BY_COLLECTOR[collectorOf(signal)] ?? "other";
}

/**
 * How severe a signal is, resolved in falling order of authority: stringer's own severity if it
 * ever emits one, then its `Priority`, then what the kind/tags say, then the collector's default.
 */
export function severityOfSignal(signal: ScanSignal): ScanSeverity {
  const explicit = firstString(signal.Severity, signal.severity);
  const named = explicit ? normalizeSeverity(explicit) : undefined;
  if (named) return named;

  const fromPriority = severityFromPriority(signal.Priority ?? signal.priority);
  if (fromPriority) return fromPriority;

  const haystack = text(
    signal.Kind ?? signal.kind,
    ...(signal.Tags ?? signal.tags ?? []),
    collectorOf(signal),
  );
  for (const [pattern, severity] of KIND_SEVERITY_RULES) {
    if (pattern.test(haystack)) return severity;
  }

  return SEVERITY_BY_COLLECTOR[collectorOf(signal)] ?? UNKNOWN_COLLECTOR_SEVERITY;
}

/** What a bead triaged from a signal of some severity must carry. */
export interface SeverityRule {
  /** The `risk:` label — bd's vocabulary is low|high (see the `bd` skill). */
  risk: "low" | "high";
  /** bd priority, 0 = critical … 4 = backlog. */
  priority: number;
}

export type ScanSeverityPolicy = Record<ScanSeverity, SeverityRule>;

/**
 * The shipped mapping. It restates in one table what skills/scan-triage already says in prose —
 * security is always `risk:high`, debt is always `risk:low` — so triage stops re-deriving it per
 * scan and the health record can be read against the same scale.
 */
export const DEFAULT_SCAN_SEVERITY_POLICY: ScanSeverityPolicy = {
  critical: { risk: "high", priority: 0 },
  high: { risk: "high", priority: 1 },
  medium: { risk: "low", priority: 2 },
  low: { risk: "low", priority: 3 },
};

/** A project's stored overrides — per severity, all-or-nothing per entry. */
export type ScanSeverityOverrides = Partial<Record<ScanSeverity, SeverityRule>>;

/** The shipped mapping with a project's overrides applied — never partial. */
export function resolveScanSeverityPolicy(overrides?: ScanSeverityOverrides): ScanSeverityPolicy {
  return { ...DEFAULT_SCAN_SEVERITY_POLICY, ...(overrides ?? {}) };
}

/**
 * The mapping as the triage prompt receives it. Rendered rather than hard-coded in the skill so a
 * project's overrides actually reach the agent that labels the beads — a documented default the
 * prompt then contradicts would be worse than no documentation.
 */
export function formatScanSeverityPolicy(policy: ScanSeverityPolicy): string {
  return [
    "| severity | label | priority |",
    "| --- | --- | --- |",
    ...SCAN_SEVERITIES.map(
      (severity) =>
        `| ${severity} | risk:${policy[severity].risk} | P${policy[severity].priority} |`,
    ),
  ].join("\n");
}
