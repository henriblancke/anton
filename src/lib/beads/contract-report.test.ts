import { describe, expect, it } from "vitest";
import type { Bead } from "./types";
import { buildContractReport, formatContractReport } from "./contract-report";

const STAMPS = { created_at: "2026-07-28T00:00:00Z", updated_at: "2026-07-28T00:00:00Z" };

/** Four of the five, in the contract's own order — Goal → Context → Out of scope → Verify. The
 * rubric is absent on purpose: like most of the board, the fixture's acceptance lives only in bd's
 * field. */
const SHAPED = [
  "## Goal",
  "Ship the thing.",
  "",
  "## Context",
  "touches: src/lib/beads/contract.ts",
  "",
  "## Out of scope",
  "- not the other thing",
  "",
  "## Verify",
  "- unit test covers it",
].join("\n");

const ticket = (over: Partial<Bead> = {}): Bead => ({
  id: "anton-1",
  title: "A shaped ticket",
  status: "open",
  issue_type: "task",
  description: SHAPED,
  acceptance_criteria: "- [ ] it works",
  ...STAMPS,
  ...over,
});

/** The rubric written into the DESCRIPTION too, in the contract's own position — after Goal, ahead
 * of Context (skills/bd/SKILL.md) — so a fixture meant to be form-conformant carries the order too. */
function withRubric(description: string): string {
  const at = description.indexOf("## Context");
  expect(at).toBeGreaterThanOrEqual(0);
  return `${description.slice(0, at)}## Acceptance Criteria\n- [ ] it works\n\n${description.slice(at)}`;
}

/** The same sections, re-emitted in the given order — how order drift is staged. */
function reorder(description: string, headings: string[]): string {
  return headings
    .map((h) => {
      const lines = description.split("\n");
      const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${h.toLowerCase()}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((l) => l.startsWith("## "));
      return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n").trim();
    })
    .join("\n\n");
}

/** Drop one `## <heading>` block, leaving the rest intact — how each gap under test is created. */
function without(description: string, heading: string): string {
  const lines = description.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return [...lines.slice(0, start), ...(end === -1 ? [] : rest.slice(end))].join("\n");
}

