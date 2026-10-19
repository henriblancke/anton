/**
 * The jev backend (anton-7i3ui): decide()'s `ask` implemented as one HTTP call to TypeSafe's Jev
 * (`POST /v1/systemone`) — a calibrated choice/score/yes-no answer in milliseconds, not a claude
 * session (claude-local.ts is the fallback the parent epic, anton-l70sq, wires this behind).
 *
 * Three things this module owns, matching the three acceptance bars:
 *
 *  - QUESTION MAPPING. decide()'s three question kinds become Jev's `choice`/`score`/`noul` types.
 *    `choice` and `noul` (yes-no) map directly. `score` has no natural fit: Jev's score primitive
 *    answers against a named rubric (`criteria`, an ordered list of level descriptions) and returns a
 *    position over that rubric's own index range, not the point's `[min, max]` — so this module sends
 *    exactly two criteria entries (the point's min and max, stringified) and rescales Jev's 0..1
 *    response linearly back onto `[min, max]`. See {@link toJevQuestion} and {@link rescaleScore}.
 *  - ZOD-VALIDATED RESPONSE. The reply is parsed against a schema shaped from Jev's own documented
 *    response (`model`, `answers` keyed by question id, each carrying confidence/probabilities per
 *    docs.typesafe.ai/introduction/quickstart) — never trusted from a bare `.json()` cast.
 *  - PINNED VERSION ENFORCED. `jevBackend` refuses to construct against `jev-latest` or any model
 *    string that isn't an exact `jev-X.Y.Z` — a decision log row must be able to name the one version
 *    that answered, not a moving target (parent epic's own acceptance bar).
 */
import { z } from "zod";
import { ModelCallError, type ModelAnswer, type ModelCaller } from "../index";
import { narrowState, type DecisionPoint, type DecisionState } from "../points";

const BACKEND = "jev";
const SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";

/** `jev-<major>.<minor>.<patch>` — an exact version, never `jev-latest` or a bare tag. */
const PINNED_MODEL_PATTERN = /^jev-\d+\.\d+\.\d+$/;

/** Jev answers in ~70-500 ms per vendor figures (parent epic's own doc) — generous enough to absorb
 * ordinary network jitter without making a caller wait anywhere near claude-local's budget. */
export const DEFAULT_JEV_TIMEOUT_MS = 5_000;

export interface JevConfig {
  apiKey: string;
  /** Must be an exact `jev-X.Y.Z` — {@link jevBackend} throws at construction time otherwise. */
  model: string;
  /** Overrides {@link SYSTEMONE_URL}, for tests. */
  baseUrl?: string;
  /** Overrides {@link DEFAULT_JEV_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable so a test can drive the backend without a real network call. */
  fetchImpl?: typeof fetch;
}

/** Exported so Settings can refuse an unpinned version at the API boundary (anton-p32iy), before a
 * misconfigured project ever gets as far as constructing a backend. */
export function isPinnedJevModel(model: string): boolean {
  return PINNED_MODEL_PATTERN.test(model);
}

function assertPinnedModel(model: string): void {
  if (!isPinnedJevModel(model)) {
    throw new Error(
      `decide/jev: model must be pinned to an exact version (e.g. "jev-1.13.0"), got "${model}"`,
    );
  }
}

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()),
});

const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number().min(0).max(1),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
});

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});

const jevAnswerSchema = z.discriminatedUnion("type", [
  choiceAnswerSchema,
  scoreAnswerSchema,
  noulAnswerSchema,
]);

const systemOneResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z
    .object({ input_tokens: z.number(), output_tokens: z.number() })
    .optional(),
});

type JevAnswer = z.infer<typeof jevAnswerSchema>;

type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

/** decide()'s question shapes, mapped to Jev's `choice`/`score`/`noul` primitives (docs.typesafe.ai
 * /introduction/quickstart). A `ChoiceQuestion` has no per-option description to send as Jev's
 * `criteria` text (only the option labels themselves), so each option stands in as its own
 * criteria entry — the point's shared `instructions` is what actually distinguishes them. A
 * `ScoreQuestion` has no rubric levels either, just `[min, max]`; two criteria entries (the
 * endpoints) are enough to let {@link rescaleScore} map Jev's 0..1 response back onto that range. */
