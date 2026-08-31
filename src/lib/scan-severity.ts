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
  /** Repo-relative path the finding is about; absent for a signal that isn't about one file. */
  FilePath?: string | null;
  filePath?: string | null;
  /** 1-based line the finding starts at; 0 when the collector is about the file as a whole. */
  Line?: number | null;
  line?: number | null;
  Kind?: string | null;
  kind?: string | null;
  /** The one-line finding, as stringer phrases it — some collectors put the whole claim in it. */
  Title?: string | null;
  title?: string | null;
  Description?: string | null;
  description?: string | null;
  Priority?: number | string | null;
  priority?: number | string | null;
  /** Not emitted today; read first if a future stringer adds it, rather than guessing around it. */
  Severity?: string | null;
  severity?: string | null;
  Tags?: string[] | null;
  tags?: string[] | null;
}

/** Anything that reads as a leaked credential, wherever it was found. */
const SECRET_PATTERN = /secret|credential|password|private[-_]?key|api[-_]?key/i;

/** Which class each stringer collector reports on (`stringer collectors list`). */
const CLASS_BY_COLLECTOR: Record<string, SignalClass> = {
  vuln: "security",
  githygiene: "risk", // merge-conflict markers, large binaries — its secrets refine to `security`
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
 * The severity a security-shaped signal cannot be scored BELOW, whatever else the scan file says.
 * A committed secret or a CVE is critical wherever it came from, and a collector's generic
 * `Priority` is a queueing hint rather than a security judgment — letting `Priority: 2` demote a
 * leaked key to `medium` would understate it on the trend AND file the bead at whatever the project
 * reserves for routine work.
 *
 * A floor, not an override: a signal already ranked worse (a P0 merge-conflict) keeps its rank.
 * Deliberately narrow and security-shaped — a generic word like "high" is NOT matched, because
 * `high-churn` is a churn signal, not a high-severity one.
 */
const SECURITY_SEVERITY_FLOORS: [pattern: RegExp, severity: ScanSeverity][] = [
  [SECRET_PATTERN, "critical"],
  [/\bcve\b|vulnerab|osv-/i, "critical"],
  [/merge[-_]?conflict|conflict[-_]?marker/i, "high"],
];

/**
 * Kind/tag patterns that refine the collector's default when nothing more specific ranked the
 * signal. Not a floor: these describe how a dependency is aging, so a collector that priced one
 * itself has the better number.
 */
const KIND_SEVERITY_RULES: [pattern: RegExp, severity: ScanSeverity][] = [
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

/**
 * Collectors that report on more than one class, refined by what the signal itself says. `githygiene`
 * finds committed secrets beside merge-conflict markers and large binaries — and the triage contract
 * files only the first as security, the rest as risk/hygiene cleanup. Classing them all `security`
 * would over-report the health panel's security column AND stamp an `AntonClass` triage then acts on.
 */
const CLASS_REFINEMENTS: Record<string, [pattern: RegExp, cls: SignalClass][]> = {
  githygiene: [[SECRET_PATTERN, "security"]],
};

/** The kind/tag/collector words a rule is matched against. */
function haystackOf(signal: ScanSignal): string {
  return text(
    signal.Kind ?? signal.kind,
    ...(signal.Tags ?? signal.tags ?? []),
    collectorOf(signal),
  );
}

/** The class of problem a signal reports — `other` for a collector anton doesn't know. */
export function classOfSignal(signal: ScanSignal): SignalClass {
  const collector = collectorOf(signal);
  const refinements = CLASS_REFINEMENTS[collector];
  if (refinements) {
    const haystack = haystackOf(signal);
    for (const [pattern, cls] of refinements) {
      if (pattern.test(haystack)) return cls;
    }
  }
  return CLASS_BY_COLLECTOR[collector] ?? "other";
}

/** The worse of two readings — SCAN_SEVERITIES is ordered worst-first, so the lower index wins. */
function worst(a: ScanSeverity, b: ScanSeverity): ScanSeverity {
  return SCAN_SEVERITIES.indexOf(a) <= SCAN_SEVERITIES.indexOf(b) ? a : b;
}

function matchRule(
  rules: [pattern: RegExp, severity: ScanSeverity][],
  haystack: string,
): ScanSeverity | undefined {
  for (const [pattern, severity] of rules) {
    if (pattern.test(haystack)) return severity;
  }
  return undefined;
}

/** Falling order of authority: stringer's own severity, its `Priority`, its kind, its collector. */
function rankSignal(signal: ScanSignal, haystack: string): ScanSeverity {
  const explicit = firstString(signal.Severity, signal.severity);
  const named = explicit ? normalizeSeverity(explicit) : undefined;
  if (named) return named;

  const fromPriority = severityFromPriority(signal.Priority ?? signal.priority);
  if (fromPriority) return fromPriority;

  return (
    matchRule(KIND_SEVERITY_RULES, haystack) ??
    SEVERITY_BY_COLLECTOR[collectorOf(signal)] ??
    UNKNOWN_COLLECTOR_SEVERITY
  );
}

/**
 * How severe a signal is: what the scan file's own ranking says, floored by
 * {@link SECURITY_SEVERITY_FLOORS} so a secret or a CVE can never be recorded below its worth.
 */
export function severityOfSignal(signal: ScanSignal): ScanSeverity {
  const haystack = haystackOf(signal);
  const ranked = rankSignal(signal, haystack);
  const floor = matchRule(SECURITY_SEVERITY_FLOORS, haystack);
  return floor ? worst(ranked, floor) : ranked;
}

/**
 * A signal carrying anton's own reading of it, as the scan file hands it to /scan-triage. Written
 * back into the scan file (lib/stringer) so the agent labels the signal anton COUNTED rather than
 * re-deriving a severity from the raw fields: the rules above are not all restatable in a prompt —
 * a `merge-conflict` kind at `Priority: 2` floors to `high` here — so an agent left to re-derive
 * would label a bead `medium`/P2 for a signal the trend charts as high.
 *
 * Deliberately NOT stringer's own `Severity` key: {@link rankSignal} reads that first, so reusing it
 * would make a re-scan of an annotated file echo anton's previous answer instead of stringer's input.
 */
export interface AnnotatedScanSignal extends ScanSignal {
  AntonSeverity: ScanSeverity;
  AntonClass: SignalClass;
}

/** The annotation keys, named once so stringer, the prompt, and the tests can't drift apart. */
export const ANTON_SEVERITY_KEY = "AntonSeverity";
export const ANTON_CLASS_KEY = "AntonClass";

/**
 * Stamp anton's derived reading onto a signal, IN PLACE — the caller re-serializes the envelope the
 * signal sits inside, so a copy would leave the scan file unannotated.
 */
export function annotateSignal(signal: ScanSignal): AnnotatedScanSignal {
  return Object.assign(signal, {
    [ANTON_SEVERITY_KEY]: severityOfSignal(signal),
    [ANTON_CLASS_KEY]: classOfSignal(signal),
  }) as AnnotatedScanSignal;
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
 * The shipped mapping — the one place a triaged bead's `risk:`/priority is decided, so triage stops
 * re-deriving it per scan and the health record can be read against the same scale. skills/scan-
 * triage's per-class rules say what becomes a bead and defer the labelling here, because a project
 * that overrides an entry must not meet prose insisting on the default.
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
