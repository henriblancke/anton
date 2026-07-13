/**
 * Resolve a ticket's agent-tag prompt (anton-dzh.3). The `agent:<tag>` label on a bead maps to a
 * `<tag>.md` prompt file whose body is injected via --append-system-prompt (frontmatter stripped).
 *
 * Resolution honors user-provided agents (anton-3n5.4). A `<tag>` is looked up, in order, from:
 *   1. the TARGET PROJECT's `.claude/agents/<tag>.md`  (per-project override — highest precedence)
 *   2. the user's global `~/.claude/agents/<tag>.md`   (machine-wide fallback)
 *   3. anton's bundled `src/prompts/agents/<tag>.md`    (shipped default — lowest precedence)
 * The first file that exists wins; sources are never merged. A tag with no match anywhere returns
 * undefined (the driver then runs with no --append-system-prompt).
 *
 * ── CONTRACT (locked — implement the bodies, keep these signatures) ──
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory holding anton's bundled agent prompts, relative to anton's repo root. */
export const AGENT_PROMPTS_DIR = "src/prompts/agents";

/** Subdirectory (under a project or global `.claude`) holding user-provided agent prompts. */
export const USER_AGENTS_DIR = ".claude/agents";

/** Where to look for a `<tag>.md`, in precedence order. All fields are optional/overridable. */
export interface AgentPromptSources {
  /** Target project working dir (the worktree). Its `.claude/agents/<tag>.md` wins. */
  projectDir?: string;
  /** Home dir for the global `~/.claude/agents` lookup. Defaults to os.homedir(). */
  homeDir?: string;
  /** Anton repo root holding the bundled prompts. Defaults to process.cwd(). */
  bundledRoot?: string;
}

/**
 * Load the agent prompt body for `tag` (e.g. "nextjs"), frontmatter stripped. Resolves by the
 * precedence documented above (project override > global > anton bundled). Returns undefined when
 * the tag is empty or no matching prompt file exists in any source.
 */
export async function loadAgentPrompt(
  tag: string | undefined,
  sources: AgentPromptSources = {},
): Promise<string | undefined> {
  if (!tag) return undefined;

  const candidates: string[] = [];
  if (sources.projectDir) candidates.push(join(sources.projectDir, USER_AGENTS_DIR, `${tag}.md`));
  candidates.push(join(sources.homeDir ?? homedir(), USER_AGENTS_DIR, `${tag}.md`));
  candidates.push(join(sources.bundledRoot ?? process.cwd(), AGENT_PROMPTS_DIR, `${tag}.md`));

  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf8");
      return stripFrontmatter(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw err;
    }
  }
  return undefined;
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
