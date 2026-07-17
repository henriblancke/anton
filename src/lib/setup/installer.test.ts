/**
 * Installer (anton-3n5.2): copies selected bundled agents + always-on required skills into a
 * project's `.claude/`, idempotently and without clobbering existing files. Tests run against the
 * real bundled prompts (process.cwd() = repo root) writing into a throwaway temp project dir.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_AGENTS_DIR,
  CLAUDE_SKILLS_DIR,
  INSTALLED_SKILLS,
  installSelection,
  planInstall,
} from "./installer";

const agentPath = (dir: string, tag: string) => join(dir, CLAUDE_AGENTS_DIR, `${tag}.md`);
const skillDir = (dir: string, name: string) => join(dir, CLAUDE_SKILLS_DIR, name);
const skillPath = (dir: string, name: string) => join(skillDir(dir, name), "SKILL.md");

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("planInstall", () => {
  it("plans selected agents + always the required skills, deduped", () => {
    const plan = planInstall(
      { agents: ["nextjs", "nextjs"], skills: ["shape", "extra"] },
      { projectDir: "/proj" },
    );
    const skills = plan.filter((p) => p.kind === "skill").map((p) => p.name);
    const agents = plan.filter((p) => p.kind === "agent").map((p) => p.name);

    expect(agents).toEqual(["nextjs"]); // deduped
    // installed skills present exactly once even though "shape" was also selected
    for (const req of INSTALLED_SKILLS) expect(skills.filter((s) => s === req)).toHaveLength(1);
    expect(skills).toContain("extra");
    expect(plan.find((p) => p.name === "shape")?.required).toBe(true);
    expect(plan.find((p) => p.name === "setup")?.required).toBe(true); // always-installed, non-deselectable
    expect(plan.find((p) => p.name === "extra")?.required).toBe(false);
  });

  it("targets flat agent files and whole <name>/ skill dirs", () => {
    const plan = planInstall({ agents: ["fastapi"] }, { projectDir: "/proj" });
    expect(plan.find((p) => p.kind === "agent")?.target).toBe(agentPath("/proj", "fastapi"));
    // A skill is copied as its whole directory, not just SKILL.md.
    expect(plan.find((p) => p.name === "shape")?.target).toBe(skillDir("/proj", "shape"));
  });
});

describe("installSelection", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "anton-installer-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("fresh install: writes selected agent + installed skills, byte-identical to source", async () => {
    const summary = await installSelection({ agents: ["nextjs"] }, { projectDir });

    expect(summary.changed).toBe(true);
    expect(summary.skipped).toHaveLength(0);
    // one agent + every always-installed skill (setup included)
    expect(summary.installed).toHaveLength(1 + INSTALLED_SKILLS.length);

    const agentBody = await readFile(agentPath(projectDir, "nextjs"), "utf8");
    const srcBody = await readFile(join(process.cwd(), "src/prompts/agents/nextjs.md"), "utf8");
    expect(agentBody).toBe(srcBody); // verbatim copy, frontmatter intact

    for (const req of INSTALLED_SKILLS) {
      const body = await readFile(skillPath(projectDir, req), "utf8");
      const src = await readFile(join(process.cwd(), `skills/${req}/SKILL.md`), "utf8");
      expect(body).toBe(src);
    }
  });

  it("ships setup's bundled `.product/` templates alongside its SKILL.md", async () => {
    await installSelection({}, { projectDir });

    // The whole skill directory is copied, so setup's scaffolding templates land in the project —
    // the fix that lets `/setup` find templates to copy in a target repo (anton-olh).
    for (const rel of ["PRODUCT.md", "config.yaml", "principles.md", "decisions/README.md"]) {
      const dest = join(skillDir(projectDir, "setup"), "templates", ".product", rel);
      expect(await exists(dest)).toBe(true);
      const body = await readFile(dest, "utf8");
      const src = await readFile(join(process.cwd(), "skills/setup/templates/.product", rel), "utf8");
      expect(body).toBe(src); // verbatim copy
    }
  });

  it("required-always: installs the full set even with an empty selection", async () => {
    const summary = await installSelection({}, { projectDir });

    expect(summary.installed.map((e) => e.name).sort()).toEqual([...INSTALLED_SKILLS].sort());
    expect(summary.installed.every((e) => e.kind === "skill" && e.required)).toBe(true);
    for (const req of INSTALLED_SKILLS) expect(await exists(skillPath(projectDir, req))).toBe(true);
    expect(await exists(join(projectDir, CLAUDE_AGENTS_DIR))).toBe(false);
  });

  it("idempotent: a second run with the same selection makes no changes", async () => {
    const first = await installSelection({ agents: ["nextjs"] }, { projectDir });
    expect(first.changed).toBe(true);

    const second = await installSelection({ agents: ["nextjs"] }, { projectDir });
    expect(second.changed).toBe(false);
    expect(second.installed).toHaveLength(0);
    expect(second.skipped).toHaveLength(first.installed.length);
    expect(second.skipped.every((e) => e.outcome === "skipped")).toBe(true);
  });

  it("skip-existing-user-file: a pre-existing file is reported skipped and left byte-for-byte", async () => {
    const userFile = agentPath(projectDir, "nextjs");
    const userContent = "---\nname: nextjs\n---\n\nMY OWN AGENT — do not touch\n";
    await mkdir(join(projectDir, CLAUDE_AGENTS_DIR), { recursive: true });
    await writeFile(userFile, userContent);

    const summary = await installSelection({ agents: ["nextjs"] }, { projectDir });

    // the user's agent is untouched...
    expect(await readFile(userFile, "utf8")).toBe(userContent);
    const nextjsEntry = summary.entries.find((e) => e.kind === "agent" && e.name === "nextjs");
    expect(nextjsEntry?.outcome).toBe("skipped");
    // ...while the fresh installed skills still install
    expect(summary.installed.every((e) => e.kind === "skill")).toBe(true);
    expect(summary.installed).toHaveLength(INSTALLED_SKILLS.length);
  });

  it("installs optional extra skills from the selection", async () => {
    // Every vendored skill is always-installed, so stand up a synthetic bundled root carrying the
    // installed set plus one non-required "custom" skill to exercise the additive selection.skills path.
    const bundledRoot = await mkdtemp(join(tmpdir(), "anton-bundled-"));
    for (const name of [...INSTALLED_SKILLS, "custom"]) {
      await mkdir(join(bundledRoot, "skills", name), { recursive: true });
      await writeFile(join(bundledRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n\nbody\n`);
    }

    const summary = await installSelection({ skills: ["custom"] }, { projectDir, bundledRoot });
    const extra = summary.installed.find((e) => e.name === "custom");
    expect(extra).toBeDefined();
    expect(extra?.required).toBe(false);
    expect(await exists(skillPath(projectDir, "custom"))).toBe(true);

    await rm(bundledRoot, { recursive: true, force: true });
  });

  it("fails loud when a selected agent has no bundled source", async () => {
    await expect(
      installSelection({ agents: ["does-not-exist"] }, { projectDir }),
    ).rejects.toThrow(/does-not-exist/);
  });
});
