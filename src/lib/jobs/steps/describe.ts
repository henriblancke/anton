/**
 * `step:describe` — write the run's PR narrative from its committed diff (anton-aucch), in the one
 * slot where the diff exists and the PR has not opened yet (anton-xl51z registers the step and its
 * slot between `step:commit` and `step:pr`).
 *
 * A describer that fails costs the narrative and nothing else: a thrown error, a timed-out or
 * quota-exhausted dispatch, an unparseable report are all caught and turned into `{ ok: true }` with
 * no narrative. That is why this step manages its own dispatch (borrowing `dispatchClaude`'s
 * session/metering machinery through a capturing `runClaude` rather than propagating its result)
 * instead of letting the runner's usual quota-backoff / poison-park classification see what it
 * throws.
 *
 * ONE failure is not the step's to swallow, and it is not about the narrative: a describer that
 * WROTE to the worktree and whose write could not be reverted (see `enforceDescriberReadOnly`).
 * This step sits between the review gate and the push, so continuing there would open the PR on a
 * commit no review ever graded. That parks the run — the only case that does.
 */
import { labelValueOf } from "../../beads/bd";
import { loadAgentPrompt, stripFrontmatter, USER_AGENTS_DIR } from "../../claude/agent-prompt";
import type { ClaudeResult, RunClaudeOptions } from "../../claude/driver";
import { runClaude } from "../../claude/driver";
import { bundledSkillDigest, loadSkill } from "../../claude/prompt";
import { digestFiles, textDigest } from "../../claude/skill-stamp.mjs";
import { buildExecutionSystemPrompt } from "../../claude/system-prompt";
import type { ReasoningAttribution } from "../../claude-invocations";
import { isForbiddenByte } from "../../control-bytes";
import {
  diffAgainstBase,
  listFilesAtRev,
  readFileAtRev,
  readFileBytesAtRev,
  readWorktreeState,
  resolveMergeBase,
  restoreWorktreeState,
  sameWorktreeState,
  type WorktreeState,
} from "../../git/ops";
import { isForbiddenCodePoint } from "../../invisible-unicode";
import { isPoisonError, PoisonError } from "../errors";
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
    // The ONE thing that is not just a lost narrative: a describer that wrote, and whose write could
    // not be undone (`enforceDescriberReadOnly`). Swallowing that would hand `step:pr` a worktree
    // carrying a commit no review gate ever saw — the exact harm the read-only guard exists to
    // prevent — so it parks for a human instead. Every OTHER failure still costs the narrative and
    // nothing else. See the module header.
    if (isPoisonError(e)) throw e;
    return { ok: true, detail: `describer failed — no narrative (${errorText(e)})` };
  }
}

