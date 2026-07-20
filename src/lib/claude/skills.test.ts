/**
 * Asset test for anton's vendored REQUIRED skills (anton-d8f.1). Proves the skills anton ships
 * (`skills/<name>/SKILL.md`) exist and are well-formed, so a `/shape` run — and anton's own jobs —
 * have full operating context from anton's assets alone, with no loom/plugin dependency.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLED_SKILLS, REQUIRED_SKILLS, loadSkill, skillPath } from "./prompt";
import { stripFrontmatter } from "./agent-prompt";

/** Pull `name:` and `description:` out of a SKILL.md frontmatter block. */
function frontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith("---\n")) return {};
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return {};
  const block = raw.slice(4, end);
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  // description may be a folded scalar (>-); just assert the key is present + non-empty.
  const description = block.match(/^description:\s*([\s\S]+?)(?:\n\S|$)/m)?.[1]?.trim();
  return { name, description };
}

describe("required skill assets", () => {
  it("ships exactly the expected required set", () => {
    expect([...REQUIRED_SKILLS].sort()).toEqual(
      ["bd", "review-fix", "scan-triage", "shape"].sort(),
    );
  });

  for (const name of REQUIRED_SKILLS) {
    describe(`skills/${name}`, () => {
      const raw = readFileSync(skillPath(name), "utf8");

      it("has frontmatter whose name matches its directory", () => {
        const fm = frontmatter(raw);
        expect(fm.name).toBe(name);
        expect(fm.description && fm.description.length).toBeGreaterThan(0);
      });

      it("has a non-empty body once frontmatter is stripped", () => {
        expect(stripFrontmatter(raw).trim().length).toBeGreaterThan(0);
      });

      it("carries no dangling loom / external-plugin references", () => {
        const body = stripFrontmatter(raw);
        expect(body).not.toMatch(/loom/i);
        expect(body).not.toMatch(/foolery/i);
        expect(body).not.toMatch(/skills\/bd\b/); // stale cross-skill path
        expect(body).not.toMatch(/SessionStart/i);
        expect(body).not.toMatch(/loom-scan/i);
      });

      it("loadSkill returns the frontmatter-stripped body", async () => {
        expect(await loadSkill(name)).toBe(stripFrontmatter(raw).trim());
      });
    });
  }

  it("shape and scan-triage point at the bd skill for conventions", () => {
    for (const name of ["shape", "scan-triage"] as const) {
      expect(readFileSync(skillPath(name), "utf8")).toMatch(/`bd` skill/);
    }
  });

  it("shape and scan-triage warn about missing .product/ and point at /setup", () => {
    // If .product/ is absent, these skills must not shape/triage against a vacuum — they warn
    // explicitly and direct the user at the now-bundled /setup (anton-olh).
    for (const name of ["shape", "scan-triage"] as const) {
      const raw = readFileSync(skillPath(name), "utf8");
      expect(raw).toMatch(/`.product\/` is missing/);
      expect(raw).toMatch(/`\/setup`/);
    }
  });

  // `setup` is founder-run, not loaded by anton's runtime for a background job — so it lives outside
  // REQUIRED_SKILLS. But it IS in INSTALLED_SKILLS: the installer must ship it (skill + its bundled
  // templates) into a target repo, or `/setup` can't resolve where `/shape` sends the founder (anton-olh).
  describe("bundled setup skill", () => {
    const raw = readFileSync(skillPath("setup"), "utf8");

    it("is not in the runtime-required set", () => {
      expect([...REQUIRED_SKILLS]).not.toContain("setup");
    });

    it("is in the always-installed set (so `/setup` resolves in a target repo)", () => {
      expect([...INSTALLED_SKILLS]).toContain("setup");
    });

    it("has frontmatter whose name matches its directory + a non-empty body", () => {
      const fm = frontmatter(raw);
      expect(fm.name).toBe("setup");
      expect(fm.description && fm.description.length).toBeGreaterThan(0);
      expect(stripFrontmatter(raw).trim().length).toBeGreaterThan(0);
    });

    it("is de-loomed and scaffolds from templates bundled alongside the skill", () => {
      const body = stripFrontmatter(raw);
      expect(body).not.toMatch(/loom/i);
      expect(body).not.toMatch(/foolery/i);
      expect(body).toMatch(/templates\/\.product\//);
      expect(body).toMatch(/bd init/);
    });

    it("ships its `.product/` templates inside the skill directory (they travel with the skill)", () => {
      // The templates must live under skills/setup/ so installing the skill dir copies them into a
      // target repo — the fix for a source tree where /setup had no templates to copy (anton-olh).
      const templates = join(dirname(skillPath("setup")), "templates", ".product");
      for (const rel of [
        "PRODUCT.md",
        "config.yaml",
        "principles.md",
        "learnings.md",
        "decisions/README.md",
        "entities/README.md",
      ]) {
        expect(existsSync(join(templates, rel))).toBe(true);
      }
    });
  });
});
