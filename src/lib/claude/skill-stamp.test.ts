/**
 * `listFiles`/`skillDigest` symlink handling (PR #313 review): a `Dirent` for a symlink reports
 * `false` from both `isFile()` and `isDirectory()` — those describe the link itself, not its
 * target — so a skill directory keeping `SKILL.md` as a symlink to a file shared elsewhere must
 * still be walked and hashed via its resolved target.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listFiles, skillDigest } from "./skill-stamp.mjs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-skill-stamp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listFiles — symlinked skill contents", () => {
  it("resolves a symlinked SKILL.md to its target file", () => {
    const shared = join(dir, "shared-skill.md");
    writeFileSync(shared, "---\nname: sym\ndescription: shared\n---\nbody");
    const skillDir = join(dir, "skills", "sym");
    mkdirSync(skillDir, { recursive: true });
    symlinkSync(shared, join(skillDir, "SKILL.md"));

    expect(listFiles(skillDir)).toEqual(["SKILL.md"]);
  });

  it("resolves a symlinked subdirectory", () => {
    const sharedDir = join(dir, "shared-assets");
    mkdirSync(sharedDir);
    writeFileSync(join(sharedDir, "template.md"), "asset");
    const skillDir = join(dir, "skills", "sym-dir");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: sym-dir\ndescription: d\n---\nbody");
    symlinkSync(sharedDir, join(skillDir, "assets"));

    expect(listFiles(skillDir).sort()).toEqual(["SKILL.md", join("assets", "template.md")].sort());
  });

  it("skips a broken symlink instead of throwing", () => {
    const skillDir = join(dir, "skills", "broken");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: broken\ndescription: d\n---\nbody");
    symlinkSync(join(dir, "does-not-exist"), join(skillDir, "dangling"));

    expect(listFiles(skillDir)).toEqual(["SKILL.md"]);
  });
});

describe("skillDigest — symlinked SKILL.md", () => {
  it("changes when the symlink target's content changes", () => {
    const shared = join(dir, "shared-skill.md");
    writeFileSync(shared, "---\nname: sym\ndescription: shared\n---\nbody v1");
    const skillDir = join(dir, "skills", "sym");
    mkdirSync(skillDir, { recursive: true });
    symlinkSync(shared, join(skillDir, "SKILL.md"));

    const before = skillDigest(skillDir);
    writeFileSync(shared, "---\nname: sym\ndescription: shared\n---\nbody v2");
    expect(skillDigest(skillDir)).not.toBe(before);
  });
});
