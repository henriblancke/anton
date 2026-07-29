/**
 * The board's contract conformance, as one report (anton-odlr).
 *
 * Switching the hard gate on (anton-j9zs) strands any open bead that is missing Acceptance, so the
 * switch-on needs numbers rather than a hunch: which beads, which sections, at which severity. This
 * turns a bead list into exactly that, and is the same judgement the gate will apply — it calls
 * {@link validateBeadContract}, it does not re-implement it.
 *
 * Pure (no bd calls, no IO) so the shape of the report is unit-tested; `scripts/contract-report.ts`
 * is the shell that reads the boards and prints it.
 */
import { isContractJudged, validateBeadContract, type ContractViolation } from "./contract";
import type { Bead } from "./types";

/**
 * The statuses that count as open work. Closed is excluded — a closed bead's spec can no longer
 * strand a run. `deferred` is INCLUDED: a snoozed bead is work that comes back, and it would hit the
 * gate on the day it wakes, so leaving it out would make the report read better than the board is.
 */
export const OPEN_WORK_STATUSES = "open,in_progress,blocked,deferred";

export interface ContractReportRow {
  id: string;
  title: string;
  issueType: string;
  status: string;
  violations: ContractViolation[];
}

/** How often one section is missing across the board — the "5 Context, 2 Goal" line of the report. */
export interface ContractSectionCount {
  section: string;
  severity: string;
  count: number;
}

export interface ContractReport {
  /** Beads the contract applies to — the only honest denominator for a conformance rate. */
  judged: number;
  conformant: number;
  /** Beads carrying at least one BLOCKING violation: exactly what the hard gate would refuse. */
  blocked: number;
  blocking: number;
  advisory: number;
  bySection: ContractSectionCount[];
  /** Only beads with violations, worst first. A clean board reports an empty list. */
  rows: ContractReportRow[];
}

/** Blocking beads first, then the messiest, then by id so two runs of the report read the same. */
function severityRank(row: ContractReportRow): number {
  return row.violations.some((v) => v.severity === "blocking") ? 0 : 1;
}

/** Every way the given beads fall short of the contract, tallied and ordered for reading. */
export function buildContractReport(beads: Bead[]): ContractReport {
  const rows: ContractReportRow[] = [];
  const counts = new Map<string, ContractSectionCount>();
  let judged = 0;
  let blocking = 0;
  let advisory = 0;

  for (const bead of beads) {
    if (!isContractJudged(bead)) continue;
    judged++;
    const violations = validateBeadContract(bead);
    if (violations.length === 0) continue;
    for (const v of violations) {
      if (v.severity === "blocking") blocking++;
      else advisory++;
      const key = `${v.severity}:${v.section}`;
      const seen = counts.get(key);
      if (seen) seen.count++;
      else counts.set(key, { section: v.section, severity: v.severity, count: 1 });
    }
    rows.push({
      id: bead.id,
      title: bead.title,
      issueType: bead.issue_type ?? "",
      status: bead.status,
      violations,
    });
  }

  rows.sort(
    (a, b) =>
      severityRank(a) - severityRank(b) ||
      b.violations.length - a.violations.length ||
      a.id.localeCompare(b.id),
  );
  const bySection = [...counts.values()].sort(
    (a, b) =>
      Number(a.severity !== "blocking") - Number(b.severity !== "blocking") ||
      b.count - a.count ||
      a.section.localeCompare(b.section),
  );

  return {
    judged,
    conformant: judged - rows.length,
    blocked: rows.filter((r) => severityRank(r) === 0).length,
    blocking,
    advisory,
    bySection,
    rows,
  };
}

const pct = (part: number, whole: number) => (whole === 0 ? 100 : Math.round((part / whole) * 100));

const tally = (counts: ContractSectionCount[], severity: string) =>
  counts
    .filter((c) => c.severity === severity)
    .map((c) => `${c.section} ${c.count}`)
    .join(", ");

/**
 * The report as text: a headline the switch-on decision can be made from, then every violation by
 * bead and section. Returned rather than printed so it is testable and can be pasted into a bead.
 */
export function formatContractReport(report: ContractReport, label = ""): string {
  const head = label ? `${label}: ` : "";
  const lines = [
    `${head}${report.conformant}/${report.judged} open work beads conformant (${pct(report.conformant, report.judged)}%)`,
    `  BLOCKING ${report.blocking} across ${report.blocked} bead(s)${report.blocking ? ` — ${tally(report.bySection, "blocking")}` : ""}`,
    `  advisory ${report.advisory}${report.advisory ? ` — ${tally(report.bySection, "advisory")}` : ""}`,
  ];
  if (report.rows.length === 0) {
    lines.push("", "  No violations. The hard gate can be switched on without stranding work.");
    return lines.join("\n");
  }
  lines.push("");
  for (const row of report.rows) {
    lines.push(`${row.id}  [${row.issueType}/${row.status}]  ${row.title}`);
    for (const v of row.violations) {
      const severity = v.severity === "blocking" ? "BLOCKING" : "advisory";
      lines.push(`    ${severity}  ${v.section.padEnd(16)} ${v.message}`);
    }
  }
  return lines.join("\n");
}