function toJevQuestion(point: DecisionPoint): JevQuestion {
  const { question, instruction } = point;
  switch (question.kind) {
    case "choice":
      return {
        type: "choice",
        instructions: instruction,
        criteria: Object.fromEntries(question.options.map((option) => [option, option])),
      };
    case "score":
      return {
        type: "score",
        instructions: `${instruction} (answer on a scale from ${question.min} to ${question.max})`,
        criteria: [String(question.min), String(question.max)],
      };
    case "yes-no":
      return { type: "noul", instructions: instruction };
  }
}

/** Jev's `score` reports a weighted position over the `criteria` array's own index range (0 to
 * `criteria.length - 1`), not the point's `[min, max]` — confirmed against the docs' own example
 * (a 3-entry rubric, legend keyed "0"/"1"/"2", score 0.67 landing inside that span). Sending exactly
 * two criteria entries (the endpoints) makes that index range `[0, 1]`, so this rescale is a plain
 * linear map onto `[min, max]` with no further knowledge of what lies between. */
function rescaleScore(score: number, min: number, max: number): number {
  return min + score * (max - min);
}

function toModelAnswer(point: DecisionPoint, modelVersion: string, answer: JevAnswer): ModelAnswer {
  const base = { backend: BACKEND, modelVersion };
  const { question } = point;

  if (question.kind === "choice" && answer.type === "choice") {
    return { ...base, value: answer.choice, confidence: answer.confidence, distribution: answer.probabilities };
  }
  if (question.kind === "score" && answer.type === "score") {
    return {
      ...base,
      value: rescaleScore(answer.score, question.min, question.max),
      confidence: answer.confidence,
    };
  }
  if (question.kind === "yes-no" && answer.type === "noul") {
    const value = answer.noul >= 0.5;
    return {
      ...base,
      value,
      confidence: value ? answer.noul : 1 - answer.noul,
      distribution: { yes: answer.noul, no: 1 - answer.noul },
    };
  }

  // Jev echoed a different `type` than the question we sent asked for — not a shape decide() itself
  // would ever pass through as a trustworthy answer, so attribute the attempt and let the caller fall
  // back rather than coerce a mismatched reply into this point's question.
  throw new ModelCallError(
    `decide/jev: response type "${answer.type}" for "${point.id}" doesn't match its question kind "${question.kind}"`,
    base,
  );
}

/**
 * One POST to `/v1/systemone`, parsed and Zod-validated. Throws a plain `Error` on a non-2xx
 * response, a network failure, or a body that fails schema validation — the caller (the returned
 * `ask`) is what attaches backend/model attribution and decides whether to retry.
 */
async function callSystemOne(
  config: JevConfig,
  point: DecisionPoint,
  state: DecisionState,
  signal: AbortSignal,
): Promise<z.infer<typeof systemOneResponseSchema>> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(config.baseUrl ?? SYSTEMONE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state,
      model: config.model,
      questions: { [point.id]: toJevQuestion(point) },
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`decide/jev: systemone responded ${response.status} for "${point.id}"`);
  }

  const body: unknown = await response.json();
  return systemOneResponseSchema.parse(body);
}

/**
 * Build the jev {@link ModelCaller}. Validates the pinned model up front — a misconfigured
 * `jev-latest` (or any non-exact version) fails at construction, never silently at call time — and
 * retries the systemone call exactly once on failure (out of scope: anything past one retry).
 */
export function jevBackend(config: JevConfig): ModelCaller {
  assertPinnedModel(config.model);
  const timeoutMs = config.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;

  return async function ask(point: DecisionPoint, state: DecisionState): Promise<ModelAnswer> {
    const narrowed = narrowState(point, state);
    let lastError: unknown;

    // One attempt, one retry — no more (out of scope). Each gets its own deadline so a stuck first
    // attempt can't eat the retry's own timeout budget.
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const parsed = await callSystemOne(config, point, narrowed, controller.signal);
        const answer = parsed.answers[point.id];
        if (!answer) {
          throw new Error(`decide/jev: systemone reply carried no answer for "${point.id}"`);
        }
        return toModelAnswer(point, parsed.model, answer);
      } catch (error) {
        if (error instanceof ModelCallError) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new ModelCallError(
      `decide/jev: systemone call failed for "${point.id}": ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      { backend: BACKEND, modelVersion: config.model },
    );
  };
}
