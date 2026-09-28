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
  readonly modelVersion: string;
}

/**
 * Stands in for the eventual backend call. `state` here is already narrowed to the point's own
 * `stateFields` — decide() never hands a backend more of the caller's state than the point declared.
 */
export type ModelCaller = (point: DecisionPoint, state: DecisionState) => Promise<ModelAnswer>;

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

function isValidAnswer(question: Question, value: AnswerValue): boolean {
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

function fallback(point: DecisionPoint, mode: DecisionMode, reason: string): DecideResult {
  return { point: point.id, mode, decidedBy: "fallback", confidence: 0, acted: false, reason };
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
  } catch {
    return fallback(point, mode, "model call failed");
  }

  if (!isValidConfidence(modelAnswer.confidence) || !isValidAnswer(point.question, modelAnswer.value)) {
    return fallback(point, mode, "invalid model answer");
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
