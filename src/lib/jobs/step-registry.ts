/**
 * The pipeline step registry (anton-4npr): one uniform, testable entry point per run step.
 *
 * A project's run formula names its steps by label — `step:implement`, `step:commit`, … — and this
 * module is the single place a label becomes the anton code that executes it. Every built-in handler
 * WRAPS a code path execute-epic already ran in its numbered steps (the per-ticket claude dispatch,
 * the verify gates, the review gate, `commitAll`, `openPullRequest`) — this moved that code behind
 * one entry point rather than writing new run logic, and execute-epic's fixed sequence now calls the
 * same handlers a formula walk will. The walker that dispatches these in formula ORDER is anton-lnkt;
 * the floor validator that consumes the step CLASSES below is anton-6b99.
 *
 * Two rules hold the seam together:
 *
 * 1. **A label that maps to nothing PARKS the run** ({@link resolveStep}) — naming the step id, the
 *    label, and the formula file. A silent skip would let a project formula quietly define a run that
 *    never opens a PR, which is the failure this registry exists to make impossible.
 * 2. **Handlers are pure of molecule bookkeeping.** They take a worktree plus ticket(s) and report a
 *    {@link StepResult}; claiming beads, closing them, stamping the PR ref, and deciding what a
 *    failed step does to the run all stay with the caller.
 *
 * ── Rejected: `step:shell` (recorded so it is not re-litigated) ──
 * There is deliberately NO `step:shell`. "Run a command, fail on non-zero" is already the verify
 * gates' whole job (operator-pinned commands in project settings, run under the host verify-gate
 * lock), so a second arbitrary-command primitive inside the pipeline buys no capability and widens
 * the blast radius: formula files are git-tracked project data, so a `step:shell` would turn every
 * branch that edits one into a way to run an arbitrary command on the operator's machine, outside the
 * one lock and the one log the gates funnel through. `step:claude` is the extension point instead —
 * it dispatches an agent that can run whatever the project needs under the guards anton already has.
 * See `.product/decisions/2026-08-01-no-step-shell.md`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beads, labelValueOf, type Bead, type CookedStep } from "../beads/bd";
import { acceptanceBody } from "../beads/contract";
import { humanNotesPromptBlock } from "../beads/notes";
import { loadAgentPrompt, stripFrontmatter } from "../claude/agent-prompt";
import { formatAntonResult, parseAntonResult, type AntonResult } from "../claude/anton-result";
import { runClaude, type ClaudeResult, type RunClaudeOptions } from "../claude/driver";
import { loadSkill } from "../claude/prompt";
import { buildExecutionSystemPrompt } from "../claude/system-prompt";
import { commitAll, openPullRequest, type PullRequest } from "../git/ops";
import { resolveVerifyGates, type ProjectSettings } from "../projects";
import {
  appendSessionLog,
  endSession,
  setSessionClaudeId,
  startJobSession,
  type JobSession,
} from "../sessions";
import { PoisonEpic } from "./errors";
import { buildPrTitle } from "./pr-title";
import { findingLines, type ReviewFinding } from "./review-context";
import { runReviewGate, type ReviewGateResult, type ReviewRound } from "./review-gate";
import { runVerifyGates } from "./shell";
import type { AntonDb, Clock } from "./queue";
import type { JobContext } from "./runner";

/** The label prefix that names a step's handler: `step:<name>`. */
export const STEP_LABEL_PREFIX = "step";

/**
 * What a formula may do with a step, which is the whole of anton's invariant floor (anton-6b99
 * enforces it; this module only DECLARES it):
 *
 * - `required` — the runtime's guarantees depend on it. A formula that omits one is invalid, because
 *   a run that never implements, never commits, or never opens a PR has no evidence of record and no
 *   way to reach a human.
 * - `default-on` — anton ships it in the default formula and a project may remove it. Removing it
 *   costs quality (an unverified, unreviewed PR), never the run's integrity.
 * - `additive` — everything else. A project may add as many as it likes; the floor constrains
 *   omission and ordering, never extension.
 */
export type StepClass = "required" | "default-on" | "additive";

/**
 * A step as the cooked formula carries it, re-exported from the bd seam (anton-brdg) so the registry
 * and the loader (anton-hrql) read ONE definition of a step rather than two that can drift. `labels`
 * is where the step names its handler (`step:<name>`) and, for `step:claude`, its prompt
 * (`prompt:<id>` / `skill:<id>`) — labels, not a custom TOML key, because `bd cook` silently DROPS
 * non-standard step keys, so a step's configuration has to ride somewhere that survives the cook.
 */
export type { CookedStep };

