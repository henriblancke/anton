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
import { bundledSkillDigest, loadSkill } from "../claude/prompt";
import { textDigest } from "../claude/skill-stamp.mjs";
import type { ReasoningAttribution } from "../claude-invocations";
import { threadsNeedingAttention, type PrReview, type ReviewThread } from "../git/pr";
import { type ProjectSettings } from "../projects";

/** One reported outcome for an inline review thread, parsed from claude's final message. */
export interface ThreadOutcome {
  id: string;
  outcome: "fixed" | "left" | "needs-human";
  reply?: string;
}

/**
 * Sentinel `ThreadOutcome.id` for a round with NO inline threads but still actionable (a failing
 * check, a merge conflict, or a reviewer summary with no inline comments) — reuses the same
 * `{"threads":[...]}` report shape so `parseThreadReport` needs no new parsing path. Its presence in
 * the parsed report is the positive evidence review-fix.ts requires before treating such a round as
 * "answered": a successful claude run that never mentions it must NOT be mistaken for one that
 * actually handled the reason (anton-091jr review round 2, chatgpt-codex-connector).
 */
export const NON_THREAD_REPORT_ID = "non-thread-reasons";

/**
 * A "fixed" claim with nothing pushed behind it — a fabrication whether it's about to answer a
 * thread reply (review-fix.ts's `applyThreadOutcomes`) or a PR-body round summary
 * (review-fix-body.ts, anton-te6nr). Shared here so both readers exclude it the same way.
 */
export const fabricatedFix = (item: ThreadOutcome, pushed: boolean): boolean =>
  item.outcome === "fixed" && !pushed;

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
 *
 * `attribution` carries this resolution's {@link ReasoningAttribution} for the ledger (PR #313
 * review): `appendSystemPrompt` here is the EXECUTION contract (agent + seed), which `metered`
 * digests unaided — this text, the review-fix REASONING contract, rides in `prompt` beside the PR's
 * own context instead, so an edited `reviewFixPrompt` or a rewritten `review-fix` skill needs its
 * own stamp or it pools silently into the same cohort as before the edit.
 */
export async function buildReviewFixPrompt(args: {
  epic: Bead;
  pr: PrReview;
  reasons: string[];
  conflicts: string[];
  /** A gate that just failed after a prior fix session — the bounded follow-up round's own context. */
  gateFailure?: GateFailure;
  /**
   * Does `reasons` include something besides the unresolved-thread count — a failing check, a
   * merge conflict, or a reviewer summary? When true, `reportingFormatSection` asks for the
   * {@link NON_THREAD_REPORT_ID} sentinel ALONGSIDE the per-thread report, not just when there are
   * zero threads — a mixed round (both inline threads and a non-thread reason) must still be asked
   * about the non-thread reason, or `allWaitingThreadsAnswered` can never see the positive evidence
   * it now requires for one (PR #338 review, chatgpt-codex-connector). Defaults to `false` for the
   * gate follow-up round, whose own report is never read back into that check.
   */
  hasNonThreadReasons?: boolean;
  settings: ProjectSettings;
  /** The worktree the fix runs in (for resolving a project-local agent prompt). */
  projectDir: string;
}): Promise<{ prompt: string; appendSystemPrompt: string; attribution: ReasoningAttribution }> {
  const { epic, pr, reasons, conflicts, gateFailure, hasNonThreadReasons = false, settings, projectDir } =
    args;

  // Compose the same layered system prompt used for execution (base + agent + seed). Use the
  // epic's agent tag if it has one.
  const agentTag = labelValue(epic.labels, "agent");
  const appendSystemPrompt = await buildExecutionSystemPrompt({
    agentPrompt: await loadAgentPrompt(agentTag, { projectDir }),
    seedPrompt: settings.seedPrompt,
  });

  // The editable reasoning contract (per-project override, else the shipped default) followed by
  // the concrete PR context anton fetched.
  const override = settings.reviewFixPrompt?.trim();
  const reasoning = override || (await loadSkill("review-fix"));
  const attribution: ReasoningAttribution = override
    ? { promptBodyDigest: textDigest(override) }
    : { skillId: "review-fix", skillDigest: bundledSkillDigest("review-fix"), skillIsDefault: true };
  const prompt = [
    reasoning,
    "",
    "---",
    "",
    reviewFixContext(epic, pr, reasons, conflicts, gateFailure, hasNonThreadReasons),
  ].join("\n");

  return { prompt, appendSystemPrompt, attribution };
}

