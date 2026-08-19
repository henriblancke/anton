/**
 * What a step REPORTS, and how the registry describes one.
 *
 * Separate from the context because these are the types a caller reads on the way OUT — the facts,
 * the verdict, and the floor class the formula validator (anton-6b99) enforces.
 */
import type { AntonResult } from "../../claude/anton-result";
import type { PullRequest } from "../../git/ops";
import type { ReviewGateResult } from "../review-gate";
import type { StepContext } from "./context";

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
 * A step result whose caller can count on specific facts. The registry maps every step to the
 * uniform {@link StepHandler}, but a caller invoking one handler DIRECTLY (execute-epic, until the
 * walker lands) knows which facts it produces — so the handler's own signature promises them and no
 * call site has to assert.
 */
export interface StepResultWith<K extends keyof StepFacts> extends StepResult {
  facts: Required<Pick<StepFacts, K>> & StepFacts;
}

/** The uniform entry point every registered step is invoked through. */
export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

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

