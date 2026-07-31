/**
 * The anton↔claude protocol for the pre-PR self-review gate (anton-3apm): the reviewer's reasoning
 * contract (shipped default, or the operator's swap), the concrete run context appended beneath it,
 * and the machine-readable findings report parsed back out of the reviewer's final message — plus
 * the fix prompt the gate hands the next session when findings come back blocking.
 *
 * Mirrors review-fix-context.ts and its discipline: the report format is DEFINED here (in
 * {@link reviewContext}) and PARSED here ({@link parseReviewFindings}), so swapping the reviewer —
 * a named agent, an operator prompt, or a rewritten skill — can never break the protocol the gate
 * relies on. That is why the score is demanded by the appended context rather than by the skill.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { acceptanceBody, goalBody } from "../beads/contract";
import { type Bead } from "../beads/bd";
import { loadAgentPrompt } from "../claude/agent-prompt";
import { loadSkill } from "../claude/prompt";
import { buildExecutionSystemPrompt } from "../claude/system-prompt";
import { type BranchDiff } from "../git/ops";
import { resolveReviewConfig, type ProjectSettings } from "../projects";
import { labelValue } from "./review-fix-context";

/** The project's own enforced rules, read from the worktree and inlined into the review context. */
export const PRINCIPLES_PATH = ".product/principles.md";

/** Bounds on inlined text, so one huge bead or principles file can't crowd out the diff. */
const MAX_BEAD_FIELD_CHARS = 4000;
const MAX_PRINCIPLES_CHARS = 8000;

/** One reported problem with the run's diff, parsed from the reviewer's final message. */
export interface ReviewFinding {
  /** Blocking findings hold the PR back; advisory ones are recorded and shipped with it. */
  severity: "blocking" | "advisory";
  /** Where the problem is — `file:line`, a file, or `(general)` for a whole-run finding. */
  location: string;
  /** What is wrong, why, and what correct looks like — enough for a fixer with no context. */
  note: string;
}

/** Which reasoning contract the reviewer ran with — reported for logging and the precedence tests. */
export interface ReviewerSource {
  kind: "agent" | "prompt" | "default";
  /** The agent id, for `kind: "agent"`. */
  id?: string;
}

/**
 * How a review failed the protocol. Deliberately NOT folded into "no findings": a reviewer that
 * never reported, reported an unusable score, or edited the code it was judging has told us nothing
 * trustworthy about the work — treating that as a clean review would open a PR on unreviewed code.
 */
export type ReviewProtocolViolation = "no-report" | "invalid-score" | "worktree-modified";

/**
 * Outcome of parsing a review report. `ok: true` is a review that spoke the protocol — the score is
 * a validated integer 0-10 and the findings (possibly none, which is a legitimate clean review) are
 * actionable. `ok: false` is a protocol violation for the gate to park or retry on; any findings
 * salvaged from the block are carried along, never as evidence the run is clean.
 */
export type ReviewReportResult =
  | { ok: true; score: number; rationale?: string; findings: ReviewFinding[] }
  | { ok: false; violation: ReviewProtocolViolation; findings: ReviewFinding[] };

/** The run put in front of the reviewer: what it was supposed to do, and what it actually changed. */
export interface ReviewRun {
  /** The run target — the epic, or the single ticket of a standalone run. */
  target: Bead;
  /** Every ticket the run implemented, in execution order. */
  tickets: Bead[];
  diff: BranchDiff;
  /** `.product/principles.md` from the worktree, when the project has one. */
  principles?: string;
}

/**
 * The full prompt handed to the reviewer: the reasoning contract, then the concrete run context.
 *
 * Reasoning resolves by precedence — a named review agent (`reviewAgent`) beats the operator's
 * review prompt (`reviewPrompt`), which beats anton's shipped `review` skill. An agent id that no
 * longer resolves (deleted after it was saved) falls through to the next source rather than
 * failing the gate, which is what the settings UI promises the operator.
 */
