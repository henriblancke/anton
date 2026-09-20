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
  /**
   * True when anton classified THIS ticket's delivery as board-only ({@link
   * import("../jobs/execute-epic-board-evidence").isBoardOnlyRun}) — its deliverable is `bd`
   * writes to the board, never a git diff. The base's "Never report `delivered` on an unchanged
   * tree" rule was written for the tree-based ticket it always used to be, so a compliant
   * board-only agent that made exactly the bd writes it was asked for — and left the tree
   * untouched, as it should — has no outcome left to report under that rule but `blocked`, which
   * is the false failure a review of the anton-fc5x PR caught: the run's own board-evidence gate
   * only inspects `selfReport.outcome === "delivered"`, so a compliant `blocked` report makes it
   * reject genuine board work without ever reading the board. This flag adds the one carve-out the
   * base cannot state for itself, since it is a fact about THIS run's classification of THIS
   * ticket, not a project or agent preference — so it is layered as part of the contract, ahead of
   * the agent/seed layers, rather than as a customization that could be mistaken for one.
   */
  boardOnly?: boolean;
  /**
   * The live board's repo path ({@link import("../jobs/steps/context").StepContext.repoPath}) — only
   * read when {@link boardOnly} is set. anton's board-evidence check ({@link
   * import("../jobs/execute-epic-board-evidence").readBoardEvidence}) always reads/writes THIS path,
   * never the ticket's own worktree: on an embedded (non-server) Dolt board, the worktree carries its
   * own separate, unsynced copy with no remote wired to publish from (see `MAX_TICKET_FIELD_CHARS`'s
   * docstring in `steps/prompts.ts`), so a `bd` write left at the worktree's default cwd can land in a
   * copy the evidence check never reads and never converges into — stranding a compliant board-only
   * agent's own writes forever, not just delaying them. Passing this lets {@link boardOnlySection}
   * tell the agent to point every `bd` write at the live board explicitly, via `bd`'s own `-C` flag,
   * rather than relying on its cwd.
   */
  repoPath?: string;
}

/** The carve-out from the base's unchanged-tree rule for a ticket anton classified as board-only —
 * a fact about THIS run, so it rides with the contract rather than the customizable layers below
 * it (see {@link SystemPromptLayers.boardOnly}). `repoPath`, when given, adds the explicit `-C`
 * instruction described on {@link SystemPromptLayers.repoPath}. */
function boardOnlySection(repoPath?: string): string {
  return [
    "## This ticket is board-only",
    "",
    "anton classified this ticket's delivery as **board-only** (`delivery:board`): its deliverable",
    "is `bd` writes to the board, not a git diff. Editing the working tree is neither required nor",
    "expected, and an unchanged tree is the normal, successful shape of this ticket's work.",
    "",
    "This carves out the base contract's \"Never report `delivered` on an unchanged tree\" rule",
    "above, for this ticket only: once you have made the bd write(s) this ticket's acceptance",
    "calls for, report",
    "",
    "```",
    "ANTON-RESULT: delivered",
    "```",
    "",
    "even though the working tree is unchanged. anton verifies a board-only `delivered` against the",
    "board itself — a fresh read compared against the read taken before you started — never against",
    "the branch, so this is not the false-success shape the base rule exists to catch. If you could",
    "not make the required writes, report `blocked` or `needs-human` exactly as you would for any",
    "other ticket.",
    ...(repoPath
      ? [
          "",
          `Run every \`bd\` write against the live board at \`${repoPath}\`, not this worktree's own ` +
            "copy — pass `bd`'s own directory flag rather than relying on where you happen to be, e.g.:",
          "",
          "```",
          `bd -C ${repoPath} update <id> --status done`,
          "```",
          "",
          "This worktree's embedded beads database is a separate, unsynced copy on a non-server board: " +
            "anton's board-evidence check reads and writes only the path above, and a write left at " +
            "this worktree's own cwd can be stranded there permanently rather than merely delayed.",
        ]
      : []),
  ].join("\n");
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

  // The board-only carve-out rides with the contract, ahead of the agent/seed layers, since it is
  // part of what the base itself means for THIS ticket rather than a customization of it.
  if (layers.boardOnly) sections.push(boardOnlySection(layers.repoPath));

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
  boardOnly?: boolean;
  repoPath?: string;
}): Promise<string> {
  const base = await loadBaseSystemPrompt();
  return composeSystemPrompt({
    base,
    agentPrompt: opts.agentPrompt,
    seedPrompt: opts.seedPrompt,
    boardOnly: opts.boardOnly,
    repoPath: opts.repoPath,
  });
}