describe("buildContractReport", () => {
  it("reports nothing and counts everything conformant on a clean board", () => {
    const report = buildContractReport([ticket(), ticket({ id: "anton-2", issue_type: "feature" })]);
    expect(report).toMatchObject({ judged: 2, conformant: 2, blocked: 0, blocking: 0, advisory: 0 });
    expect(report.rows).toEqual([]);
    expect(report.bySection).toEqual([]);
  });

  // The denominator is the whole point: an exempt or unread bead is "not judged", NOT "conformant".
  // Both ride on a feature's run here, so it is the tier check dropping them, not the run gate.
  it("excludes exempt tiers and unread beads from the denominator", () => {
    const report = buildContractReport([
      ticket({ id: "anton-f", issue_type: "feature" }),
      ticket({
        id: "anton-l",
        issue_type: "learning",
        parent: "anton-f",
        description: "",
        acceptance_criteria: "",
      }),
      { id: "anton-p", title: "A graph projection", status: "open", issue_type: "task", parent: "anton-f" },
    ]);
    expect(report.judged).toBe(1);
    expect(report.conformant).toBe(1);
    expect(report.rows).toEqual([]);
  });

  it("tallies each missing section by severity", () => {
    const report = buildContractReport([
      ticket({ id: "anton-a", acceptance_criteria: undefined }),
      ticket({ id: "anton-b", description: without(SHAPED, "Context") }),
      ticket({ id: "anton-c", description: without(SHAPED, "Context") }),
      ticket({ id: "anton-d", description: without(SHAPED, "Verify") }),
    ]);
    expect(report).toMatchObject({ judged: 4, conformant: 0, blocked: 1, blocking: 1, advisory: 3 });
    expect(report.bySection).toEqual([
      { section: "Acceptance", severity: "blocking", count: 1 },
      { section: "Context", severity: "advisory", count: 2 },
      { section: "Verify", severity: "advisory", count: 1 },
    ]);
  });

  it("orders blocking beads first, then the messiest, then by id", () => {
    const report = buildContractReport([
      ticket({ id: "anton-tidy", description: without(SHAPED, "Verify") }),
      ticket({ id: "anton-messy", description: without(without(SHAPED, "Verify"), "Goal") }),
      ticket({ id: "anton-also", description: without(SHAPED, "Goal") }),
      ticket({ id: "anton-block", acceptance_criteria: undefined }),
    ]);
    expect(report.rows.map((r) => r.id)).toEqual([
      "anton-block",
      "anton-messy",
      "anton-also",
      "anton-tidy",
    ]);
  });

  it("carries the identifying fields a repair session needs per row", () => {
    const [row] = buildContractReport([
      ticket({ id: "anton-x", title: "Fix it", issue_type: "bug", status: "in_progress", acceptance_criteria: undefined }),
    ]).rows;
    expect(row).toMatchObject({
      id: "anton-x",
      title: "Fix it",
      issueType: "bug",
      status: "in_progress",
    });
    expect(row.violations.map((v) => v.section)).toEqual(["Acceptance"]);
  });

  // A legacy epic runs its own children, so its rubric is the one that run's self-review scores
  // against — its gap strands work and must count.
  it("counts a runnable epic's missing Success Criteria as blocking", () => {
    const report = buildContractReport([
      {
        id: "anton-e",
        title: "An outcome",
        status: "open",
        issue_type: "epic",
        description: "Reports are shareable outside the app.",
        labels: ["area:reports"],
        ...STAMPS,
      },
      ticket({ id: "anton-t", parent: "anton-e" }),
    ]);
    expect(report).toMatchObject({ judged: 2, blocked: 1, blocking: 1, advisory: 0 });
    expect(report.rows.map((r) => r.id)).toEqual(["anton-e"]);
  });

  // The exit code means "switching the hard gate on would strand work", so only beads a gate reads
  // may count. A container epic can't be approved or run, and no feature's gate reads its parent.
  it("ignores a container epic's own gaps and judges its features instead", () => {
    const report = buildContractReport([
      { id: "anton-c", title: "A container", status: "open", issue_type: "epic", ...STAMPS },
      ticket({ id: "anton-f", issue_type: "feature", parent: "anton-c" }),
    ]);
    expect(report).toMatchObject({ judged: 1, conformant: 1, blocking: 0, advisory: 0 });
    expect(report.rows).toEqual([]);
  });

  // Same reason, the other shape of unreachable work: a chore is never a run target on its own, so
  // no gate ever reads a parentless one — but the run of the feature it rides on does.
  it("judges a chore only when it rides on a run", () => {
    const loose = buildContractReport([
      ticket({ id: "anton-ch", issue_type: "chore", acceptance_criteria: undefined }),
    ]);
    expect(loose).toMatchObject({ judged: 0, blocking: 0 });
    expect(loose.rows).toEqual([]);

    const riding = buildContractReport([
      ticket({ id: "anton-f", issue_type: "feature" }),
      ticket({
        id: "anton-ch",
        issue_type: "chore",
        parent: "anton-f",
        acceptance_criteria: undefined,
      }),
    ]);
    expect(riding).toMatchObject({ judged: 2, blocked: 1, blocking: 1 });
    expect(riding.rows.map((r) => r.id)).toEqual(["anton-ch"]);
  });

  // A closed bead's spec can no longer strand a run — nothing re-reads it. A deferred one wakes up
  // and hits the gate on that day, so it stays in the denominator.
  it("drops closed beads but keeps deferred ones", () => {
    const report = buildContractReport([
      ticket({ id: "anton-f", issue_type: "feature" }),
      ticket({ id: "anton-done", parent: "anton-f", status: "closed", acceptance_criteria: undefined }),
      ticket({ id: "anton-later", parent: "anton-f", status: "deferred", acceptance_criteria: undefined }),
    ]);
    expect(report).toMatchObject({ judged: 2, blocked: 1, blocking: 1 });
    expect(report.rows.map((r) => r.id)).toEqual(["anton-later"]);
  });
});