async function runDescriber(ctx: StepContext): Promise<StepResult> {
  const baseRev = await resolveMergeBase(ctx.worktreePath, ctx.baseRef);
  const [contract, diff] = await Promise.all([
    resolveDescribeContract(ctx, baseRev),
    diffAgainstBase(ctx.worktreePath, baseRev),
  ]);
  const { reasoning, attribution } = contract;
  const prompt = [
    reasoning,
    "",
    "---",
    "",
    describeContext({ target: ctx.target, tickets: ctx.tickets, diff }),
  ].join("\n");
  const appendSystemPrompt = await buildExecutionSystemPrompt({ seedPrompt: ctx.settings.seedPrompt });
  // The tree as it stands BEFORE the describer runs — the commit the PR step is about to push. See
  // `enforceDescriberReadOnly`.
  const before = await (ctx.deps?.readWorktreeState ?? readWorktreeState)(ctx.worktreePath);

  let dispatch: { result: StepResult; text: string | undefined };
  try {
    dispatch = await dispatchAndCapture(ctx, {
      beadId: ctx.target.id,
      prompt,
      appendSystemPrompt,
      failure: (t) => `describer reported an error for ${ctx.target.id}: ${t ?? "unknown"}`,
      // The describer writes prose, never code — see `DESCRIBE_DENIED_TOOLS`.
      disallowedTools: [...DESCRIBE_DENIED_TOOLS],
      // Only the operator's settings. The default would load `.claude/settings.json` from the tree
      // under description — source-controlled, and able to register hooks that run shell commands,
      // which is a write path no tool-name filter can see. Same reasoning as the reviewer's
      // `REVIEW_SETTING_SOURCES`.
      settingSources: ["user"],
      // This step describes the RUN, so its model route resolves against the run's whole label
      // context rather than its ticket count (PR #303 review).
      runLevelLabels: true,
      // NOT `execute` (the default): an `execute` session settled `done` is delivery evidence
      // (`listDeliveriesByBead` in runs.ts), and this step delivers nothing — it writes no code,
      // makes no commit, and cannot fail the run. See the `describe` kind's own note in sessions.ts.
      sessionKind: "describe",
      // The resolved reasoning contract's identity (PR #313 review): this text rides in
      // `options.prompt`, not `appendSystemPrompt`, so `dispatchClaude`'s own meter cannot digest it —
      // without this, every describer invocation records only the execution system prompt's digest
      // and pools invocations that ran under different `prompt:`/`skill:` contracts into one cohort.
      attribution,
    });
  } catch (e) {
    // A describer that wrote and then DIED — quota exhaustion, the job's deadline, a lost lease —
    // left exactly the dirt one that survived would have, and this is the only path that reaches it:
    // the module-level catch turns the throw into `{ ok: true }` without ever seeing the worktree.
    // The reviewer reverts on its own throw path for the same reason (`discardSessionWrites`).
    //
    // A revert that FAILS is poison and propagates as itself (see `enforceDescriberReadOnly`) —
    // pushing an unrevertable commit is worse than losing this error. Anything else it throws is
    // swallowed so it cannot mask the failure that got us here: that is the one the runner
    // classifies, and a `UsageLimitError` must reach it as itself to reschedule rather than burn an
    // attempt.
    try {
      await enforceDescriberReadOnly(ctx, before);
    } catch (revertFailure) {
      if (isPoisonError(revertFailure)) throw revertFailure;
    }
    throw e;
  }
  const { result, text } = dispatch;

  // Only a SUCCEEDED dispatch can speak for the branch (PR #303 review). `dispatchClaude` returns
  // `{ ok: false }` for a claude result that failed without throwing — a non-transient error result,
  // a session the driver settled `failed` — and its `text` is that failure's output, which can still
  // carry a narrative-shaped block: a partially-written report the agent abandoned, or diagnostic
  // prose quoting the format. Parsing it would publish that as the run's authoritative narrative
  // while the session is recorded failed, contradicting this step's own contract. A failed describer
  // costs the narrative and nothing else — the same outcome as one that reported nothing at all.
  const narrative = result.ok ? parseNarrativeReport(text) : undefined;
  // Runs whether the dispatch succeeded or not: a describer that wrote before it failed left the
  // same dirt as one that survived.
  const wrote = await enforceDescriberReadOnly(ctx, before);
  return {
    ok: true,
    detail: wrote
      ? "describer MODIFIED the worktree — reverted, no narrative"
      : narrative
        ? "wrote the run narrative"
        : (result.detail ?? "describer produced no parseable narrative"),
    facts: { sessionIds: result.facts?.sessionIds, ...(narrative && !wrote ? { narrative } : {}) },
  };
}

/**
 * The describer writes PROSE. It is handed the diff, the file list and the beads, and it needs no
 * tool that writes bytes — so every write-shaped tool is denied outright (PR #303 review).
 *
 * The reviewer denies the same four plus `Bash(git:*)`, keeping `Bash` because its contract asks it
 * to run the project's own checks. The describer has no such need — its entire input is the diff,
 * the file list and the beads — so `Bash` and `Task` go too, matching the other read-only pass in
 * this codebase (`PM_DENIED_TOOLS`). `Task` because a subagent is a fresh tool context, and `Bash`
 * outright rather than by command prefix because a prefix filter cannot cover every path to a write.
 *
 * This does NOT mean no shell can run in the session, which is why `settingSources` is narrowed to
 * `user` at the call site: Claude Code's default would load `.claude/settings.json` from the very
 * worktree being described, and settings register hooks that run shell commands. Reading stays open
 * throughout (`Read`/`Grep`/`Glob`) — a truncated diff tells the describer to read the files, and a
 * read changes nothing.
 *
 * It matters because the describer runs under the EXECUTION system prompt, which tells the agent it
 * is implementing a ticket and should edit the working tree, at the project's configured permission
 * mode (normally `bypassPermissions`). Deny rules are evaluated ahead of the permission mode, so
 * they bind that session rather than merely asking it. An agent that followed the prompt would leave
 * dirt that breaks a pre-push hook and strands the run, or — worse — commit code that the review
 * gate, which has already run by this point, never saw.
 */
