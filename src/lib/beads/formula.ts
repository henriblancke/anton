/**
 * The bead formula — anton's bead skeleton, per project (anton-8mnr).
 *
 * The contract validator (contract.ts) REPORTS gaps and the gate (anton-j9zs) refuses on them. This
 * module is the other half: it makes the conformant shape the path of least resistance, so the gate
 * almost never fires. Every bead anton's own surfaces create is poured from a beads FORMULA — a
 * `.beads/formulas/anton-bead.formula.json` whose steps carry the contract sections pre-stubbed —
 * rather than from a prompt remembering five headers.
 *
 * Three decisions worth keeping:
 *
 * 1. **Cook, don't pour.** `bd mol pour` materialises a molecule whose ROOT is `issue_type=molecule`
 *    — not one of anton's tiers (epic / feature / task|bug|chore), so the board's parent walk drops
 *    straight through it. We resolve the template here and materialise with ordinary `bd create`.
 * 2. **The project-local copy wins.** `.beads/formulas/` is where bd itself looks first, and it is
 *    git-tracked (only the JSONL exports and the Dolt runtime are ignored), so a project's own bead
 *    shape travels to every clone. anton's bundled asset is only the fallback for a repo that never
 *    ran the installer.
 * 3. **The stub defaults are PROMPTS, not content.** A fabricated Acceptance box is worse than an
 *    absent one — self-review scores the diff against it (docs/runbooks/bead-contract-conformance.md).
 *    So the surfaces that create beads REQUIRE their author to fill the sections; the defaults exist
 *    so `bd cook anton-bead` alone still renders a complete, obviously-unfilled skeleton.
 *
 * Rendering is done in-process rather than by shelling out to `bd cook`: it is the same `{{var}}`
 * substitution over `title`/`description` (bd interpolates nothing else — verified against bd 1.1.2),
 * and keeping it pure is what lets a UNIT test assert that the shipped formula yields beads
 * `validateBeadContract` passes. `formula.integration.test.ts` pins the two together against real bd
 * so they cannot drift.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BEAD_FORMULA_FILENAME,
  bundledBeadFormulaPath as bundledFormulaUnder,
} from "./config.mjs";
import { renderedText, validateBeadContract } from "./contract";

export { BEAD_FORMULA_FILENAME };

/** The formula's own name — how `bd cook` / `bd formula show` address it. */
export const BEAD_FORMULA_NAME = "anton-bead";

/**
 * The tiers anton creates, mapped to the formula's step ids. `ticket` covers the working layer
 * (`task`); a `bug` shares the ticket shape and only differs in its bd type at create time.
 */
export type BeadTier = "epic" | "feature" | "ticket";

/** The bd issue type each tier materialises as. */
const TIER_TYPE: Record<BeadTier, "epic" | "feature" | "task"> = {
  epic: "epic",
  feature: "feature",
  ticket: "task",
};

/**
 * The var whose text is mirrored into bd's own acceptance field. The description markdown stays the
 * canonical home of the whole contract (contract.ts, ticket-dialog-utils.ts) — the mirror is what
 * keeps `bd lint`, `parseAcceptance`, and the board card reading the same text as the section.
 */
const TIER_ACCEPTANCE_VAR: Record<BeadTier, string> = {
  epic: "success_criteria",
  feature: "acceptance",
  ticket: "acceptance",
};

interface FormulaVar {
  description?: string;
  default?: string;
}

interface FormulaStep {
  id: string;
  title?: string;
  type?: string;
  description?: string;
}

export interface BeadFormula {
  formula: string;
  description?: string;
  vars: Record<string, FormulaVar>;
  steps: FormulaStep[];
  /** Where this formula was read from — the project copy or anton's bundled asset. */
  source: string;
}

/** A rendered bead, ready for `beads.create`. */
export interface BeadSkeleton {
  type: "epic" | "feature" | "task";
  /** The contract markdown — `bd create --description`. */
  description: string;
  /** The tier's acceptance/success text, mirrored into bd's own field. */
  acceptance: string;
}