// The second question over the same beads: does the DESCRIPTION alone carry the contract? A bead
// whose rubric lives only in bd's field passes the gate and falls short here — that is the drift
// this rate exists to make visible.
describe("buildContractReport form rate", () => {
  const withAcceptance = (over: Partial<Bead> = {}) =>
    ticket({ ...over, description: withRubric(over.description ?? SHAPED) });

  it("divides by the same denominator as the contract rate", () => {
    const report = buildContractReport([
      withAcceptance({ id: "anton-f", issue_type: "feature" }),
      // Exempt and unread beads are not judged, so neither rate may count them.
      ticket({ id: "anton-l", issue_type: "learning", parent: "anton-f", description: "" }),
      { id: "anton-p", title: "A projection", status: "open", issue_type: "task", parent: "anton-f" },
    ]);
    expect(report.judged).toBe(1);
    expect(report.form).toMatchObject({ conformant: 1, rows: [] });
    expect(report.form.bySection).toEqual([]);
  });

  it("faults a bead whose acceptance lives only in bd's field, without blocking it", () => {
    const report = buildContractReport([ticket({ id: "anton-fieldonly" })]);
    expect(report).toMatchObject({ judged: 1, conformant: 1, blocking: 0, advisory: 0 });
    expect(report.form.conformant).toBe(0);
    expect(report.form.rows).toEqual([
      {
        id: "anton-fieldonly",
        title: "A shaped ticket",
        issueType: "task",
        status: "open",
        missing: ["Acceptance"],
        misplaced: [],
      },
    ]);
  });

  // The exit code is `report.blocking`, so form drift must leave it at zero however wide it gets.
  it("keeps the exit-code counters untouched by form gaps", () => {
    const report = buildContractReport([
      ticket({ id: "anton-a" }),
      ticket({ id: "anton-b" }),
      withAcceptance({ id: "anton-c" }),
    ]);
    expect(report).toMatchObject({ judged: 3, conformant: 3, blocked: 0, blocking: 0, advisory: 0 });
    expect(report.form.rows.map((r) => r.id)).toEqual(["anton-a", "anton-b"]);
  });

  it("tallies each absent section and lists the messiest bead first", () => {
    const report = buildContractReport([
      ticket({ id: "anton-tidy" }),
      ticket({ id: "anton-messy", description: without(without(SHAPED, "Verify"), "Goal") }),
      withAcceptance({ id: "anton-also", description: without(SHAPED, "Verify") }),
    ]);
    expect(report.form.rows.map((r) => [r.id, r.missing])).toEqual([
      ["anton-messy", ["Goal", "Acceptance", "Verify"]],
      ["anton-also", ["Verify"]],
      ["anton-tidy", ["Acceptance"]],
    ]);
    expect(report.form.bySection).toEqual([
      { section: "Acceptance", count: 2 },
      { section: "Verify", count: 2 },
      { section: "Goal", count: 1 },
    ]);
  });

  // A description holding all five in the wrong sequence is drift, not conformance (anton-um80) —
  // and the report must say which repair it needs: move the section, do not author it.
  it("counts a shuffled description as falling short, and tallies order apart from absence", () => {
    const shuffled = reorder(withRubric(SHAPED), [
      "Goal",
      "Acceptance Criteria",
      "Out of scope",
      "Verify",
      "Context",
    ]);
    const report = buildContractReport([
      ticket({ id: "anton-order", description: shuffled }),
      ticket({ id: "anton-tidy", description: withRubric(SHAPED) }),
    ]);
    // The gate is untouched by order: neither bead carries a violation, and the exit code stays 0.
    expect(report).toMatchObject({ judged: 2, conformant: 2, blocked: 0, blocking: 0, advisory: 0 });
    expect(report.form.conformant).toBe(1);
    expect(report.form.rows).toEqual([
      {
        id: "anton-order",
        title: "A shaped ticket",
        issueType: "task",
        status: "open",
        missing: [],
        misplaced: ["Context"],
      },
    ]);
    expect(report.form.bySection).toEqual([]);
    expect(report.form.misplacedBySection).toEqual([{ section: "Context", count: 1 }]);
  });

  // Absent sections are the bigger failure, so they rank a row ahead of a merely shuffled one.
  it("ranks a bead missing sections ahead of one that only has them out of order", () => {
    const report = buildContractReport([
      ticket({
        id: "anton-shuffled",
        description: reorder(withRubric(SHAPED), [
          "Verify",
          "Out of scope",
          "Context",
          "Acceptance Criteria",
          "Goal",
        ]),
      }),
      ticket({ id: "anton-absent", description: without(withRubric(SHAPED), "Verify") }),
    ]);
    expect(report.form.rows.map((r) => [r.id, r.missing, r.misplaced])).toEqual([
      ["anton-absent", ["Verify"], []],
      ["anton-shuffled", [], ["Acceptance", "Context", "Out of scope", "Verify"]],
    ]);
  });

  // An epic answers for its own two sections, not a ticket's five — the form judgement is tiered
  // exactly as the gate is.
  it("judges a runnable epic on its outcome and Success Criteria", () => {
    const report = buildContractReport([
      {
        id: "anton-e",
        title: "An outcome",
        status: "open",
        issue_type: "epic",
        description: "Reports are shareable outside the app.",
        acceptance_criteria: "- [ ] every report has a public link",
        labels: ["area:reports"],
        ...STAMPS,
      },
      withAcceptance({ id: "anton-t", parent: "anton-e" }),
    ]);
    expect(report.form.rows.map((r) => [r.id, r.missing])).toEqual([
      ["anton-e", ["Success Criteria"]],
    ]);
  });
});

