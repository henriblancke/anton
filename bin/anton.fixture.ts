/**
 * The harness the anton CLI suites share (anton-k7q2): where the launcher lives, throwaway
 * directories that clean themselves up, the stub `bd` those suites put first on PATH, and the
 * sqlite reader they assert a temp `anton.db` with.
 *
 * It exists because the CLI's smoke tests are split along the subcommands they exercise —
 * `anton.test.ts` (dispatch, board-check, doctor), `anton-init.test.ts`, `anton-skills.test.ts`,
 * `anton-migrations.test.ts`, `anton-release.test.ts` — and every one of them needs the same
 * process-boundary seam. A copy per suite is how the copies drift.
 *
 * Test-only, and deliberately vitest-free: nothing here asserts, so each suite composes these into
 * whatever `beforeEach`/`afterEach` shape it already had.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { chmodSync, writeFileSync } from "node:fs";
import type DatabaseCtor from "better-sqlite3";

import { skillDigest } from "../src/lib/claude/skill-stamp.mjs";

export const CLI = join(dirname(fileURLToPath(import.meta.url)), "anton.mjs");
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Spawn the launcher and capture its output — the plain dispatch path, no stubs on PATH. */
export function run(args: string[]) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf8" });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A throwaway directory the caller removes itself. */
export function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * A pool of throwaway directories: `make` creates one and remembers it, `cleanup` removes every one
 * made since the last call — the shape an `afterEach` wants when a case makes several.
 */
