/**
 * Load an anton skill body from anton's own `skills/` asset dir. These are anton's vendored,
 * self-contained required skills (`shape`, `bd`, `scan-triage`, `review-fix`) — the machinery
 * anton owns so it runs standalone (no external plugin or session-start injection). anton's
 * runtime loads the body as its `-p` instruction for a background job; the setup wizard
 * (anton-3n5) installs the same assets into a target project's `.claude/skills/`.
 *
 * Distinct from agent-tag specialist prompts (agent-prompt.ts) and the locked base contract
 * (system-prompt.ts). Frontmatter is stripped; the body is the prompt.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripFrontmatter } from "./agent-prompt";

/** Directory holding the vendored skill assets, relative to anton's repo root (process.cwd()). */
export const SKILLS_DIR = "skills";

/**
 * anton's REQUIRED skills: always shipped, and (per the setup wizard, anton-3n5) always installed
 * into a target project — the founder cannot deselect them, because anton itself depends on them.
 * This is the canonical list; the installer and the asset test both read it.
 */
export const REQUIRED_SKILLS = ["shape", "bd", "scan-triage", "review-fix"] as const;

/** Absolute path to a skill's `SKILL.md`, resolved against anton's repo root. */
export function skillPath(name: string): string {
  return join(process.cwd(), SKILLS_DIR, name, "SKILL.md");
}

/**
 * Load `skills/<name>/SKILL.md` with frontmatter stripped. Throws if the file is missing or empty —
 * a job that needs its skill cannot proceed without it (fail loud), so this surfaces as a job error.
 */
export async function loadSkill(name: string): Promise<string> {
  const path = skillPath(name);
  const raw = await readFile(path, "utf8");
  const body = stripFrontmatter(raw).trim();
  if (!body) throw new Error(`skill is empty: ${path}`);
  return body;
}
