/**
 * The project's named outcomes (anton-cdeki): a pure reader for `## Outcomes` in `.product/PRODUCT.md`,
 * so every consumer — contract gaps, board chips, the shaping formula — agrees on the same id set
 * without each re-parsing the file its own way.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { renderedLines, type RenderedLine } from "./beads/markdown";
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

const OUTCOMES_HEADING = /^##\s+Outcomes\s*$/i;
const BULLET_PATTERN = /^-\s*`([^`]+)`\s*—\s*(.+)$/;
const RETIRED_MARKER = /\s*\(retired\)\.?\s*$/i;

/**
 * Every `## Outcomes` section's body lines, up to each one's next heading of any level — or
 * undefined if the heading never appears. Reads via {@link renderedLines} so HTML-comment content
 * (the scaffolded template's embedded example bullet) is masked out before scanning, the same way
 * the contract parser's `renderedText` does — otherwise an unedited PRODUCT.md's example bullet
 * inside `<!-- ... -->` would parse as a real outcome. Terminates each section on any rendered
 * heading, ATX or Setext — a Setext heading's text doesn't start with `#`, so re-checking its
 * source spelling here would let a later section's bullets leak into Outcomes.
 *
 * Collects EVERY occurrence rather than stopping at the first, mirroring
 * {@link extractOutcomeIdsSection} in backlog.ts — a PRODUCT.md authored (or merged) with more than
 * one `## Outcomes` heading must not have ids declared only in a later occurrence silently dropped.
 * Lines stay {@link RenderedLine}s (not bare strings) so a caller can skip fenced or raw-HTML
 * ones — a fenced example bullet renders as code and a bullet-shaped line inside a `<script>`/`<pre>`
 * block renders as nothing, neither a real outcome, but source-level slicing here would have lost
 * that distinction before the caller ever sees it.
 */
function outcomesSections(markdown: string): RenderedLine[] | undefined {
  const lines = renderedLines(markdown);
  let found = false;
  const body: RenderedLine[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.heading) {
      inSection = OUTCOMES_HEADING.test(line.text.trim());
      if (inSection) found = true;
      continue;
    }
    if (inSection) body.push(line);
  }
  return found ? body : undefined;
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
  const section = outcomesSections(markdown);
  for (const line of section ?? []) {
    // Raw HTML (a `<script>`/`<pre>` block) renders no Markdown structure, so an outcome-shaped
    // line inside one is not a real bullet — same reasoning as skipping a fenced line.
    if (line.fenced || line.html) continue;
    const outcome = parseBullet(line.text);
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
