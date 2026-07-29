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

/**
 * Resolve `{{var}}` against the caller's values, then the formula's defaults. An unknown var is left
 * verbatim — exactly what `bd cook --mode=runtime` does, so an author sees the hole rather than a
 * section that silently collapsed to empty.
 */
function interpolate(template: string, formula: BeadFormula, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (literal, name: string) => {
    const supplied = vars[name]?.trim();
    if (supplied) return supplied;
    const fallback = formula.vars[name]?.default;
    return fallback ?? literal;
  });
}

/** Render one tier of the formula into the fields `beads.create` takes. */
export function renderBeadSkeleton(
  formula: BeadFormula,
  tier: BeadTier,
  vars: Record<string, string> = {},
): BeadSkeleton {
  const step = formula.steps.find((s) => s.id === tier);
  if (!step?.description) throw new Error(`bead formula ${formula.source} has no \`${tier}\` step`);
  return {
    type: TIER_TYPE[tier],
    description: interpolate(step.description, formula, vars).trim(),
    acceptance: interpolate(`{{${TIER_ACCEPTANCE_VAR[tier]}}}`, formula, vars).trim(),
  };
}

/** Load the project's formula and render `tier` from it — the one call a creation path needs. */
export async function beadSkeleton(
  repoPath: string,
  tier: BeadTier,
  vars: Record<string, string> = {},
): Promise<BeadSkeleton> {
  return renderBeadSkeleton(await loadBeadFormula(repoPath), tier, vars);
}
