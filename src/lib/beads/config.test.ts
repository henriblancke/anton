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
  configYamlComments,
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
/**
 * The other thing the flat map drops. A comment carries a team's reasoning — why auto-push is off,
 * a block somebody is mid-way through enabling — and a rollback that could not see one changing
 * would restore an older text straight over it (PR #174 review).
 */
describe("configYamlComments", () => {
  it("reports a comment under the path open above it, and never as a setting", () => {
    const text = "# top\ndolt:\n  # inner\n  user: beads\n";
    expect(parseConfigYaml(text)).toEqual({ "dolt.user": "beads" });
    expect(configYamlNonScalars(text)).toEqual({});
    expect(configYamlComments(text)).toEqual({ "": ["# top"], dolt: ["# inner"] });
  });

  it("sees a comment added, edited or removed — the scalar diff sees none of them", () => {
    const base = "dolt.user: beads\n# why: the shared board\n";
    const edited = "dolt.user: beads\n# why: the shared board, since August\n";
    const removed = "dolt.user: beads\n";
    expect(parseConfigYaml(edited)).toEqual(parseConfigYaml(base));
    expect(parseConfigYaml(removed)).toEqual(parseConfigYaml(base));
    expect(configYamlComments(base)).toEqual({ "": ["# why: the shared board"] });
    expect(configYamlComments(edited)).toEqual({ "": ["# why: the shared board, since August"] });
    expect(configYamlComments(removed)).toEqual({});
  });

  /**
   * And under the blocks its OWN INDENTATION puts it inside (PR #174 review). The rollback tells the
   * strike-outs it made itself from somebody else's prose by the path a comment reports under — a
   * retraction comments a nested key out in place — so a top-level `# user: old` a concurrent editor
   * adds below a `dolt:` block must NOT read as the struck-out `dolt.user` line above it, or the
   * restore forgives it as this run's own and deletes it silently.
   */
  it("reports a comment under the blocks its indentation puts it inside, not the block still open", () => {
    const text = "dolt:\n  # user: old\n# user: old\n";
    expect(configYamlComments(text)).toEqual({ dolt: ["# user: old"], "": ["# user: old"] });
    // The block is still open for SETTINGS — a comment closes nothing.
    expect(parseConfigYaml("dolt:\n  # user: old\n# user: old\n  user: new\n")).toEqual({ "dolt.user": "new" });
  });

  /** A block scalar's body is the value's own text: a `#` line in it is prose, not a comment. */
  it("does not mistake a block scalar's body for comments", () => {
    const text = "notes: |\n  # not a comment\ndolt.user: beads\n";
    expect(configYamlComments(text)).toEqual({});
    expect(configYamlNonScalars(text).notes).toEqual(["notes: |", "  # not a comment"]);
  });
});

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

  /**
   * A quoted scalar carries on over the lines below it until its closing quote, and every one of
   * those lines is the value's own text. Read as settings, a `dolt.user:` sitting inside somebody's
   * `notes:` string is a live top-level key — enough to make config enforcement skip a required
   * write, and to make a retraction comment out the middle of that string and leave the file
   * unparseable (PR #174 review).
   */
  it("treats a multiline quoted scalar as opaque until its closing quote", () => {
    const text = 'notes: "first\n  dolt.user: historical\n  # still the string"\ndolt.user: beads\n';
    expect(parseConfigYaml(text)).toEqual({ "dolt.user": "beads" });
    expect(configYamlComments(text)).toEqual({});
    expect(configYamlNonScalars(text).notes).toEqual(['notes: "first', "  dolt.user: historical", '  # still the string"']);
  });

  /** Whitespace and blank lines inside the string are content too, and neither closes it. */
  it("keeps a quoted scalar's continuation verbatim, blank lines included", () => {
    const base = 'notes: "first\n\n  second"\ndolt.user: beads\n';
    const reindented = 'notes: "first\n\n      second"\ndolt.user: beads\n';
    expect(parseConfigYaml(base)).toEqual({ "dolt.user": "beads" });
    expect(configYamlNonScalars(base).notes).toEqual(['notes: "first', "", '  second"']);
    expect(configYamlNonScalars(reindented).notes).not.toEqual(configYamlNonScalars(base).notes);
  });

  /**
   * A plain scalar carries on over the lines indented deeper than its key, and `dolt.user:historical`
   * is text there rather than a key: YAML only opens a mapping on a colon FOLLOWED BY WHITESPACE.
   * Read as a setting, that line is a live `dolt.user` — enough to make stale-key cleanup strike out
   * the middle of somebody's `notes:` and report a user it never cleared (PR #174 review).
   */
  it("treats a plain scalar's continuation as opaque, never as settings", () => {
    const text = "notes: first\n  dolt.user:historical\n  # still the value\ndolt.user: beads\n";
    expect(parseConfigYaml(text)).toEqual({ notes: "first", "dolt.user": "beads" });
    expect(configYamlNonScalars(text).notes).toEqual(["  dolt.user:historical"]);
    // A `#` line ends the scalar wherever it sits — YAML starts a comment at any `#` a space precedes.
    expect(configYamlComments(text)).toEqual({ "": ["# still the value"] });
  });

  it("sees a continuation line edited or re-indented — the scalar diff sees neither", () => {
    const base = "notes: first\n  second\ndolt.user: beads\n";
    const edited = "notes: first\n  second thoughts\ndolt.user: beads\n";
    const reindented = "notes: first\n      second\ndolt.user: beads\n";
    expect(parseConfigYaml(edited)).toEqual(parseConfigYaml(base));
    expect(parseConfigYaml(reindented)).toEqual(parseConfigYaml(base));
    expect(configYamlNonScalars(base).notes).toEqual(["  second"]);
    expect(configYamlNonScalars(edited).notes).toEqual(["  second thoughts"]);
    expect(configYamlNonScalars(reindented).notes).toEqual(["      second"]);
  });

  /**
   * The continuation ends where YAML says it does: at the first line indented no deeper than the key
   * — and at any line carrying a `: `, which a plain scalar cannot hold at all. Swallowing those
   * would hide real settings from enforcement, the mirror-image failure.
   */
  it("closes a plain scalar at a shallower line, and never swallows a `key: value`", () => {
    expect(parseConfigYaml("dolt:\n  user: beads\n  motd: hello\nexport.auto: false\n")).toEqual({
      "dolt.user": "beads",
      "dolt.motd": "hello",
      "export.auto": "false",
    });
    expect(parseConfigYaml("notes: first\n  dolt.user: beads\n")).toEqual({ notes: "first", "dolt.user": "beads" });
    expect(configYamlNonScalars("notes: first\n  dolt.user: beads\n")).toEqual({});
  });

  it("does not read the blank line that merely follows a plain scalar as part of it", () => {
    expect(configYamlNonScalars("notes: first\n\ndolt.user: beads\n")).toEqual({});
    expect(configYamlNonScalars("notes: first\n\n  second\ndolt.user: beads\n").notes).toEqual(["", "  second"]);
  });

  /** A scalar that closes on its own line is an ordinary setting — escapes and all. */
  it("does not swallow the file when a quoted scalar closes where YAML says it does", () => {
    expect(parseConfigYaml('notes: "one line"\ndolt.user: beads\n')).toEqual({ notes: "one line", "dolt.user": "beads" });
    // A backslash escapes the next character in a double-quoted scalar...
    expect(parseConfigYaml('notes: "he said \\"no\\""\ndolt.user: beads\n')["dolt.user"]).toBe("beads");
    // ...and a doubled apostrophe is a literal one, not the end of a single-quoted scalar.
    expect(parseConfigYaml("notes: 'o''brien'\ndolt.user: beads\n")["dolt.user"]).toBe("beads");
  });

  it("does not read the blank line that merely follows a block as part of it", () => {
    const text = "notes: |\n  body\n\ndolt.user: beads\n";
    expect(configYamlNonScalars(text).notes).toEqual(["notes: |", "  body"]);
    expect(configYamlNonScalars("notes: |\n  body\n\n").notes).toEqual(["notes: |", "  body"]);
  });

  /**
   * `|+`/`>+` KEEP their trailing line breaks — they are part of the value, not the document's
   * whitespace — so two texts differing only in how many blanks follow the body are different
   * values, and a rollback that could not tell them apart would restore the older one (PR #174).
   */
  it("keeps the trailing blanks of a keep-chomped block, and still chomps them otherwise", () => {
    const one = "notes: |+\n  body\n\ndolt.user: beads\n";
    const two = "notes: |+\n  body\n\n\ndolt.user: beads\n";
    expect(configYamlNonScalars(one).notes).toEqual(["notes: |+", "  body", ""]);
    expect(configYamlNonScalars(two).notes).toEqual(["notes: |+", "  body", "", ""]);
    expect(configYamlNonScalars(two).notes).not.toEqual(configYamlNonScalars(one).notes);
    // The indicator can carry an explicit indentation digit on either side, and a comment after it.
    expect(configYamlNonScalars("notes: >+2 # keep\n  body\n\n").notes).toEqual(["notes: >+2 # keep", "  body", "", ""]);
    // `-` and the default still chomp: the blank after the body is the document's, not the value's.
    expect(configYamlNonScalars("notes: |-\n  body\n\ndolt.user: beads\n").notes).toEqual(["notes: |-", "  body"]);
    // Neither reading leaks a body line into the settings map.
    expect(parseConfigYaml(two)).toEqual({ "dolt.user": "beads" });
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
