import { describe, expect, it } from "vitest";
import type { Bead } from "./types";
import {
  buildContractReport,
  formatContractReport,
  OPEN_WORK_STATUSES,
} from "./contract-report";

const STAMPS = { created_at: "2026-07-28T00:00:00Z", updated_at: "2026-07-28T00:00:00Z" };

const SHAPED = [
  "## Goal",
  "Ship the thing.",
  "",
  "## Out of scope",
  "- not the other thing",
  "",
  "## Verify",
  "- unit test covers it",
  "",
  "## Context",
  "touches: src/lib/beads/contract.ts",
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
  it("excludes exempt tiers and unread beads from the denominator", () => {
    const report = buildContractReport([
      ticket(),
      ticket({ id: "anton-l", issue_type: "learning", description: "", acceptance_criteria: "" }),
      { id: "anton-p", title: "A graph projection", status: "open", issue_type: "task" },
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

  it("counts an epic's missing Success Criteria as blocking", () => {
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
    ]);
    expect(report).toMatchObject({ judged: 1, blocked: 1, blocking: 1, advisory: 0 });
  });
});

describe("formatContractReport", () => {
  it("states the switch-on is safe when the board is clean", () => {
    const text = formatContractReport(buildContractReport([ticket()]));
    expect(text).toContain("1/1 open work beads conformant (100%)");
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
    expect(text).toContain("0/2 open work beads conformant (0%)");
    expect(text).toContain("BLOCKING 1 across 1 bead(s) — Acceptance 1");
    expect(text).toContain("advisory 1 — Context 1");
    expect(text).toContain("anton-a  [task/open]  Needs a rubric");
    expect(text).toMatch(/BLOCKING {2}Acceptance/);
    expect(text).toMatch(/advisory {2}Context/);
  });

  it("prefixes the headline with the board when several are reported", () => {
    expect(formatContractReport(buildContractReport([ticket()]), "/repos/anton")).toContain(
      "/repos/anton: 1/1",
    );
  });
});

describe("OPEN_WORK_STATUSES", () => {
  // A closed bead can no longer strand a run; a deferred one wakes up and hits the gate.
  it("covers every non-closed status", () => {
    expect(OPEN_WORK_STATUSES.split(",")).toEqual(["open", "in_progress", "blocked", "deferred"]);
  });
});
