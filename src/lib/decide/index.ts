/**
 * decide() (anton-528bw): the pure pipeline that turns a bounded question into an answer plus
 * whether anton may act on it — independent of any backend. A hard rule runs first and, if one
 * fires, decides outright with no model call; otherwise the caller-supplied `ask` stands in for the
 * eventual backend (claude-local lands in anton-spkh7), and its answer is trusted only after
 * shape-checking against the point's own question.
 *
 * Every path funnels through one "acted" formula instead of three near-duplicate branches:
 *
 *   acted = mode === "auto" && answer !== undefined && confidence >= point.threshold
 *
 * `shadow` and `assist` are never `"auto"`, so `acted` is always false for them by construction —
 * decide() still computes the same answer an `auto` point would have acted on (so shadow output is
 * comparable to what a live decision would have done), it just never authorizes acting on it. The
 * difference between the two is entirely how a caller presents `acted: false`: shadow logs it,
 * assist surfaces it as a suggestion — neither is this module's concern.
 */
import { narrowState } from "./points";
import type { AnswerValue, DecisionMode, DecisionPoint, DecisionState, Question } from "./points";

export type DecidedBy = "rule" | "model" | "fallback";

/** What a backend call answers with. `distribution` only makes sense for `choice`/`yes-no` — a
 * `score` backend has nothing to spread probability mass over. */
export interface ModelAnswer {
  readonly value: AnswerValue;
  readonly confidence: number;
  readonly distribution?: Readonly<Record<string, number>>;
  readonly backend: string;
  /** `undefined` when the backend answered but could not identify which model authored the reply
   * (e.g. a model-less event alongside more than one `modelUsage` entry) — never a placeholder
   * string, which `agreement()`'s cohort lookup (log.ts) would otherwise treat as a real, reusable
   * model identity and fold different underlying models' evidence into one cohort (PR #332 review).
   */
  readonly modelVersion?: string;
}

/**
 * Stands in for the eventual backend call. `state` here is already narrowed to the point's own
 * `stateFields` — decide() never hands a backend more of the caller's state than the point declared.
 */
export type ModelCaller = (point: DecisionPoint, state: DecisionState) => Promise<ModelAnswer>;

/**
 * What a {@link ModelCaller} may throw instead of resolving, when it knows which backend/model it was
 * even though it has no trustworthy {@link ModelAnswer} to return (a timeout, a session error, a reply
 * with no parseable report). decide() reads `backend`/`modelVersion` off this if present so the
 * fallback still attributes the attempt — a plain `Error` still falls back the same way, just without
 * attribution, so throwing one remains a valid (if less informative) `ModelCaller` failure.
 */
export class ModelCallError extends Error {
  readonly backend?: string;
  readonly modelVersion?: string;

  constructor(message: string, attribution?: { backend?: string; modelVersion?: string }) {
    super(message);
    this.name = "ModelCallError";
    this.backend = attribution?.backend;
    this.modelVersion = attribution?.modelVersion;
  }
}

export interface DecideInput {
  readonly point: DecisionPoint;
  readonly state: DecisionState;
  /** Overrides `point.defaultMode` — mainly for exercising one point across every mode in tests. */
  readonly mode?: DecisionMode;
  readonly ask: ModelCaller;
}

export interface DecideResult {
  readonly point: string;
  readonly mode: DecisionMode;
  readonly decidedBy: DecidedBy;
  /** `undefined` only for `off` and `fallback` — "no answer", never an invented one. */
  readonly answer?: AnswerValue;
  readonly confidence: number;
  readonly distribution?: Readonly<Record<string, number>>;
  readonly backend?: string;
  readonly modelVersion?: string;
  readonly acted: boolean;
  readonly reason?: string;
}

function fireHardRule(point: DecisionPoint, state: DecisionState) {
  for (const rule of point.hardRules) {
    const outcome = rule(state);
    if (outcome) return outcome;
  }
  return undefined;
}

/** Exported for {@link settleDecision} (log.ts): an operator answer needs the same shape check
 * before it is trusted as evidence, or a typo (`"fixed"` for `"fix"`) or an answer to a different
 * question would settle silently and, being first-write-wins, could never be corrected. */
