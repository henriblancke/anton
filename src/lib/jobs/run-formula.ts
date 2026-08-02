/**
 * The run formula (anton-hrql): the pipeline anton walks, owned per project.
 *
 * anton ships `anton-run.formula.toml` as an asset and the installer drops it into the project's
 * `.beads/formulas/` — the same no-clobber shape as the bead skeleton (beads/config.mjs), the verify
 * gates, and the reviewer. A project-local file of that name therefore always wins, and it is
 * git-tracked, so a tuned pipeline travels to every clone.
 *
 * This module is the LOADER, and it exists to make a broken pipeline fail at the START of a run
 * rather than halfway through one. `validateRunFormula` is called before any worktree is created, and
 * it parks on:
 *
 * 1. **Unparseable TOML** — with the file path and the parser's own line/column.
 * 2. **A key bd does not recognise** — `bd cook` DROPS unknown keys silently and exits 0, so a
 *    `lables = ["step:implement"]` typo would cook into a step with no handler and park mid-run (or,
 *    worse, define a pipeline that quietly never opens a PR). anton reports them instead.
 * 3. **An `extends`** — {@link assertNoExtends}: the inherited source is never scanned, so the
 *    dropped-key check above would cover only half the pipeline anton then walks.
 * 4. **A cook failure** — bd's own reason, which already names the file.
 * 5. **A step that maps to no handler, or names two** — {@link resolveStep}'s message, naming the
 *    step and label. A `step:claude` naming neither a `prompt:` nor a `skill:` parks there too: it
 *    would otherwise reach a human only at dispatch, after `implement` had already committed.
 * 6. **A step bd gated** — {@link assertNoStepGates}: anton's walker has no gate resolution, so a
 *    gated step would run immediately rather than waiting on what the project gated it behind.
 *
 * What it deliberately does NOT do: check the cooked pipeline against anton's invariant floor (which
 * steps may be omitted or reordered) — that is anton-6b99's, and it consumes what this returns.
 *
 * It is also where a run picks WHICH pipeline it walks (anton-aa3m): a project may map a bead label
 * to a formula of its own, so `risk:high` can carry extra steps while everything else walks the
 * default. See {@link selectRunFormula} for the precedence.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { beads, type CookedFormula, type CookedStep } from "../beads/bd";
import {
  RUN_FORMULA_FILENAME,
  bundledRunFormulaPath as bundledRunFormulaUnder,
} from "../beads/config.mjs";
import { PoisonEpic } from "./errors";
import { resolveStep, type StepDefinition } from "./step-registry";

export { RUN_FORMULA_FILENAME };

/** The formula's own name — how `bd cook` / `bd formula show` address it. */
export const RUN_FORMULA_NAME = "anton-run";

/** A cooked step paired with the anton handler its `step:<name>` label resolved to. */
export interface ResolvedStep {
  step: CookedStep;
  definition: StepDefinition;
}

/** A pipeline that parsed, cooked, and resolved — what the walker (anton-lnkt) executes. */
export interface RunFormula extends FormulaChoice {
  /** The cooked pipeline, its `steps` already in {@link orderFormulaSteps execution order}. */
  cooked: CookedFormula;
  /** Every step in execution order, each with its resolved handler. */
  steps: ResolvedStep[];
}

/** Where a project keeps its own pipeline — the path bd's own formula search hits first. */
export function projectRunFormulaPath(repoPath: string): string {
  return join(repoPath, ".beads", "formulas", RUN_FORMULA_FILENAME);
}

/**
 * One entry of a project's label→formula map (anton-aa3m). A LABEL, not a predicate: the whole
 * feature is "risk:high runs a different pipeline", and an expression language would buy nothing a
 * label doesn't already say.
 */
export interface FormulaVariant {
  /** An exact bead label — `risk:high`, `size:S`, `domain:docs`. Matched literally; no globs. */
  label: string;
  /** The formula's name: `.beads/formulas/<formula>.formula.toml` in the project. */
  formula: string;
}