/** What a step produced, for the caller's bookkeeping and for the steps that follow it. */
export interface StepFacts {
  /** `implement` / `claude` — the agent's `ANTON-RESULT` self-report, when it emitted one. */
  selfReport?: AntonResult | null;
  /** `commit` — whether the worktree actually had a diff to commit (false ⇒ nothing delivered). */
  committed?: boolean;
  /** `pr` — the PR that was opened or reused. */
  pr?: PullRequest;
  /** `review` — the gate's full verdict; the caller owns the park / advisory handling. */
  review?: ReviewGateResult;
  /** Every claude session this step recorded, in dispatch order. */
  sessionIds?: string[];
}

/**
 * A step's report. `ok: false` is a step that ran and did not achieve its work — the CALLER decides
 * what that means for the run (park, halt, carry on), because that judgement is molecule bookkeeping.
 * A step that cannot run at all throws instead, so the runner's existing durability classification
 * (quota → backoff, poison → park) applies unchanged.
 */
export interface StepResult {
  ok: boolean;
  /** One line for the run log / park message. */
  detail?: string;
  facts?: StepFacts;
}

/**
 * Machinery a caller may swap. Production passes none; the unit tests pass a fake claude driver, the
 * same seam {@link runReviewGate} already exposes.
 */
export interface StepDeps {
  /**
   * The claude driver every dispatching step goes through. Defaults to the bare {@link runClaude};
   * the walker passes the run's resume-aware wrapper so a transient mid-stream death continues
   * in-session (anton-juar) instead of re-running the step from scratch.
   */
  runClaude?: (options: RunClaudeOptions) => Promise<ClaudeResult>;
}

/**
 * Everything a step needs to do its work — the same state execute-epic's numbered steps close over
 * today, passed explicitly so a handler is callable (and testable) on its own.
 */
export interface StepContext {
  db: AntonDb;
  clock: Clock;
  /** The runner's job context: cancellation, heartbeats, and the live-session handle. */
  ctx: Pick<JobContext, "signal" | "heartbeat" | "report">;
  projectId: string;
  runId: string;
  /** The project repo — where bd and gh run. Never the worktree. */
  repoPath: string;
  /** The run's worktree — where every step's work happens. */
  worktreePath: string;
  /** The run's branch. */
  branch: string;
  /** The base branch the PR targets — a plain branch name, which is what `gh` needs. */
  baseBranch: string;
  /**
   * The ref the run actually forked from (`origin/<base>` when the fetch landed): the accurate fork
   * point to diff against even when the local base has drifted. The review step reads it; the PR
   * step must NOT, since `gh` takes a branch and not a remote-tracking ref.
   */
  baseRef: string;
  /** The run target — the epic, or the single bead of a standalone run. */
  target: Bead;
  /** The ticket(s) this step covers, in execution order. */
  tickets: Bead[];
  settings: ProjectSettings;
  /** The formula step being executed. Absent for a caller invoking a handler directly. */
  step?: CookedStep;
  /**
   * An already-open session the caller owns. A step that dispatches an agent or shells out records
   * into it (and leaves closing it to the caller) instead of opening its own, so a caller that keeps
   * ONE session across several steps — as execute-epic does per ticket — keeps doing so.
   */
  session?: JobSession;
  /** Re-assert the cross-machine run-lease; throws when it has lapsed (anton-jz1). */
  assertLeaseHeld?: () => void;
  /** Advisory findings an earlier `review` step left open — `pr` carries them into the PR body. */
  advisories?: ReviewFinding[];
  /**
   * Where a step records progress the caller still needs when the step THROWS. The review gate's
   * completed rounds are the only user: a gate that dies mid-flight returns nothing, but the founder
   * is still owed the rounds it finished.
   */
  rounds?: ReviewRound[];
  deps?: StepDeps;
}

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

/**
 * A step result whose caller can count on specific facts. The registry maps every step to the
 * uniform {@link StepHandler}, but a caller invoking one handler DIRECTLY (execute-epic, until the
 * walker lands) knows which facts it produces — so the handler's own signature promises them and no
 * call site has to assert.
 */
export interface StepResultWith<K extends keyof StepFacts> extends StepResult {
  facts: Required<Pick<StepFacts, K>> & StepFacts;
}

/** One registered step: the handler a `step:<name>` label resolves to, and its class. */
export interface StepDefinition {
  /** The label suffix — `implement` for `step:implement`. */
  name: string;
  class: StepClass;
  /** One line, used by the validator's rejection messages. */
  summary: string;
  /**
   * The step leaves work in the worktree that only `step:commit` turns into evidence — so the floor
   * (anton-6b99) requires it to run BEFORE the commit, or the work is silently thrown away. False
   * for a step that commits its own output: the review gate does, which is why it may sit after the
   * commit (and must, since it reads the run's diff).
   */
  producesDiff: boolean;
  handler: StepHandler;
}

