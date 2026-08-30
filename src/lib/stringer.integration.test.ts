/**
 * Integration test for the scan excludes (anton-bqge), against the REAL stringer binary: the unit
 * suite can only prove the glob reaches argv, not that stringer honours it. Self-skips when
 * stringer isn't installed, like the other integration suites.
 *
 * What it pins: a repo holding a Claude Code isolation worktree (`.claude/worktrees/<name>/`) is a
 * second copy of the whole source tree. Before the exclude, the 2026-08-05 scan spent 118 of 211
 * signals reporting each real file as a clone of its shadow under that path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STRINGER_BIN_ENV, scan } from "./stringer";
import type { ScanSignal } from "./scan-severity";

function filePathOf(signal: ScanSignal): string {
  return signal.FilePath ?? "";
}

function stringerAvailable(): boolean {
  try {
    execFileSync(process.env[STRINGER_BIN_ENV] ?? "stringer", ["scan", "--help"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const TODO_SOURCE = [
  "// TODO(anton-bqge): a signal-bearing line the scan is expected to find once",
  "export function realThing(a: number): number {",
  "  return a + 1;",
  "}",
  "",
].join("\n");

describe.runIf(stringerAvailable())("scan against a repo holding an agent worktree", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "anton-stringer-worktree-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "dup.ts"), TODO_SOURCE, "utf8");
    // The nested checkout: byte-identical content, so anything the collectors report for the real
    // file they would report for this one too — the phantom half of every duplication pair.
    mkdirSync(join(repo, ".claude", "worktrees", "x"), { recursive: true });
    cpSync(join(repo, "src"), join(repo, ".claude", "worktrees", "x", "src"), { recursive: true });
    // Collectors read history for authorship; an uncommitted tree is not the case under test.
    execFileSync("git", ["init", "-q", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.email=test@anton", "-c", "user.name=anton test", "commit", "-qm", "init"],
      { cwd: repo, stdio: "ignore" },
    );
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns no signal from inside .claude/, while still finding the real tree's", async () => {
    // Non-delta: what this asserts is which paths the walk covers, not what is new since a baseline.
    const result = await scan({
      repoPath: repo,
      scanFile: join(repo, "out", "scan.json"),
      delta: false,
    });

    const paths = result.signals.map(filePathOf);
    // Not vacuous: the real copy IS reported, so the walk ran and its identical shadow was skipped
    // by the exclude rather than by stringer finding nothing anywhere.
    expect(paths).toContain("src/dup.ts");
    expect(paths.filter((p) => p.startsWith(".claude/"))).toEqual([]);
  });
});

/** 3 MB of binary (NUL-bearing) content — enough for githygiene's large-binary check, byte-identical
 * for both files so the only difference between them is what git says about the path. */
function largeBlob(): Buffer {
  const unit = Buffer.from("\x00\x01binary\r\nline\nmore\x00", "binary");
  const size = 3 * 1024 * 1024;
  return Buffer.concat(Array(Math.ceil(size / unit.length)).fill(unit)).subarray(0, size);
}

/**
 * anton-j2zg, against the real collector: every scan of this repo reported anton's own `anton.db`
 * — gitignored, and unknown to `git ls-files` — as a medium "Large binary file", the top of the
 * severity range that pass produced. The unit suite can only prove anton drops what it was HANDED;
 * this pins that stringer really does emit such a finding, and that anton really does drop it.
 */
describe.runIf(stringerAvailable())("scan of a repo holding an untracked binary", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "anton-stringer-untracked-"));
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.email=test@anton", "-c", "user.name=anton test", ...args],
        { cwd: repo, stdio: "ignore" },
      );
    writeFileSync(join(repo, "phantom.db"), largeBlob());
    writeFileSync(join(repo, "committed.bin"), largeBlob());
    git("init", "-q", ".");
    git("add", "-A");
    git("commit", "-qm", "init");
    // ...and now phantom.db is what anton.db is: present on disk, ignored, out of the index.
    git("rm", "-q", "--cached", "phantom.db");
    writeFileSync(join(repo, ".gitignore"), "phantom.db\n", "utf8");
    git("add", ".gitignore");
    git("commit", "-qm", "ignore the local db");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports the committed binary and nothing at all about the ignored one", async () => {
    const result = await scan({
      repoPath: repo,
      scanFile: join(repo, "out", "scan.json"),
      delta: false,
    });

    // Not vacuous: the byte-identical COMMITTED blob is still a medium githygiene finding, so the
    // drop is git's answer about that one path rather than the collector going quiet.
    expect(result.signals).toContainEqual(
      expect.objectContaining({
        Source: "githygiene",
        FilePath: "committed.bin",
        AntonSeverity: "medium",
      }),
    );
    expect(result.signals.map(filePathOf)).not.toContain("phantom.db");
    // Kind is stringer's to spell, so only the path is pinned — but every drop carries one, which
    // is what keeps a filtered secret distinguishable from a filtered stale binary on the session.
    expect(result.untracked.dropped.map((d) => d.path)).toEqual(["phantom.db"]);
    expect(result.untracked.dropped.every((d) => d.kind && d.severity)).toBe(true);
  });
});

/**
 * anton-yvx9, against the real collector: `coupling` reads the source text, so an `import type` —
 * which the compiler erases — closes a cycle for it exactly as a value import would. The 2026-08-18
 * scan of this repo reported an 11-module cycle whose only link back was src/lib/types.ts, a pure
 * type barrel. The unit suite can only prove anton drops what it was HANDED; this pins that stringer
 * really does report such a cycle, and that anton really does drop that one and keep the real one.
 */
describe.runIf(stringerAvailable())("scan of a repo whose cycle is closed by a type import", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "anton-stringer-coupling-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    const write = (name: string, lines: string[]) =>
      writeFileSync(join(repo, "src", name), `${lines.join("\n")}\n`, "utf8");
    // The phantom: `types` reaches `a` only through a type it re-exports, so nothing links them
    // back at runtime.
    write("types.ts", [`import type { A } from "./a";`, `export type { A };`, `export const STAGES = ["backlog"];`]);
    write("a.ts", [`import { STAGES } from "./types";`, `export type A = number;`, `export const first = () => STAGES[0];`]);
    // The real one: two value imports, and the cycle survives the compiler.
    write("x.ts", [`import { y } from "./y";`, `export const x = () => y();`]);
    write("y.ts", [`import { x } from "./x";`, `export const y = () => x;`]);
    execFileSync("git", ["init", "-q", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.email=test@anton", "-c", "user.name=anton test", "commit", "-qm", "init"],
      { cwd: repo, stdio: "ignore" },
    );
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("keeps the value-import cycle and drops the one only the compiler can see", async () => {
    const result = await scan({
      repoPath: repo,
      scanFile: join(repo, "out", "scan.json"),
      delta: false,
    });

    const cycles = result.signals.filter((s) => s.Kind === "circular-dependency");
    // Not vacuous: the real cycle IS reported, so the drop is anton's filter rather than a collector
    // that found nothing in a four-file repo.
    expect(cycles.map(filePathOf)).toEqual(["src/x"]);
    expect(result.coupling.dropped.map((d) => d.path)).toEqual(["src/a"]);
    expect(result.coupling.dropped[0].reason).toContain("type-only");
  });
});
