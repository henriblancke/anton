/**
 * Installer (anton-3n5.2): copy anton's selected bundled agents + the always-on required skills
 * into a target project's `.claude/`, idempotently and NEVER overwriting anything already there.
 *
 * Source layout (anton's own repo — the `bundledRoot`):
 *   - agents:  src/prompts/agents/<tag>.md   — Claude Code agent (flat file, name/description/model frontmatter)
 *   - skills:  skills/<name>/                 — anton's vendored skill DIRECTORY (SKILL.md + any bundled assets)
 * Target layout (the project's `.claude/`, so `claude` resolves them):
 *   - agents:  <projectDir>/.claude/agents/<tag>.md
 *   - skills:  <projectDir>/.claude/skills/<name>/   (the whole directory, SKILL.md and all)
 *
 * A skill is installed as its whole directory, not just SKILL.md, so a skill's bundled companion
 * files travel with it — notably `setup`, which ships its `.product/` scaffolding under
 * `skills/setup/templates/` (anton-olh). No-clobber is the invariant: a destination that already
 * exists — a prior anton install OR the user's own file — is left untouched and reported as
 * `skipped` (already-present). A skill's presence is decided by its `SKILL.md`; if that exists the
 * whole skill directory is left alone. Re-running with the same selection therefore performs zero
 * writes (`changed === false`). Files are copied verbatim (frontmatter intact) so `claude` can read
 * the agent/skill metadata.
 *
 * This is a pure filesystem helper the CLI calls: no interactive I/O, and it does not decide the
 * selection (that's the wizard). It DOES own the "required" set — required skills are installed
 * even when they aren't in the selection.
 */
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { INSTALLED_SKILLS, REQUIRED_SKILLS, SKILLS_DIR } from "../claude/prompt";

/** Anton's bundled agent prompts, relative to the bundled root. */
export const AGENTS_SRC_DIR = "src/prompts/agents";
/** Anton's vendored skill assets, relative to the bundled root (each is `<name>/SKILL.md`). */
export const SKILLS_SRC_DIR = SKILLS_DIR;
/** Where agents land under a project (Claude Code reads flat `<tag>.md` files here). */
export const CLAUDE_AGENTS_DIR = ".claude/agents";
/** Where skills land under a project (Claude Code reads `<name>/SKILL.md` directories here). */
export const CLAUDE_SKILLS_DIR = ".claude/skills";

/**
 * Skills anton always installs, regardless of selection — the founder cannot deselect them.
 * {@link REQUIRED_SKILLS} is the runtime-loaded subset; {@link INSTALLED_SKILLS} is the full set the
 * installer writes (it adds the founder-run `setup`). Each name resolves to the `skills/<name>/`
 * directory. Re-exported so `inventory.ts` and callers import them here.
 */
export { INSTALLED_SKILLS, REQUIRED_SKILLS };

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
  /** True for an {@link INSTALLED_SKILLS} member (always installed, non-deselectable). */
  required: boolean;
  /** Absolute source path in the bundled root — an agent `.md` file, or a skill's directory. */
  source: string;
  /** Absolute destination under the project's `.claude/` — an agent `.md` file, or a skill's directory. */
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

  const requiredSet = new Set<string>(INSTALLED_SKILLS);
  for (const name of unique([...INSTALLED_SKILLS, ...(selection.skills ?? [])])) {
    items.push({
      kind: "skill",
      name,
      required: requiredSet.has(name),
      // A skill is a directory (SKILL.md + any bundled assets); it's copied whole.
      source: join(root, SKILLS_SRC_DIR, name),
      target: join(projectDir, CLAUDE_SKILLS_DIR, name),
    });
  }

  return items;
}

/** Recursively list every file under `dir` as paths relative to `dir` (files only, no dir entries). */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(relative(dir, abs));
    }
  }
  return out;
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

/** Copy a single bundled file to `target` (no-clobber), fail-loud if the source is missing. */
async function copyFile(source: string, target: string, kind: string, name: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(source, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`installSelection: bundled ${kind} "${name}" not found at ${source}`);
    }
    throw err;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

/**
 * Install one planned item. Agents are a single file. A skill is a whole directory: it's considered
 * already-present iff its `SKILL.md` exists (a prior install/user copy is left untouched); otherwise
 * every file under the bundled skill dir is copied verbatim, so bundled companion assets (e.g.
 * `setup`'s `templates/`) travel with the skill. A skill whose bundled dir has no `SKILL.md` is a
 * fail-loud error (a selection should only name real bundled skills).
 */
async function installItem(item: PlanItem): Promise<InstallOutcome> {
  if (item.kind === "agent") {
    if (await pathExists(item.target)) return "skipped";
    await copyFile(item.source, item.target, item.kind, item.name);
    return "installed";
  }

  // Skill: the SKILL.md is the presence sentinel for the whole directory.
  if (await pathExists(join(item.target, "SKILL.md"))) return "skipped";

  const files = await walkFiles(item.source).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [] as string[];
    throw err;
  });
  if (!files.includes("SKILL.md")) {
    throw new Error(`installSelection: bundled skill "${item.name}" not found at ${item.source}`);
  }
  for (const rel of files) {
    const dest = join(item.target, rel);
    if (await pathExists(dest)) continue; // never clobber a stray user file within the skill dir
    await copyFile(join(item.source, rel), dest, item.kind, item.name);
  }
  return "installed";
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
    entries.push({ ...item, outcome: await installItem(item) });
  }

  const installed = entries.filter((e) => e.outcome === "installed");
  const skipped = entries.filter((e) => e.outcome === "skipped");
  return { entries, installed, skipped, changed: installed.length > 0 };
}