/** Which pipeline a run walks, and why — the two things the run record has to name (anton-aa3m). */
export interface FormulaChoice {
  /** Absolute path the pipeline is read from — a variant, the project's copy, or anton's asset. */
  source: string;
  /** The mapped label that selected it; absent ⇒ no mapping matched, so the default applies. */
  variant?: string;
}

/**
 * A formula NAME as it may appear in a project's variant map: what `<name>.formula.toml` accepts as
 * a filename, and nothing that could climb out of `.beads/formulas/` (no separators, and `..` can't
 * match because the name must start and end alphanumeric). Settings are hand-editable through the
 * API, so this is enforced here as well as at that boundary.
 */
const FORMULA_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * The pipeline a run over `labels` walks, by a precedence that is deterministic and inspectable:
 *
 * 1. **The first variant, in the project's own declaration order, whose label the run target
 *    carries.** The operator's ORDER IS THE PRECEDENCE — a bead labelled both `risk:high` and
 *    `size:S` walks whichever of the two the project listed first, every time, with no tie-break
 *    anton invents on its behalf.
 * 2. Else the project's own `anton-run.formula.toml`.
 * 3. Else anton's bundled default.
 *
 * So a project with no map configured is exactly where it was before this existed (2 → 3), which is
 * the point: the feature is invisible until someone maps a label.
 *
 * The labels are the RUN TARGET's, not its tickets': a run is one worktree and one PR, so it walks
 * one pipeline. A mapped variant whose file is missing PARKS rather than falling back to the default
 * — the project asked for a different pipeline, and silently walking another one is the failure this
 * whole seam exists to make impossible.
 */
export function selectRunFormula(
  repoPath: string,
  labels: readonly string[] = [],
  variants: readonly FormulaVariant[] = [],
): FormulaChoice {
  const carried = new Set(labels);
  const match = variants.find((v) => carried.has(v.label));
  if (!match) return { source: resolveRunFormulaPath(repoPath) };

  if (!FORMULA_NAME.test(match.formula)) {
    throw new PoisonEpic(
      `this project maps label \`${match.label}\` to run formula "${match.formula}", which is not a ` +
        `formula name — a variant names a file in \`.beads/formulas/\` (\`<name>.formula.toml\`), so ` +
        `it may only contain letters, digits, \`.\`, \`-\` and \`_\`. Correct the mapping in ` +
        `Settings → Pipeline variants, then resume the run.`,
    );
  }

  const path = join(repoPath, ".beads", "formulas", `${match.formula}.formula.toml`);
  if (existsSync(path)) return { source: path, variant: match.label };
  assertNoJsonFormulaAt(path);
  throw new PoisonEpic(
    `this project maps label \`${match.label}\` to run formula "${match.formula}", but ${path} does ` +
      `not exist — anton parks rather than walking its default pipeline for a bead the project ` +
      `asked to run differently. Add the formula (or remove the mapping in Settings → Pipeline ` +
      `variants), then resume the run.`,
  );
}

/**
 * A `.json` sibling PARKS rather than being passed over: `bd cook` accepts either extension, so a
 * project that wrote `<name>.formula.json` has written a pipeline anton would silently ignore in
 * favour of another — running something other than what the project asked for, with no signal
 * anywhere. anton reads one filename; say so instead.
 */
function assertNoJsonFormulaAt(tomlPath: string): void {
  const asJson = tomlPath.replace(/\.toml$/, ".json");
  if (!existsSync(asJson)) return;
  throw new PoisonEpic(
    `${asJson} is a run formula anton does not read — a pipeline must be \`<name>.formula.toml\`. ` +
      `Convert it (\`bd formula convert\`) or rename it, then resume the run; anton would otherwise ` +
      `walk a different pipeline and silently ignore this one.`,
  );
}

/**
 * anton's bundled copy. The path segments come from `config.mjs` — one definition, so a rename of the
 * asset moves both the installer and this loader — but the ANCHOR is supplied here: the server's cwd
 * (anton's package root; `bin/anton.mjs` launches it with `cwd: APP_ROOT`), for the same reason
 * `formula.ts` passes its own — config.mjs's module-relative default does not survive the Next server
 * bundle, where `import.meta.url` points at a build chunk rather than the source tree.
 */