/** Where a project keeps its own copy — the path bd's own formula search hits first. */
export function projectBeadFormulaPath(repoPath: string): string {
  return join(repoPath, ".beads", "formulas", BEAD_FORMULA_FILENAME);
}

/**
 * anton's bundled copy. The path segments come from `config.mjs` — one definition, so a rename of
 * the asset moves both the installer and this renderer — but the ANCHOR is supplied here: the
 * server's cwd (anton's package root; `bin/anton.mjs` launches it with `cwd: APP_ROOT`), the same
 * convention `skillPath` uses for the vendored skills. config.mjs defaults its anchor to a
 * module-relative `PACKAGE_ROOT` because the CLI runs from anywhere; that anchor does not survive
 * the Next server bundle, where `import.meta.url` points at a build chunk rather than the source
 * tree. Hence one implementation, two anchors — passed explicitly rather than duplicated.
 */
export function bundledBeadFormulaPath(): string {
  return bundledFormulaUnder(process.cwd());
}

/** The project's copy when it has one, else anton's bundled asset. Project-local always wins. */
export function resolveBeadFormulaPath(repoPath: string): string {
  const local = projectBeadFormulaPath(repoPath);
  return existsSync(local) ? local : bundledBeadFormulaPath();
}

/**
 * Parse + validate a formula document. Fails loud on anything a renderer would otherwise paper over
 * with an empty section: a malformed skeleton must surface as a broken install, not as a bead that
 * silently violates the contract it exists to satisfy.
 */
export function parseBeadFormula(raw: string, source: string): BeadFormula {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`bead formula ${source} is not valid JSON: ${(err as Error).message}`);
  }
  const obj = doc as Partial<BeadFormula>;
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.steps)) {
    throw new Error(`bead formula ${source} has no \`steps\` array`);
  }
  const steps = obj.steps as FormulaStep[];
  for (const tier of Object.keys(TIER_TYPE) as BeadTier[]) {
    const step = steps.find((s) => s?.id === tier);
    if (!step) throw new Error(`bead formula ${source} has no \`${tier}\` step`);
    if (typeof step.description !== "string" || step.description.trim() === "") {
      throw new Error(`bead formula ${source}: step \`${tier}\` has no description template`);
    }
  }
  return {
    formula: typeof obj.formula === "string" ? obj.formula : BEAD_FORMULA_NAME,
    description: typeof obj.description === "string" ? obj.description : undefined,
    vars: (obj.vars ?? {}) as Record<string, FormulaVar>,
    steps,
    source,
  };
}

/** Load the formula that applies to `repoPath` (project copy first, bundled asset as fallback). */
export async function loadBeadFormula(repoPath: string): Promise<BeadFormula> {
  const path = resolveBeadFormulaPath(repoPath);
  return parseBeadFormula(await readFile(path, "utf8"), path);
}

/** One `{{var}}` token — the shape {@link interpolate} resolves and the consumption check scans. */
const VAR_TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * The vars that ARE each tier's contract — the ones a creation path submits as the author's actual
 * spec, so a template that never references one silently discards founder input
 * ({@link renderBeadSkeleton}). Scoped per tier because callers pass one var bag for the whole
 * formula (the same way `bd cook --var` does): an epic render legitimately ignores `acceptance`,
 * and a ticket render legitimately ignores `outcome`.
 */
const TIER_CONTRACT_VARS: Record<BeadTier, string[]> = {
  epic: ["outcome", "success_criteria"],
  feature: ["goal", "acceptance", "context", "out_of_scope", "verify"],
  ticket: ["goal", "acceptance", "context", "out_of_scope", "verify"],
};

/**
 * Resolve `{{var}}` against the caller's values, then the formula's defaults. A var with neither is
 * left verbatim and its name collected into `unresolved` — {@link renderBeadSkeleton} fails loud on
 * any rather than materializing the token: `stateOf` reads a literal `{{criteria}}` as written text,
 * so a misspelled placeholder in a project-local formula would pass validation while every view
 * rendered the token instead of the authored criteria.
 */
