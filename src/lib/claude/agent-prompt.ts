/**
 * Resolve a ticket's agent-tag prompt (anton-dzh.3). The `agent:<tag>` label on a bead maps to
 * `src/prompts/agents/<tag>.md` in anton's OWN repo (not the target project). The markdown
 * frontmatter (--- … ---) is stripped; the body is injected via --append-system-prompt.
 *
 * ── CONTRACT (locked — implement the bodies, keep these signatures) ──
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Directory holding the agent prompts, relative to anton's repo root (process.cwd()). */
export const AGENT_PROMPTS_DIR = "src/prompts/agents";

/**
 * Load the agent prompt body for `tag` (e.g. "nextjs"), frontmatter stripped. Returns undefined
 * when the tag is empty or no matching prompt file exists (the driver then runs with no
 * --append-system-prompt).
 */
export async function loadAgentPrompt(tag: string | undefined): Promise<string | undefined> {
  if (!tag) return undefined;
  const path = join(process.cwd(), AGENT_PROMPTS_DIR, `${tag}.md`);
  try {
    const raw = await readFile(path, "utf8");
    return stripFrontmatter(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
}

/** Strip a leading YAML frontmatter block (--- … ---) from markdown. */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const lines = md.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return lines.slice(i + 1).join("\n").trim();
    }
  }
  return md;
}