export function bundledRunFormulaPath(): string {
  return bundledRunFormulaUnder(process.cwd());
}

/**
 * The project's pipeline when it has one, else anton's bundled default. Project-local always wins.
 * A `.json` sibling parks — see {@link assertNoJsonFormulaAt}.
 */
export function resolveRunFormulaPath(repoPath: string): string {
  const local = projectRunFormulaPath(repoPath);
  if (existsSync(local)) return local;
  assertNoJsonFormulaAt(local);
  return bundledRunFormulaPath();
}

/**
 * Every key `bd cook` actually honors, by scope (verified against bd 1.1.2 — a formula using all of
 * them round-trips through a real cook with none dropped, which `run-formula.integration.test.ts`
 * pins). Anything else is reported rather than dropped: bd exits 0 and simply omits the key from its
 * cooked output, so a misspelling reads as a working formula right up until the run behaves wrongly.
 *
 * `formula`, not `name`: a formula keyed `name` PARSES and then fails cook with "name is required"
 * (anton-upfc) — so `name` is an unknown key here, and reporting it that way is the more useful error.
 *
 * `extends` stays on the list because bd DOES honor it; anton rejects it separately
 * ({@link assertNoExtends}), so the operator reads why anton won't walk it rather than a wrong claim
 * that bd would drop it.
 */
const KNOWN_KEYS = {
  top: ["formula", "description", "version", "schema_version", "type", "vars", "steps", "extends"],
  var: ["description", "default", "required", "type", "enum", "pattern"],
  step: [
    "id",
    "title",
    "type",
    "description",
    "labels",
    "needs",
    "depends_on",
    "gate",
    "priority",
    "assignee",
    "notes",
    "condition",
  ],
  gate: ["type", "await_id", "timeout"],
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Keys in a parsed formula document that `bd cook` would silently drop, each as the dotted path an
 * operator can find in the file (`steps[implement].lables`). Pure, so the check is unit-testable
 * without bd. A step with no `id` is addressed by its index instead — bd's cook rejects it anyway,
 * but the key report must still be readable when it does.
 */
export function unknownFormulaKeys(doc: unknown): string[] {
  if (!isRecord(doc)) return [];
  const out: string[] = [];
  const scan = (obj: unknown, known: readonly string[], prefix: string) => {
    if (!isRecord(obj)) return;
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) out.push(`${prefix}${key}`);
    }
  };

  scan(doc, KNOWN_KEYS.top, "");
  if (isRecord(doc.vars)) {
    for (const [name, spec] of Object.entries(doc.vars)) scan(spec, KNOWN_KEYS.var, `vars.${name}.`);
  }
  if (Array.isArray(doc.steps)) {
    doc.steps.forEach((step, i) => {
      if (!isRecord(step)) return;
      const label = typeof step.id === "string" && step.id ? step.id : String(i);
      scan(step, KNOWN_KEYS.step, `steps[${label}].`);
      scan(step.gate, KNOWN_KEYS.gate, `steps[${label}].gate.`);
    });
  }
  return out;
}

/**
 * Parse the formula source and reject anything bd would swallow. Separate from the cook so the two
 * failures read differently: this one is about the FILE as written, the cook is about the pipeline it
 * resolves to.
 */
export function parseRunFormulaSource(raw: string, source: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = parseToml(raw);
  } catch (e) {
    throw new PoisonEpic(
      `run formula ${source} is not valid TOML: ${e instanceof Error ? e.message : String(e)} — ` +
        `fix the file (or delete it to fall back to anton's default), then resume the run`,
    );
  }
  if (!isRecord(doc)) {
    throw new PoisonEpic(`run formula ${source} is not a TOML table — anton cannot read a pipeline from it`);
  }
  const unknown = unknownFormulaKeys(doc);
  if (unknown.length > 0) {
    throw new PoisonEpic(
      `run formula ${source} carries key(s) bd does not recognise: ${unknown.join(", ")} — bd DROPS ` +
        `them silently at cook time, so the pipeline anton would walk is not the one written here. ` +
        `Correct or remove them, then resume the run. (anton's own per-step configuration rides on ` +
        `\`labels\` — \`step:<name>\`, \`prompt:<id>\`, \`skill:<id>\` — precisely because a custom step ` +
        `key would not survive the cook.)`,
    );
  }
  assertNoExtends(doc, source);
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new PoisonEpic(
      `run formula ${source} declares no \`[[steps]]\` — a pipeline with no steps would implement ` +
        `nothing, commit nothing, and open no PR`,
    );
  }
  return doc;
}

