/**
 * The anton↔claude protocol for the review-fix job: the concrete PR context handed to claude
 * beneath the (editable) reasoning contract, and the per-thread outcome report parsed back out of
 * claude's final message. Extracted from review-fix.ts (anton-l6u) so the job module owns
 * orchestration while this module owns the prompt-building + report-parsing concern (and the
 * claude/* prompt-composition imports that go with it).
 *
 * The reporting format is DEFINED here (in reviewFixContext) and PARSED here (parseThreadReport) so
 * an operator override of the reasoning contract can never break the protocol the job relies on.
 */
import { type Bead } from "../beads/bd";
import { loadAgentPrompt } from "../claude/agent-prompt";
import { buildExecutionSystemPrompt } from "../claude/system-prompt";
import { loadSkill } from "../claude/prompt";
import { threadsNeedingAttention, type PrReview, type ReviewThread } from "../git/pr";
import { type ProjectSettings } from "../projects";

/** One reported outcome for an inline review thread, parsed from claude's final message. */
export interface ThreadOutcome {
  id: string;
  outcome: "fixed" | "left" | "needs-human";
  reply?: string;
}

/** Value of a `prefix:value` label (e.g. the epic's `agent:` tag), or undefined if absent. */
export function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const l = labels?.find((x) => x.startsWith(`${prefix}:`));
  return l ? l.slice(prefix.length + 1) : undefined;
}

/**
 * The full prompt handed to claude for a review-fix: the (per-project override, else shipped
 * default) reasoning contract, then the concrete PR context anton fetched — plus the layered
 * execution system prompt so the fix obeys the operating contract. Returns both so the caller
 * passes them straight to runClaude.
 */
export async function buildReviewFixPrompt(args: {
  epic: Bead;
  pr: PrReview;
  reasons: string[];
  conflicts: string[];
  settings: ProjectSettings;
  /** The worktree the fix runs in (for resolving a project-local agent prompt). */
  projectDir: string;
}): Promise<{ prompt: string; appendSystemPrompt: string }> {
  const { epic, pr, reasons, conflicts, settings, projectDir } = args;

  // Compose the same layered system prompt used for execution (base + agent + seed). Use the
  // epic's agent tag if it has one.
  const agentTag = labelValue(epic.labels, "agent");
  const appendSystemPrompt = await buildExecutionSystemPrompt({
    agentPrompt: await loadAgentPrompt(agentTag, { projectDir }),
    seedPrompt: settings.seedPrompt,
  });

  // The editable reasoning contract (per-project override, else the shipped default) followed by
  // the concrete PR context anton fetched.
  const reasoning = settings.reviewFixPrompt?.trim() || (await loadSkill("review-fix"));
  const prompt = [reasoning, "", "---", "", reviewFixContext(epic, pr, reasons, conflicts)].join("\n");

  return { prompt, appendSystemPrompt };
}

/**
 * The concrete PR context appended beneath the (editable) reasoning contract: which epic/PR, why
 * it needs action, the reviewer summaries + unresolved inline threads + failing checks + merge
 * conflicts, and the per-thread reporting format anton parses afterwards. The reasoning of HOW to
 * resolve lives in the review-fix prompt (default file or settings override), not here.
 *
 * Assembled from independent section builders (each returns its own lines, empty when it does not
 * apply) so the shape stays flat and every section is testable in isolation.
 */
export function reviewFixContext(epic: Bead, pr: PrReview, reasons: string[], conflicts: string[] = []): string {
  const threads = threadsNeedingAttention(pr);
  return [
    ...headerSection(epic, pr, reasons),
    ...reviewerSummarySection(pr),
    ...threadsSection(threads),
    ...failingChecksSection(pr),
    ...conflictsSection(conflicts),
    ...reportingFormatSection(threads),
  ]
    .join("\n")
    .trimEnd();
}

function headerSection(epic: Bead, pr: PrReview, reasons: string[]): string[] {
  return [
    `## This PR`,
    ``,
    `Epic: ${epic.id} — ${epic.title}`,
    `PR: #${pr.number} (${pr.url})`,
    `Branch: ${pr.headRefName}`,
    `Why this needs action: ${reasons.join("; ")}.`,
    ``,
  ];
}

function reviewerSummarySection(pr: PrReview): string[] {
  const changeReviews = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED" && r.body.trim());
  if (changeReviews.length === 0) return [];
  return [
    `Reviewer summaries requesting changes:`,
    ...changeReviews.map((r) => `- @${r.author}: ${r.body.trim()}`),
    ``,
  ];
}

function threadsSection(threads: ReviewThread[]): string[] {
  if (threads.length === 0) return [];
  const lines = [`Unresolved review threads (already-resolved threads are omitted):`];
  for (const t of threads) {
    const loc = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "(general)";
    lines.push(`- [thread ${t.id}] ${loc}${t.isOutdated ? " (outdated diff)" : ""}`);
    for (const c of t.comments) lines.push(`  - @${c.author}: ${c.body.trim()}`);
  }
  lines.push(``);
  return lines;
}

function failingChecksSection(pr: PrReview): string[] {
  if (pr.failingChecks.length === 0) return [];
  return [`Failing CI checks: ${pr.failingChecks.join(", ")}.`, ``];
}

function conflictsSection(conflicts: string[]): string[] {
  if (conflicts.length === 0) return [];
  return [
    `Merge conflicts: the base branch was merged into this worktree and left conflict markers`,
    `in the following files. Resolve the markers (pick the semantically correct result — never`,
    `blindly one side); the merge is concluded for you afterwards:`,
    ...conflicts.map((f) => `- ${f}`),
    ``,
  ];
}

function reportingFormatSection(threads: ReviewThread[]): string[] {
  if (threads.length === 0) return [];
  return [
    `## Reporting format (required)`,
    ``,
    `End your final message with a fenced json block reporting each thread listed above:`,
    ``,
    "```json",
    `{"threads":[{"id":"<thread id>","outcome":"fixed" | "left" | "needs-human","reply":"one-line note for the reviewer"}]}`,
    "```",
    ``,
    `Use "fixed" only for threads you actually changed code for, "left" for findings you`,
    `deliberately did not act on, "needs-human" when a decision is required. The reply is posted`,
    `on the thread verbatim.`,
  ];
}

/** True iff `t` is a well-formed ThreadOutcome (valid id + known outcome). */
function isThreadOutcome(t: unknown): t is ThreadOutcome {
  return (
    typeof t === "object" &&
    t !== null &&
    typeof (t as ThreadOutcome).id === "string" &&
    ["fixed", "left", "needs-human"].includes((t as ThreadOutcome).outcome)
  );
}

/**
 * Parse the per-thread outcome report claude is asked (in reviewFixContext) to end its final
 * message with: the LAST fenced ```json block containing {"threads":[…]}. Tolerant by design —
 * any malformed/missing report yields [] and the job falls back to the generic PR comment.
 */
export function parseThreadReport(text: string | undefined): ThreadOutcome[] {
  if (!text) return [];
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(blocks[i][1]) as { threads?: unknown };
      if (!Array.isArray(parsed.threads)) continue;
      return parsed.threads.filter(isThreadOutcome);
    } catch {
      // not the report block — keep scanning backwards.
    }
  }
  return [];
}
