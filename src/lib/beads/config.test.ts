/**
 * configYamlHas must accept BOTH on-disk encodings bd has shipped for the team-config keys: the flat
 * dotted lines bd 1.0.4 appends (`export.auto: false`) and the nested maps bd 1.1.0 writes for
 * `export.*`/`dolt.*` (`export:` / `    auto: false`). If it only understood the flat form, `anton
 * init` would read the nested form as unset and re-set every key on every run (anton-qhoz).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configYamlHas } from "./config.mjs";

// bd 1.0.4: settings appended as flat dotted lines after a comment header.
const FLAT = `# Beads Configuration File
# no-db: false

export.auto: false

dolt.auto-commit: "on"
export.git-add: false
dolt.auto-push: false
sync.remote: git+ssh://git@example.com/org/repo.git
`;

// bd 1.1.0: export.* and dolt.* nest under a map header (4-space indent); sync.remote stays flat.
const NESTED = `# Beads Configuration File
# output:
#   title-length: 255

export:
    auto: false
    git-add: false

dolt:
    auto-commit: on
    auto-push: false

sync.remote: git+ssh://git@example.com/org/repo.git
`;

describe("configYamlHas", () => {
  const dirs: string[] = [];
  const withConfig = (contents: string): string => {
    const beadsDir = mkdtempSync(join(tmpdir(), "anton-cfg-"));
    dirs.push(beadsDir);
    writeFileSync(join(beadsDir, "config.yaml"), contents);
    return beadsDir;
  };

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("returns true for keys set in the flat (bd 1.0.4) encoding", () => {
    const beadsDir = withConfig(FLAT);
    expect(configYamlHas(beadsDir, "export.auto", "false")).toBe(true);
    expect(configYamlHas(beadsDir, "export.git-add", "false")).toBe(true);
    expect(configYamlHas(beadsDir, "dolt.auto-commit", "on")).toBe(true); // quotes tolerated
    expect(configYamlHas(beadsDir, "dolt.auto-push", "false")).toBe(true);
  });

  it("returns true for the SAME keys set in the nested (bd 1.1.0) encoding", () => {
    const beadsDir = withConfig(NESTED);
    expect(configYamlHas(beadsDir, "export.auto", "false")).toBe(true);
    expect(configYamlHas(beadsDir, "export.git-add", "false")).toBe(true);
    expect(configYamlHas(beadsDir, "dolt.auto-commit", "on")).toBe(true);
    expect(configYamlHas(beadsDir, "dolt.auto-push", "false")).toBe(true);
  });

  it("still resolves a flat key (sync.remote) that stays flat in bd 1.1.0", () => {
    for (const contents of [FLAT, NESTED]) {
      const beadsDir = withConfig(contents);
      expect(configYamlHas(beadsDir, "sync.remote", "git+ssh://git@example.com/org/repo.git")).toBe(true);
    }
  });

  it("returns false when the value differs, in either encoding", () => {
    expect(configYamlHas(withConfig(FLAT), "export.auto", "true")).toBe(false);
    expect(configYamlHas(withConfig(NESTED), "export.auto", "true")).toBe(false);
  });

  it("returns false for an unset key and for a missing config.yaml", () => {
    expect(configYamlHas(withConfig(FLAT), "linear.api_key", "x")).toBe(false);
    expect(configYamlHas(join(tmpdir(), "anton-cfg-does-not-exist"), "export.auto", "false")).toBe(false);
  });

  it("ignores commented-out settings (a nested example must not read as set)", () => {
    // The bd config template ships commented nested examples like `# output:` / `#   title-length:
    // 255`; those must never count as a live setting.
    const beadsDir = withConfig("# export:\n#     auto: false\n");
    expect(configYamlHas(beadsDir, "export.auto", "false")).toBe(false);
  });
});