// ── handlers ──

/**
 * `step:implement` — dispatch the ticket's agent in the worktree (execute-epic's per-ticket claude
 * call). One session per ticket, the ticket's `agent:` prompt in the system prompt, the full spec on
 * stdin, and the agent's `ANTON-RESULT` self-report parsed out of its final message.
 *
 * The bead's notes are re-read at dispatch, not taken from the run's opening snapshot: an operator's
 * steer (anton-bfy4) can land while an earlier ticket is still running.
 */
export async function implementStep(ctx: StepContext): Promise<StepResultWith<"sessionIds">> {
  const sessionIds: string[] = [];
  let last: StepResult = { ok: true };
  for (const ticket of ctx.tickets) {
    ctx.assertLeaseHeld?.();
    const agentTag = labelValueOf(ticket.labels, "agent");
    // The base contract is mandatory (buildExecutionSystemPrompt throws without it); the agent tag
    // and the operator's seed layer on top.
    const appendSystemPrompt = await buildExecutionSystemPrompt({
      agentPrompt: await loadAgentPrompt(agentTag, { projectDir: ctx.worktreePath }),
      seedPrompt: ctx.settings.seedPrompt,
    });
    const dispatched = await withDispatchNotes(ctx.repoPath, ticket);
    last = await dispatchClaude(ctx, {
      beadId: ticket.id,
      prompt: ticketPrompt(dispatched),
      appendSystemPrompt,
      failure: (text) => `claude reported an error for ${ticket.id}: ${text ?? "unknown"}`,
    });
    sessionIds.push(...(last.facts?.sessionIds ?? []));
    // The LAST dispatch's self-report is the one that speaks for the step: a caller running a step
    // per ticket (as execute-epic does) sees one either way, and a run-wide dispatch is judged on
    // where it ended up.
    if (!last.ok) return { ...last, facts: { ...last.facts, sessionIds } };
  }
  return { ok: true, detail: last.detail, facts: { ...last.facts, sessionIds } };
}

/**
 * `step:verify` — the project's operator-pinned gates (tests, lint, typecheck, build) in the
 * worktree. No gates configured ⇒ nothing runs, which is the unchanged behavior for a project that
 * pinned none. A non-zero exit throws, exactly as it does today, so the caller never commits behind
 * a red gate.
 */
export async function verifyStep(ctx: StepContext): Promise<StepResult> {
  const gates = resolveVerifyGates(ctx.settings);
  // No gates ⇒ nothing to run and nothing to record: return before a session is opened for an
  // empty log.
  if (gates.length === 0) return { ok: true, detail: "no verify gates configured" };

  const subject = stepSubject(ctx).id;
  const { session, owned } = await stepSession(ctx, subject);
  // The live handle has to name the session the gates are actually writing into. A run-phase verify
  // (a formula that moved `step:verify` after the commit) opens its OWN session, so without this
  // observe/investigate would attach to the last ticket's already-ended one for the whole of a
  // potentially long run-wide gate. Reported unconditionally, like every dispatching step: when the
  // caller handed its session in, this re-reports the one already on the handle.
  ctx.ctx.report({ sessionId: session.sessionId, cwd: ctx.worktreePath });
  try {
    await runVerifyGates(
      gates,
      ctx.worktreePath,
      ctx.ctx.signal,
      session.logPath,
      (gate, code) => `${gate.label} gate failed for ${subject} (exit ${code})`,
    );
  } catch (e) {
    if (owned) await endSession(ctx.db, ctx.clock, session.sessionId, "failed");
    throw e;
  }
  if (owned) await endSession(ctx.db, ctx.clock, session.sessionId, "done");
  return { ok: true, detail: `${gates.length} gate(s) passed`, facts: { sessionIds: [session.sessionId] } };
}

/**
 * `step:review` — the pre-PR self-review gate (anton-cbak): a fresh-context reviewer reads the run's
 * diff and its blocking findings are fixed on the branch before a PR exists.
 *
 * Reports the verdict rather than acting on it: whether an unresolved verdict parks the run, and
 * where the advisories are recorded, is the caller's call.
 */
