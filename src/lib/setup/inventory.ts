/**
 * Inventory (anton-3n5.1): a pure, read-only report of what the setup wizard renders — anton's
 * bundled agents/skills, which skills are required, and which agents/skills the target repo or the
 * user's home already has. It writes NOTHING; installing is the installer's job (anton-3n5.2).
 *
 * Sources it reads:
 *   - anton's bundled agents:  <bundledRoot>/src/prompts/agents/<tag>.md   (name/description frontmatter)
 *   - anton's bundled skills:  <bundledRoot>/skills/<name>/SKILL.md        (the always-installed INSTALLED_SKILLS)
 *   - project `.claude/`:      <projectDir>/.claude/agents/<tag>.md, <projectDir>/.claude/skills/<name>/SKILL.md
 *   - global  `.claude/`:      <homeDir>/.claude/agents/<tag>.md,   <homeDir>/.claude/skills/<name>/SKILL.md
 *
 * Every bundled item is classified by comparing the already-present copy (if any) against anton's
 * bundled source, mirroring the installer's no-clobber contract and the agent-prompt resolution
 * precedence (project over global):
 *   - "available"           — not present in either scope; the wizard may install it.
 *   - "installed-by-anton"  — present and byte-identical to anton's bundled source (anton put it there).
 *   - "user"                — present but DIFFERENT from bundled (a user override — never touch it).
 * A `.claude/` agent/skill anton doesn't bundle at all is reported as a bundled=false "user" item so
 * the wizard can show it as already-present-do-not-touch. The install target is the project's
 * `.claude/`, so the project copy (not global) decides an item's classification; global presence is
 * still recorded in `present` for the wizard to surface.
 */
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripFrontmatter } from "../claude/agent-prompt";
import {
  AGENTS_SRC_DIR,
  CLAUDE_AGENTS_DIR,
  CLAUDE_SKILLS_DIR,
  INSTALLED_SKILLS,
  SKILLS_SRC_DIR,
} from "./installer";

export type ItemKind = "agent" | "skill";
/** Which `.claude/` an already-present copy lives in. */
export type Scope = "project" | "global";
export type Classification = "available" | "installed-by-anton" | "user";

/** One already-present copy of an item found on disk. */
export interface PresentCopy {
  scope: Scope;
  /** Absolute path to the file (`<tag>.md` for agents, `<name>/SKILL.md` for skills). */
  path: string;
  /** True iff byte-identical to anton's bundled source. Always false for non-bundled items. */
  matchesBundled: boolean;
}

export interface InventoryItem {
  kind: ItemKind;
  /** Agent tag or skill name. */
  name: string;
  /** Short description from frontmatter `description:` / first non-empty line. */
  description?: string;
  /** True iff anton ships a bundled source for this item. */
  bundled: boolean;
  /** True for an {@link INSTALLED_SKILLS} member — always installed, cannot be deselected. */
  required: boolean;
  classification: Classification;
  /** Every scope where a copy already exists (may span both project and global). */
  present: PresentCopy[];
}

export interface Inventory {
  agents: InventoryItem[];
  skills: InventoryItem[];
  /** Bundled items with no copy on disk yet — the wizard's installable set. */
  availableToInstall: InventoryItem[];
  /** Bundled items already present and byte-identical to anton's source. */
  installedByAnton: InventoryItem[];
  /** Items present but not anton's (user overrides + agents/skills anton doesn't bundle). */
  preExistingUser: InventoryItem[];
}

export interface InventoryOptions {
  /** Target repo whose `.claude/` is the install destination and primary scan scope. */
  projectDir: string;
  /** Home dir for the global `~/.claude` scan. Defaults to os.homedir(). */
  homeDir?: string;
  /** Anton repo root holding the bundled prompts. Defaults to process.cwd(). */
  bundledRoot?: string;
}

/** Read a UTF-8 file, returning undefined on ENOENT (absent is a normal, expected outcome). */
async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
}

/** List directory entry names, returning [] when the directory doesn't exist. */
async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Pull a single frontmatter scalar (supporting YAML block scalars like `description: >-`) out of a
 * markdown file. Deliberately minimal — just enough for anton's/user's `name:`/`description:` fields
 * without pulling in a YAML dependency.
 */