function interpolate(
  template: string,
  formula: BeadFormula,
  vars: Record<string, string>,
  unresolved: Set<string>,
): string {
  return template.replace(VAR_TOKEN, (literal, name: string) => {
    const supplied = vars[name]?.trim();
    if (supplied) return supplied;
    const fallback = formula.vars[name]?.default;
    if (fallback === undefined) unresolved.add(name);
    return fallback ?? literal;
  });
}

/**
 * Render one tier of the formula into the fields `beads.create` takes. Throws on an unresolved
 * `{{var}}` (no supplied value, no formula default) — a broken project-local formula must surface
 * as a render error at creation time, not as a bead carrying the literal token as its contract.
 *
 * The inverse breakage throws too: a supplied CONTRACT var ({@link TIER_CONTRACT_VARS}) the render
 * would DISCARD. A project-local formula that replaced `{{outcome}}` with static Goal text renders
 * successfully and validates — the static text reads as written — while the founder's submitted
 * outcome vanishes. The tier's acceptance var is judged one step further: an unreferencing template
 * still preserves it through the mirrored bd field, UNLESS the rendered description carries its own
 * written criteria section — which takes display precedence over the field (acceptanceBody,
 * contract.ts) and so shadows the submitted criteria. Discarded input must surface as a render
 * error, not a plausible bead.
 */
export function renderBeadSkeleton(
  formula: BeadFormula,
  tier: BeadTier,
  vars: Record<string, string> = {},
): BeadSkeleton {
  const step = formula.steps.find((s) => s.id === tier);
  if (!step?.description) throw new Error(`bead formula ${formula.source} has no \`${tier}\` step`);
  const unresolved = new Set<string>();
  const skeleton: BeadSkeleton = {
    type: TIER_TYPE[tier],
    description: interpolate(step.description, formula, vars, unresolved).trim(),
    acceptance: interpolate(`{{${TIER_ACCEPTANCE_VAR[tier]}}}`, formula, vars, unresolved).trim(),
  };
  if (unresolved.size > 0) {
    const names = [...unresolved].map((n) => `{{${n}}}`).join(", ");
    throw new Error(
      `bead formula ${formula.source}: unresolved ${names} in the \`${tier}\` template — supply the value or add a var default`,
    );
  }
  // Only OUTPUT-BEARING description text counts as consumption: the description is the sole
  // templated field the skeleton emits (`step.title` is never rendered — `createDraftEpic` uses the
  // draft's own title), and within it a placeholder hidden in an HTML comment interpolates into
  // markup the render never shows — the raw-template scan read `<!-- {{outcome}} -->` as consumed
  // while the founder's value landed invisibly and a static section shadowed it.
  const referenced = new Set([...renderedText(step.description).matchAll(VAR_TOKEN)].map((m) => m[1]));
  const discarded = TIER_CONTRACT_VARS[tier].filter((n) => {
    if (!vars[n]?.trim() || referenced.has(n)) return false;
    if (n !== TIER_ACCEPTANCE_VAR[tier]) return true;
    return descriptionShadowsAcceptance(skeleton);
  });
  if (discarded.length > 0) {
    const names = discarded.map((n) => `{{${n}}}`).join(", ");
    throw new Error(
      `bead formula ${formula.source}: the \`${tier}\` template never references ${names} — the supplied value would be discarded; add the placeholder to the step's template`,
    );
  }
  return skeleton;
}

/**
 * Does the rendered description carry a WRITTEN criteria section of its own? Judged with the shared
 * validator over the description alone (no mirrored field): no blocking gap there means the
 * description's static section satisfies the rubric by itself — and would therefore take display
 * precedence over the mirrored field the submitted criteria land in, shadowing them.
 */
function descriptionShadowsAcceptance(skeleton: BeadSkeleton): boolean {
  return !validateBeadContract({
    id: "formula-render",
    title: "",
    status: "open",
    issue_type: skeleton.type,
    description: skeleton.description,
  }).some((v) => v.severity === "blocking");
}

/** Load the project's formula and render `tier` from it — the one call a creation path needs. */
export async function beadSkeleton(
  repoPath: string,
  tier: BeadTier,
  vars: Record<string, string> = {},
): Promise<BeadSkeleton> {
  return renderBeadSkeleton(await loadBeadFormula(repoPath), tier, vars);
}