export async function reviewStep(ctx: StepContext): Promise<StepResultWith<"review">> {
  // Asserted here AND handed in: the gate's review → fix → re-review sequence can outlive the lease
  // TTL, so it re-asserts at every dispatch rather than only on the way in.
  ctx.assertLeaseHeld?.();
  const review = await runReviewGate({
    db: ctx.db,
    clock: ctx.clock,
    ctx: ctx.ctx,
    projectId: ctx.projectId,
    runId: ctx.runId,
    target: ctx.target,
    tickets: ctx.tickets,
    settings: ctx.settings,
    worktreePath: ctx.worktreePath,
    baseBranch: ctx.baseRef,
    assertLeaseHeld: ctx.assertLeaseHeld,
    rounds: ctx.rounds,
  });
  return {
    ok: review.outcome === "clean",
    detail: `self-review ${review.outcome} after ${review.rounds.length} round(s)`,
    facts: { review },
  };
}

/**
 * `step:commit` — commit whatever the run changed. An empty tree is reported as `ok: false`, never
 * as a quiet success: a clean agent exit that left no diff delivered nothing, and git is the run's
 * evidence of record.
 */
export async function commitStep(ctx: StepContext): Promise<StepResultWith<"committed">> {
  const { committed } = await commitAll(ctx.worktreePath, commitMessage(ctx));
  return {
    ok: committed,
    detail: committed ? "committed" : "nothing to commit (zero diff)",
    facts: { committed },
  };
}

/**
 * `step:pr` — open (or refresh) the run's single PR. The unresolved advisories from `step:review`
 * ride in the body, which is where the founder meets them at the merge gate.
 */
export async function prStep(ctx: StepContext): Promise<StepResultWith<"pr">> {
  ctx.assertLeaseHeld?.();
  const pr = await openPullRequest({
    repoPath: ctx.repoPath,
    branch: ctx.branch,
    base: ctx.baseBranch,
    title: buildPrTitle(ctx.target, ctx.target.id, ctx.settings.conventionalCommits),
    body: prBody(ctx.target, ctx.tickets, ctx.advisories ?? []),
  });
  return { ok: true, detail: `PR ${pr.ref}`, facts: { pr } };
}

/**
 * `step:claude` — the generic extension point. A project adds a pipeline step by naming a prompt or
 * skill of its own on the formula step (`prompt:<id>` → an agent-style prompt file, `skill:<id>` →
 * the project's `.claude/skills/<id>/SKILL.md`, falling back to anton's own) with NO anton code
 * change.
 *
 * It is cheap because it adds no failure mode: it dispatches through the same driver every other
 * step uses, so session recording, the lease assertion, quota backoff/parking and `ANTON-RESULT`
 * parsing all come along unchanged. A step that names no prompt, or names one that resolves nowhere,
 * parks the run rather than running an agent with no instruction.
 */
export async function claudeStep(ctx: StepContext): Promise<StepResult> {
  const stepId = ctx.step?.id ?? "claude";
  const reasoning = await loadStepReasoning(ctx, stepId);
  ctx.assertLeaseHeld?.();
  return dispatchClaude(ctx, {
    beadId: ctx.target.id,
    prompt: [reasoning, "", "---", "", stepTaskBlock(ctx, stepId)].join("\n"),
    appendSystemPrompt: await buildExecutionSystemPrompt({ seedPrompt: ctx.settings.seedPrompt }),
    failure: (text) => `claude reported an error for step ${stepId}: ${text ?? "unknown"}`,
  });
}

/**
 * Every step anton knows how to execute, by label suffix. A project formula may name any of these;
 * anything else parks the run (see {@link resolveStep}).
 */
export const BUILTIN_STEPS: Readonly<Record<string, StepDefinition>> = Object.freeze({
  implement: {
    name: "implement",
    class: "required",
    summary: "dispatch the ticket's agent in the run's worktree",
    producesDiff: true,
    handler: implementStep,
  },
  verify: {
    name: "verify",
    class: "default-on",
    summary: "run the project's verify gates (tests, lint, typecheck, build)",
    // Gates read the worktree and report; anything they write (a lockfile, a formatter's output) is
    // incidental, so a project is free to verify again after the commit.
    producesDiff: false,
    handler: verifyStep,
  },
  review: {
    name: "review",
    class: "default-on",
    summary: "run the pre-PR self-review gate",
    // The gate commits its own fixes onto the run's branch, so it strands nothing uncommitted.
    producesDiff: false,
    handler: reviewStep,
  },
  commit: {
    name: "commit",
    class: "required",
    summary: "commit the run's work — git is the evidence of record",
    producesDiff: false,
    handler: commitStep,
  },
  pr: {
    name: "pr",
    class: "required",
    summary: "open the run's single pull request",
    producesDiff: false,
    handler: prStep,
  },
  claude: {
    name: "claude",
    class: "additive",
    summary: "dispatch a project-named prompt or skill in the run's worktree",
    // The extension point dispatches an agent with no commit of its own — same as `implement`.
    producesDiff: true,
    handler: claudeStep,
  },
});