describe("formatContractReport", () => {
  it("states the switch-on is safe when the board is clean", () => {
    const text = formatContractReport(buildContractReport([ticket()]));
    expect(text).toContain("1/1 run-gated beads conformant (100%)");
    expect(text).toContain("BLOCKING 0");
    expect(text).toContain("No violations.");
  });

  it("names every violation by bead and section", () => {
    const text = formatContractReport(
      buildContractReport([
        ticket({ id: "anton-a", title: "Needs a rubric", acceptance_criteria: undefined }),
        ticket({ id: "anton-b", description: without(SHAPED, "Context") }),
      ]),
    );
    expect(text).toContain("0/2 run-gated beads conformant (0%)");
    expect(text).toContain("BLOCKING 1 across 1 bead(s) — Acceptance 1");
    expect(text).toContain("advisory 1 — Context 1");
    expect(text).toContain("anton-a  [task/open]  Needs a rubric");
    expect(text).toMatch(/BLOCKING {2}Acceptance/);
    expect(text).toMatch(/advisory {2}Context/);
  });

  it("prints the form rate over the contract rate's denominator and names what each lacks", () => {
    const text = formatContractReport(
      buildContractReport([
        ticket({ id: "anton-a", title: "Rubric in bd's field" }),
        ticket({ id: "anton-b", description: withRubric(SHAPED) }),
      ]),
    );
    expect(text).toContain("2/2 run-gated beads conformant (100%)");
    expect(text).toContain("form     1/2 descriptions carry every section, in order (50%) — missing Acceptance 1");
    expect(text).toContain("anton-a  [task/open]  Rubric in bd's field");
    expect(text).toContain("missing   Acceptance");
    expect(text).toContain("Never blocking, never in the exit code");
  });

  // A board with no violations still reports its form gaps: the switch-on verdict and the form rate
  // are separate readings, and the clean-board message must not swallow the second.
  it("reports form gaps beside the clean-board verdict", () => {
    const text = formatContractReport(buildContractReport([ticket({ id: "anton-a" })]));
    expect(text).toContain("No violations.");
    expect(text).toContain("form     0/1 descriptions carry every section, in order (0%)");
    expect(text).toContain("anton-a  [task/open]");
    expect(text).toContain("a form gap alone never withholds a run.");
    expect(text).not.toContain("BLOCKING above");
  });

  it("keeps the BLOCKING caveat only when a bead is listed BLOCKING above", () => {
    const text = formatContractReport(
      buildContractReport([ticket({ id: "anton-a", acceptance_criteria: undefined })]),
    );
    expect(text).toContain("BLOCKING 1 across 1 bead(s)");
    expect(text).toContain("bead listed BLOCKING above is refused all the same.");
  });

  it("says nothing about form when every description carries the contract", () => {
    const text = formatContractReport(
      buildContractReport([ticket({ description: withRubric(SHAPED) })]),
    );
    expect(text).toContain("form     1/1 descriptions carry every section, in order (100%)");
    expect(text).not.toContain("missing ");
  });

  it("prints a misplaced section on its own line, so the repair is not confused with authoring", () => {
    const text = formatContractReport(
      buildContractReport([
        ticket({
          id: "anton-order",
          title: "Context appended by --context",
          description: reorder(withRubric(SHAPED), [
            "Goal",
            "Acceptance Criteria",
            "Out of scope",
            "Verify",
            "Context",
          ]),
        }),
      ]),
    );
    expect(text).toContain(
      "form     0/1 descriptions carry every section, in order (0%) — out of order Context 1",
    );
    expect(text).toContain("misplaced Context");
    expect(text).not.toContain("missing ");
    expect(text).toContain("Never blocking, never in the exit code");
  });

  it("prefixes the headline with the board when several are reported", () => {
    expect(formatContractReport(buildContractReport([ticket()]), "/repos/anton")).toContain(
      "/repos/anton: 1/1",
    );
  });
});
