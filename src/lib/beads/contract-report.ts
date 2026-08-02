/**
 * The board's contract conformance, as one report (anton-odlr).
 *
 * Switching the hard gate on (anton-j9zs) strands any open bead that is missing Acceptance, so the
 * switch-on needs numbers rather than a hunch: which beads, which sections, at which severity. This
 * turns a bead list into exactly that, and is the same judgement the gate will apply — it calls
 * {@link validateBeadContract}, it does not re-implement it.
 *
 * Judged over the beads the RUN GATE evaluates ({@link contractGatedBoard}), not every bead the
 * contract has an opinion about. The exit code means "turning the gate on would strand work", so
 * work no gate can reach must not count: a container epic can't be approved, and no feature's gate
 * reads its parent, so counting its missing Success Criteria as blocking would fail the command over
 * a run that was never going to be refused.
 *
 * Pure (no bd calls, no IO) so the shape of the report is unit-tested; `scripts/contract-report.ts`
 * is the shell that reads the boards and prints it.
 */
import { contractGatedBoard } from "../ticket-view";
import { isContractJudged, validateBeadContract, type ContractViolation } from "./contract";
import type { Bead } from "./types";

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
  /** Run-gated beads the contract applies to — the only honest denominator for a conformance rate. */
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

/** Does this row carry a gap the hard gate would refuse the run over? Blocking rows rank first. */
function severityRank(row: ContractReportRow): number {
  return row.violations.some((v) => v.severity === "blocking") ? 0 : 1;
}

/**
 * Every way this board's run-gated beads fall short of the contract, tallied and ordered for reading.
 *
 * Takes the WHOLE board, closed beads included — {@link contractGatedBoard} needs the parent graph to
 * tell a container epic from a run target, and drops the closed and resume-skipped beads itself.
 */
export function buildContractReport(all: Bead[]): ContractReport {
  const judged = contractGatedBoard(all).filter(isContractJudged);
  const rows = judged
    .map(rowOf)
    .filter((row): row is ContractReportRow => row !== undefined)
    .sort(byWorstFirst);
  const violations = rows.flatMap((row) => row.violations);

  return {
    judged: judged.length,
    conformant: judged.length - rows.length,
    blocked: rows.filter((r) => severityRank(r) === 0).length,
    blocking: violations.filter((v) => v.severity === "blocking").length,
    advisory: violations.filter((v) => v.severity !== "blocking").length,
    bySection: tallySections(violations),
    rows,
  };
}

/** A bead's row, or undefined when it is conformant — the report lists only what falls short. */
function rowOf(bead: Bead): ContractReportRow | undefined {
  const violations = validateBeadContract(bead);
  if (violations.length === 0) return undefined;
  return {
    id: bead.id,
    title: bead.title,
    issueType: bead.issue_type ?? "",
    status: bead.status,
    violations,
  };
}

/** Blocking beads first, then the messiest, then by id so two runs of the report read the same. */
function byWorstFirst(a: ContractReportRow, b: ContractReportRow): number {
  return (
    severityRank(a) - severityRank(b) ||
    b.violations.length - a.violations.length ||
    a.id.localeCompare(b.id)
  );
}

/** How often each section is missing, blocking sections first then by frequency. */
function tallySections(violations: ContractViolation[]): ContractSectionCount[] {
  const counts = new Map<string, ContractSectionCount>();
  for (const v of violations) {
    const key = `${v.severity}:${v.section}`;
    const seen = counts.get(key);
    if (seen) seen.count++;
    else counts.set(key, { section: v.section, severity: v.severity, count: 1 });
  }
  return [...counts.values()].sort(
    (a, b) =>
      Number(a.severity !== "blocking") - Number(b.severity !== "blocking") ||
      b.count - a.count ||
      a.section.localeCompare(b.section),
  );
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
    `${head}${report.conformant}/${report.judged} run-gated beads conformant (${pct(report.conformant, report.judged)}%)`,
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