/** The steps a formula may not omit — anton's invariant floor, for the validator (anton-6b99). */
export const REQUIRED_STEP_NAMES: readonly string[] = Object.values(BUILTIN_STEPS)
  .filter((s) => s.class === "required")
  .map((s) => s.name);

/** The `step:<name>` suffix a cooked step names its handler with, if any. */
export function stepName(step: CookedStep): string | undefined {
  return labelValueOf(step.labels, STEP_LABEL_PREFIX);
}

/**
 * Why a `step:claude` that names neither a prompt nor a skill cannot run — one sentence, shared by
 * the run-start rejection ({@link resolveStep}) and the dispatch-time backstop
 * ({@link loadStepReasoning}), so an operator meets the same instruction wherever it surfaces.
 */
const NAMES_NO_REASONING =
  `is a \`${STEP_LABEL_PREFIX}:claude\` step but names no prompt — add a \`prompt:<id>\` label (a ` +
  `\`.claude/agents/<id>.md\`) or a \`skill:<id>\` label (a \`.claude/skills/<id>/SKILL.md\`) so anton ` +
  `knows what to dispatch`;

/** The label prefixes a `step:claude` names its instruction with. */
const REASONING_PREFIXES = ["prompt", "skill"] as const;

/**
 * The instruction labels a step carries. A valueless `prompt:` names nothing, so it doesn't count —
 * it falls through to the "names no prompt" rejection rather than reading as an ambiguity.
 */
function reasoningLabels(labels: string[] | undefined): string[] {
  return (labels ?? []).filter((l) =>
    REASONING_PREFIXES.some((p) => l.startsWith(`${p}:`) && l.length > p.length + 1),
  );
}

/**
 * A `step:claude` dispatches EXACTLY ONE instruction. {@link loadStepReasoning} reads `prompt:`
 * first and `skill:` only if there is none, and `labelValueOf` takes the first label of a prefix by
 * array order — so `prompt:security` next to `skill:release`, or two `prompt:` labels, would run one
 * and silently drop the other, with which one it is decided by label ordering. Reject the ambiguity
 * instead: the operator wrote two instructions and anton cannot know which they meant.
 *
 * `subject` names the step (and, at run start, the file), so the same rejection reads correctly from
 * both the validator and the dispatch-time backstop.
 */
function assertOneReasoningLabel(labels: string[] | undefined, subject: string): void {
  const named = reasoningLabels(labels);
  if (named.length === 0) throw new PoisonEpic(`${subject} ${NAMES_NO_REASONING}`);
  if (named.length === 1) return;
  throw new PoisonEpic(
    `${subject} carries ${named.length} instruction labels (${named.join(", ")}), but a ` +
      `\`${STEP_LABEL_PREFIX}:claude\` step dispatches exactly one — anton will not pick one by label ` +
      `order and silently drop the rest. Keep the one you meant, and give the other its own ` +
      `\`[[steps]]\` entry.`,
  );
}

/**
 * The handler a cooked step resolves to.
 *
 * FAIL LOUD on anything else: a step carrying no `step:` label, one carrying several, one naming a
 * handler that doesn't exist, or a `step:claude` naming no prompt, PARKS the run with the step id,
 * the label, and the formula file — never a silent skip, which would let a formula define a run that
 * quietly never opens a PR. Resolution runs at run START (anton-hrql), so all four park before a
 * worktree exists rather than partway through a run that has already committed work.
 */