/** A verify gate that failed after a fix session — label + tailed output, for the follow-up round's prompt. */
export interface GateFailure {
  label: string;
  output: string;
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
export function reviewFixContext(
  epic: Bead,
  pr: PrReview,
  reasons: string[],
  conflicts: string[] = [],
  gateFailure?: GateFailure,
  hasNonThreadReasons = false,
): string {
  const threads = threadsNeedingAttention(pr);
  return [
    ...headerSection(epic, pr, reasons),
    ...reviewerSummarySection(pr),
    ...threadsSection(threads),
    ...clusterSection(threads),
    ...failingChecksSection(pr),
    ...conflictsSection(conflicts),
    ...gateFailureSection(gateFailure),
    ...reportingFormatSection(threads, reasons, hasNonThreadReasons),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * Below this many unresolved threads on one path, treat each as its own independent fix. At or
 * above it, an audit of the last 40 anton PRs (703 external findings) found the fixer answering a
 * structurally broken file with N one-line patches instead of the root cause — e.g. identity.mjs
 * took 54 findings on PR #217, rework-contract.ts 48 on #252. 3 is the floor that catches those
 * cases without flagging a file that just happens to have two unrelated nits.
 */
export const CLUSTERED_FINDINGS_THRESHOLD = 3;

function clusterSection(threads: ReviewThread[]): string[] {
  const counts = new Map<string, number>();
  for (const t of threads) {
    if (!t.path) continue;
    counts.set(t.path, (counts.get(t.path) ?? 0) + 1);
  }
  const clustered = [...counts.entries()].filter(([, n]) => n >= CLUSTERED_FINDINGS_THRESHOLD);
  if (clustered.length === 0) return [];
  return [
    `## Clustered findings`,
    ``,
    `These paths carry ${CLUSTERED_FINDINGS_THRESHOLD}+ findings each — that many hits on one file`,
    `is a sign the file is structurally broken, not that it has that many independent bugs. Find`,
    `the root cause on these paths before writing per-site patches:`,
    ``,
    ...clustered.map(([path, n]) => `- ${path} (${n} findings)`),
    ``,
  ];
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

/**
 * The bounded follow-up round's own context (anton-pwekp): the fixer just ran, its verify gates
 * came back red, and this is the ONE extra round the gate gets before the job parks. Tailed output
 * already trimmed by the caller — this section renders whatever it's handed verbatim.
 */
function gateFailureSection(gateFailure: GateFailure | undefined): string[] {
  if (!gateFailure) return [];
  return [
    `## Gate failure (one follow-up round)`,
    ``,
    `The ${gateFailure.label} gate failed after the fix above. This is the only extra round the`,
    `gate gets — if it fails again, the PR is parked for a human. Resolve what it's complaining`,
    `about (a deterministic gate failure like a migration re-stamp or a lint error is usually a`,
    `small, targeted fix, not a re-diagnosis of the review feedback):`,
    ``,
    "```",
    gateFailure.output,
    "```",
    ``,
  ];
}

/**
 * `hasNonThreadReasons` names whether this round is ALSO actionable via something besides the
 * threads above (a failing check, a merge conflict, or a reviewer summary with no inline
 * comments — see "Why this needs action" above). A mixed round (both inline threads and a
 * non-thread reason) must still ask for the {@link NON_THREAD_REPORT_ID} sentinel — restricting
 * that ask to the `threads.length === 0` case let a mixed round report every thread and never
 * once be asked about the non-thread reason, so `allWaitingThreadsAnswered` had no way to tell a
 * genuinely-handled round from one that silently ignored it (PR #338 review,
 * chatgpt-codex-connector).
 */
function reportingFormatSection(
  threads: ReviewThread[],
  reasons: string[],
  hasNonThreadReasons: boolean,
): string[] {
  if (threads.length === 0) {
    // No inline threads, but the round is still actionable. Without an explicit report, a claude
    // run that touches nothing looks identical to one that genuinely resolved the reason — and
    // would get recorded as "answered" on nothing but that resemblance (anton-091jr review round
    // 2, chatgpt-codex-connector). Reuses the thread-report shape (one entry keyed on the sentinel
    // id) so parseThreadReport needs no separate parsing path.
    if (reasons.length === 0) return [];
    return [
      `## Reporting format (required)`,
      ``,
      `There are no inline review threads here, but this round is still actionable. End your final`,
      `message with a fenced json block naming what you did about it:`,
      ``,
      "```json",
      `{"threads":[{"id":"${NON_THREAD_REPORT_ID}","outcome":"fixed" | "left","reply":"one-line summary of what you changed, or why nothing needed to change"}]}`,
      "```",
    ];
  }
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
    ...(hasNonThreadReasons
      ? [
          ``,
          `This round is ALSO actionable for a reason with no inline thread (a failing check, a`,
          `merge conflict, or a reviewer summary with no inline comments — see "Why this needs`,
          `action" above). Report that too: add one more entry to the same "threads" array, keyed`,
          `on the sentinel id "${NON_THREAD_REPORT_ID}", with outcome "fixed" or "left" and a`,
          `one-line reply summarizing what you did about it.`,
        ]
      : []),
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