function frontmatterField(md: string, field: string): string | undefined {
  if (!md.startsWith("---\n")) return undefined;
  const end = md.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const lines = md.slice(4, end).split("\n");

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m || m[1] !== field) continue;

    const inline = m[2].trim();
    // Block scalar (folded `>`/`>-` or literal `|`/`|-`): gather the more-indented following lines.
    if (/^[|>][+-]?$/.test(inline)) {
      const literal = inline.startsWith("|");
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") {
          collected.push("");
        } else if (/^\s/.test(lines[j])) {
          collected.push(lines[j].trim());
        } else {
          break; // dedent back to a sibling key — the block ended
        }
      }
      const joined = collected.join(literal ? "\n" : " ");
      return joined.replace(/\s+/g, " ").trim() || undefined;
    }

    // Inline scalar — strip a single layer of surrounding quotes.
    return inline.replace(/^["']|["']$/g, "").trim() || undefined;
  }
  return undefined;
}

/** Best-effort short description: frontmatter `description:`, else the first non-empty body line. */
function extractDescription(md: string): string | undefined {
  const fm = frontmatterField(md, "description");
  if (fm) return fm;
  const body = md.startsWith("---\n") ? stripFrontmatter(md) : md;
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t;
  }
  return undefined;
}

/** The install target is the project, so its copy decides; global only decides when project is absent. */
function classify(present: PresentCopy[]): Classification {
  const proj = present.find((p) => p.scope === "project");
  const glob = present.find((p) => p.scope === "global");
  if (proj) return proj.matchesBundled ? "installed-by-anton" : "user";
  if (glob) return glob.matchesBundled ? "installed-by-anton" : "user";
  return "available";
}

/** Absolute on-disk path of an item within a given scope root's `.claude/`. */
function itemPath(kind: ItemKind, root: string, name: string): string {
  return kind === "agent"
    ? join(root, CLAUDE_AGENTS_DIR, `${name}.md`)
    : join(root, CLAUDE_SKILLS_DIR, name, "SKILL.md");
}

/**
 * Resolve one bundled item (agent tag or skill name) into a fully classified {@link InventoryItem}
 * by comparing the project + global copies (if any) against its bundled source content.
 */
async function bundledItem(
  kind: ItemKind,
  name: string,
  bundledContent: string,
  required: boolean,
  opts: Required<InventoryOptions>,
): Promise<InventoryItem> {
  const scopeRoots: { scope: Scope; root: string }[] = [
    { scope: "project", root: opts.projectDir },
    { scope: "global", root: opts.homeDir },
  ];

  const present: PresentCopy[] = [];
  for (const { scope, root } of scopeRoots) {
    const path = itemPath(kind, root, name);
    const content = await readMaybe(path);
    if (content !== undefined) {
      present.push({ scope, path, matchesBundled: content === bundledContent });
    }
  }

  return {
    kind,
    name,
    description: extractDescription(bundledContent),
    bundled: true,
    required,
    classification: classify(present),
    present,
  };
}

/** Names of the agents/skills anton bundles under `<bundledRoot>/src/prompts`. */
async function bundledAgentTags(bundledRoot: string): Promise<string[]> {
  const names = await listDir(join(bundledRoot, AGENTS_SRC_DIR));
  return names
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.slice(0, -".md".length))
    .sort();
}

/**
 * Discover agents/skills already in a scope's `.claude/` that anton does NOT bundle — pure user
 * content the wizard must show as present and never touch. Returns one entry per (scope, name).
 */