const DESCRIBE_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task"] as const;

/**
 * The second half of the guard above: catch a describer that wrote ANYWAY and put the tree back.
 *
 * The deny list is the prevention and this is the proof, for the same reason the reviewer keeps both
 * — a tool filter is only as good as the tool names it enumerates, and this step runs between the
 * review gate and the push, the one window where dirt reaches a PR ungraded. Restoring is safe here
 * because the step runs on a COMMITTED tree (`step:commit` precedes it in the formula), so the
 * fingerprint's baseline has no legitimate dirt to discard.
 *
 * A write costs the narrative, exactly like every other describer failure: the run continues with a
 * PR body built from the fallback rather than one written by a session that just broke its own
 * contract.
 *
 * Unless the revert itself FAILS on a moved HEAD or a switched branch — the one case this step does
 * park on, and the only one. Uncommitted dirt left behind is survivable (the tree is committed, so
 * `step:pr` pushes the graded commit regardless), but a commit that could not be undone is precisely
 * what the guard exists to keep out of the push: continuing would open the PR on code no review gate
 * ever saw. Poison rather than a retry, because no re-run unsticks a worktree — the same call the
 * reviewer's `discardSessionWrites` makes on the same evidence.
 */
async function enforceDescriberReadOnly(ctx: StepContext, before: WorktreeState): Promise<boolean> {
  // A fingerprint that cannot be READ does not short-circuit the restore (PR #303 review). The read
  // runs git and can fail on a momentarily unreadable or lock-contended tree; treating that as
  // "unchanged" would skip the revert entirely on the one tree most likely to need it. Unknown is
  // not clean — fall through and reset unconditionally, exactly as `discardSessionWrites` does.
  const readState = ctx.deps?.readWorktreeState ?? readWorktreeState;
  const restoreState = ctx.deps?.restoreWorktreeState ?? restoreWorktreeState;
  let after: WorktreeState | undefined;
  try {
    after = await readState(ctx.worktreePath);
  } catch {
    after = undefined;
  }
  if (after && sameWorktreeState(after, before)) return false;
  try {
    await restoreState(ctx.worktreePath, before);
  } catch (e) {
    // A state nobody could read may be either, so it parks with the stuck cases rather than passing
    // for survivable dirt.
    if (after === undefined || after.head !== before.head || after.ref !== before.ref) {
      throw new PoisonError(
        `the describer of ${ctx.target.id} WROTE to its own worktree and the revert failed (${errorText(e)}): ` +
          `${ctx.worktreePath} is ${after ? `at ${after.ref ?? "detached"}@${after.head.slice(0, 12)}` : "in a state that could not be read"}, not the reviewed ` +
          `${before.ref ?? "detached"}@${before.head.slice(0, 12)}. Parked instead of continued — opening the PR ` +
          `from here would push a commit the review gate never saw. Reset the worktree by hand, then resume.`,
      );
    }
    // Uncommitted dirt only: the commit `step:pr` pushes is still the reviewed one, so losing the
    // narrative is the whole cost.
    return true;
  }
  return true;
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
 *
 * `attribution` carries this resolution's identity for the ledger (PR #313 review), mirroring
 * `resolveReviewerContract`: this text rides in `options.prompt`, not `appendSystemPrompt`, so
 * `dispatchClaude`'s own meter cannot digest it — the caller must stamp it explicitly, or every
 * describer invocation pools into one cohort regardless of which `prompt:`/`skill:`/`describePrompt`
 * contract actually ran.
 *
 * The `prompt:<id>` and `skill:<id>` branches stamp a NAMED, versioned source — `promptId`/`skillId`
 * paired with a digest, mirroring `StepReasoning` (resolve.ts) — so an attribution query can tell
 * which named producer ran, not just that "some prompt" did. `describePrompt` (the project setting)
 * names nothing: it is free-form operator text with no id of its own, so it stays digest-only, same
 * as `resolveReviewerContract`'s `operatorPrompt` branch.
 */
async function resolveDescribeContract(
  ctx: StepContext,
  baseRev: string,
): Promise<{ reasoning: string; attribution: ReasoningAttribution }> {
  const promptId = labelValueOf(ctx.step?.labels, "prompt");
  if (promptId) {
    const body = await loadBaseAgentPrompt(ctx.worktreePath, baseRev, promptId);
    if (body) return { reasoning: body, attribution: { promptId, promptBodyDigest: textDigest(body) } };
  }
  const skillId = labelValueOf(ctx.step?.labels, "skill");
  if (skillId) {
    const skill = await loadBaseProjectSkill(ctx.worktreePath, baseRev, skillId);
    if (skill) return { reasoning: skill.text, attribution: { skillId, skillDigest: skill.digest } };
  }
  const projectPrompt = resolveDescribeConfig(ctx.settings).prompt;
  if (projectPrompt) {
    return { reasoning: projectPrompt, attribution: { promptBodyDigest: textDigest(projectPrompt) } };
  }
  return {
    reasoning: await loadSkill("describe"),
    attribution: { skillId: "describe", skillDigest: bundledSkillDigest("describe") },
  };
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

/**
 * A `skill:<id>` read as of `baseRev`: the project's own skill at the base commit, else anton's
 * bundled one — same precedence as `loadProjectSkill` in resolve.ts, the `step:claude` sibling this
 * mirrors.
 *
 * `digest` uses the SAME directory-digest semantics every other skill attribution does
 * ({@link skillDigestAtRev} for the project-local source, `bundledSkillDigest` for the fallback —
 * both reduce to `digestFiles`, the shared core `skillDigest` itself reduces to) rather than hashing
 * only the returned `SKILL.md` body: two rows for the same skill VERSION must land on the same
 * digest regardless of which handler ran it, and a change to a bundled asset (`templates/…`) the
 * skill instructs Claude to read must move the digest even though `SKILL.md`'s own bytes didn't
 * change (PR #313 review).
 */
async function loadBaseProjectSkill(
  worktreePath: string,
  baseRev: string,
  id: string,
): Promise<{ text: string; digest: string | undefined } | undefined> {
  const dir = `.claude/skills/${id}`;
  const raw = await readFileAtRev(worktreePath, baseRev, `${dir}/SKILL.md`).catch(() => undefined);
  if (raw !== undefined) {
    const text = stripFrontmatter(raw).trim();
    if (text) return { text, digest: await skillDigestAtRev(worktreePath, baseRev, dir) };
  }
  const bundled = (await loadSkill(id).catch(() => undefined))?.trim();
  return bundled ? { text: bundled, digest: bundledSkillDigest(id) } : undefined;
}

/**
 * {@link skillDigest}'s own algorithm (`digestFiles`), fed from a COMMITTED tree instead of disk —
 * the at-rev sibling `listFilesAtRev`/`readFileBytesAtRev` exist for. Reads RAW bytes
 * (`readFileBytesAtRev`), not `readFileAtRev`'s decoded-and-trimmed text: `digestFiles` hashes
 * `skillDigest`'s disk reads byte-for-byte, and a `git show` round-tripped through UTF-8 decoding
 * plus `stdout.trim()` would land a different digest on the same unchanged directory — losing a
 * text file's trailing whitespace, corrupting a binary asset outright (anton-z33ia review).
 * Swallowed to `undefined` on any failure, like `digestOf` in resolve.ts: the digest is a ledger
 * dimension, and losing it costs only the cohort key, never the narrative this step is already
 * committed to producing from the text in hand.
 *
 * `listFilesAtRev` returns each file's real `path` alongside its digest `rel` key precisely so a
 * symlinked asset directory can be read here: `dir` joined with `rel` is not a real tree entry for
 * anything reached through an expanded symlink, only `path` is (anton-z33ia review, PR #313).
 */
async function skillDigestAtRev(worktreePath: string, rev: string, dir: string): Promise<string | undefined> {
  try {
    const files = await listFilesAtRev(worktreePath, rev, dir);
    const entries = await Promise.all(
      files.map(async ({ rel, path }) => {
        const raw = await readFileBytesAtRev(worktreePath, rev, path);
        return raw === undefined ? undefined : ([rel, raw] as const);
      }),
    );
    if (entries.some((e) => e === undefined)) return undefined;
    return digestFiles(entries as Array<readonly [string, Buffer]>);
  } catch {
    return undefined;
  }
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
