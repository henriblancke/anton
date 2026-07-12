/**
 * Load a named prompt from anton's own `src/prompts/` (anton-3t2.3/.4). These are anton's own
 * task prompts (`scan-triage.md`, …) claude runs as its `-p` instruction for a background job —
 * distinct from agent-tag specialist prompts (agent-prompt.ts) and the locked base contract
 * (system-prompt.ts). Frontmatter is stripped; the body is the prompt.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripFrontmatter } from "./agent-prompt";

/** Directory holding the task prompts, relative to anton's repo root (process.cwd()). */
export const PROMPTS_DIR = "src/prompts";

/**
 * Load `src/prompts/<name>.md` with frontmatter stripped. Throws if the file is missing — a job
 * that needs its prompt cannot proceed without it (fail loud), so this surfaces as a job error.
 */
export async function loadPrompt(name: string): Promise<string> {
  const path = join(process.cwd(), PROMPTS_DIR, `${name}.md`);
  const raw = await readFile(path, "utf8");
  const body = stripFrontmatter(raw).trim();
  if (!body) throw new Error(`prompt is empty: ${path}`);
  return body;
}
