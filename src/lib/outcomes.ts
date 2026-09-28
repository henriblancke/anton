/**
 * The project's named outcomes (anton-cdeki): a pure reader for `## Outcomes` in `.product/PRODUCT.md`,
 * so every consumer — contract gaps, board chips, the shaping formula — agrees on the same id set
 * without each re-parsing the file its own way.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { renderedLines } from "./beads/markdown";
import { AREA_SHAPE } from "./epic-patch";

export interface ProjectOutcome {
  /** Stable id, referenced elsewhere by an `outcome:<id>` label. */
  id: string;
  /** One-line statement of what winning looks like. */
  summary: string;
  /** Retired outcomes still resolve (existing labels stay valid) but are no longer offered for new work. */
  retired: boolean;
}

/**
 * Every project has this outcome whether or not PRODUCT.md lists it — scan-triage-produced work
 * (anton-42zmh) always has somewhere to point.
 */
const BUILT_IN_OUTCOME: ProjectOutcome = {
  id: "codebase-health",
  summary: "Tests, types, and lint stay green as the code changes; found debt gets paid down.",
  retired: false,
};

const HEADING_PATTERN = /^#{1,6}\s+/;
const OUTCOMES_HEADING = /^##\s+Outcomes\s*$/i;
const BULLET_PATTERN = /^-\s*`([^`]+)`\s*—\s*(.+)$/;
const RETIRED_MARKER = /\s*\(retired\)\.?\s*$/i;

/**
 * The `## Outcomes` section body, up to the next heading of any level — or undefined if absent.
 * Reads via {@link renderedLines} so HTML-comment content (the scaffolded template's embedded
 * example bullet) is masked out before scanning, the same way the contract parser's
 * `renderedText` does — otherwise an unedited PRODUCT.md's example bullet inside `<!-- ... -->`
 * would parse as a real outcome.
 */
function outcomesSection(markdown: string): string[] | undefined {
  const lines = renderedLines(markdown);
  const start = lines.findIndex((line) => line.heading && OUTCOMES_HEADING.test(line.text.trim()));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && !(lines[i].heading && HEADING_PATTERN.test(lines[i].text)); i++) {
    body.push(lines[i].text);
  }
  return body;
}

function parseBullet(line: string): ProjectOutcome | undefined {
  const match = BULLET_PATTERN.exec(line.trim());
  if (!match) return undefined;
  const id = match[1].trim();
  let summary = match[2].trim();
  const retired = RETIRED_MARKER.test(summary);
  if (retired) summary = summary.replace(RETIRED_MARKER, "").trim();
  if (!id || !summary) return undefined;
  // An id that can't survive as an `outcome:<id>` label (a leading `-`, a space, ...) would be
  // offered here yet rejected by the Add-work schema (AREA_SHAPE) the moment it's chosen — treat
  // it the same as any other malformed bullet, and skip it, rather than advertise a dead end.
  if (!AREA_SHAPE.test(id)) return undefined;
  return { id, summary, retired };
}

/**
 * Reads `## Outcomes` bullets of the form `` - `id` — summary``, an optional trailing `(retired)`
 * marking one no longer offered for new work. Never throws: a missing section or a malformed bullet
 * just falls back to (or skips past) the built-in {@link BUILT_IN_OUTCOME}.
 *
 * A `codebase-health` bullet may only override the built-in's summary — scan triage always files
 * new scan-produced work against it, so it can never be retired even via a `(retired)` override.
 */
export function parseOutcomes(markdown: string): ProjectOutcome[] {
  const outcomes = new Map<string, ProjectOutcome>([[BUILT_IN_OUTCOME.id, BUILT_IN_OUTCOME]]);
  const section = outcomesSection(markdown);
  for (const line of section ?? []) {
    const outcome = parseBullet(line);
    if (!outcome) continue;
    if (outcome.id === BUILT_IN_OUTCOME.id) {
      outcomes.set(outcome.id, { ...outcome, retired: false });
    } else {
      outcomes.set(outcome.id, outcome);
    }
  }
  return [...outcomes.values()];
}

/** Where a project's outcomes live — read relative to the project's repo root. */
export function productMdPath(repoPath: string): string {
  return join(repoPath, ".product", "PRODUCT.md");
}

/**
 * `repoPath`'s `.product/PRODUCT.md` raw text, or `""` if it doesn't exist yet. Never throws on a
 * missing file — the shared read {@link readProjectOutcomes} and {@link projectOutcomesConfigured}
 * both build on.
 */
export async function readProductMd(repoPath: string): Promise<string> {
  try {
    return await readFile(productMdPath(repoPath), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Read and parse `repoPath`'s `.product/PRODUCT.md`. Never throws — a project with no PRODUCT.md
 * yet (or no `## Outcomes` section) resolves to just {@link BUILT_IN_OUTCOME}, same as
 * {@link parseOutcomes} handed an empty string, so a fresh project is never stuck unable to file
 * work for want of the file.
 */
export async function readProjectOutcomes(repoPath: string): Promise<ProjectOutcome[]> {
  return parseOutcomes(await readProductMd(repoPath));
}

/**
 * Whether `markdown` declares at least one REAL outcome, as opposed to resolving to just the
 * built-in via {@link parseOutcomes}'s fallback. The distinction matters to callers deciding how
 * strictly to gate an outcome id against the parsed set:
 *
 *   - a project whose PRODUCT.md predates this feature (anton-cdeki) has no `## Outcomes` section
 *     at all;
 *   - a project scaffolded by `/setup` since (skills/setup/templates/.product/PRODUCT.md) has the
 *     section, but its bundled placeholder is deliberately unparseable (an HTML comment, not a
 *     bullet) rather than a fake outcome a founder could ship features against by never noticing it.
 *
 * Both are "nothing decided yet", not "deliberately only `codebase-health`" — so both fall out of
 * this the same way, off `parseOutcomes`' own result rather than re-deriving section presence: a
 * section with only malformed or unparseable bullets is exactly as unconfigured as no section, and
 * the two are already the same input to every caller that matters (`activeOutcomeIds`).
 */
export function outcomesConfigured(markdown: string): boolean {
  return parseOutcomes(markdown).some((o) => o.id !== BUILT_IN_OUTCOME.id);
}

/** {@link outcomesConfigured}, reading `repoPath`'s `.product/PRODUCT.md` itself. */
export async function projectOutcomesConfigured(repoPath: string): Promise<boolean> {
  return outcomesConfigured(await readProductMd(repoPath));
}

/** The outcome ids new work may point at — retired ones resolve for existing labels but are never
 * offered here (see {@link ProjectOutcome.retired}). */
export function activeOutcomeIds(outcomes: ProjectOutcome[]): Set<string> {
  return new Set(outcomes.filter((o) => !o.retired).map((o) => o.id));
}
