/**
 * The decision-point registry (anton-xi9lv): what decide() may be asked, and the shape of a safe
 * answer to it. Nothing here calls a model or takes an action — a point is a declaration, validated
 * once at {@link definePoint} time so a bad threshold or an escape hatch missing from its own option
 * list fails at startup, not mid-decision.
 *
 * Three question shapes, chosen for what decide() exists to do (a pluggable decide() for BOUNDED
 * choices, anton-528bw): a fixed set of options, a bounded score, or yes/no. A `choice` point's
 * options always carry the human escape (or "unknown") — a bounded call with no way out is the one
 * shape decide() must never produce. `score` and `yes-no` have no in-band escape value: their safety
 * net is structural, decide() falls back to `answer: undefined` whenever a rule doesn't fire and the
 * model can't be trusted, rather than inventing a number or boolean to stand in for "ask a human".
 */

export const DECISION_MODES = ["off", "shadow", "assist", "auto"] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];

export const CONSEQUENCES = ["low", "med", "high"] as const;
export type Consequence = (typeof CONSEQUENCES)[number];

export interface ChoiceQuestion {
  readonly kind: "choice";
  readonly options: readonly string[];
}

export interface ScoreQuestion {
  readonly kind: "score";
  readonly min: number;
  readonly max: number;
}

export interface YesNoQuestion {
  readonly kind: "yes-no";
}

export type Question = ChoiceQuestion | ScoreQuestion | YesNoQuestion;

/** What a hard rule or a model can answer with — checked against `question.kind` at decide()'s own
 * boundary, never trusted from its shape alone. */
export type AnswerValue = string | number | boolean;

/** The state a decision point reads, narrowed by its own `stateFields` before anything leaves the
 * process — deliberately untyped: each point's caller owns what shape it hands in. */
export type DecisionState = Readonly<Record<string, unknown>>;

export interface HardRuleOutcome {
  readonly value: AnswerValue;
  /** Why the rule fired — carried into the decision result so a decisions-table row explains itself. */
  readonly reason: string;
}

/**
 * A deterministic pre-model gate. Returns `undefined` to defer to the next rule (or the model);
 * anything else decides outright, with `decidedBy: "rule"` and full confidence — no model call, no
 * threshold check, whatever the mode.
 *
 * `version` is optional caller-supplied semantic identity, hashed into `pointDefinitionHash`
 * (log.ts) alongside the rule's own source. A rule that closes over an imported or captured value —
 * a cutoff date, a threshold constant — has identical `toString()` source before and after that
 * value changes, so the source alone can't tell `agreement()` the rule's decisions now differ. Bump
 * `version` whenever such a captured value changes the rule's behavior; leave it unset when the rule
 * has no closure-dependent behavior worth versioning.
 */
export type HardRule = ((state: DecisionState) => HardRuleOutcome | undefined) & {
  readonly version?: string;
};

export interface DecisionPoint {
  readonly id: string;
  readonly question: Question;
  /** The proposition a backend must actually evaluate — a point's id and `stateFields` names are not
   * instructions, so without this a model has nothing to answer but the shape of the reply, and can
   * clear the confidence threshold while answering an arbitrary question. Sent verbatim to the model
   * (see `buildPrompt`, claude-local.ts). */
  readonly instruction: string;
  /** What a wrong answer costs. Informational today — no gate in this pipeline reads it yet, because
   * nothing here is wired into a job (out of scope, anton-528bw); it exists so the Settings surface
   * and the eventual backend can key off it without a registry shape change. */
  readonly consequence: Consequence;
  /** Confidence an `auto`-mode answer must clear to be acted on unattended. */
  readonly threshold: number;
  readonly defaultMode: DecisionMode;
  /** Which `state` fields reach a model backend — the only path untrusted text may travel. */
  readonly stateFields: readonly string[];
  readonly hardRules: readonly HardRule[];
  /** Required for, and only for, a `choice` question: must be one of `question.options`. */
  readonly escapeValue?: string;
}

