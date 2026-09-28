/**
 * The project's named outcomes (anton-cdeki): a pure reader for `## Outcomes` in `.product/PRODUCT.md`,
 * so every consumer — contract gaps, board chips, the shaping formula — agrees on the same id set
 * without each re-parsing the file its own way.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

/** The `## Outcomes` section body, up to the next heading of any level — or undefined if absent. */
function outcomesSection(markdown: string): string[] | undefined {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => OUTCOMES_HEADING.test(line.trim()));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && !HEADING_PATTERN.test(lines[i]); i++) {
    body.push(lines[i]);
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
 * Read and parse `repoPath`'s `.product/PRODUCT.md`. Never throws — a project with no PRODUCT.md
 * yet (or no `## Outcomes` section) resolves to just {@link BUILT_IN_OUTCOME}, same as
 * {@link parseOutcomes} handed an empty string, so a fresh project is never stuck unable to file
 * work for want of the file.
 */
export async function readProjectOutcomes(repoPath: string): Promise<ProjectOutcome[]> {
  try {
    return parseOutcomes(await readFile(productMdPath(repoPath), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return parseOutcomes("");
    throw err;
  }
}

/** The outcome ids new work may point at — retired ones resolve for existing labels but are never
 * offered here (see {@link ProjectOutcome.retired}). */
export function activeOutcomeIds(outcomes: ProjectOutcome[]): Set<string> {
  return new Set(outcomes.filter((o) => !o.retired).map((o) => o.id));
}
