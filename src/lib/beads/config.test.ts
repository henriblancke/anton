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
  bundledRunFormulaPath,
  configYamlHas,
  configYamlNonScalars,
  ensureBeadFormula,
  ensureRunFormula,
  MIN_BD_VERSION,
  parseConfigYaml,
  RUN_FORMULA_FILENAME,
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

/**
 * The flat map is a LOSSY read of config.yaml — it holds scalars and nothing else. A rollback diffs
 * two texts through it, so whatever it drops has to be readable somewhere, or an edit it cannot
 * represent reads as no edit at all and gets restored over (PR #174 review).
 */
describe("configYamlNonScalars", () => {
  const SEQUENCE = `repos:
  additional:
    - one
    - two
dolt.user: beads
`;

  it("keeps the flat map to scalars, and reports sequence items under the key enclosing them", () => {
    expect(parseConfigYaml(SEQUENCE)).toEqual({ "dolt.user": "beads" });
    expect(configYamlNonScalars(SEQUENCE)).toEqual({ "repos.additional": ["- one", "- two"] });
  });

  it("sees an item added, removed or reordered — a scalar diff sees none of them", () => {
    const added = SEQUENCE.replace("    - two\n", "    - two\n    - three\n");
    const reordered = `repos:\n  additional:\n    - two\n    - one\ndolt.user: beads\n`;
    expect(parseConfigYaml(added)).toEqual(parseConfigYaml(SEQUENCE));
    expect(parseConfigYaml(reordered)).toEqual(parseConfigYaml(SEQUENCE));
    expect(configYamlNonScalars(added)["repos.additional"]).toEqual(["- one", "- two", "- three"]);
    expect(configYamlNonScalars(reordered)["repos.additional"]).toEqual(["- two", "- one"]);
  });

  it("owns an item to a same-indent parent, and a top-level sequence to no key at all", () => {
    expect(configYamlNonScalars("repos:\n- one\n")).toEqual({ repos: ["- one"] });
    expect(configYamlNonScalars("- one\n")).toEqual({ "": ["- one"] });
  });

  it("never flattens a sequence of maps onto dotted keys — two items would collapse into one", () => {
    const items = "hooks:\n  - name: a\n    run: x\n  - name: b\n    run: y\n";
    expect(parseConfigYaml(items)).toEqual({});
    expect(configYamlNonScalars(items).hooks).toEqual(["- name: a", "run: x", "- name: b", "run: y"]);
  });

  /**
   * A block scalar's body is prose, not settings — exposing a body line as a live setting would let
   * enforcement skip a required write and let a retraction comment out somebody's text (PR #174).
   */
  it("treats a block scalar's body as opaque content, never as settings", () => {
    const text = "notes: |\n  dolt.user: historical\n  # not a comment\n\n  still body\ndolt.user: beads\n";
    expect(parseConfigYaml(text)).toEqual({ "dolt.user": "beads" });
    expect(configYamlNonScalars(text).notes).toEqual([
      "notes: |",
      "  dolt.user: historical",
      "  # not a comment",
      "",
      "  still body",
    ]);
  });

  it("closes a block scalar at the first line indented no deeper than its key", () => {
    const text = "dolt:\n  motd: >-\n    wrapped text\n  user: beads\nexport.auto: false\n";
    expect(parseConfigYaml(text)).toEqual({ "dolt.user": "beads", "export.auto": "false" });
    expect(configYamlNonScalars(text)).toEqual({ "dolt.motd": ["motd: >-", "    wrapped text"] });
  });

  /**
   * Whitespace IS content inside a block scalar: an added blank line or a re-indented body line
   * changes what the value says. Trimming it away would leave the diff empty and let a rollback
   * restore over somebody's edit (PR #174 review).
   */
  it("sees a body re-indented or a blank line added — both are edits to the value", () => {
    const base = "notes: |\n  first\n  second\ndolt.user: beads\n";
    const blanked = "notes: |\n  first\n\n  second\ndolt.user: beads\n";
    const reindented = "notes: |\n  first\n      second\ndolt.user: beads\n";
    expect(parseConfigYaml(blanked)).toEqual(parseConfigYaml(base));
    expect(parseConfigYaml(reindented)).toEqual(parseConfigYaml(base));
    expect(configYamlNonScalars(base).notes).toEqual(["notes: |", "  first", "  second"]);
    expect(configYamlNonScalars(blanked).notes).toEqual(["notes: |", "  first", "", "  second"]);
    expect(configYamlNonScalars(reindented).notes).toEqual(["notes: |", "  first", "      second"]);
  });

  it("does not read the blank line that merely follows a block as part of it", () => {
    const text = "notes: |\n  body\n\ndolt.user: beads\n";
    expect(configYamlNonScalars(text).notes).toEqual(["notes: |", "  body"]);
    expect(configYamlNonScalars("notes: |\n  body\n\n").notes).toEqual(["notes: |", "  body"]);
  });

  it("keeps an ordinary scalar that merely starts with an indicator character", () => {
    expect(parseConfigYaml("sync.remote: |pipe\n  nested: x\n")).toEqual({ "sync.remote": "|pipe", nested: "x" });
    expect(parseConfigYaml("notes: |2-\n  body\n")).toEqual({});
  });

  it("reads both scalar encodings exactly as before, and carries no residue for either", () => {
    expect(parseConfigYaml(FLAT)["export.auto"]).toBe("false");
    expect(parseConfigYaml(NESTED)["dolt.auto-commit"]).toBe("on");
    expect(configYamlNonScalars(FLAT)).toEqual({});
    expect(configYamlNonScalars(NESTED)).toEqual({});
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

/**
 * The setup half of anton-hrql: the RUN pipeline installs on the same terms as the bead skeleton
 * above — a fresh project gets anton's default, and a project that wrote its own keeps it across
 * every `anton setup` / `anton init` / addProject re-run. Both assets share one installer, so only
 * the run-formula-specific behavior is asserted here.
 */
describe("ensureRunFormula (anton-hrql)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const beadsDir = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "anton-run-formula-")), ".beads");
    dirs.push(join(dir, ".."));
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const dest = (dir: string) => join(dir, "formulas", RUN_FORMULA_FILENAME);

  it("installs the bundled pipeline into .beads/formulas/, creating the dir", () => {
    const dir = beadsDir();
    expect(ensureRunFormula(dir).status).toBe("installed");
    // `formula`, not `name` — the key bd validates on (anton-upfc).
    expect(readFileSync(dest(dir), "utf8")).toContain('formula = "anton-run"');
  });

  it("never clobbers a project's own pipeline", () => {
    const dir = beadsDir();
    ensureRunFormula(dir);
    writeFileSync(dest(dir), 'formula = "anton-run"\n# ours\n');

    expect(ensureRunFormula(dir).status).toBe("already");
    expect(readFileSync(dest(dir), "utf8")).toContain("# ours");
  });

  it("lands beside the bead formula rather than replacing it", () => {
    const dir = beadsDir();
    ensureBeadFormula(dir);
    ensureRunFormula(dir);
    expect(existsSync(join(dir, "formulas", BEAD_FORMULA_FILENAME))).toBe(true);
    expect(existsSync(dest(dir))).toBe(true);
  });

  it("resolves the bundled asset from the package, not the cwd", () => {
    expect(existsSync(bundledRunFormulaPath())).toBe(true);
  });
});