export function resolveStep(step: CookedStep, formulaFile: string): StepDefinition {
  // A step runs exactly ONE handler. `labelValueOf` would take the first `step:` label by array
  // order, so `["step:implement", "step:verify"]` would implement and silently never verify — and the
  // floor, seeing a resolved implement, would pass it.
  const named = (step.labels ?? []).filter((l) => l.startsWith(`${STEP_LABEL_PREFIX}:`));
  if (named.length > 1) {
    throw new PoisonEpic(
      `formula step "${step.id}" in ${formulaFile} carries ${named.length} \`${STEP_LABEL_PREFIX}:\` ` +
        `labels (${named.join(", ")}), but a step runs exactly one handler — anton will not pick one by ` +
        `label order and silently skip the rest. Split them into separate \`[[steps]]\`.`,
    );
  }
  const name = stepName(step);
  if (!name) {
    throw new PoisonEpic(
      `formula step "${step.id}" in ${formulaFile} carries no \`${STEP_LABEL_PREFIX}:<name>\` label, ` +
        `so anton cannot tell what it should run — label it with one of: ${knownStepNames()}`,
    );
  }
  const definition = BUILTIN_STEPS[name];
  if (definition) {
    // The extension point's instruction rides on the step's OWN labels, so whether it can execute is
    // knowable here — both that it names one, and that it names no more than one. Checking it at
    // dispatch alone (loadStepReasoning) would park a run that had already implemented and committed
    // — the exact halfway failure run-start validation exists to prevent.
    if (definition.name === "claude") {
      assertOneReasoningLabel(step.labels, `formula step "${step.id}" in ${formulaFile}`);
    }
    return definition;
  }
  if (name === "shell") {
    throw new PoisonEpic(
      `formula step "${step.id}" in ${formulaFile} names \`${STEP_LABEL_PREFIX}:shell\`, which anton ` +
        `deliberately does not provide: "run a command, fail on non-zero" is what the project's ` +
        `verify gates already do (Settings → Verify gates, covered by \`${STEP_LABEL_PREFIX}:verify\`). ` +
        `Use a verify gate for a command, or \`${STEP_LABEL_PREFIX}:claude\` with a prompt of your own ` +
        `for anything else.`,
    );
  }
  throw new PoisonEpic(
    `formula step "${step.id}" in ${formulaFile} names \`${STEP_LABEL_PREFIX}:${name}\`, which maps to ` +
      `no anton handler — the run is parked rather than skipping it. Known steps: ${knownStepNames()}. ` +
      `To add a step of your own, use \`${STEP_LABEL_PREFIX}:claude\` with a \`prompt:<id>\` or ` +
      `\`skill:<id>\` label.`,
  );
}

function knownStepNames(): string {
  return Object.keys(BUILTIN_STEPS)
    .map((n) => `${STEP_LABEL_PREFIX}:${n}`)
    .join(", ");
}

// ── shared dispatch ──

/**
 * The session a step records into: the caller's when it handed one in (`owned: false` — the caller
 * closes it), else one this step opens and closes itself. One rule for every step that produces
 * output, so a run never leaks a `running` session and never splits one ticket's record in two.
 */
async function stepSession(
  ctx: StepContext,
  beadId: string,
): Promise<{ session: JobSession; owned: boolean }> {
  if (ctx.session) return { session: ctx.session, owned: false };
  const session = await startJobSession(ctx.db, ctx.clock, {
    projectId: ctx.projectId,
    runId: ctx.runId,
    kind: "execute",
    beadId,
  });
  return { session, owned: true };
}

/**
 * One claude dispatch, with everything a step inherits from the run: the session row + log (opened
 * here unless the caller handed one in), the live-session handle, the `ANTON-RESULT` self-report,
 * and the driver's own quota/transient classification passed through untouched — a `UsageLimitError`
 * must reach the runner as itself so the job reschedules instead of burning an attempt.
 */
async function dispatchClaude(
  ctx: StepContext,
  args: {
    beadId: string;
    prompt: string;
    appendSystemPrompt: string;
    /** The message for a run claude itself reported as failed. */
    failure: (text: string | undefined) => string;
  },
): Promise<StepResult> {
  const claude = ctx.deps?.runClaude ?? runClaude;
  const { session, owned } = await stepSession(ctx, args.beadId);
  ctx.ctx.report({ sessionId: session.sessionId, cwd: ctx.worktreePath });

  try {
    const result = await claude({
      cwd: ctx.worktreePath,
      prompt: args.prompt,
      appendSystemPrompt: args.appendSystemPrompt,
      model: ctx.settings.model,
      permissionMode: ctx.settings.permissionMode ?? "bypassPermissions",
      signal: ctx.ctx.signal,
      onEvent: session.onEvent,
    });
    if (result.sessionId) {
      await setSessionClaudeId(ctx.db, session.sessionId, result.sessionId).catch(() => {});
    }
    // The agent's own verdict. It CORROBORATES the delivery evidence a later step reports, never
    // replaces it — a `delivered` claim on an unchanged tree is exactly the false success the commit
    // step's zero-diff report exists to catch.
    const selfReport = parseAntonResult(result.text);
    await appendSessionLog(session.logPath, `[anton-result] ${formatAntonResult(selfReport)}\n`).catch(
      () => {},
    );
    if (owned) await endSession(ctx.db, ctx.clock, session.sessionId, result.ok ? "done" : "failed");
    return {
      ok: result.ok,
      detail: result.ok ? formatAntonResult(selfReport) : args.failure(result.text),
      facts: { selfReport, sessionIds: [session.sessionId] },
    };
  } catch (e) {
    if (owned) await endSession(ctx.db, ctx.clock, session.sessionId, "failed");
    throw e;
  }
}

