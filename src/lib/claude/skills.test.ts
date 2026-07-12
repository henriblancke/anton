/**
 * Asset test for anton's vendored REQUIRED skills (anton-d8f.1). Proves the skills anton ships
 * (`skills/<name>/SKILL.md`) exist and are well-formed, so a `/shape` run — and anton's own jobs —
 * have full operating context from anton's assets alone, with no loom/plugin dependency.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REQUIRED_SKILLS, loadSkill, skillPath } from "./prompt";
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
});
