/**
 * Installer (anton-3n5.2): copy anton's selected bundled agents + the always-on required skills
 * into a target project's `.claude/`, idempotently and NEVER overwriting anything already there.
 *
 * Source layout (anton's own repo — the `bundledRoot`):
 *   - agents:  src/prompts/agents/<tag>.md   — Claude Code agent (flat file, name/description/model frontmatter)
 *   - skills:  src/prompts/<name>.md         — Claude Code skill (name/description frontmatter)
 * Target layout (the project's `.claude/`, so `claude` resolves them):
 *   - agents:  <projectDir>/.claude/agents/<tag>.md
 *   - skills:  <projectDir>/.claude/skills/<name>/SKILL.md
 *
 * No-clobber is the invariant: a destination that already exists — a prior anton install OR the
 * user's own file — is left byte-for-byte untouched and reported as `skipped` (already-present).
 * Re-running with the same selection therefore performs zero writes (`changed === false`). Files
 * are copied verbatim (frontmatter intact) so `claude` can read the agent/skill metadata.
 *
 * This is a pure filesystem helper the CLI calls: no interactive I/O, and it does not decide the
 * selection (that's the wizard). It DOES own the "required" set — required skills are installed
 * even when they aren't in the selection.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Anton's bundled agent prompts, relative to the bundled root. */
export const AGENTS_SRC_DIR = "src/prompts/agents";
/** Anton's bundled skill prompts, relative to the bundled root. */
export const SKILLS_SRC_DIR = "src/prompts";
/** Where agents land under a project (Claude Code reads flat `<tag>.md` files here). */
export const CLAUDE_AGENTS_DIR = ".claude/agents";
/** Where skills land under a project (Claude Code reads `<name>/SKILL.md` directories here). */
export const CLAUDE_SKILLS_DIR = ".claude/skills";

/**
 * Skills anton always installs, regardless of selection — the machinery its own `claude` runs
 * depend on. Each name resolves to `src/prompts/<name>.md`, which carries skill frontmatter.
 */
export const REQUIRED_SKILLS = ["shape", "scan-triage", "review-fix"] as const;

/** What the caller (wizard/CLI) chose. Skills are additive over the always-required set. */
export interface Selection {
  /** Agent tags to install (e.g. ["nextjs", "fastapi"]). */
  agents?: string[];
  /** Optional extra skills to install on top of {@link REQUIRED_SKILLS}. */
  skills?: string[];
}

export interface InstallOptions {
  /** Target project working dir whose `.claude/` we write into. */
  projectDir: string;
  /** Anton repo root holding the bundled prompts. Defaults to process.cwd(). */
  bundledRoot?: string;
}

export type InstallOutcome = "installed" | "skipped";

export interface InstallEntry {
  kind: "agent" | "skill";
  /** Agent tag or skill name. */
  name: string;
  /** True for a {@link REQUIRED_SKILLS} member (always installed). */
  required: boolean;
  /** Absolute source path in the bundled root. */
  source: string;
  /** Absolute destination path under the project's `.claude/`. */
  target: string;
  outcome: InstallOutcome;
}

export interface InstallSummary {
  /** Every planned item, in install order. */
  entries: InstallEntry[];
  /** Items newly written this run. */
  installed: InstallEntry[];
  /** Items that already existed and were left untouched (already-present). */
  skipped: InstallEntry[];
  /** True iff at least one file was written — false on a fully idempotent re-run. */
  changed: boolean;
}

/** A planned copy before its filesystem outcome is known. */
type PlanItem = Omit<InstallEntry, "outcome">;

/** Preserve first-seen order while dropping duplicates. */
function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * Resolve a selection into the concrete list of files to install (selected agents + required and
 * selected skills), deduped. Pure — it only computes paths, it does not touch the filesystem.
 */
export function planInstall(selection: Selection, options: InstallOptions): PlanItem[] {
  const root = options.bundledRoot ?? process.cwd();
  const { projectDir } = options;

  const items: PlanItem[] = [];

  for (const tag of unique(selection.agents ?? [])) {
    items.push({
      kind: "agent",
      name: tag,
      required: false,
      source: join(root, AGENTS_SRC_DIR, `${tag}.md`),
      target: join(projectDir, CLAUDE_AGENTS_DIR, `${tag}.md`),
    });
  }

  const requiredSet = new Set<string>(REQUIRED_SKILLS);
  for (const name of unique([...REQUIRED_SKILLS, ...(selection.skills ?? [])])) {
    items.push({
      kind: "skill",
      name,
      required: requiredSet.has(name),
      source: join(root, SKILLS_SRC_DIR, `${name}.md`),
      target: join(projectDir, CLAUDE_SKILLS_DIR, name, "SKILL.md"),
    });
  }

  return items;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Install the selection into `options.projectDir`'s `.claude/`, creating subdirs as needed. Any
 * destination that already exists is skipped (never overwritten); missing ones are copied verbatim
 * from the bundled source. A missing bundled source is a fail-loud error (a selection should only
 * name real bundled agents/skills). Returns a summary of what was installed vs. already-present.
 */
export async function installSelection(
  selection: Selection,
  options: InstallOptions,
): Promise<InstallSummary> {
  const plan = planInstall(selection, options);
  const entries: InstallEntry[] = [];

  for (const item of plan) {
    if (await pathExists(item.target)) {
      entries.push({ ...item, outcome: "skipped" });
      continue;
    }

    let content: string;
    try {
      content = await readFile(item.source, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error(
          `installSelection: bundled ${item.kind} "${item.name}" not found at ${item.source}`,
        );
      }
      throw err;
    }

    await mkdir(dirname(item.target), { recursive: true });
    await writeFile(item.target, content);
    entries.push({ ...item, outcome: "installed" });
  }

  const installed = entries.filter((e) => e.outcome === "installed");
  const skipped = entries.filter((e) => e.outcome === "skipped");
  return { entries, installed, skipped, changed: installed.length > 0 };
}