/**
 * The reasoning contract a `step:claude` runs with, named by the formula step's own labels:
 * `prompt:<id>` resolves like an agent tag (project `.claude/agents` first, then the operator's
 * global copy, anton's bundled prompts, and installed plugins), `skill:<id>` reads the project's
 * `.claude/skills/<id>/SKILL.md` and falls back to anton's own vendored skill of that name.
 *
 * An unresolvable name PARKS: an agent dispatched with no instruction would burn a session and
 * report whatever it invented. The "names neither" and "names two" cases are already rejected at run
 * start by {@link resolveStep}; the assertion stays here as the backstop for a caller invoking the
 * handler directly.
 */
async function loadStepReasoning(ctx: StepContext, stepId: string): Promise<string> {
  assertOneReasoningLabel(ctx.step?.labels, `formula step "${stepId}"`);
  const promptId = labelValueOf(ctx.step?.labels, "prompt");
  if (promptId) {
    const body = await loadAgentPrompt(promptId, { projectDir: ctx.worktreePath });
    if (body?.trim()) return body.trim();
    throw new PoisonEpic(
      `formula step "${stepId}" names \`prompt:${promptId}\`, which resolves to no prompt file — ` +
        `add \`.claude/agents/${promptId}.md\` to the project, or correct the label`,
    );
  }
  const skillId = labelValueOf(ctx.step?.labels, "skill");
  if (skillId) {
    const body = await loadProjectSkill(ctx.worktreePath, skillId);
    if (body) return body;
    throw new PoisonEpic(
      `formula step "${stepId}" names \`skill:${skillId}\`, which resolves to no skill — add ` +
        `\`.claude/skills/${skillId}/SKILL.md\` to the project, or correct the label`,
    );
  }
  throw new PoisonEpic(`formula step "${stepId}" ${NAMES_NO_REASONING}`);
}

/** The project's own skill, else anton's vendored one of the same name. Undefined when neither exists. */
async function loadProjectSkill(worktreePath: string, id: string): Promise<string | undefined> {
  const path = join(worktreePath, ".claude", "skills", id, "SKILL.md");
  const local = await readFile(path, "utf8").then(stripFrontmatter, () => undefined);
  if (local?.trim()) return local.trim();
  const bundled = await loadSkill(id).catch(() => undefined);
  return bundled?.trim() || undefined;
}

/**
 * What the `step:claude` agent is working ON: the run target, the tickets in scope, and the worktree
 * it is already in. The operating contract (git/beads ownership, scope, fail-loud, the
 * `ANTON-RESULT` line) lives in the system prompt, so it isn't repeated here.
 */
function stepTaskBlock(ctx: StepContext, stepId: string): string {
  const lines = [
    `You are running the \`${stepId}\` step of anton's run pipeline for **${ctx.target.id}** — ` +
      `${ctx.target.title}.`,
    ``,
    `Work in the current worktree (${ctx.branch}, forked from ${ctx.baseBranch}). Follow the ` +
      `instructions above; the operating contract in your system prompt still binds.`,
  ];
  if (ctx.tickets.length > 0) {
    lines.push(
      ``,
      `Tickets in this run:`,
      ...ctx.tickets.map((t) => `- ${t.id} — ${t.title}`),
    );
  }
  return lines.join("\n");
}

/**
 * Which bead a step SPEAKS FOR — the one its commit message names and its session is filed under:
 * the single ticket in scope, else the run target.
 *
 * The distinction is the walk's two phases (anton-lnkt). A ticket-phase step is handed exactly one
 * ticket and speaks for it; a run-phase step is handed every live ticket and speaks for the run as a
 * whole, so filing its record under `tickets[0]` would send anyone diagnosing it to one arbitrary
 * bead's log for work that covered all of them.
 */
export function stepSubject(ctx: Pick<StepContext, "tickets" | "target">): Bead {
  return (ctx.tickets.length === 1 ? ctx.tickets[0] : undefined) ?? ctx.target;
}

/** The commit message for the run's work. */
function commitMessage(ctx: StepContext): string {
  const subject = stepSubject(ctx);
  return `${subject.id}: ${subject.title}`;
}

/**
 * The ticket as it should be dispatched: the board-snapshot bead plus its CURRENT notes blob, read
 * fresh so an operator's steer written after the run started still reaches this ticket's prompt.
 * `bd show` failing (e.g. a locked DB) must never block the run — the snapshot bead is returned.
 */