function validate(point: DecisionPoint): void {
  if (!point.id) throw new Error("decide: a decision point needs an id");
  if (!point.instruction.trim()) {
    throw new Error(`decide: "${point.id}" needs an instruction stating what it asks a backend`);
  }
  if (!(point.threshold >= 0 && point.threshold <= 1)) {
    throw new Error(`decide: "${point.id}" threshold must be within [0, 1], got ${point.threshold}`);
  }
  if (point.question.kind === "choice") {
    if (point.question.options.length < 2) {
      throw new Error(`decide: "${point.id}" is a choice with fewer than two options`);
    }
    if (new Set(point.question.options).size !== point.question.options.length) {
      throw new Error(`decide: "${point.id}" has duplicate choice options`);
    }
    if (point.escapeValue === undefined || !point.question.options.includes(point.escapeValue)) {
      throw new Error(`decide: "${point.id}" needs an escapeValue that is one of its own options`);
    }
  } else if (point.question.kind === "score") {
    const { min, max } = point.question;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error(`decide: "${point.id}" score bounds must be finite with min <= max, got [${min}, ${max}]`);
    }
  }
  if (point.question.kind !== "choice" && point.escapeValue !== undefined) {
    throw new Error(
      `decide: "${point.id}" is a ${point.question.kind} question — escapeValue only applies to choice`,
    );
  }
}

/**
 * On `globalThis`, not module scope: Next compiles `instrumentation.ts` (where a job step's own
 * module runs and calls {@link definePoint} as a side effect of being imported) and the app layer
 * (RSC pages, route handlers — the Settings page, `project-settings.ts`'s PATCH validator) into
 * SEPARATE module registries, so a plain `new Map()` here would give each graph its own empty copy
 * — exactly the split `service-runner.ts`'s `STATE_KEY` documents and works around for the job
 * runner singleton. Only the instrumentation side ever imports a point-defining module, so it is the
 * only side that ever calls `definePoint`; the app layer only reads what is already there by the
 * time a request arrives, since `instrumentation.ts` runs once at server boot, before any request.
 */
const REGISTRY_KEY = Symbol.for("anton.decide.points");

function registry(): Map<string, DecisionPoint> {
  const global = globalThis as unknown as Record<symbol, Map<string, DecisionPoint> | undefined>;
  return (global[REGISTRY_KEY] ??= new Map());
}

/**
 * Clones the mutable containers a caller could still hold a reference to (`options`, `stateFields`,
 * `hardRules`) so a post-registration mutation — e.g. pushing a duplicate choice option onto the
 * caller's own array — can't reopen an invariant `validate` already checked. Freezing what we store
 * makes that reopening throw instead of silently corrupting the registry entry.
 */
function snapshot(point: DecisionPoint): DecisionPoint {
  const question: Question =
    point.question.kind === "choice"
      ? { kind: "choice", options: Object.freeze([...point.question.options]) }
      : point.question;
  return Object.freeze({
    ...point,
    question: Object.freeze(question),
    stateFields: Object.freeze([...point.stateFields]),
    hardRules: Object.freeze([...point.hardRules]),
  });
}

/**
 * Validates and registers a decision point. Throws on a bad shape or a duplicate id — both are
 * programmer errors caught at definition time, never something a caller is meant to recover from.
 */
export function definePoint(point: DecisionPoint): DecisionPoint {
  validate(point);
  if (registry().has(point.id)) {
    throw new Error(`decide: duplicate decision point id "${point.id}"`);
  }
  const registered = snapshot(point);
  registry().set(point.id, registered);
  return registered;
}

export function getPoint(id: string): DecisionPoint | undefined {
  return registry().get(id);
}

export function listPoints(): readonly DecisionPoint[] {
  return [...registry().values()];
}

/**
 * The untrusted-text boundary (anton-528bw): the subset of `state` a point declared, and the only
 * shape that ever leaves the process. Lives here rather than in decide() because it is a property of
 * the POINT — the decision log hashes the same narrowing (`decisionInputHash`, log.ts), and two
 * copies of the rule would let a row claim a digest over state the backend never saw.
 */
export function narrowState(point: DecisionPoint, state: DecisionState): DecisionState {
  // Prototype-free: a declared field named "__proto__" must land as an own property,
  // not reassign the object's prototype via the inherited setter (which would silently
  // drop it from both the backend prompt and decisionInputHash).
  const picked: Record<string, unknown> = Object.create(null);
  for (const field of point.stateFields) {
    // Bracket access on a field named "__proto__" reads the inherited accessor (Object.prototype
    // itself) when `state` doesn't own that key, not undefined — an own-property check is required
    // to tell "field absent" from "field named __proto__" apart.
    const value = Object.prototype.hasOwnProperty.call(state, field) ? state[field] : undefined;
    Object.defineProperty(picked, field, { value, enumerable: true, writable: true, configurable: true });
  }
  return picked;
}

/** Test-only: the registry is a process-wide singleton (`globalThis`, so it survives Next's
 * instrumentation/app-layer module split — see the field's own doc comment), so suites that define
 * points need a way to clear it between runs instead of leaking into one another. */
export function resetRegistryForTests(): void {
  registry().clear();
}
