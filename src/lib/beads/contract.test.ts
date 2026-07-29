import { describe, expect, it } from "vitest";
import type { Bead } from "./types";
import {
  contractGaps,
  formatContractGaps,
  isContractJudged,
  isContractReadable,
  validateBeadContract,
  type ContractSection,
  type ContractSeverity,
} from "./contract";

/** The stamps bd puts on every issue it returns — what marks a bead as actually read (not projected). */
const STAMPS = { created_at: "2026-07-28T00:00:00Z", updated_at: "2026-07-28T00:00:00Z" };

const DESCRIPTION = [
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

/** A fully contract-complete ticket; overrides carve pieces out of it. */
const ticket = (over: Partial<Bead> = {}): Bead => ({
  id: "anton-1",
  title: "A shaped ticket",
  status: "open",
  issue_type: "task",
  description: DESCRIPTION,
  acceptance_criteria: "- [ ] it works",
  ...STAMPS,
  ...over,
});

/** A fully contract-complete epic: outcome + Success Criteria + exactly one `area:`. */
const epic = (over: Partial<Bead> = {}): Bead => ({
  id: "anton-e",
  title: "An outcome",
  status: "open",
  issue_type: "epic",
  description: "Reports are shareable outside the app.",
  acceptance_criteria: "- [ ] every report leaves the app in a customer-openable format",
  labels: ["area:reports"],
  ...STAMPS,
  ...over,
});

/** Drop one `## <heading>` block from a description, leaving the rest intact. */
function withoutSection(description: string, heading: string): string {
  const lines = description.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return [...lines.slice(0, start), ...(end === -1 ? [] : rest.slice(end))].join("\n");
}

const summarize = (bead: Bead): Array<[ContractSection, ContractSeverity]> =>
  validateBeadContract(bead).map((v) => [v.section, v.severity]);

describe("validateBeadContract — ticket tier (task / bug / feature)", () => {
  it.each(["task", "bug", "feature"])("passes a fully shaped %s", (issue_type) => {
    expect(validateBeadContract(ticket({ issue_type }))).toEqual([]);
  });

  // The table the ticket asks for: each section removed in turn, reported at its own severity.
  const CASES: Array<[string, Partial<Bead>, ContractSection, ContractSeverity]> = [
    ["acceptance", { acceptance_criteria: undefined }, "Acceptance", "blocking"],
    ["goal", { description: withoutSection(DESCRIPTION, "Goal") }, "Goal", "advisory"],
    ["context", { description: withoutSection(DESCRIPTION, "Context") }, "Context", "advisory"],
    [
      "out of scope",
      { description: withoutSection(DESCRIPTION, "Out of scope") },
      "Out of scope",
      "advisory",
    ],
    ["verify", { description: withoutSection(DESCRIPTION, "Verify") }, "Verify", "advisory"],
  ];

  it.each(CASES)("reports missing %s as one %s violation", (_name, over, section, severity) => {
    expect(summarize(ticket(over))).toEqual([[section, severity]]);
  });

  it("reports every section of a bead bd read but that carries nothing", () => {
    // bd omits empty fields from --json entirely, so "no description key" on a real read means the
    // description is empty — not that the read was shallow.
    expect(summarize({ id: "anton-2", title: "bare", status: "open", issue_type: "task", ...STAMPS }))
      .toEqual([
        ["Acceptance", "blocking"],
        ["Goal", "advisory"],
        ["Context", "advisory"],
        ["Out of scope", "advisory"],
        ["Verify", "advisory"],
      ]);
  });

  it("accepts Acceptance from either home — bd's field or `## Acceptance` in the description", () => {
    const inDescription = ticket({
      acceptance_criteria: undefined,
      description: `${DESCRIPTION}\n\n## Acceptance\n- [ ] it works`,
    });
    expect(validateBeadContract(inDescription)).toEqual([]);
    expect(validateBeadContract(ticket({ acceptance: "- [ ] it works", acceptance_criteria: undefined }))).toEqual([]);
  });

  it("treats an empty section body as no section", () => {
    expect(summarize(ticket({ description: DESCRIPTION.replace("Ship the thing.", "  ") }))).toEqual(
      [["Goal", "advisory"]],
    );
    expect(summarize(ticket({ acceptance_criteria: "   " }))).toEqual([["Acceptance", "blocking"]]);
  });

  it("reads headings case-, level- and punctuation-insensitively", () => {
    const loose = [
      "# goal",
      "why",
      "### Out-of-Scope:",
      "- nope",
      "#### VERIFY",
      "- tested",
      "## Context",
      "here",
    ].join("\n");
    expect(validateBeadContract(ticket({ description: loose }))).toEqual([]);
  });

  it("never blocks on more than Acceptance — the rest is advice", () => {
    const bare = ticket({ description: "", acceptance_criteria: "- [ ] it works" });
    expect(validateBeadContract(bare).every((v) => v.severity === "advisory")).toBe(true);
  });
});

describe("validateBeadContract — epic tier", () => {
  it("passes an epic carrying outcome + Success Criteria + one area:", () => {
    expect(validateBeadContract(epic())).toEqual([]);
  });

  it("does not ask an epic for the ticket sections — it is read, not executed", () => {
    // The epic's description is a one-liner with none of Goal/Context/Out of scope/Verify.
    expect(validateBeadContract(epic({ description: "One line of outcome." }))).toEqual([]);
  });

  it("blocks an epic with no Success Criteria", () => {
    expect(summarize(epic({ acceptance_criteria: undefined }))).toEqual([
      ["Success Criteria", "blocking"],
    ]);
  });

  it("accepts Success Criteria written as a description section", () => {
    const inDescription = epic({
      acceptance_criteria: undefined,
      description: "Outcome.\n\n## Success Criteria\n- [ ] shipped",
    });
    expect(validateBeadContract(inDescription)).toEqual([]);
  });

  it("reports an epic with no outcome", () => {
    expect(summarize(epic({ description: undefined }))).toEqual([["Outcome", "advisory"]]);
  });

  it.each([
    ["no", undefined],
    ["no", ["domain:eng"]],
    ["two", ["area:reports", "area:billing"]],
  ])("reports an epic with %s area: label", (_n, labels) => {
    expect(summarize(epic({ labels }))).toEqual([["area:", "advisory"]]);
  });

  it("names the offending labels when an epic carries several", () => {
    const [violation] = validateBeadContract(epic({ labels: ["area:reports", "area:billing"] }));
    expect(violation.message).toContain("area:reports, area:billing");
  });
});

describe("validateBeadContract — exempt types", () => {
  it.each(["chore", "learning", "molecule", undefined])("exempts %s", (issue_type) => {
    expect(
      validateBeadContract({
        id: "anton-3",
        title: "tidy up",
        status: "open",
        issue_type,
        ...STAMPS,
      }),
    ).toEqual([]);
  });
});

describe("shallow reads", () => {
  // The live hazard beads.parentOf exists for: reads populate different field sets. A bead that
  // never carried the contract fields must not be faulted for lacking them.
  const shallow: Bead = { id: "anton-4", title: "from a projection", status: "open", issue_type: "task" };

  it("reports nothing for a bead that carries no bd record fields", () => {
    expect(validateBeadContract(shallow)).toEqual([]);
    expect(isContractReadable(shallow)).toBe(false);
  });

  it("reports nothing for a shallow epic either", () => {
    expect(validateBeadContract({ ...shallow, issue_type: "epic" })).toEqual([]);
  });

  it("judges a bead as soon as a read carried any contract field or stamp", () => {
    expect(isContractReadable({ ...shallow, description: "" })).toBe(true);
    expect(isContractReadable({ ...shallow, acceptance_criteria: "- [ ] x" })).toBe(true);
    expect(isContractReadable({ ...shallow, ...STAMPS })).toBe(true);
  });
});

describe("isContractJudged", () => {
  // An empty violation list means "conformant" OR "never judged"; anything reporting a rate has to
  // tell those apart or it divides by the wrong denominator.
  it("separates a judged bead from an exempt or unread one", () => {
    expect(isContractJudged(ticket())).toBe(true);
    expect(isContractJudged(epic())).toBe(true);
    expect(isContractJudged(ticket({ issue_type: "chore" }))).toBe(false);
    expect(isContractJudged({ id: "anton-5", title: "projection", status: "open", issue_type: "task" })).toBe(false);
  });

  it("judges a bead that is readable but non-conformant", () => {
    const gap = ticket({ acceptance_criteria: undefined, description: "" });
    expect(isContractJudged(gap)).toBe(true);
    expect(validateBeadContract(gap).length).toBeGreaterThan(0);
  });
});

describe("contractGaps + formatContractGaps (the gates' shared input, anton-j9zs)", () => {
  const noAcceptance = ticket({ id: "anton-a", acceptance_criteria: undefined });
  const noGoal = ticket({ id: "anton-b", description: withoutSection(DESCRIPTION, "Goal") });

  it("collects only the requested severity, keeping input order", () => {
    const blocking = contractGaps([ticket(), noAcceptance, noGoal], "blocking");
    expect(blocking.map((g) => g.id)).toEqual(["anton-a"]);
    expect(blocking[0].violations.map((v) => v.section)).toEqual(["Acceptance"]);

    const advisory = contractGaps([noAcceptance, noGoal], "advisory");
    expect(advisory.map((g) => g.id)).toEqual(["anton-b"]);
    expect(advisory[0].violations.map((v) => v.section)).toEqual(["Goal"]);
  });

  it("reports nothing for a conformant, exempt, or never-read bead — none of those can gate a run", () => {
    const shallow: Bead = { id: "anton-p", title: "projection", status: "open", issue_type: "task" };
    expect(contractGaps([ticket(), epic(), ticket({ issue_type: "chore" }), shallow], "blocking")).toEqual([]);
  });

  it("faults an epic on Success Criteria, not Acceptance — the tiers gate on different sections", () => {
    const gaps = contractGaps([epic({ id: "anton-e2", acceptance_criteria: undefined })], "blocking");
    expect(gaps.map((g) => g.id)).toEqual(["anton-e2"]);
    expect(gaps[0].violations.map((v) => v.section)).toEqual(["Success Criteria"]);
  });

  it("formats one line naming every offender, its section, and the fix", () => {
    const line = formatContractGaps(contractGaps([noAcceptance, epic({ id: "anton-e3", acceptance_criteria: undefined })], "blocking"));
    expect(line).toContain("anton-a → no Acceptance criteria");
    expect(line).toContain("anton-e3 → no Success Criteria");
    expect(line).toContain("bd update --acceptance"); // the remedy travels with the gap
    expect(line.split("\n")).toHaveLength(1); // one line: it lands in a 422 body and a park note
  });

  it("formats empty gaps as an empty string", () => {
    expect(formatContractGaps([])).toBe("");
  });
});
