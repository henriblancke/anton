/**
 * configYamlHas must accept BOTH on-disk encodings bd has shipped for the team-config keys: the flat
 * dotted lines bd 1.0.4 appends (`export.auto: false`) and the nested maps bd 1.1.0 writes for
 * `export.*`/`dolt.*` (`export:` / `    auto: false`). If it only understood the flat form, `anton
 * init` would read the nested form as unset and re-set every key on every run (anton-qhoz).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bdVersion,
  bdVersionAtLeast,
  BEAD_FORMULA_FILENAME,
  bundledBeadFormulaPath,
  configYamlHas,
  ensureBeadFormula,
  MIN_BD_VERSION,
} from "./config.mjs";

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

describe("bd version gate (anton-qwsq)", () => {
  const run = (out: string, status = 0, error?: unknown) => () => ({ status, stdout: out, error });

  it("parses the `bd version X.Y.Z (hash)` line", () => {
    expect(bdVersion(run("bd version 1.1.0 (8e4e59d39)"))).toEqual({ major: 1, minor: 1, patch: 0, raw: "1.1.0" });
    expect(bdVersion(run("bd version 1.0.4 (ce242a879)"))).toEqual({ major: 1, minor: 0, patch: 4, raw: "1.0.4" });
  });

  it("returns null when bd errors, exits non-zero, or prints no version", () => {
    expect(bdVersion(run("", 127))).toBeNull();
    expect(bdVersion(run("bd version 1.1.0", 0, new Error("x")))).toBeNull();
    expect(bdVersion(run("no version here"))).toBeNull();
  });

  it("gates at the minimum version — accepts >= 1.1.0, rejects older and unreadable", () => {
    expect(MIN_BD_VERSION).toBe("1.1.0");
    expect(bdVersionAtLeast({ major: 1, minor: 1, patch: 0 })).toBe(true);
    expect(bdVersionAtLeast({ major: 1, minor: 2, patch: 0 })).toBe(true);
    expect(bdVersionAtLeast({ major: 2, minor: 0, patch: 0 })).toBe(true);
    expect(bdVersionAtLeast({ major: 1, minor: 0, patch: 4 })).toBe(false);
    expect(bdVersionAtLeast({ major: 0, minor: 63, patch: 3 })).toBe(false);
    expect(bdVersionAtLeast(null)).toBe(false);
  });
});

/**
 * The setup half of anton-8mnr: the bead formula must LAND in a fresh `.beads/`, and must never
 * overwrite a project-local copy — a team that tuned its own bead skeleton keeps it across every
 * `anton setup` / `anton init` / addProject re-run.
 */
describe("ensureBeadFormula (anton-8mnr)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A real (bd-initialised) workspace root — the only place a formula may land. */
  const beadsDir = () => {
    const dir = absentBeadsDir();
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  /** A repo with NO `.beads/` — a release-bundle install, where nothing may be created. */
  const absentBeadsDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "anton-formula-cfg-"));
    dirs.push(dir);
    return join(dir, ".beads");
  };

  const dest = (dir: string) => join(dir, "formulas", BEAD_FORMULA_FILENAME);

  it("installs the bundled formula into .beads/formulas/, creating the dir", () => {
    const dir = beadsDir();
    expect(ensureBeadFormula(dir).status).toBe("installed");
    expect(JSON.parse(readFileSync(dest(dir), "utf8")).formula).toBe("anton-bead");
  });

  it("never clobbers an existing project-local copy", () => {
    const dir = beadsDir();
    ensureBeadFormula(dir);
    writeFileSync(dest(dir), '{"formula":"anton-bead","mine":true}');

    expect(ensureBeadFormula(dir).status).toBe("already");
    expect(JSON.parse(readFileSync(dest(dir), "utf8")).mine).toBe(true);
  });

  it("reports a missing asset instead of throwing", () => {
    expect(ensureBeadFormula(beadsDir(), join(tmpdir(), "no-such-formula.json")).status).toBe(
      "missing-asset",
    );
  });

  it("refuses to fabricate a .beads workspace where none exists", () => {
    // A release-bundle install has no workspace at the package root. Creating `.beads/formulas/`
    // there would make every "is this a beads repo?" probe answer yes — configureBeadsDoltSync
    // reads exactly that, then fails `anton setup` for having no git origin in an extracted runtime.
    const dir = absentBeadsDir();
    expect(ensureBeadFormula(dir).status).toBe("no-workspace");
    expect(existsSync(dir)).toBe(false);
  });

  it("reports a write failure instead of aborting the setup around it", () => {
    // An unwritable `.beads/` (read-only checkout, no permission, a `formulas` path that isn't a
    // directory) must not take down project registration — the formula is one best-effort step
    // among a dozen and anton's renderer falls back to its packaged copy. A throw here aborted
    // `anton setup` / addProject outright.
    const dir = beadsDir();
    writeFileSync(join(dir, "formulas"), "not a directory");

    const result = ensureBeadFormula(dir);
    expect(result.status).toBe("failed");
    expect(result.detail).toBeTruthy();
  });

  it("resolves the bundled asset from the package, not the cwd", () => {
    expect(existsSync(bundledBeadFormulaPath())).toBe(true);
  });
});