async function userExtras(
  kind: ItemKind,
  scope: Scope,
  root: string,
  bundledNames: Set<string>,
): Promise<{ name: string; copy: PresentCopy; description?: string }[]> {
  const out: { name: string; copy: PresentCopy; description?: string }[] = [];

  if (kind === "agent") {
    for (const entry of await listDir(join(root, CLAUDE_AGENTS_DIR))) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -".md".length);
      if (bundledNames.has(name)) continue; // bundled items are handled by bundledItem()
      const path = itemPath("agent", root, name);
      const content = await readMaybe(path);
      if (content === undefined) continue;
      out.push({ name, copy: { scope, path, matchesBundled: false }, description: extractDescription(content) });
    }
    return out;
  }

  for (const dir of await listDir(join(root, CLAUDE_SKILLS_DIR))) {
    if (bundledNames.has(dir)) continue;
    const path = itemPath("skill", root, dir);
    const content = await readMaybe(path);
    if (content === undefined) continue; // a skill dir without SKILL.md isn't a skill
    out.push({ name: dir, copy: { scope, path, matchesBundled: false }, description: extractDescription(content) });
  }
  return out;
}

/**
 * Collapse per-scope user extras (which may name the same item in both project and global) into one
 * {@link InventoryItem} each, merging the present copies. Preserves discovery order.
 */
function collectUserItems(
  kind: ItemKind,
  extras: { name: string; copy: PresentCopy; description?: string }[],
): InventoryItem[] {
  const byName = new Map<string, InventoryItem>();
  for (const { name, copy, description } of extras) {
    const existing = byName.get(name);
    if (existing) {
      existing.present.push(copy);
      existing.description ??= description;
      continue;
    }
    byName.set(name, {
      kind,
      name,
      description,
      bundled: false,
      required: false,
      classification: "user",
      present: [copy],
    });
  }
  return [...byName.values()];
}

/**
 * Build the setup inventory: read anton's bundled agents/skills, scan the project and global
 * `.claude/` directories, and classify every item into available / installed-by-anton / user. Pure
 * and read-only — no filesystem writes.
 */
export async function buildInventory(options: InventoryOptions): Promise<Inventory> {
  const opts: Required<InventoryOptions> = {
    projectDir: options.projectDir,
    homeDir: options.homeDir ?? homedir(),
    bundledRoot: options.bundledRoot ?? process.cwd(),
  };

  // --- Bundled agents (all optional/selectable) ---
  const agentTags = await bundledAgentTags(opts.bundledRoot);
  const agentNameSet = new Set(agentTags);
  const bundledAgents: InventoryItem[] = [];
  for (const tag of agentTags) {
    const src = await readMaybe(join(opts.bundledRoot, AGENTS_SRC_DIR, `${tag}.md`));
    if (src === undefined) continue; // raced away between listing and reading — skip
    bundledAgents.push(await bundledItem("agent", tag, src, false, opts));
  }

  // --- Bundled skills (the always-installed set: required runtime skills + founder-run setup) ---
  const skillNameSet = new Set<string>(INSTALLED_SKILLS);
  const bundledSkills: InventoryItem[] = [];
  for (const name of INSTALLED_SKILLS) {
    const src = await readMaybe(join(opts.bundledRoot, SKILLS_SRC_DIR, name, "SKILL.md"));
    if (src === undefined) {
      throw new Error(`buildInventory: bundled skill "${name}" missing from bundled ${SKILLS_SRC_DIR}`);
    }
    bundledSkills.push(await bundledItem("skill", name, src, true, opts));
  }

  // --- User agents/skills anton doesn't bundle (present, do-not-touch) ---
  const scopeRoots: { scope: Scope; root: string }[] = [
    { scope: "project", root: opts.projectDir },
    { scope: "global", root: opts.homeDir },
  ];
  const agentExtras: { name: string; copy: PresentCopy; description?: string }[] = [];
  const skillExtras: { name: string; copy: PresentCopy; description?: string }[] = [];
  for (const { scope, root } of scopeRoots) {
    agentExtras.push(...(await userExtras("agent", scope, root, agentNameSet)));
    skillExtras.push(...(await userExtras("skill", scope, root, skillNameSet)));
  }

  const agents = [...bundledAgents, ...collectUserItems("agent", agentExtras)];
  const skills = [...bundledSkills, ...collectUserItems("skill", skillExtras)];
  const all = [...agents, ...skills];

  return {
    agents,
    skills,
    availableToInstall: all.filter((i) => i.classification === "available"),
    installedByAnton: all.filter((i) => i.classification === "installed-by-anton"),
    preExistingUser: all.filter((i) => i.classification === "user"),
  };
}
