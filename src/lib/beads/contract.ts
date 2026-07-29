/**
 * The bead contract, in one place (anton-crj5).
 *
 * "Is this bead runnable" is judged at three sites — the approve route, execute-epic, and the
 * board — so the judgement lives here as one pure function rather than three copies that drift.
 * This module only REPORTS; gating is the caller's (anton-j9zs).
 *
 * Severity is the whole point of the split. Only Acceptance BLOCKS: it is the run's definition of
 * done and the rubric self-review scores the diff against, so without it the work is unrunnable.
 * Goal / Context / Out of scope / Verify degrade quality without making it unrunnable — they warn.
 *
 * Two parsing facts this encodes (both measured against bd 1.1.0, 2026-07-28):
 *
 * 1. The contract lives in the DESCRIPTION markdown. `--context` is sugar that appends a
 *    `## Context` section to it; there is no `context` field in `--json`. `acceptance_criteria`
 *    (bd's own field, rendered "Success Criteria" for an epic) is the one genuinely separate home —
 *    and beads edited through the ticket dialog also keep it as `## Acceptance` in the description,
 *    so either home satisfies it.
 * 2. bd OMITS empty fields from `--json` rather than emitting `""` — a bead created with no
 *    description comes back with no `description` key at all. So an absent field cannot be read as
 *    "the section is there, we just didn't fetch it"; on a bead that came from a bd read it is a
 *    genuine gap. What must never be faulted is a bead that never came from one — see
 *    {@link isContractReadable}.
 *
 * Contract text: skills/bd/SKILL.md. Kept dependency-free (a type-only import) so the API route,
 * the job runner, and the board can all import it.
 */
import type { Bead } from "./types";

export type ContractSeverity = "blocking" | "advisory";

/** The piece of the contract a violation points at. Which apply depends on the bead's tier. */
export type ContractSection =
  | "Acceptance"
  | "Goal"
  | "Context"
  | "Out of scope"
  | "Verify"
  | "Outcome"
  | "Success Criteria"
  | "area:";

export interface ContractViolation {
  section: ContractSection;
  severity: ContractSeverity;
  /** One line naming the gap and its fix — ready for a 422 body, a park note, or a board tooltip. */
  message: string;
}

/**
 * Which requirements a bead answers to. `epic` is read, not executed, so it carries less; `exempt`
 * covers `chore` and every non-work type (`learning`, `molecule`, …) — plus a bead whose type the
 * read didn't carry, which cannot be classified and is therefore never faulted.
 */
type ContractTier = "ticket" | "epic" | "exempt";

function tierOf(bead: Bead): ContractTier {
  switch (bead.issue_type) {
    case "task":
    case "bug":
    case "feature":
      return "ticket";
    case "epic":
      return "epic";
    default:
      return "exempt";
  }
}

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** Heading text → comparison key, case- and punctuation-insensitive: `## Out-of-Scope:` → `outofscope`. */
const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Section bodies of a description, keyed by slugged heading. A repeated heading concatenates. */
function sectionsOf(description: string): Map<string, string> {
  const out = new Map<string, string>();
  let key: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (!key) return;
    const text = [out.get(key), body.join("\n").trim()].filter(Boolean).join("\n");
    out.set(key, text);
  };
  for (const line of description.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      key = slug(heading[1]);
      body = [];
      continue;
    }
    if (key) body.push(line);
  }
  flush();
  return out;
}

interface SectionRule {
  section: ContractSection;
  severity: ContractSeverity;
  /** Slugged headings that satisfy the rule. */
  keys: string[];
  message: string;
}

/** The four advisory sections every task/bug/feature carries, in the order they read best. */
const TICKET_RULES: SectionRule[] = [
  {
    section: "Goal",
    severity: "advisory",
    keys: ["goal"],
    message: "no `## Goal` section — nothing states what the work is for",
  },
  {
    section: "Context",
    severity: "advisory",
    keys: ["context"],
    message:
      "no `## Context` section — the agent has to rediscover which files and patterns apply (`bd update --context` appends one)",
  },
  {
    section: "Out of scope",
    severity: "advisory",
    keys: ["outofscope"],
    message: "no `## Out of scope` section — nothing bounds the change",
  },
  {
    section: "Verify",
    severity: "advisory",
    keys: ["verify", "verification"],
    message: "no `## Verify` section — no stated way to prove the work landed",
  },
];

