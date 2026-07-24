/**
 * Discover the specialist agents a project actually has (anton-dvo.1). Runtime already resolves an
 * `agent:<tag>` label from four sources (project `.claude/agents` > global `~/.claude/agents` >
 * anton's bundled `src/prompts/agents` > an installed Claude Code plugin's `agents`; see
 * loadAgentPrompt). This enumerates those same sources so
 * the Settings UI can list — and let the operator toggle — every agent, not just the hardcoded
 * bundled set (KNOWN_AGENTS). Server-only: reads the filesystem, so it must never be imported by a
 * client component (pass DiscoveredAgent[] as plain props instead). Supersedes the old hardcoded
 * bundled-only agent list.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { AGENT_PROMPTS_DIR, USER_AGENTS_DIR, pluginAgentDirs } from "./claude/agent-prompt";

/**
 * Where an agent prompt was found, in precedence order: project overrides global overrides bundled
 * overrides an installed Claude Code plugin (loadAgentPrompt resolves a single tag the same way).
 */
export type AgentSource = "project" | "global" | "bundled" | "plugin";

export interface DiscoveredAgent {
  /** The `<tag>` used in `agent:<tag>` bead labels — the filename stem, matching loadAgentPrompt. */
  id: string;
  source: AgentSource;
  /** `description:` from the prompt's frontmatter, if any (display-only). */
  description?: string;
}

export interface DiscoverAgentsOptions {
  /** Home dir for the global `~/.claude/agents` lookup. Defaults to os.homedir(). */
  homeDir?: string;
  /** Anton repo root holding the bundled prompts. Defaults to process.cwd() (mirrors loadAgentPrompt). */
  bundledRoot?: string;
}

/**
 * List every discoverable agent for a project, deduped by id with project > global > bundled >
 * plugin precedence (the same order loadAgentPrompt resolves a single tag). `repoPath` is the
 * project's checkout; omit it to list only global + bundled + plugin agents. Missing source dirs
 * are skipped, not errors. Sorted by id.
 */
export async function discoverAgents(
  repoPath?: string,
  opts: DiscoverAgentsOptions = {},
): Promise<DiscoveredAgent[]> {
  const home = opts.homeDir ?? homedir();
  const bundledRoot = opts.bundledRoot ?? process.cwd();

  // Highest precedence first — the first source to define an id wins (project overrides the rest).
  const sources: { source: AgentSource; dir: string }[] = [];
  if (repoPath) sources.push({ source: "project", dir: join(repoPath, USER_AGENTS_DIR) });
  sources.push({ source: "global", dir: join(home, USER_AGENTS_DIR) });
  sources.push({ source: "bundled", dir: join(bundledRoot, AGENT_PROMPTS_DIR) });
  // Lowest precedence: the user's installed Claude Code plugins (in deterministic plugin-key order,
  // matching loadAgentPrompt), so plugin-only agents like `prompt-engineer` are discoverable — and
  // therefore exempt from the bundled-only allowlist gate (execute-epic).
  for (const dir of await pluginAgentDirs(home)) sources.push({ source: "plugin", dir });

  const byId = new Map<string, DiscoveredAgent>();
  for (const { source, dir } of sources) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue; // no such source dir → nothing to add
      throw err;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const id = entry.slice(0, -3);
      if (!id || byId.has(id)) continue; // earlier (higher-precedence) source already claimed this id
      let description: string | undefined;
      try {
        description = parseFrontmatter(await readFile(join(dir, entry), "utf8")).description;
      } catch {
        // unreadable prompt → still list it by id, just without a description
      }
      byId.set(id, { id, source, description });
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The ids of anton's BUNDLED specialist agents (`src/prompts/agents/*.md`), ignoring any user
 * override of the same name. The active-agents allowlist governs exactly this namespace: an
 * `agent:<id>` label whose id names a bundled agent is gated by the allowlist (whatever prompt file
 * actually resolves — a user's `.claude/agents/<id>.md` override still runs under anton's slot),
 * while an id OUTSIDE this set is the project's own agent and is never gated (execute-epic). Read
 * directly from the bundled dir rather than derived from discoverAgents, whose project/global >
 * bundled dedup hides a bundled id the moment the operator overrides it — on a machine that mirrors
 * every bundled name into `~/.claude/agents`, source alone can't tell "anton's slot" from "mine".
 * Missing bundled dir → empty. Sorted.
 */
export async function bundledAgentIds(bundledRoot?: string): Promise<string[]> {
  const dir = join(bundledRoot ?? process.cwd(), AGENT_PROMPTS_DIR);
  try {
    return (await readdir(dir))
      .filter((e) => e.endsWith(".md"))
      .map((e) => e.slice(0, -3))
      .sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

/**
 * Extract the `name` / `description` scalars from a markdown file's leading YAML frontmatter. A
 * deliberately tiny parser — it only needs the two display fields anton's agent prompts carry, and
 * handles the plain (`key: value`), quoted, and folded/block (`>-`, `|`) forms those files use. Not
 * a general YAML parser; nested maps and lists are ignored.
 */
export function parseFrontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith("---\n")) return {};
  const lines = md.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};

  const body = lines.slice(1, end);
  const out: Record<string, string> = {};
  for (let i = 0; i < body.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(body[i]);
    if (!m) continue; // indented continuation / list item / blank — handled by the block collector
    const key = m[1];
    const rest = m[2].trim();
    const isBlock = /^[|>][+-]?$/.test(rest); // folded (>) or literal (|) block scalar indicator
    if (isBlock || rest === "") {
      // Collect the indented continuation lines that make up this key's value.
      const collected: string[] = [];
      let j = i + 1;
      for (; j < body.length; j++) {
        if (body[j].trim() === "") {
          collected.push("");
          continue;
        }
        if (/^\s/.test(body[j])) collected.push(body[j].trim());
        else break; // a new top-level key ends the block
      }
      i = j - 1;
      // Literal (|) keeps line breaks; folded (>) joins lines with spaces, dropping blank markers.
      out[key] = rest.startsWith("|")
        ? collected.join("\n").trim()
        : collected.filter((l) => l !== "").join(" ").trim();
    } else {
      out[key] = stripQuotes(rest);
    }
  }
  return { name: out.name, description: out.description };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}
