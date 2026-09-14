/**
 * The `bd cook` seam (anton-brdg): argv builder and the typed parse of a cooked formula. Lifted
 * out of ./bd (anton-lsad); `beads.cook` in ./bd is the spawn, everything here is pure.
 */
import { pick, str, strings } from "./bd-json";

// ── formula cooking (anton-brdg) ──
//
// `bd cook` resolves a `.formula.{toml,json}` into its steps. This is the ONLY place anton shells a
// formula verb, so the pipeline stays swappable: the loader (anton-hrql) and the invariant-floor
// validator (anton-6b99) consume {@link CookedFormula}, never bd stdout.
//
// Deliberately a READ: `--persist` is never passed. Persisting materialises a proto bead, which is a
// write — it would need bdWrite's snapshot invalidation and a dolt sync, and anton has no use for a
// stored proto (it cooks per run). See formula.ts for why anton cooks rather than pours.

/**
 * A step's gate — the async wait condition bd blocks it on. `type` is bd's gate kind (`human`,
 * `timer`, `gh:run`, `gh:pr`, `bead`); `await_id` and `timeout` are that kind's parameter. Read-only
 * here: resolving gates is anton-uk95's, so this seam reports a gate rather than acting on one.
 */
export interface CookedGate {
  type: string;
  /** What the gate waits on: a run/PR ref for `gh:*`, `<rig>:<bead-id>` for `bead`. */
  await_id?: string;
  /** `timer` only — the window after which the gate expires. */
  timeout?: string;
}

/**
 * One resolved step of a cooked formula, in declaration order.
 *
 * `labels` is where a step names its handler (`step:<name>`) and its prompt: `bd cook` silently
 * DROPS step keys it doesn't recognise, so anton's per-step configuration has to ride on labels
 * rather than a custom formula key. `needs` carries the DAG edges (a `blocks` edge once poured).
 */
export interface CookedStep {
  id: string;
  title?: string;
  /** The bd issue type the step materialises as (`task`, `feature`, …). */
  type?: string;
  labels?: string[];
  /** Ids of the steps this one depends on — bd's `needs` AND `depends_on` merged (see {@link needsOf}). */
  needs?: string[];
  gate?: CookedGate;
}

/** A cooked formula — the resolved pipeline the runtime walks. */
export interface CookedFormula {
  /** The formula's own name. bd's key is `formula`, NOT `name`: a formula written with `name`
   * parses and then fails cook with "name is required" (verified on bd 1.1.2, anton-upfc). */
  formula: string;
  description?: string;
  /** Absolute path bd cooked from — what a park message must name so an operator finds the file. */
  source?: string;
  steps: CookedStep[];
}

/**
 * How a formula is cooked. `compile` keeps `{{var}}` placeholders (modelling, validation of the
 * shipped default); `runtime` substitutes them and requires every variable to have a value —
 * a missing one exits non-zero rather than rendering a half-resolved pipeline.
 */
export type CookMode = "compile" | "runtime";

export interface CookOptions {
  /** Defaults to `runtime` when `vars` are given, `compile` otherwise. */
  mode?: CookMode;
  /** `{{var}}` values for this run, passed as `--var k=v`. */
  vars?: Record<string, string>;
}

/**
 * Pure argv builder for `bd cook`, exposed for testing (like {@link buildUpdateArgs}).
 *
 * `--mode` is always explicit so the argv never depends on bd's implicit "any --var enables runtime"
 * rule. That rule is also why `mode: "compile"` WITH vars is rejected rather than emitted: bd
 * substitutes whenever a `--var` is present, so such an argv would declare an intent bd ignores.
 */
export function buildCookArgs(formula: string, opts: CookOptions = {}): string[] {
  const vars = Object.entries(opts.vars ?? {});
  if (opts.mode === "compile" && vars.length > 0) {
    throw new Error(
      `bd cook ${formula}: mode "compile" cannot be combined with vars — bd substitutes whenever ` +
        `--var is present, so the placeholders would not survive. Cook without vars, or use "runtime".`,
    );
  }
  for (const [k] of vars) {
    // bd splits `--var k=v` on the FIRST `=`, so a key containing one silently sets a different
    // variable (values may contain `=` freely). Fail loud rather than parameterise the wrong var.
    if (!k || k.includes("=")) {
      throw new Error(`bd cook ${formula}: invalid variable name ${JSON.stringify(k)}`);
    }
  }
  const mode: CookMode = opts.mode ?? (vars.length > 0 ? "runtime" : "compile");
  return [
    "cook",
    formula,
    `--mode=${mode}`,
    ...vars.flatMap(([k, v]) => ["--var", `${k}=${v}`]),
    "--json",
  ];
}

/**
 * A step's prerequisites, from EITHER spelling bd accepts. bd cooks `needs` and `depends_on` through
 * verbatim — it normalises neither into the other (measured on bd 1.1.2) — so reading only `needs`
 * would hand the walker a formula with no edges at all: it would run in declaration order, or be
 * rejected by the invariant floor for an ordering the file actually expressed. Merged and deduped
 * here so every consumer downstream reads ONE field.
 */
function needsOf(s: Record<string, unknown> | null | undefined): string[] | undefined {
  const merged = [...(strings(s?.needs) ?? []), ...(strings(s?.depends_on) ?? [])];
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function gateOf(v: unknown): CookedGate | undefined {
  const g = v as Record<string, unknown> | null | undefined;
  const type = str(g?.type);
  if (!type) return undefined;
  return { type, ...pick("await_id", str(g?.await_id)), ...pick("timeout", str(g?.timeout)) };
}

/**
 * Parse `bd cook --json` into the typed pipeline, normalising each step to {@link CookedStep} so no
 * caller ever touches bd's raw output. Fails loud on anything that is not a cooked formula —
 * a step with no id has no handler, no park message, and no place in the DAG, so it cannot be
 * silently dropped. `formula` names the cooked formula in every message.
 */
export function parseCookedFormula(raw: string, formula: string): CookedFormula {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `bd cook ${formula}: output was not JSON (got ${JSON.stringify(raw.slice(0, 200))})`,
      { cause: e },
    );
  }
  const doc = parsed as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`bd cook ${formula}: expected a formula object, got ${typeof parsed}`);
  }
  if (!Array.isArray(doc.steps)) {
    throw new Error(`bd cook ${formula}: cooked output has no steps array`);
  }
  const steps = doc.steps.map((step, i): CookedStep => {
    const s = step as Record<string, unknown> | null;
    const id = str(s?.id)?.trim();
    if (!id) {
      throw new Error(`bd cook ${formula}: step ${i} has no id — every step must declare one`);
    }
    return {
      id,
      ...pick("title", str(s?.title)),
      ...pick("type", str(s?.type)),
      ...pick("labels", strings(s?.labels)),
      ...pick("needs", needsOf(s)),
      ...pick("gate", gateOf(s?.gate)),
    };
  });
  return {
    formula: str(doc.formula) ?? formula,
    ...pick("description", str(doc.description)),
    ...pick("source", str(doc.source)),
    steps,
  };
}
