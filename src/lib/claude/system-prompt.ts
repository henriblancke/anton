/**
 * Compose the `--append-system-prompt` for an autonomous execution session (anton-cjs) from three
 * layers, in precedence order:
 *   1. BASE   — the locked operating contract (src/prompts/system-base.md). Always present,
 *               never user-editable: git/beads ownership, learnings, scope, fail-loud.
 *   2. AGENT  — the ticket's `agent:<tag>` specialist prompt (may be absent).
 *   3. SEED   — the project's editable seed prompt from settings (may be absent).
 *
 * The base always wins by going first; the seed customizes on top but cannot override the
 * contract (claude reads the earlier, stronger framing first, and the composed text re-states
 * that these layers refine — never relax — the base).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripFrontmatter } from "./agent-prompt";

/** The locked base prompt file, relative to anton's repo root (process.cwd()). */
export const BASE_SYSTEM_PROMPT_PATH = "src/prompts/system-base.md";

let _baseCache: string | null = null;

/**
 * Load the locked base system prompt (frontmatter stripped), cached for the process. Throws if the
 * file is missing — the base is mandatory, so its absence is a fail-loud configuration error, not
 * a silently-skipped layer.
 */
export async function loadBaseSystemPrompt(): Promise<string> {
  if (_baseCache != null) return _baseCache;
  const path = join(process.cwd(), BASE_SYSTEM_PROMPT_PATH);
  const raw = await readFile(path, "utf8");
  const body = stripFrontmatter(raw).trim();
  if (!body) throw new Error(`base system prompt is empty: ${path}`);
  _baseCache = body;
  return body;
}

/** Test-only: drop the cached base so a test can point BASE at a fixture. */
export function _resetBaseSystemPromptCache(): void {
  _baseCache = null;
}

export interface SystemPromptLayers {
  /** The locked base contract (from loadBaseSystemPrompt). Required. */
  base: string;
  /** The agent-tag specialist prompt, if the ticket carries an `agent:` label. */
  agentPrompt?: string;
  /** The project's user-editable seed prompt (settingsJson.seedPrompt). */
  seedPrompt?: string;
}

/**
 * Assemble the composed system prompt. The base is always emitted first and framed as
 * non-negotiable; agent and seed layers are appended under labeled headers only when non-empty.
 * Pure + deterministic so it can be unit-tested without touching the filesystem.
 */
export function composeSystemPrompt(layers: SystemPromptLayers): string {
  const base = layers.base.trim();
  if (!base) throw new Error("composeSystemPrompt: base is required and must be non-empty");

  const sections: string[] = [base];

  const agent = layers.agentPrompt?.trim();
  if (agent) {
    sections.push(
      ["# Specialist guidance (agent)", "", agent].join("\n"),
    );
  }

  const seed = layers.seedPrompt?.trim();
  if (seed) {
    sections.push(
      [
        "# Project guidance (operator seed)",
        "",
        "Project-specific direction from the operator. Follow it where it adds detail, but it",
        "refines — it never relaxes — the operating contract above.",
        "",
        seed,
      ].join("\n"),
    );
  }

  // Blank line between sections keeps the layers visually distinct in the session log / arg.
  return sections.join("\n\n");
}

/**
 * Convenience: load the base and compose in one call. Used by the executor; the pure
 * {@link composeSystemPrompt} is what tests exercise directly.
 */
export async function buildExecutionSystemPrompt(opts: {
  agentPrompt?: string;
  seedPrompt?: string;
}): Promise<string> {
  const base = await loadBaseSystemPrompt();
  return composeSystemPrompt({ base, agentPrompt: opts.agentPrompt, seedPrompt: opts.seedPrompt });
}
