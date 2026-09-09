/**
 * The model routing table (anton-uu7r): which model each KIND of work runs on, authored in the same
 * shape as the pipeline variants beside it — an ORDERED list where the order IS the precedence.
 *
 * Storage and validation only at this stage; nothing resolves or dispatches against it yet. The
 * shape is fixed here so the settings boundary, the settings form and the eventual resolver all
 * read one definition of what a rule is.
 */
import type { JobType } from "./queue";
import type { BuiltinStepId } from "./step-ids";
import type { ProjectSettings } from "../projects";

/**
 * One routing rule: the work it matches, and the model that work runs on.
 *
 * Every matcher is optional and they AND together — a rule naming only `jobType` routes that whole
 * job type, one naming `jobType` + `step` routes a single step of it, and one naming nothing at all
 * is a catch-all that routes everything the rows above it did not. A matcher left out is not a
 * wildcard the operator has to spell; it is simply a question the rule does not ask.
 */
export interface ModelRoute {
  /** A {@link JobType} — the kind of job. Absent ⇒ any job type. */
  jobType?: JobType;
  /** A pipeline step id (`step:<name>` in the run formula). Absent ⇒ any step. */
  step?: BuiltinStepId;
  /** An exact bead label — `risk:high`, `size:S`. Matched literally; no globs. Absent ⇒ any bead. */
  label?: string;
  /**
   * The model this work runs on. A FREE STRING, deliberately: a gateway combo name like
   * `cc/claude-opus-5[1m]` is not knowable to anton, and an allowlist here would reject the exact
   * value an operator with a gateway needs to write.
   */
  model: string;
}

/** The matcher keys, in the order a rule reads. */
export const MODEL_ROUTE_MATCHERS = ["jobType", "step", "label"] as const;

type Matcher = (typeof MODEL_ROUTE_MATCHERS)[number];

/**
 * Just the matchers, loosely typed — what {@link subsumes} needs and all it needs. Widened from
 * {@link ModelRoute} so the settings FORM can flag an unreachable row against the same function the
 * server rejects it with, rather than reimplementing the rule in a client mirror that can drift.
 */
export type ModelRouteMatch = { [K in Matcher]?: string };

/**
 * Whether `earlier` fires for everything `later` would — which makes `later` dead, because the
 * first match wins.
 *
 * True when every question `earlier` asks, `later` answers the same way: a rule constrains what it
 * matches, so a rule asking FEWER questions matches a SUPERSET. `{jobType: execute-epic}` subsumes
 * `{jobType: execute-epic, step: verify}`; a bare catch-all subsumes everything after it; and two
 * identical rules subsume each other. `{label: "a"}` and `{label: "b"}` subsume neither way.
 */
export function subsumes(earlier: ModelRouteMatch, later: ModelRouteMatch): boolean {
  return MODEL_ROUTE_MATCHERS.every(
    (key: Matcher) => earlier[key] === undefined || earlier[key] === later[key],
  );
}

/** The facts known at one Claude invocation. Omitted step/labels mean that call has none. */
export interface ModelRouteContext {
  jobType: JobType;
  step?: BuiltinStepId;
  labels?: readonly string[];
}

/** Resolve in author order; the project's existing model remains the exact fallback. */
export function resolveModel(
  settings: Pick<ProjectSettings, "model" | "modelRoutes">,
  context: ModelRouteContext,
): string | undefined {
  const labels = new Set(context.labels ?? []);
  const match = settings.modelRoutes?.find(
    (rule) =>
      (rule.jobType === undefined || rule.jobType === context.jobType) &&
      (rule.step === undefined || rule.step === context.step) &&
      (rule.label === undefined || labels.has(rule.label)),
  );
  return match?.model ?? settings.model;
}