export function tempDirs() {
  const made: string[] = [];
  return {
    async make(prefix: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      made.push(dir);
      return dir;
    },
    async cleanup(): Promise<void> {
      for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  };
}

/** PATH with `dir` first, so a stub binary there shadows — or stands in for — the real tool. */
export function pathWith(dir: string): string {
  return `${dir}${delimiter}${process.env.PATH ?? ""}`;
}

/**
 * Overwrite an installed skill copy so it looks like an UNTOUCHED copy of some other release:
 * different content, carrying a `version:` stamp that matches that content (anton-gsyh). This is the
 * state anton is allowed to refresh on its own — as opposed to a hand-edited copy, whose stamp
 * describes a body it no longer has. Two writes because the stamp digests the file minus its own
 * stamp line, so the placeholder pass computes the value the final pass declares.
 */
export function seedOtherRelease(skillDir: string, body: string) {
  const render = (stamp: string) => `---\nname: ${basename(skillDir)}\nversion: ${stamp}\n---\n\n${body}`;
  writeFileSync(join(skillDir, "SKILL.md"), render("placeholder"));
  writeFileSync(join(skillDir, "SKILL.md"), render(skillDigest(skillDir)));
}

/** Initialize a throwaway git repo, optionally with an `origin` the init path can read. */
export function gitInit(dir: string, withOrigin: boolean) {
  spawnSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  if (withOrigin) {
    spawnSync("git", ["-C", dir, "remote", "add", "origin", join(dir, "origin.git")], { stdio: "ignore" });
  }
}

// `bd` isn't installed in CI, so the flows that need it are exercised end-to-end against a STUB `bd`
// placed first on PATH (git stays real, run over a throwaway temp repo). The stub mutates the real
// .beads/ files (config.yaml, dolt-remote state) so config.mjs's file-reading logic — configYamlHas,
// the idempotency skips, the drift patch — sees a realistic workspace. This is the "inject exec" seam
// applied at the process boundary rather than by forking config.mjs's spawnSync.
const FAKE_BD = [
  "#!/usr/bin/env node",
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const a = process.argv.slice(2);",
  'const beads = path.join(process.cwd(), ".beads");',
  'const cfg = path.join(beads, "config.yaml");',
  'const marker = path.join(beads, ".fake-dolt-remotes");',
  'const setlog = path.join(beads, ".fake-config-set-order");',
  // onPath() probes --version/--help; beadsPrereqs parses the version and gates on >= 1.1.0
  // (anton-qwsq), so the stub must report a supported version to reach the init path under test.
  'if (a[0] === "--version" || a[0] === "--help") { console.log("bd version 1.1.0 (fake)"); process.exit(0); }',
  // `bd init` creates the workspace + the (gitignored) local Dolt DB dir — its presence is how the
  // real config path tells an existing workspace from a fresh clone. The team-config keys are
  // intentionally left OUT so the subsequent `bd config set` calls (config.yaml enforcement) run.
  'if (a[0] === "init") {',
  "  fs.mkdirSync(beads, { recursive: true });",
  '  fs.mkdirSync(path.join(beads, "dolt"), { recursive: true });',
  '  const pi = a.indexOf("--prefix");',
  '  const prefix = pi >= 0 ? a[pi + 1] : "bd";',
  '  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, "# beads config (fake)\\nprefix: " + prefix + "\\n");',
  "  process.exit(0);",
  "}",
  // `bd bootstrap` hydrates a fresh clone: it creates the local Dolt DB (which the clone lacked) and
  // records that it ran so the fresh-clone test can assert bootstrap — not init — was the entry point.
  'if (a[0] === "bootstrap") {',
  "  fs.mkdirSync(beads, { recursive: true });",
  '  fs.mkdirSync(path.join(beads, "dolt"), { recursive: true });',
  '  fs.writeFileSync(path.join(beads, ".fake-bootstrapped"), "1");',
  "  process.exit(0);",
  "}",
  // `bd config set` patches an existing uncommented `key:` line in place (drift), else appends it.
  'if (a[0] === "config" && a[1] === "set") {',
  "  const key = a[2], val = a[3];",
  // Record each enforced key in order so tests can assert export.auto is disabled FIRST (anton-1th):
  // a real `bd config set` write regenerates the JSONL under export.auto=true, so ordering matters.
  '  try { fs.appendFileSync(setlog, key + "\\n"); } catch {}',
  '  let text = ""; try { text = fs.readFileSync(cfg, "utf8"); } catch {}',
  '  const lines = text.split("\\n");',
  "  let replaced = false;",
  "  for (let i = 0; i < lines.length; i++) {",
  "    const t = lines[i].trimStart();",
  '    if (!t.startsWith("#") && t.startsWith(key + ":")) { lines[i] = key + ": " + val; replaced = true; break; }',
  "  }",
  '  const out = replaced ? lines.join("\\n") : (text.length && !text.endsWith("\\n") ? text + "\\n" : text) + key + ": " + val + "\\n";',
  "  fs.writeFileSync(cfg, out);",
  "  process.exit(0);",
  "}",
  // Dolt remote state is tracked in a marker file so `remote list` reflects prior `remote add`s.
  'if (a[0] === "dolt" && a[1] === "remote" && a[2] === "list") {',
  '  let r = []; try { r = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}',
  '  if (!r.length) console.log("no remotes configured");',
  '  else for (const x of r) console.log(x.name + "\\t" + x.url);',
  "  process.exit(0);",
  "}",
  'if (a[0] === "dolt" && a[1] === "remote" && a[2] === "add") {',
  '  let r = []; try { r = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}',
  "  r.push({ name: a[3], url: a[4] });",
  "  fs.writeFileSync(marker, JSON.stringify(r));",
  "  process.exit(0);",
  "}",
  'if (a[0] === "dolt" && (a[1] === "pull" || a[1] === "push")) process.exit(0);',
  "process.exit(0);",
].join("\n");

/** A stub `bd` that answers only the version probe — how an unsupported install is staged. */
export function fakeBdVersion(version: string): string {
  return [
    "#!/usr/bin/env node",
    "const a = process.argv.slice(2);",
    `if (a[0] === "--version" || a[0] === "--help") { console.log("bd version ${version} (old)"); process.exit(0); }`,
    "process.exit(0);",
  ].join("\n");
}

/** Drop an executable stub `bd` into `dir` (first on PATH is the caller's job) and return its path. */
export function writeFakeBd(dir: string, script: string = FAKE_BD): string {
  const bd = join(dir, "bd");
  writeFileSync(bd, script);
  chmodSync(bd, 0o755);
  return bd;
}

type Db = InstanceType<typeof DatabaseCtor>;

/**
 * Read a temp `anton.db` through the repo's own better-sqlite3 — the same binary the launcher loads
 * via createRequire, so what the suites inspect is what the CLI just wrote — and close it after.
 */
export function withDb<T>(dbPath: string, read: (db: Db) => T): T {
  const requireFromRepo = createRequire(join(REPO_ROOT, "package.json"));
  const Database = requireFromRepo("better-sqlite3") as typeof DatabaseCtor;
  const db: Db = new Database(dbPath);
  try {
    return read(db);
  } finally {
    db.close();
  }
}