export async function buildReviewPrompt(args: {
  target: Bead;
  tickets: Bead[];
  diff: BranchDiff;
  settings: ProjectSettings;
  /** The worktree under review — resolves a project-local agent prompt and its principles file. */
  projectDir: string;
}): Promise<{ prompt: string; reviewer: ReviewerSource }> {
  const { target, tickets, diff, settings, projectDir } = args;
  const config = resolveReviewConfig(settings);

  let reasoning: string | undefined;
  let reviewer: ReviewerSource = { kind: "default" };
  if (config.agent) {
    reasoning = await loadAgentPrompt(config.agent, { projectDir });
    if (reasoning) reviewer = { kind: "agent", id: config.agent };
  }
  if (!reasoning && config.prompt) {
    reasoning = config.prompt.trim();
    reviewer = { kind: "prompt" };
  }
  if (!reasoning) {
    reasoning = await loadSkill("review");
    reviewer = { kind: "default" };
  }

  const principles = await readPrinciples(projectDir);
  const prompt = [
    reasoning,
    "",
    "---",
    "",
    reviewContext({ target, tickets, diff, principles }),
  ].join("\n");
  return { prompt, reviewer };
}

/** Read the project's principles file, or undefined when it has none / can't be read. */
async function readPrinciples(projectDir: string): Promise<string | undefined> {
  try {
    return (await readFile(join(projectDir, PRINCIPLES_PATH), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The concrete run context appended beneath the (swappable) reasoning contract: which run, the
 * contract it must satisfy (each bead's Goal + Acceptance), the diff it produced, the project's
 * principles, and the report format anton parses afterwards. HOW to judge lives in the reasoning
 * contract; WHAT to judge and how to say it live here.
 *
 * Assembled from independent section builders so each stays testable in isolation.
 */
export function reviewContext(run: ReviewRun): string {
  return [
    ...headerSection(run),
    ...beadsSection(run),
    ...diffSection(run.diff),
    ...principlesSection(run.principles),
    ...readOnlySection(),
    ...reportingFormatSection(),
  ]
    .join("\n")
    .trimEnd();
}

function headerSection(run: ReviewRun): string[] {
  return [
    `## This run`,
    ``,
    `Run target: ${run.target.id} — ${run.target.title}`,
    `Tickets in this run: ${run.tickets.length}`,
    `Files changed: ${run.diff.files.length}`,
    ``,
    `You are reviewing the diff below against the beads below. Nothing outside this run is yours`,
    `to judge.`,
    ``,
  ];
}

/**
 * The contract the work is measured against: the run target plus every ticket, each with its Goal
 * and Acceptance. A standalone run (epic-of-one) lists its bead once — repeating it as "ticket 1"
 * reads as two separate contracts to grade against.
 */
function beadsSection(run: ReviewRun): string[] {
  const standalone = run.tickets.length === 1 && run.tickets[0]?.id === run.target.id;
  const lines = [`## What this run had to deliver`, ``, ...beadBlock(run.target, "Run target")];
  if (!standalone) {
    for (const t of run.tickets) lines.push(...beadBlock(t, "Ticket"));
  }
  return lines;
}

function beadBlock(bead: Bead, label: string): string[] {
  const goal = goalBody(bead)?.trim();
  const acceptance = acceptanceBody(bead)?.trim();
  return [
    `### ${label}: ${bead.id} — ${bead.title}`,
    ``,
    `**Goal**`,
    goal ? truncate(goal, MAX_BEAD_FIELD_CHARS) : `(none stated)`,
    ``,
    `**Acceptance**`,
    acceptance ? truncate(acceptance, MAX_BEAD_FIELD_CHARS) : `(none stated)`,
    ``,
  ];
}

function diffSection(diff: BranchDiff): string[] {
  if (diff.files.length === 0) {
    return [
      `## The diff under review`,
      ``,
      `The run produced NO changes against its base. Nothing was delivered against the Acceptance`,
      `criteria above — report that as blocking.`,
      ``,
    ];
  }
  return [
    `## The diff under review`,
    ``,
    `Changed files (${diff.files.length}):`,
    ...diff.files.map((f) => `- ${f}`),
    ``,
    ...(diff.truncated
      ? [`The patch below is truncated — read the files in the worktree for anything it cuts off.`, ``]
      : []),
    "```diff",
    diff.patch,
    "```",
    ``,
  ];
}

function principlesSection(principles: string | undefined): string[] {
  if (!principles) {
    return [
      `## Project principles`,
      ``,
      `This project has no \`${PRINCIPLES_PATH}\`. Judge adherence against \`CLAUDE.md\` /`,
      `\`AGENTS.md\` and the conventions of the surrounding code.`,
      ``,
    ];
  }
  return [
    `## Project principles (\`${PRINCIPLES_PATH}\`)`,
    ``,
    `These are enforced rules for this project. Each violation in the diff is a finding.`,
    ``,
    truncate(principles, MAX_PRINCIPLES_CHARS),
    ``,
  ];
}

/**
 * The read-only rule. Lives in anton's own context, not in the (swappable) reasoning contract, so an
 * implementation-oriented agent swapped in as reviewer is still told not to write: a reviewer that
 * repairs what it finds and then reports clean would ship its verdict and lose its fix — the branch
 * anton pushes is the one it just judged, and the gate discards any edit made under a review.
 */
function readOnlySection(): string[] {
  return [
    `## This review is READ-ONLY`,
    ``,
    `Do not modify anything in this worktree — no edits, no new files, no commits, no \`git\` writes,`,
    `no formatters or codemods, even if your instructions above tell you to fix what you find. anton`,
    `dispatches the fixes in a separate session after your report.`,
    ``,
    `anton compares the worktree before and after this review: any change you make is reverted and`,
    `the review is discarded as a protocol violation, which parks the run for a human. Reading,`,
    `searching, and running the project's own read-only checks (tests, type-check, lint) is expected —`,
    `just leave the tree exactly as you found it.`,
    ``,
  ];
}

/**
 * The report protocol. Lives here rather than in the reasoning contract precisely so a swapped
 * reviewer — a named agent that has never heard of anton, or an operator prompt — still emits the
 * score and findings the gate parses. Hence the explicit "even if your instructions above say
 * otherwise": this section is the protocol, the contract above it is only the judgment.
 */
function reportingFormatSection(): string[] {
  return [
    `## Reporting format (required)`,
    ``,
    `End your final message with a fenced json block — nothing after it — in exactly this shape,`,
    `even if your instructions above describe a different format:`,
    ``,
    "```json",
    `{"score":<integer 0-10>,"rationale":"one-line justification of the score","findings":[{"severity":"blocking" | "advisory","location":"<file>:<line>","note":"what is wrong, why, and what correct looks like"}]}`,
    "```",
    ``,
    `\`score\` is MANDATORY: an integer from 0 to 10 for the overall quality of this run's work,`,
    `on the anchored scale you were given. A report with no score, a non-integer, or one outside`,
    `0-10 is a protocol violation — anton cannot grade the run and the run is parked for a human.`,
    `Report the score even when you found nothing.`,
    ``,
    `Use "blocking" only for work that fails a stated Acceptance criterion, is wrong or unsafe, or`,
    `reaches green by weakening a check — anton fixes every blocking finding before the PR opens.`,
    `Use "advisory" for real improvements that do not invalidate the work. \`location\` is a path`,
    `(with a line when you have one), or "(general)" for a finding with no single site. An empty`,
    `\`findings\` array is a legitimate clean review; say so with a score rather than padding it.`,
  ];
}

/**
 * The prompt for a gate FIX session (anton-cbak): the blocking findings the reviewer reported, in a
 * fresh context, to be resolved in the worktree. Paired with the layered execution system prompt
 * (base contract + the target's agent prompt + the operator seed) so the fix obeys the same quality
 * floor as the implementation it is repairing — notably "never make a check pass by weakening it".
 *
 * Deliberately has NO report protocol: the next review round re-reads the diff, so the code is the
 * only evidence. A fixer that changes nothing (every finding declined) leaves an empty tree, which
 * the gate reads as no progress and hands to the call-site to park — the right outcome for findings
 * a fixer believes are wrong.
 */
export async function buildFindingsFixPrompt(args: {
  target: Bead;
  /** The findings to resolve — the gate passes the blocking ones. */
  findings: ReviewFinding[];
  settings: ProjectSettings;
  /** The worktree the fix runs in — resolves a project-local agent prompt. */
  projectDir: string;
  round: number;
  maxRounds: number;
}): Promise<{ prompt: string; appendSystemPrompt: string }> {
  const { target, findings, settings, projectDir, round, maxRounds } = args;

  const appendSystemPrompt = await buildExecutionSystemPrompt({
    agentPrompt: await loadAgentPrompt(labelValue(target.labels, "agent"), { projectDir }),
    seedPrompt: settings.seedPrompt,
  });

  const prompt = [
    `## Fix the review findings`,
    ``,
    `anton's pre-PR self-review read this branch's diff in a fresh context and reported the findings`,
    `below. Resolve them here in this worktree — round ${round} of ${maxRounds}. Another fresh`,
    `reviewer re-reads the diff after you, so the code is the only thing that speaks for you.`,
    ``,
    `Run target: ${target.id} — ${target.title}`,
    ``,
    `### Findings to resolve (${findings.length})`,
    ``,
    ...findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.location} — ${f.note}`),
    ``,
    `### How to resolve them`,
    ``,
    `- Fix the root cause of each finding with a real code change, and add or update the test that`,
    `  would have caught it. Never make a check pass by weakening it.`,
    `- Stay inside the findings: no refactor, cleanup, or feature the list above did not ask for.`,
    `- Leave the project's own checks green — run them before you finish.`,
    `- If a finding is WRONG or contradicts the run's beads, leave that code alone and say so plainly`,
    `  in your final message, with the reason. Do NOT make a token change to look responsive: unresolved`,
    `  findings are surfaced to a human, which is the correct outcome for a bad finding.`,
    `- Do not commit, push, or open a PR — anton commits what you change.`,
  ].join("\n");

  return { prompt, appendSystemPrompt };
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n… [truncated]`;
}

/** True iff `f` is a usable finding: a known severity and a note a fixer can act on. */
function toFinding(f: unknown): ReviewFinding | undefined {
  if (typeof f !== "object" || f === null) return undefined;
  const { severity, location, note } = f as Record<string, unknown>;
  if (severity !== "blocking" && severity !== "advisory") return undefined;
  if (typeof note !== "string" || !note.trim()) return undefined;
  return {
    severity,
    // A finding about the run as a whole is legitimate; only the note is load-bearing.
    location: typeof location === "string" && location.trim() ? location.trim() : "(general)",
    note: note.trim(),
  };
}

/** Shape of a candidate report block — anything carrying a score or findings key. */
function isReportBlock(parsed: unknown): parsed is { score?: unknown; findings?: unknown; rationale?: unknown } {
  if (typeof parsed !== "object" || parsed === null) return false;
  // Key PRESENCE, not value shape: `{"findings":null}` is a broken report, not an unrelated block.
  // Scanning past it would let an earlier clean draft stand in for the verdict it withdrew.
  return "score" in parsed || "findings" in parsed;
}

/**
 * Does an UNPARSEABLE block still read as an attempted report? A truncated or otherwise broken
 * report must not fall through to an earlier draft — a clean draft followed by a corrected report
 * that got cut off would otherwise pass the gate on the verdict the reviewer withdrew.
 */
function looksLikeReportText(raw: string): boolean {
  return /"(?:score|findings)"\s*:/.test(raw);
}

/**
 * Parse the review report the reviewer is asked (in {@link reportingFormatSection}) to end its
 * final message with: the LAST fenced ```json block that looks like a report. Unrelated json
 * blocks (a config the reviewer quoted) are skipped, not treated as the report.
 *
 * Tolerant about FINDINGS — malformed entries are dropped, a missing/non-array `findings` yields
 * [] — and strict about the SCORE. A report that never came, or whose score is missing, non-
 * integer, or out of 0-10, returns `ok: false`: the gate must park on that rather than read silence
 * as a clean run. Scanning stops at the first report-shaped block from the end — including a
 * BROKEN one — so a reviewer's earlier draft can never stand in for a final report it withdrew.
 */
export function parseReviewFindings(text: string | undefined): ReviewReportResult {
  if (!text) return { ok: false, violation: "no-report", findings: [] };

  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blocks[i][1]);
    } catch {
      // A block that tried to be the report and failed IS the report — a malformed one. Only
      // unrelated json (a config the reviewer quoted) keeps the scan going backwards.
      if (looksLikeReportText(blocks[i][1])) return { ok: false, violation: "no-report", findings: [] };
      continue;
    }
    if (!isReportBlock(parsed)) continue;

    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map(toFinding).filter((f): f is ReviewFinding => f !== undefined)
      : [];
    const { score, rationale } = parsed;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 10) {
      return { ok: false, violation: "invalid-score", findings };
    }
    return {
      ok: true,
      score,
      ...(typeof rationale === "string" && rationale.trim() ? { rationale: rationale.trim() } : {}),
      findings,
    };
  }
  return { ok: false, violation: "no-report", findings: [] };
}
