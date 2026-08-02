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
 * 3. **A cook failure** — bd's own reason, which already names the file.
 * 4. **A step that maps to no handler** — {@link resolveStep}'s message, naming the step and label.
 *
 * What it deliberately does NOT do: check the cooked pipeline against anton's invariant floor (which
 * steps may be omitted or reordered) — that is anton-6b99's, and it consumes what this returns.
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
export interface RunFormula {
  /** Absolute path the pipeline was read from — the project's copy, or anton's bundled asset. */
  source: string;
  cooked: CookedFormula;
  /** Every step in declaration order, each with its resolved handler. */
  steps: ResolvedStep[];
}

/** Where a project keeps its own pipeline — the path bd's own formula search hits first. */
export function projectRunFormulaPath(repoPath: string): string {
  return join(repoPath, ".beads", "formulas", RUN_FORMULA_FILENAME);
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
 *
 * A `.json` sibling PARKS rather than being passed over: `bd cook` accepts either extension, so a
 * project that wrote `anton-run.formula.json` has written a pipeline anton would silently ignore in
 * favour of the shipped default — running something other than what the project asked for, with no
 * signal anywhere. anton reads one filename; say so instead.
 */
export function resolveRunFormulaPath(repoPath: string): string {
  const local = projectRunFormulaPath(repoPath);
  if (existsSync(local)) return local;
  const asJson = local.replace(/\.toml$/, ".json");
  if (existsSync(asJson)) {
    throw new PoisonEpic(
      `${asJson} is a run formula anton does not read — the pipeline must be \`${RUN_FORMULA_FILENAME}\`. ` +
        `Convert it (\`bd formula convert\`) or rename it, then resume the run; anton would otherwise ` +
        `walk its own default and silently ignore this project's pipeline.`,
    );
  }
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
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new PoisonEpic(
      `run formula ${source} declares no \`[[steps]]\` — a pipeline with no steps would implement ` +
        `nothing, commit nothing, and open no PR`,
    );
  }
  return doc;
}

/** Machinery a caller may swap. Production passes none; the unit tests pass a fake cook. */
export interface RunFormulaDeps {
  /** The `bd cook` seam (anton-brdg). Defaults to {@link beads.cook}. */
  cook?: (repoPath: string, formulaPath: string) => Promise<CookedFormula>;
  /** Read the formula source. Defaults to the filesystem. */
  read?: (path: string) => Promise<string>;
}

/**
 * Load, cook, and fully resolve the pipeline that applies to `repoPath`. Every failure PARKS
 * ({@link PoisonEpic}) naming the file — and, where there is one, the offending step — because a run
 * that cannot read its own pipeline has no safe way to proceed.
 *
 * Cooked in COMPILE mode (no `--var`): `{{var}}` placeholders survive, so validation never depends on
 * per-run values that don't exist yet. Substitution belongs to the walk.
 */
export async function validateRunFormula(
  repoPath: string,
  deps: RunFormulaDeps = {},
): Promise<RunFormula> {
  const source = resolveRunFormulaPath(repoPath);
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

  // Resolution is the whole point of validating early: an unmapped `step:` label parks HERE, before a
  // worktree exists, instead of three steps into a run that has already dispatched an agent.
  const steps = cooked.steps.map((step) => ({ step, definition: resolveStep(step, source) }));
  return { source, cooked, steps };
}
