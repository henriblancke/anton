/**
 * `step:describe` — write the run's PR narrative from its committed diff (anton-aucch), in the one
 * slot where the diff exists and the PR has not opened yet (anton-xl51z registers the step and its
 * slot between `step:commit` and `step:pr`).
 *
 * A describer that fails costs the narrative and nothing else: EVERYTHING here — a thrown error, a
 * timed-out or quota-exhausted dispatch, an unparseable report — is caught and turned into
 * `{ ok: true }` with no narrative. This step never parks the run and never fails it, which is why
 * it manages its own dispatch (borrowing `dispatchClaude`'s session/metering machinery through a
 * capturing `runClaude` rather than propagating its result) instead of letting the runner's usual
 * quota-backoff / poison-park classification see anything thrown from in here.
 */
import { labelValueOf } from "../../beads/bd";
import { loadAgentPrompt, stripFrontmatter, USER_AGENTS_DIR } from "../../claude/agent-prompt";
import type { ClaudeResult, RunClaudeOptions } from "../../claude/driver";
import { runClaude } from "../../claude/driver";
import { loadSkill } from "../../claude/prompt";
import { buildExecutionSystemPrompt } from "../../claude/system-prompt";
import { isForbiddenByte } from "../../control-bytes";
import { diffAgainstBase, readFileAtRev, resolveMergeBase } from "../../git/ops";
import { isForbiddenCodePoint } from "../../invisible-unicode";
import { resolveDescribeConfig } from "../../projects";
import { errorText } from "../../retry-helpers";
import type { StepContext } from "./context";
import { dispatchClaude } from "./dispatch";
import { describeContext } from "./prompts";
import type { RunNarrative, StepResult } from "./result";

export async function describeStep(ctx: StepContext): Promise<StepResult> {
  try {
    return await runDescriber(ctx);
  } catch (e) {
    // ANY failure — a thrown git error, a quota exhaustion, an abort on the job's own deadline —
    // costs the narrative and nothing else. See the module header.
    return { ok: true, detail: `describer failed — no narrative (${errorText(e)})` };
  }
}

async function runDescriber(ctx: StepContext): Promise<StepResult> {
  const baseRev = await resolveMergeBase(ctx.worktreePath, ctx.baseRef);
  const [reasoning, diff] = await Promise.all([
    resolveDescribeContract(ctx, baseRev),
    diffAgainstBase(ctx.worktreePath, baseRev),
  ]);
  const prompt = [
    reasoning,
    "",
    "---",
    "",
    describeContext({ target: ctx.target, tickets: ctx.tickets, diff }),
  ].join("\n");
  const appendSystemPrompt = await buildExecutionSystemPrompt({ seedPrompt: ctx.settings.seedPrompt });

  const { result, text } = await dispatchAndCapture(ctx, {
    beadId: ctx.target.id,
    prompt,
    appendSystemPrompt,
    failure: (t) => `describer reported an error for ${ctx.target.id}: ${t ?? "unknown"}`,
  });

  const narrative = parseNarrativeReport(text);
  return {
    ok: true,
    detail: narrative ? "wrote the run narrative" : (result.detail ?? "describer produced no parseable narrative"),
    facts: { sessionIds: result.facts?.sessionIds, ...(narrative ? { narrative } : {}) },
  };
}

/**
 * `dispatchClaude` reports the agent's `ANTON-RESULT` self-report, never the raw text a custom
 * protocol (like the narrative report below) is parsed from — every other dispatching step needs
 * only the self-report, so the raw text is discarded at that boundary rather than carried into
 * {@link StepFacts} and persisted. Wrapping the driver this step's own dispatch runs through, purely
 * to capture the text locally, gets `dispatchClaude`'s session/metering/quota handling unchanged
 * without widening what every step persists.
 */
async function dispatchAndCapture(
  ctx: StepContext,
  args: Parameters<typeof dispatchClaude>[1],
): Promise<{ result: StepResult; text: string | undefined }> {
  const baseRunner = ctx.deps?.runClaude ?? runClaude;
  let text: string | undefined;
  const capture = async (options: RunClaudeOptions): Promise<ClaudeResult> => {
    const r = await baseRunner(options);
    text = r.text;
    return r;
  };
  const result = await dispatchClaude({ ...ctx, deps: { ...ctx.deps, runClaude: capture } }, args);
  return { result, text };
}

/**
 * The describer's reasoning contract, resolved by the same precedence the reviewer uses (see
 * `resolveReviewerContract` in `review-context.ts`, the pattern this mirrors): a `prompt:<id>` or
 * `skill:<id>` label on the formula step itself, then the project's `describePrompt` setting, then
 * anton's shipped `describe` skill.
 *
 * Read at the BASE revision, never from the worktree being described — a `prompt:<id>` names a
 * project-local `.claude/agents/<id>.md`, which IS the reasoning contract, so resolving it from the
 * worktree would let a run's own diff rewrite the instruction that describes it. An id that resolves
 * to nothing (deleted after a formula named it, or never existed) falls through to the next source
 * rather than parking the run — this step has no park to fall back to, only the next tier.
 */
