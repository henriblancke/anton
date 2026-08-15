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
 * Those same beads are measured a SECOND way (anton-5ltn): the form rate, "does the description
 * alone carry the contract" ({@link contractFormGaps}). Same denominator so the two rates compare;
 * separate from the violations because producer drift into bd's acceptance field is not a gap the
 * gate has — or should have — an opinion about. It never touches the exit code.
 *
 * Pure (no bd calls, no IO) so the shape of the report is unit-tested; `scripts/contract-report.ts`
 * is the shell that reads the boards and prints it.
 */
import { contractGatedBoard } from "../ticket-view";
import {
  contractFormGaps,
  isContractJudged,
  validateBeadContract,
  type ContractSection,
  type ContractViolation,
} from "./contract";
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

/** One bead whose DESCRIPTION does not carry the whole contract, and which sections it lacks. */
export interface ContractFormRow {
  id: string;
  title: string;
  issueType: string;
  status: string;
  /** In the contract's own reporting order — {@link contractFormGaps} returns it that way. */
  missing: ContractSection[];
}

/** How often one section is absent from the descriptions — the form line's "Acceptance 78" tally. */
export interface ContractFormSectionCount {
  section: ContractSection;
  count: number;
}

/**
 * The form question over the same denominator as the contract rate: does the markdown ALONE carry
 * every section the bead's tier owes ({@link contractFormGaps})?
 *
 * Never blocking and never in the exit code, by construction — a bead whose rubric lives only in
 * bd's `acceptance_criteria` field approves and runs today, correctly. This measures producer drift
 * into that shape, which is exactly the drift every existing check is blind to.
 */
export interface ContractFormReport {
  /** Beads whose description carries every section its tier owes — over the report's `judged`. */
  conformant: number;
  bySection: ContractFormSectionCount[];
  /** Only beads falling short, most sections missing first. A clean board reports an empty list. */
  rows: ContractFormRow[];
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
  /** The second, non-gating judgement over the same `judged` beads. */
  form: ContractFormReport;
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
    form: buildFormReport(judged),
  };
}

/**
 * The form judgement over the beads the contract rate already divides by, so the two rates read as
 * one board measured two ways. Calls {@link contractFormGaps} — the sections are never re-derived
 * here, exactly as the contract half calls {@link validateBeadContract}.
 */
function buildFormReport(judged: Bead[]): ContractFormReport {
  const rows = judged
    .map(formRowOf)
    .filter((row): row is ContractFormRow => row !== undefined)
    .sort(
      (a, b) => b.missing.length - a.missing.length || a.id.localeCompare(b.id),
    );
  return {
    conformant: judged.length - rows.length,
    bySection: tallyFormSections(rows),
    rows,
  };
}

/** A bead's form row, or undefined when its description carries the whole contract. */
function formRowOf(bead: Bead): ContractFormRow | undefined {
  const missing = contractFormGaps(bead);
  if (missing.length === 0) return undefined;
  return {
    id: bead.id,
    title: bead.title,
    issueType: bead.issue_type ?? "",
    status: bead.status,
    missing,
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

/** How often each section is absent from a description, most frequent first then by name. */
function tallyFormSections(rows: ContractFormRow[]): ContractFormSectionCount[] {
  const counts = new Map<ContractSection, number>();
  for (const section of rows.flatMap((r) => r.missing)) {
    counts.set(section, (counts.get(section) ?? 0) + 1);
  }
  return [...counts]
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count || a.section.localeCompare(b.section));
}

const pct = (part: number, whole: number) => (whole === 0 ? 100 : Math.round((part / whole) * 100));

const tally = (counts: ContractSectionCount[], severity: string) =>
  counts
    .filter((c) => c.severity === severity)
    .map((c) => `${c.section} ${c.count}`)
    .join(", ");

const formTally = (counts: ContractFormSectionCount[]) =>
  counts.map((c) => `${c.section} ${c.count}`).join(", ");

/**
 * The report as text: a headline the switch-on decision can be made from, then every violation by
 * bead and section, then the same beads' form gaps. Returned rather than printed so it is testable
 * and can be pasted into a bead.
 *
 * The form block is LAST and marked non-gating on purpose. It answers a different question over the
 * same denominator, and reading it as a second severity would misread the exit code — which stays
 * keyed to blocking Acceptance gaps alone.
 */
export function formatContractReport(report: ContractReport, label = ""): string {
  const head = label ? `${label}: ` : "";
  const lines = [
    `${head}${report.conformant}/${report.judged} run-gated beads conformant (${pct(report.conformant, report.judged)}%)`,
    `  BLOCKING ${report.blocking} across ${report.blocked} bead(s)${report.blocking ? ` — ${tally(report.bySection, "blocking")}` : ""}`,
    `  advisory ${report.advisory}${report.advisory ? ` — ${tally(report.bySection, "advisory")}` : ""}`,
    `  form     ${report.form.conformant}/${report.judged} descriptions carry every section (${pct(report.form.conformant, report.judged)}%)${report.form.rows.length ? ` — ${formTally(report.form.bySection)}` : ""}`,
  ];
  if (report.rows.length === 0) {
    lines.push("", "  No violations. The hard gate can be switched on without stranding work.");
  } else {
    lines.push("");
    for (const row of report.rows) {
      lines.push(`${row.id}  [${row.issueType}/${row.status}]  ${row.title}`);
      for (const v of row.violations) {
        const severity = v.severity === "blocking" ? "BLOCKING" : "advisory";
        lines.push(`    ${severity}  ${v.section.padEnd(16)} ${v.message}`);
      }
    }
  }
  if (report.form.rows.length > 0) {
    lines.push(
      "",
      "FORM — sections the description itself does not carry. Never blocking, never in the exit code:",
      "the gate reads acceptance from bd's field too, so a form gap alone never withholds a run" +
        // The BLOCKING caveat only reads as one when there is a BLOCKING list above to point at; on a
        // clean board it contradicts the "No violations" headline the operator just read.
        (report.blocking > 0 ? " — but a" : "."),
      ...(report.blocking > 0 ? ["bead listed BLOCKING above is refused all the same."] : []),
      "",
    );
    for (const row of report.form.rows) {
      lines.push(`${row.id}  [${row.issueType}/${row.status}]  ${row.title}`);
      lines.push(`    missing   ${row.missing.join(", ")}`);
    }
  }
  return lines.join("\n");
}