export function isValidAnswer(question: Question, value: AnswerValue): boolean {
  switch (question.kind) {
    case "choice":
      return typeof value === "string" && question.options.includes(value);
    case "score":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= question.min &&
        value <= question.max
      );
    case "yes-no":
      return typeof value === "boolean";
  }
}

function isValidConfidence(confidence: number): boolean {
  return (
    typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
  );
}

function acted(mode: DecisionMode, answer: AnswerValue | undefined, confidence: number, threshold: number): boolean {
  return mode === "auto" && answer !== undefined && confidence >= threshold;
}

function fallback(
  point: DecisionPoint,
  mode: DecisionMode,
  reason: string,
  attribution?: { backend?: string; modelVersion?: string },
): DecideResult {
  return {
    point: point.id,
    mode,
    decidedBy: "fallback",
    confidence: 0,
    acted: false,
    reason,
    ...attribution,
  };
}

/**
 * The pure pipeline. Never throws on a failed `ask` or an invalid model answer — those fall back to
 * a human, per the point's own contract, rather than surfacing as an exception every caller must
 * also handle.
 */
export async function decide(input: DecideInput): Promise<DecideResult> {
  const { point, state, ask } = input;
  const mode = input.mode ?? point.defaultMode;

  if (mode === "off") return fallback(point, mode, "mode is off");

  const rule = fireHardRule(point, state);
  if (rule) {
    // `HardRuleOutcome.value` is only the broad `AnswerValue` union, so a rule that answers outside
    // its own point's question (an unknown choice, an out-of-range score) is a type error TypeScript
    // cannot catch — the same boundary a model answer crosses below, applied before a rule is trusted.
    if (!isValidAnswer(point.question, rule.value)) {
      return fallback(point, mode, "invalid hard-rule answer");
    }
    return {
      point: point.id,
      mode,
      decidedBy: "rule",
      answer: rule.value,
      confidence: 1,
      acted: acted(mode, rule.value, 1, point.threshold),
      reason: rule.reason,
    };
  }

  let modelAnswer: ModelAnswer;
  try {
    modelAnswer = await ask(point, narrowState(point, state));
  } catch (error) {
    // Same reasoning as the invalid-answer fallback below: a thrown `ModelCallError` may still know
    // which backend/model it was (a timeout, a session error, an unparseable reply) even though it
    // has no answer to return, and dropping that here would erase the attempt from the log the same
    // way an unattributed invalid answer would (PR #332 review).
    const attribution =
      error instanceof ModelCallError ? { backend: error.backend, modelVersion: error.modelVersion } : undefined;
    return fallback(point, mode, "model call failed", attribution);
  }

  if (!isValidConfidence(modelAnswer.confidence) || !isValidAnswer(point.question, modelAnswer.value)) {
    // Preserve which backend/model attempted this even though its answer didn't validate — dropping
    // it here would erase the attempt from the log (recordDecision) entirely, and agreement()'s
    // cohort lookup would then keep reading a predecessor model as "current" for as long as the
    // replacement kept failing (PR #332 review).
    return fallback(point, mode, "invalid model answer", {
      backend: modelAnswer.backend,
      modelVersion: modelAnswer.modelVersion,
    });
  }

  return {
    point: point.id,
    mode,
    decidedBy: "model",
    answer: modelAnswer.value,
    confidence: modelAnswer.confidence,
    distribution: modelAnswer.distribution,
    backend: modelAnswer.backend,
    modelVersion: modelAnswer.modelVersion,
    acted: acted(mode, modelAnswer.value, modelAnswer.confidence, point.threshold),
  };
}

export {
  CONSEQUENCES,
  DECISION_MODES,
  definePoint,
  getPoint,
  listPoints,
  narrowState,
  resetRegistryForTests,
} from "./points";
export type {
  AnswerValue,
  ChoiceQuestion,
  Consequence,
  DecisionMode,
  DecisionPoint,
  DecisionState,
  HardRule,
  HardRuleOutcome,
  Question,
  ScoreQuestion,
  YesNoQuestion,
} from "./points";