async function resolveDescribeContract(ctx: StepContext, baseRev: string): Promise<string> {
  const promptId = labelValueOf(ctx.step?.labels, "prompt");
  if (promptId) {
    const body = await loadBaseAgentPrompt(ctx.worktreePath, baseRev, promptId);
    if (body) return body;
  }
  const skillId = labelValueOf(ctx.step?.labels, "skill");
  if (skillId) {
    const body = await loadBaseProjectSkill(ctx.worktreePath, baseRev, skillId);
    if (body) return body;
  }
  const projectPrompt = resolveDescribeConfig(ctx.settings).prompt;
  if (projectPrompt) return projectPrompt;
  return loadSkill("describe");
}

/**
 * A `prompt:<id>` read as of `baseRev`, mirroring `loadTrustedAgentPrompt` in review-context.ts: the
 * project's own `.claude/agents/<id>.md` at the base commit, else the sources OUTSIDE the worktree
 * (the operator's global `~/.claude/agents`, anton's bundled prompts, installed plugins) — never the
 * copy the run itself may have just written.
 */
async function loadBaseAgentPrompt(
  worktreePath: string,
  baseRev: string,
  tag: string,
): Promise<string | undefined> {
  const raw = await readFileAtRev(worktreePath, baseRev, `${USER_AGENTS_DIR}/${tag}.md`).catch(() => undefined);
  if (raw !== undefined) return stripFrontmatter(raw).trim() || undefined;
  return (await loadAgentPrompt(tag))?.trim() || undefined; // no projectDir: skips the worktree's own copy
}

/** A `skill:<id>` read as of `baseRev`: the project's own skill at the base commit, else anton's bundled one. */
async function loadBaseProjectSkill(
  worktreePath: string,
  baseRev: string,
  id: string,
): Promise<string | undefined> {
  const raw = await readFileAtRev(worktreePath, baseRev, `.claude/skills/${id}/SKILL.md`).catch(() => undefined);
  if (raw !== undefined) return stripFrontmatter(raw).trim() || undefined;
  return (await loadSkill(id).catch(() => undefined))?.trim() || undefined;
}

/** Cap on each narrative field — generous for PR-body prose, bounded against a runaway response. */
const MAX_NARRATIVE_FIELD_CHARS = 4000;

/**
 * Parse the narrative report the describer is asked (`narrativeReportFormat` in prompts.ts) to end
 * its final message with: the LAST fenced ```json block shaped like `{"narrative": {...}}`.
 *
 * Tolerant by design, like `parseThreadReport` — NOT like the reviewer's `parseReviewFindings`,
 * which is strict because a misread verdict opens an unreviewed PR. A misread narrative here costs
 * only a nicer PR body, so absent, garbled, or partial JSON all yield `undefined` rather than a
 * violation — there is no park reason and no protocol violation for this step anywhere in anton.
 * `summary` is the only required field: a block missing it is discarded whole rather than partially
 * used, since a narrative with no "what changed and why" is not usable as one.
 */
export function parseNarrativeReport(text: string | undefined): RunNarrative | undefined {
  if (!text) return undefined;
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blocks[i][1]);
    } catch {
      continue; // not the report block — keep scanning backwards
    }
    const narrative = isRecord(parsed) ? parsed.narrative : undefined;
    if (isRunNarrative(narrative)) return sanitizeNarrative(narrative);
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isRunNarrative(v: unknown): v is RunNarrative {
  if (!isRecord(v)) return false;
  if (typeof v.summary !== "string" || !v.summary.trim()) return false;
  if (v.spotlight !== undefined && typeof v.spotlight !== "string") return false;
  if (v.risks !== undefined && typeof v.risks !== "string") return false;
  return true;
}

/** Every field sanitized independently, so a violation in one never costs the others. */
function sanitizeNarrative(narrative: RunNarrative): RunNarrative {
  const spotlight = narrative.spotlight?.trim() ? sanitizeNarrativeField(narrative.spotlight) : undefined;
  const risks = narrative.risks?.trim() ? sanitizeNarrativeField(narrative.risks) : undefined;
  return {
    summary: sanitizeNarrativeField(narrative.summary),
    ...(spotlight ? { spotlight } : {}),
    ...(risks ? { risks } : {}),
  };
}

/**
 * Strip C0 control bytes/DEL ({@link isForbiddenByte}) and bidi-override/zero-width Unicode
 * ({@link isForbiddenCodePoint}) — the same two gates a tracked source file is held to — then cap
 * length. Applied before a narrative field leaves this step: it is untrusted agent prose that a
 * later step (the PR-body renderer) writes verbatim into a pull request anyone can open.
 */
function sanitizeNarrativeField(text: string): string {
  let out = "";
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const forbidden = (cp < 0x80 && isForbiddenByte(cp)) || isForbiddenCodePoint(cp, index);
    if (!forbidden) out += ch;
    index++;
  }
  return truncateNarrativeField(out.trim());
}

function truncateNarrativeField(text: string): string {
  if (text.length <= MAX_NARRATIVE_FIELD_CHARS) return text;
  return `${text.slice(0, MAX_NARRATIVE_FIELD_CHARS)}\n… [truncated]`;
}
