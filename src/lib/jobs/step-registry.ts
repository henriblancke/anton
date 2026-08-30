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
 * ── Where the code lives (anton-8d0f) ──
 * This file is the WIRING — the table below, and the entry points every caller in the runtime
 * imports. The implementations sit in `steps/`, split along the seams the steps themselves name:
 * `steps/context` and `steps/result` (what a step is handed, what it reports), `steps/dispatch`
 * (the one claude call), `steps/prompts` (everything a step says), `steps/resolve` (a label
 * becoming a handler or a reasoning contract), and the handlers in `steps/agent`, `steps/gates` and
 * `steps/git`. Re-exported here rather than moved, so no caller depends on the split.
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
import { claudeStep, implementStep } from "./steps/agent";
import { reviewStep, verifyStep } from "./steps/gates";
import { commitStep, prStep } from "./steps/git";
import { resolveStepIn } from "./steps/resolve";
import type { CookedStep } from "./steps/context";
import type { StepDefinition } from "./steps/result";

export { stepSubject, type CookedStep, type StepContext, type StepDeps } from "./steps/context";
export {
  type StepClass,
  type StepDefinition,
  type StepFacts,
  type StepHandler,
  type StepResult,
  type StepResultWith,
} from "./steps/result";
export { claudeStep, implementStep, withDispatchNotes } from "./steps/agent";
export { reviewStep, verifyStep } from "./steps/gates";
export { commitStep, prStep } from "./steps/git";
export { prBody, ticketPrompt, truncateField } from "./steps/prompts";
export { stepName, STEP_LABEL_PREFIX, type StepRegistry } from "./steps/resolve";

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


/**
 * The handler a cooked step resolves to, against the built-in registry — the seam every caller in
 * the runtime goes through. The resolution RULES (and their park messages) live in
 * {@link resolveStepIn}; this is only the registry it reads them against.
 */
export function resolveStep(step: CookedStep, formulaFile: string): StepDefinition {
  return resolveStepIn(BUILTIN_STEPS, step, formulaFile);
}
