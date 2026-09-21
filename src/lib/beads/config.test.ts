/**
 * configYamlHas must accept BOTH on-disk encodings bd has shipped for the team-config keys: the flat
 * dotted lines bd 1.0.4 appends (`export.auto: false`) and the nested maps bd 1.1.0 writes for
 * `export.*`/`dolt.*` (`export:` / `    auto: false`). If it only understood the flat form, `anton
 * init` would read the nested form as unset and re-set every key on every run (anton-qhoz).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
 * The setup half of anton-8mnr: the bead formula must LAND in a fresh `.beads/`, and a project-local
 * copy that DIFFERS from the shipped asset must be replaced across every `anton setup` /
 * `anton init` / addProject re-run. The original no-clobber-on-existence rule is what stranded
 * `step:describe` in every registered project; see `ensureFormula`.
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

  it("leaves a byte-identical copy alone, and says so", () => {
    const dir = beadsDir();
    expect(ensureBeadFormula(dir).status).toBe("installed");
    // The common case: a second run over an up-to-date project writes nothing and reports nothing.
    expect(ensureBeadFormula(dir).status).toBe("already");
    expect(existsSync(`${dest(dir)}.bak`)).toBe(false);
  });

  it("replaces a project-local copy that differs, backing up what was there", () => {
    const dir = beadsDir();
    ensureBeadFormula(dir);
    writeFileSync(dest(dir), '{"formula":"anton-bead","mine":true}');

    const result = ensureBeadFormula(dir);
    expect(result.status).toBe("replaced");
    expect(result.detail).toContain(`${BEAD_FORMULA_FILENAME}.bak`);
    // The shipped asset won…
    expect(JSON.parse(readFileSync(dest(dir), "utf8")).mine).toBeUndefined();
    // …and the previous contents are recoverable without reaching for git.
    expect(JSON.parse(readFileSync(`${dest(dir)}.bak`, "utf8")).mine).toBe(true);
  });

  it("reports a missing asset instead of throwing", () => {
    expect(ensureBeadFormula(beadsDir(), join(tmpdir(), "no-such-formula.json")).status).toBe(
      "missing-asset",
    );
  });

  /**
   * A behavior change from the no-clobber rule, pinned here rather than left incidental (PR #307
   * review): the old code returned "already" for this combination because existence alone decided
   * the outcome and `src` was never opened. Comparing content has to read `src`, so a shipped asset
   * that is absent or unreadable is now a warning — and the project's own file, which nothing was
   * ever compared against, is left exactly as it was.
   */
  it("warns rather than claiming 'already' when the shipped asset is gone but a local copy exists", () => {
    const dir = beadsDir();
    ensureBeadFormula(dir);
    writeFileSync(dest(dir), '{"formula":"anton-bead","mine":true}');

    expect(ensureBeadFormula(dir, join(tmpdir(), "no-such-formula.json")).status).toBe("missing-asset");
    // Untouched: a warning about anton's install is never a reason to rewrite the project's file.
    expect(JSON.parse(readFileSync(dest(dir), "utf8")).mine).toBe(true);
  });

  it("carries the reason when the shipped asset exists but cannot be read", () => {
    const dir = beadsDir();
    // A directory where a file is expected: present to existsSync, an EISDIR to readFileSync.
    const unreadable = join(dir, "..", "unreadable-asset");
    mkdirSync(unreadable, { recursive: true });

    const result = ensureBeadFormula(dir, unreadable);
    expect(result.status).toBe("missing-asset");
    // Without this the operator is told the asset is "missing from this install" while it is right
    // there — the detail is the only thing separating an absent asset from an unreadable one.
    expect(result.detail).toBeTruthy();
  });

  /**
   * The hazard that arrives WITH the replace behavior (PR #307 review, P1). `copyFileSync` follows
   * symlinks — it opens the link's target and writes there — so a symlinked destination would have
   * this installer write anton's asset to any path the link names, outside the repo entirely. The
   * path reaches here from input: `POST /api/projects` takes a repository path and runs the
   * installer over it. Under the old rule an existing symlink was never written to at all.
   */
  it("refuses to write through a symlinked destination, leaving the link's target intact", () => {
    const dir = beadsDir();
    const outside = join(dir, "..", "outside-the-repo.txt");
    writeFileSync(outside, "NOT ANTON'S TO OVERWRITE");
    mkdirSync(join(dir, "formulas"), { recursive: true });
    symlinkSync(outside, dest(dir));

    const result = ensureBeadFormula(dir);
    expect(result.status).toBe("unsafe-dest");
    expect(result.detail).toContain("SYMLINK");
    // The file the link pointed at is untouched, and the link itself is still a link.
    expect(readFileSync(outside, "utf8")).toBe("NOT ANTON'S TO OVERWRITE");
    expect(lstatSync(dest(dir)).isSymbolicLink()).toBe(true);
  });

  it("refuses a destination that is a directory rather than a formula", () => {
    const dir = beadsDir();
    mkdirSync(dest(dir), { recursive: true });
    expect(ensureBeadFormula(dir).status).toBe("unsafe-dest");
  });

  /**
   * The same escape one level UP (PR #307 review, second P1). Checking only the final component is
   * not enough: `lstat` on it resolves every ancestor, so a symlinked `formulas/` reports its
   * target's contents as ordinary files and the check passes — and `mkdirSync(recursive)` is
   * satisfied by a symlink to a directory, creating nothing. The copy then lands outside the repo.
   */
  it("refuses a symlinked formulas/ directory, so the copy cannot land outside the repo", () => {
    const dir = beadsDir();
    const outside = join(dir, "..", "outside-dir");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, BEAD_FORMULA_FILENAME), "NOT ANTON'S TO OVERWRITE");
    symlinkSync(outside, join(dir, "formulas"));

    const result = ensureBeadFormula(dir);
    expect(result.status).toBe("unsafe-dest");
    expect(result.detail).toContain("SYMLINK");
    expect(readFileSync(join(outside, BEAD_FORMULA_FILENAME), "utf8")).toBe("NOT ANTON'S TO OVERWRITE");
  });

  /**
   * The case no `lstat` can catch (PR #307 review, P1): a hard link IS an ordinary regular file by
   * every check `unsafeDestDetail` makes. `copyFileSync` would open the destination and truncate
   * it, writing through the shared inode and clobbering the other name too. Writing a temp file and
   * renaming replaces the directory entry instead, so the link keeps the old inode and its bytes.
   */
  it("replaces a hard-linked destination without touching the file sharing its inode", () => {
    const dir = beadsDir();
    const outside = join(dir, "..", "hardlink-target.json");
    writeFileSync(outside, "NOT ANTON'S TO OVERWRITE");
    mkdirSync(join(dir, "formulas"), { recursive: true });
    linkSync(outside, dest(dir)); // same inode, two names

    const result = ensureBeadFormula(dir);
    expect(result.status).toBe("replaced");
    // The formula landed…
    expect(JSON.parse(readFileSync(dest(dir), "utf8")).formula).toBe("anton-bead");
    // …and the other name still holds what it always did.
    expect(readFileSync(outside, "utf8")).toBe("NOT ANTON'S TO OVERWRITE");
  });

  /**
   * PR #307 review, P1. The backup must hold the bytes the COMPARISON saw, not a fresh read of the
   * destination: two installers on one repo (concurrent `anton init`s) both compare the customized
   * file, the first replaces it, and a second that re-read `dest` at backup time would save the
   * shipped formula it just found — leaving the operator's customization in neither the file nor
   * the `.bak`.
   *
   * This pins the INVARIANT that makes the race harmless (the backup holds what was compared), not
   * the interleaving itself: `ensureFormula` is synchronous with no seam between its compare and
   * its backup, so a true concurrent run cannot be staged from here. What the invariant rules out
   * is the only way the race could lose data.
   */
  it("backs up the bytes it compared, so a concurrent replacement cannot erase them", () => {
    const dir = beadsDir();
    ensureBeadFormula(dir);
    const shipped = readFileSync(dest(dir), "utf8");
    const customized = '{"formula":"anton-bead","MY-CUSTOMIZATION":true}';
    writeFileSync(dest(dir), customized);

    const result = ensureBeadFormula(dir);
    expect(result.status).toBe("replaced");
    // The backup holds the customization that was compared — never the shipped bytes just written.
    expect(readFileSync(`${dest(dir)}.bak`, "utf8")).toBe(customized);
    expect(readFileSync(dest(dir), "utf8")).toBe(shipped);
  });

  /**
   * An UNREADABLE original is refused, not replaced (PR #307 review, P1). It reaches the
   * replacement by being treated as "differing" — right for deciding this is not a no-op — but
   * "anton could not read it" says nothing about whether it mattered. A mode-000 formula in a
   * writable directory is still somebody's file, and replacing it destroys bytes no backup holds
   * and git may never have seen. An earlier version replaced it and reported no backup was made,
   * which announced the loss instead of preventing it.
   */
  it("refuses to replace a formula it cannot read, rather than destroying contents nothing has a copy of", () => {
    const dir = beadsDir();
    mkdirSync(join(dir, "formulas"), { recursive: true });
    writeFileSync(dest(dir), '{"formula":"anton-bead","IRREPLACEABLE":true}');
    chmodSync(dest(dir), 0o000);

    // Root reads a mode-000 file regardless, so the precondition only holds unprivileged.
    let readable: boolean;
    try {
      readFileSync(dest(dir));
      readable = true;
    } catch {
      readable = false;
    }

    try {
      const result = ensureBeadFormula(dir);
      if (readable) {
        // Running as root: the file IS readable, so the normal replace-with-backup path applies.
        expect(result.status).toBe("replaced");
        return;
      }
      expect(result.status).toBe("failed");
      expect(result.detail).toContain("could not be read");
      // The bytes are still there, and no `.bak` pretends otherwise.
      chmodSync(dest(dir), 0o600);
      expect(readFileSync(dest(dir), "utf8")).toContain("IRREPLACEABLE");
      expect(existsSync(`${dest(dir)}.bak`)).toBe(false);
    } finally {
      chmodSync(dest(dir), 0o600); // so afterEach can clean up
    }
  });

  it("leaves no temp file behind after a successful install", () => {
    const dir = beadsDir();
    ensureBeadFormula(dir);
    const leftovers = readdirSync(join(dir, "formulas")).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("refuses a symlinked .beads workspace directory for the same reason", () => {
    const parent = mkdtempSync(join(tmpdir(), "anton-formula-link-"));
    dirs.push(parent);
    const real = join(parent, "real-beads");
    mkdirSync(join(real, "formulas"), { recursive: true });
    const linked = join(parent, ".beads");
    symlinkSync(real, linked);

    expect(ensureBeadFormula(linked).status).toBe("unsafe-dest");
    expect(existsSync(join(real, "formulas", BEAD_FORMULA_FILENAME))).toBe(false);
  });

  /**
   * The backup is a PRECONDITION of the replacement (PR #307 review, P1). An earlier version wrote
   * the formula anyway and reported "NOT backed up", reasoning that git holds the durable copy —
   * false for exactly the case the backup protects, uncommitted tuning. Announcing an irreversible
   * loss is not a substitute for preventing one, so an unwritable `.bak` abandons the replacement.
   */
  it("leaves a differing file alone when its .bak path is unsafe, rather than replacing it unbacked", () => {
    const dir = beadsDir();
    ensureBeadFormula(dir);
    writeFileSync(dest(dir), '{"formula":"anton-bead","mine":true}');
    const outside = join(dir, "..", "bak-target.txt");
    writeFileSync(outside, "ALSO NOT ANTON'S");
    symlinkSync(outside, `${dest(dir)}.bak`);

    const result = ensureBeadFormula(dir);
    expect(result.status).toBe("unsafe-dest");
    expect(result.detail).toContain("uncommitted");
    // The project's own file survives — that is the whole point.
    expect(JSON.parse(readFileSync(dest(dir), "utf8")).mine).toBe(true);
    // And the symlink's target was never written through.
    expect(readFileSync(outside, "utf8")).toBe("ALSO NOT ANTON'S");
  });

  it("refuses to fabricate a .beads workspace where none exists", () => {
    // A release-bundle install has no workspace at the package root. Creating `.beads/formulas/`
    // there would make every "is this a beads repo?" probe answer yes — configureBeadsDoltSync
    // reads exactly that, then fails `anton setup` for having no git origin in an extracted runtime.
    const dir = absentBeadsDir();
    expect(ensureBeadFormula(dir).status).toBe("no-workspace");
    expect(existsSync(dir)).toBe(false);
  });

  it("reports a non-directory formulas/ path instead of aborting the setup around it", () => {
    // An unusable `.beads/formulas` (here: a plain file where the directory belongs) must not take
    // down project registration — the formula is one best-effort step among a dozen and anton's
    // renderer falls back to its packaged copy. A throw here aborted `anton setup` / addProject
    // outright. It reports "unsafe-dest" rather than the "failed" it used to: the directory check
    // now names the problem up front instead of letting `mkdirSync` throw an ENOTDIR at it.
    const dir = beadsDir();
    writeFileSync(join(dir, "formulas"), "not a directory");

    const result = ensureBeadFormula(dir);
    expect(result.status).toBe("unsafe-dest");
    expect(result.detail).toContain("not a directory");
  });

  it("reports a genuine write failure rather than throwing", () => {
    // The other half of the above, still reachable: `formulas/` passes every safety check but the
    // write itself fails — a read-only checkout, no permission, transient I/O.
    //
    // NOT driven by directory permissions (PR #307 review): mode 0500 does not stop UID 0, so under
    // root — the norm in CI containers — the write would succeed and this would assert the wrong
    // thing. A directory sitting where the TEMP FILE must be created fails for everyone: the write
    // is `writeFileSync(<dest>.tmp-<pid>-<ts>, ..., {flag:"wx"})`, so a directory at that exact path
    // is an EISDIR no privilege level can write through.
    const dir = beadsDir();
    const formulas = join(dir, "formulas");
    mkdirSync(formulas, { recursive: true });
    chmodSync(formulas, 0o500); // r-x: no new file may be created here

    // Mode 0500 does NOT stop UID 0, which is the norm in CI containers, so the permission is
    // probed rather than assumed. Where it is not enforced the precondition simply does not hold,
    // and the test asserts the install succeeds instead of asserting a failure that cannot happen —
    // an honest skip of the branch beats a green run on an unexercised path.
    let enforced: boolean;
    try {
      writeFileSync(join(formulas, ".probe"), "x");
      rmSync(join(formulas, ".probe"), { force: true });
      enforced = false;
    } catch {
      enforced = true;
    }

    try {
      const result = ensureBeadFormula(dir);
      if (!enforced) {
        expect(result.status).toBe("installed");
        return;
      }
      expect(result.status).toBe("failed");
      expect(result.detail).toBeTruthy();
    } finally {
      chmodSync(formulas, 0o700); // so afterEach can clean up
    }
  });

  it("resolves the bundled asset from the package, not the cwd", () => {
    expect(existsSync(bundledBeadFormulaPath())).toBe(true);
  });
});