/**
 * `extends` PARKS the run. bd merges the inherited formula's steps into the cooked pipeline, but the
 * checks above read only the file anton loaded — and bd resolves an inherited name through its own
 * search path (the repo's `.beads/formulas/`, then `~/.beads/formulas/`, then `$GT_ROOT`), so an
 * inherited source may not even be project data anton could reach. So every guarantee this module
 * makes about the file evaporates for the half of the pipeline that came from somewhere else: a
 * `gtae` typo in a base erases the gate `assertNoStepGates` would have parked on, and a `lables`
 * typo there erases a step's handler — both dropped silently by the cook, before anton sees the
 * result. anton refuses the pipeline rather than validating half of it and walking all of it.
 */
function assertNoExtends(doc: Record<string, unknown>, source: string): void {
  if (doc.extends === undefined) return;
  const inherited = Array.isArray(doc.extends) ? doc.extends.join(", ") : String(doc.extends);
  throw new PoisonEpic(
    `run formula ${source} inherits from another formula (\`extends = ${inherited}\`), which anton ` +
      `does not walk: bd merges the inherited steps into the cooked pipeline, but anton validates only ` +
      `THIS file — and bd DROPS unknown keys silently, so a typo in an inherited source (a \`gtae\` ` +
      `block that erases a gate, a \`lables\` key that erases a step's handler) would be gone before ` +
      `anton could report it, and the pipeline anton walked would not be the one the project wrote. ` +
      `Inline the inherited steps into ${source}, then resume the run.`,
  );
}

/**
 * A `[steps.gate]` PARKS the run. bd cooks the gate through faithfully, but anton's walker
 * dispatches each step the moment the one before it returns — gate RESOLUTION is not built (it is
 * anton-uk95's), so a gated step would run immediately rather than waiting on the human, the CI run,
 * or the timer the project gated it behind. A gated `step:pr` opening its PR anyway is precisely the
 * failure the gate was written to prevent, so anton refuses the pipeline rather than walking past a
 * wait the project asked for.
 */
export function assertNoStepGates(cooked: CookedFormula, source: string): void {
  const gated = cooked.steps.filter((s) => s.gate);
  if (gated.length === 0) return;
  throw new PoisonEpic(
    `run formula ${source} gates step(s) anton cannot wait on: ` +
      gated.map((s) => `"${s.id}" (\`gate.type = "${s.gate?.type}"\`)`).join(", ") +
      ` — anton walks each step as soon as the previous one returns and does not resolve gates yet, ` +
      `so a gated step would run IMMEDIATELY instead of waiting. anton parks rather than silently ` +
      `bypassing a wait the pipeline asked for. Remove the \`[steps.gate]\` block(s) — the merge gate ` +
      `on the run's PR is where a human still signs off — then resume the run.`,
  );
}

/**
 * The steps in EXECUTION order: topologically sorted by `needs`, ties broken by declaration order
 * (anton-lnkt). This is the order the walker runs and the order the invariant floor (anton-6b99) is
 * checked against, so the pipeline anton executes is the one the file describes — whether the
 * project expressed that shape by ordering the steps or by wiring `needs` between them.
 *
 * A `needs` cycle PARKS: no order satisfies it, so there is no pipeline to walk. Duplicate step ids
 * are left in declaration order instead of sorted — `needs` cannot address them unambiguously, and
 * the floor rejects the formula with a message that names the duplicate.
 */