const ACCEPTANCE_KEYS = ["acceptance", "acceptancecriteria"];
const SUCCESS_KEYS = ["successcriteria", "success", ...ACCEPTANCE_KEYS];

/** bd's own acceptance field, under either name a read populates it with. */
const acceptanceField = (bead: Bead): string =>
  (typeof bead.acceptance_criteria === "string" ? bead.acceptance_criteria : "").trim() ||
  (typeof bead.acceptance === "string" ? bead.acceptance : "").trim();

/**
 * Did this bead come from a bd read — one that WOULD have carried the contract fields had the bead
 * had them? `bd list` / `show` / `ready` / `dep list` all return the full issue record: bd's own
 * created/updated stamps, and description/acceptance whenever they are non-empty. A bead assembled
 * anywhere else (a graph node, a fixture, a projection of id + title + type) carries none of those,
 * and faulting it would report sections that were simply never read.
 *
 * Callers that must tell "conformant" from "not judged" — the board — check this first;
 * {@link validateBeadContract} reports nothing when it is false.
 */
export function isContractReadable(bead: Bead): boolean {
  return (
    typeof bead.description === "string" ||
    typeof bead.acceptance_criteria === "string" ||
    typeof bead.acceptance === "string" ||
    typeof bead.created_at === "string" ||
    typeof bead.updated_at === "string"
  );
}

/**
 * Does the contract apply to this bead at all? False for an exempt tier and for a bead no bd read
 * produced. An empty {@link validateBeadContract} means two different things — "conformant" and
 * "never judged" — so anything reporting a conformance RATE must divide by this, not by the board.
 */
export function isContractJudged(bead: Bead): boolean {
  return tierOf(bead) !== "exempt" && isContractReadable(bead);
}

/**
 * Every way this bead falls short of the contract for its tier — empty when it is complete, exempt,
 * or not readable. Pure: no bd calls, no IO.
 */
export function validateBeadContract(bead: Bead): ContractViolation[] {
  const tier = tierOf(bead);
  if (tier === "exempt" || !isContractReadable(bead)) return [];

  const description = typeof bead.description === "string" ? bead.description : "";
  const sections = sectionsOf(description);
  // A heading with an empty body is as absent as no heading at all — it carries no spec.
  const has = (keys: string[]) => keys.some((k) => (sections.get(k) ?? "").trim() !== "");
  const acceptance = acceptanceField(bead);
  const violations: ContractViolation[] = [];

  // An epic is read, not executed: a one-line outcome, the Success Criteria its features add up to,
  // and the one `area:` label the roadmap groups by (skills/bd/SKILL.md).
  if (tier === "epic") {
    if (description.trim() === "") {
      violations.push({
        section: "Outcome",
        severity: "advisory",
        message: "no outcome — an epic's description is the result its features add up to",
      });
    }
    if (!acceptance && !has(SUCCESS_KEYS)) {
      violations.push({
        section: "Success Criteria",
        severity: "blocking",
        message:
          "no Success Criteria — nothing states when the outcome is reached (`bd update --acceptance`)",
      });
    }
    violations.push(...areaViolations(bead));
    return violations;
  }

  if (!acceptance && !has(ACCEPTANCE_KEYS)) {
    violations.push({
      section: "Acceptance",
      severity: "blocking",
      message:
        "no Acceptance criteria — the run has no definition of done and self-review has no rubric (`bd update --acceptance`)",
    });
  }
  for (const rule of TICKET_RULES) {
    if (!has(rule.keys)) {
      violations.push({ section: rule.section, severity: rule.severity, message: rule.message });
    }
  }
  return violations;
}

/** Exactly one `area:` label — the roadmap's Area column and Linear project routing key on it. */
function areaViolations(bead: Bead): ContractViolation[] {
  const areas = (bead.labels ?? []).filter((l) => l.startsWith("area:"));
  if (areas.length === 1) return [];
  return [
    {
      section: "area:",
      severity: "advisory",
      message:
        areas.length === 0
          ? "no `area:` label — the roadmap has no product surface to group this outcome under (`bd tag <id> area:<surface>`)"
          : `carries ${areas.length} \`area:\` labels (${areas.join(", ")}) — an epic carries exactly one`,
    },
  ];
}