/**
 * The setup half of anton-hrql: the RUN pipeline installs on the same terms as the bead skeleton
 * above — a fresh project gets anton's default, and a stale or edited copy is replaced. Both assets
 * share one installer, so only the run-formula-specific behavior is asserted here: this is the asset
 * a newly shipped step has to reach, which is the whole reason the rule changed.
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

  it("replaces a pipeline that differs from the shipped one", () => {
    const dir = beadsDir();
    ensureRunFormula(dir);
    writeFileSync(dest(dir), 'formula = "anton-run"\n# ours\n');

    expect(ensureRunFormula(dir).status).toBe("replaced");
    expect(readFileSync(dest(dir), "utf8")).not.toContain("# ours");
    expect(readFileSync(`${dest(dir)}.bak`, "utf8")).toContain("# ours");
  });

  /**
   * The regression this whole change exists for. A project whose pipeline is a verbatim copy of an
   * OLDER shipped template — not tuned, just stale — is exactly what `existsSync` could not tell
   * apart from a deliberate edit, so a step anton had started shipping reached no registered
   * project and every re-run reported "already present". Pinned with `step:describe` because that
   * is the step it actually happened to (anton-gzyjd).
   */
  it("carries a newly shipped step into a project holding a stale default", () => {
    const dir = beadsDir();
    // The step block itself, not the word: the file's header comment lists every step anton knows,
    // so a bare "step:describe" search matches prose in a formula that does not run the step.
    const stepBlock = /\n\[\[steps\]\]\nid = "describe"[\s\S]*?labels = \["step:describe"\]\n/;
    const shipped = readFileSync(bundledRunFormulaPath(), "utf8");
    expect(shipped).toMatch(stepBlock);
    // The pre-describe template: same file, that one step cut out of it.
    mkdirSync(join(dir, "formulas"), { recursive: true });
    writeFileSync(dest(dir), shipped.replace(stepBlock, "\n"));
    expect(readFileSync(dest(dir), "utf8")).not.toMatch(stepBlock);

    expect(ensureRunFormula(dir).status).toBe("replaced");
    expect(readFileSync(dest(dir), "utf8")).toMatch(stepBlock);
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