export function orderFormulaSteps(steps: CookedStep[], source: string): CookedStep[] {
  const ids = steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) return steps;
  const declared = new Set(ids);
  const done = new Set<string>();
  const order: CookedStep[] = [];
  while (order.length < steps.length) {
    // Kahn's algorithm with a declaration-order scan for the tie-break: among the steps whose
    // prerequisites have all run, the earliest-declared one goes next — so a formula that wires no
    // `needs` at all runs exactly as written. A `needs` naming a step outside this formula is
    // ignored here (bd's own cook already refuses one).
    const next = steps.find(
      (s) => !done.has(s.id) && (s.needs ?? []).every((n) => !declared.has(n) || done.has(n)),
    );
    if (!next) {
      throw new PoisonEpic(
        `run formula ${source} has a \`needs\` cycle among ${steps
          .filter((s) => !done.has(s.id))
          .map((s) => `"${s.id}"`)
          .join(", ")} — no order satisfies it, so anton has no pipeline to walk. Break the cycle ` +
          `(or delete the file to fall back to anton's default), then resume the run.`,
      );
    }
    done.add(next.id);
    order.push(next);
  }
  return order;
}

/** What the pipeline is selected BY, plus machinery a caller may swap (the unit tests fake the cook). */
export interface RunFormulaOptions {
  /** The run target's labels — what a per-label variant is selected by (anton-aa3m). */
  labels?: readonly string[];
  /** The project's label→formula map, in precedence order. Absent/empty ⇒ the default, always. */
  variants?: readonly FormulaVariant[];
  /** The `bd cook` seam (anton-brdg). Defaults to {@link beads.cook}. */
  cook?: (repoPath: string, formulaPath: string) => Promise<CookedFormula>;
  /** Read the formula source. Defaults to the filesystem. */
  read?: (path: string) => Promise<string>;
}

/**
 * Select, load, cook, and fully resolve the pipeline this run walks. Every failure PARKS
 * ({@link PoisonEpic}) naming the file — and, where there is one, the offending step — because a run
 * that cannot read its own pipeline has no safe way to proceed.
 *
 * A variant (anton-aa3m) only changes WHICH file is loaded: everything past the selection — the
 * parse, the cook, handler resolution, and the invariant floor the caller applies to what this
 * returns — is identical, so a variant is validated exactly like the default and cannot escape it.
 *
 * Cooked in COMPILE mode (no `--var`): `{{var}}` placeholders survive, so validation never depends on
 * per-run values that don't exist yet. Substitution belongs to the walk.
 */
export async function validateRunFormula(
  repoPath: string,
  deps: RunFormulaOptions = {},
): Promise<RunFormula> {
  const { source, variant } = selectRunFormula(repoPath, deps.labels, deps.variants);
  const read = deps.read ?? ((p: string) => readFile(p, "utf8"));

  let raw: string;
  try {
    raw = await read(source);
  } catch (e) {
    throw new PoisonEpic(
      `run formula ${source} could not be read (${e instanceof Error ? e.message : String(e)}) — ` +
        `anton cannot start a run without the pipeline it is supposed to walk`,
    );
  }
  parseRunFormulaSource(raw, source);

  const cook = deps.cook ?? ((repo: string, path: string) => beads.cook(repo, path));
  let cooked: CookedFormula;
  try {
    cooked = await cook(repoPath, source);
  } catch (e) {
    // bd's own message already carries the full argv (formula path included) and its stderr, so it is
    // passed through rather than reformatted.
    throw new PoisonEpic(
      `run formula ${source} could not be cooked: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  assertNoStepGates(cooked, source);
  // Ordering before resolution so everything downstream — the floor check and the walk — reads ONE
  // order, the one the run actually executes.
  const ordered = orderFormulaSteps(cooked.steps, source);
  // Resolution is the whole point of validating early: an unmapped `step:` label parks HERE, before a
  // worktree exists, instead of three steps into a run that has already dispatched an agent.
  const steps = ordered.map((step) => ({ step, definition: resolveStep(step, source) }));
  return { source, variant, cooked: { ...cooked, steps: ordered }, steps };
}
