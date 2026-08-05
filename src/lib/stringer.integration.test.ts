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

/** stringer's path field, absent from ScanSignal (which types only what severity derivation reads). */
function filePathOf(signal: ScanSignal): string {
  return (signal as { FilePath?: string }).FilePath ?? "";
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