export async function withDispatchNotes(repo: string, ticket: Bead): Promise<Bead> {
  const fresh = await beads.show(repo, ticket.id).catch(() => null);
  return fresh?.notes ? { ...ticket, notes: fresh.notes } : ticket;
}

/**
 * Cap on each inlined ticket field. anton worktrees carry a frozen embedded Dolt with no remote,
 * so `bd show` inside the worktree can fail (issue #46 root cause #3) — the prompt must therefore
 * carry the spec itself and not be load-bearing on in-worktree DB access. A generous per-field
 * budget keeps a pathologically large body from bloating the prompt while still delivering the
 * whole spec for the common case.
 */
const MAX_TICKET_FIELD_CHARS = 4000;

export function truncateField(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TICKET_FIELD_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TICKET_FIELD_CHARS)}\n… [truncated — run \`bd show\` for the full text]`;
}

/**
 * The concrete task (`-p`) for one ticket. The operating contract (git/beads ownership, scope,
 * learnings, fail-loud) lives in the locked base system prompt (composeSystemPrompt), so it isn't
 * duplicated here.
 *
 * The ticket's full spec — Goal / Out of scope / Verify (the `description` markdown), Acceptance,
 * and Context — is inlined so the agent can implement even when the worktree's beads DB is
 * unreadable (issue #46 root cause #3). `bd show` is offered as a convenience, never as the sole
 * source: a bead whose spec is genuinely empty AND whose `bd show` fails is a fail-loud/blocked
 * condition, not a cue to silently produce nothing.
 *
 * Human notes on the bead (anton-bfy4) are appended last — the operator's steer is the freshest
 * intent, so it reads as a refinement of the contract above it.
 */
export function ticketPrompt(ticket: Bead): string {
  const description = ticket.description?.trim();
  // The gate's own reader: covers every home the contract accepts — bd's acceptance fields AND a
  // description-only `## Acceptance` section. Reading the fields alone said "(none stated)" for a
  // rubric the gate had just accepted, whenever the truncated description block below cut it.
  const acceptance = acceptanceBody(ticket)?.trim();
  // In some boards Context is a separate column; in others it's folded into `description` as a
  // `## Context` heading. Only inline the standalone field when it isn't already in `description`.
  const context =
    ticket.context?.trim() && ticket.context.trim() !== description
      ? ticket.context.trim()
      : undefined;

  const lines = [
    `Implement this beads ticket in the current worktree:`,
    ``,
    `Ticket: ${ticket.id} — ${ticket.title}`,
  ];
  if (description) {
    lines.push(``, `## Goal / Out of scope / Verify`, truncateField(description));
  }
  lines.push(``, `## Acceptance criteria`, acceptance ? truncateField(acceptance) : "(none stated)");
  if (context) {
    lines.push(``, `## Context`, truncateField(context));
  }
  // The human steering channel (anton-bfy4): notes an operator left on the bead between the gates.
  // They come last so the freshest human intent is what the agent reads before the closing rules.
  const humanNotes = humanNotesPromptBlock(ticket.notes);
  if (humanNotes) {
    lines.push(``, truncateField(humanNotes));
  }
  lines.push(
    ``,
    `The full ticket spec is inlined above so you can implement it even if the worktree's beads ` +
      `DB is unreadable. \`bd show ${ticket.id}\` gives the same content when bd is healthy. If ` +
      `the spec above is empty AND \`bd show\` fails, stop and report the ticket as blocked — do ` +
      `not guess or silently bail. Follow the operating contract in your system prompt.`,
  );
  return lines.join("\n");
}

/**
 * `advisory` — findings the self-review reported and did NOT fix (anton-omum). They never hold the PR
 * back, so the merge gate is the only place the founder would ever see them; putting them in the body
 * is what makes "self-reviewed" mean something they can act on rather than trust blindly.
 */
export function prBody(target: Bead, tickets: Bead[], advisory: ReviewFinding[] = []): string {
  // Standalone run (epic-of-one): the single ticket IS the target, so listing it again is noise.
  const standalone = tickets.length === 1 && tickets[0]?.id === target.id;
  const lines = [
    `Autonomous run for **${target.id}** — ${target.title}.`,
    ``,
    ...(standalone ? [] : [`Tickets:`, ...tickets.map((t) => `- ${t.id} — ${t.title}`), ``]),
    ...(advisory.length > 0
      ? [
          `### Unresolved review findings (${advisory.length}, advisory)`,
          ``,
          `anton's pre-PR self-review reported these and left them for you — they don't block the merge.`,
          ``,
          ...findingLines(advisory),
          ``,
        ]
      : []),
    `🤖 Generated with [anton](https://github.com/) autonomous execution`,
  ];
  return lines.join("\n");
}
