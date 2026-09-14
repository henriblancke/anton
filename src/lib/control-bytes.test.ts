/**
 * The `control-bytes` gate (anton-flih) — the alarm that replaces `Binary files differ` once
 * `.gitattributes` forces source globs diffable.
 *
 * Three things are worth asserting, and only one of them is the scanner:
 *   • the rule itself: which bytes offend, and where it says they are;
 *   • the SCOPE stays pinned to `.gitattributes` — a glob made diffable without a matching scan is
 *     a file whose only alarm was deleted, which is the exact regression this ticket exists to
 *     prevent;
 *   • the real CLI, over a real git repo holding a real NUL byte — because the gate's whole claim
 *     is about what git reports, and a mocked `git ls-files` proves nothing about that.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findControlBytes, formatHit, isSourcePath, MAX_HITS_PER_FILE, SOURCE_EXTENSIONS } from "./control-bytes";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("findControlBytes", () => {
  it("passes ordinary source — tabs, LFs and CRLFs are not control bytes", () => {
    const clean = Buffer.from("export const x = 1;\n\tif (x) {\r\n\t\treturn x;\r\n\t}\n", "utf8");
    expect(findControlBytes(clean)).toEqual([]);
  });

  it("passes non-ASCII text — only C0 bytes offend, not high bytes", () => {
    expect(findControlBytes(Buffer.from("// ✅ é — 日本語\n", "utf8"))).toEqual([]);
  });

  it("locates a NUL byte by line and byte column", () => {
    const content = Buffer.from("const a = 1;\nconst b = 2;\n", "utf8");
    const withNul = Buffer.concat([content.subarray(0, 19), Buffer.from([0x00]), content.subarray(19)]);
    expect(findControlBytes(withNul)).toEqual([{ byte: 0x00, line: 2, column: 7 }]);
  });

  it("flags NUL's friends — ESC, DEL, VT, FF, BS — and clears TAB/LF/CR", () => {
    for (const byte of [0x00, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f]) {
      expect(findControlBytes(Buffer.from([0x61, byte, 0x62]))).toEqual([{ byte, line: 1, column: 2 }]);
    }
    for (const byte of [0x09, 0x0a, 0x0d]) {
      expect(findControlBytes(Buffer.from([0x61, byte, 0x62]))).toEqual([]);
    }
  });

  it("caps hits per file so a misnamed blob cannot bury the report", () => {
    const blob = Buffer.alloc(MAX_HITS_PER_FILE * 10, 0x00);
    expect(findControlBytes(blob)).toHaveLength(MAX_HITS_PER_FILE);
  });

  it("formats a hit as file:line:col so editors and CI can parse it", () => {
    expect(formatHit("src/lib/epic-graph.ts", { byte: 0x00, line: 12, column: 3 })).toBe(
      "src/lib/epic-graph.ts:12:3: NUL (0x00)",
    );
    expect(formatHit("a.ts", { byte: 0x1f, line: 1, column: 1 })).toBe("a.ts:1:1: 0x1f");
  });
});

describe("isSourcePath", () => {
  it("matches the scanned extensions, case-insensitively", () => {
    expect(isSourcePath("src/lib/control-bytes.ts")).toBe(true);
    expect(isSourcePath("src/app/page.TSX")).toBe(true);
    expect(isSourcePath("drizzle/0001_init.sql")).toBe(true);
  });

  it("skips binaries, lockfiles and extensionless dotfiles", () => {
    for (const path of ["public/logo.png", "bun.lock", ".gitignore", "Makefile", "src/lib/notes"]) {
      expect(isSourcePath(path)).toBe(false);
    }
  });
});

describe(".gitattributes parity", () => {
  // The load-bearing invariant. Forcing `diff` on a glob retires git's `Binary files differ` alarm
  // for it; this gate is the replacement. A glob in one list and not the other is a hole.
  it("scans exactly the globs .gitattributes forces diffable", () => {
    const attributes = readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8");
    const diffable = attributes
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const [pattern, ...attrs] = line.split(/\s+/);
        expect(attrs, `${pattern} should be forced diffable`).toContain("diff");
        expect(attrs, "`text` drags in CRLF normalisation — see the decision record").not.toContain("text");
        expect(pattern).toMatch(/^\*\.[a-z0-9]+$/);
        return pattern.slice(2);
      });

    expect(diffable.sort()).toEqual([...SOURCE_EXTENSIONS].sort());
  });
});

/** `bun` runs the gate in CI (setup-bun) and locally; skip rather than fail where it is absent. */
const hasBun = ((): boolean => {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBun)("check-control-bytes CLI", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anton-control-bytes-"));
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"], { stdio: "ignore" });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Write `content` into the fixture repo and stage it — the gate reads git's index, not the disk. */
  const track = (name: string, content: string | Uint8Array) => {
    writeFileSync(join(dir, name), content);
    execFileSync("git", ["-C", dir, "add", name], { stdio: "ignore" });
  };
  const run = () =>
    spawnSync("bun", [join(REPO_ROOT, "scripts", "check-control-bytes.ts")], { cwd: dir, encoding: "utf8" });

  it("passes a clean tree", () => {
    track("clean.ts", "export const answer = 42;\n");

    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 tracked source files clean");
  });

  it("fails a tree carrying a NUL byte, and names the file and offset", () => {
    // The fixture the ticket's `## Verify` names — a source file with a literal NUL, which is what
    // made epic-graph.ts binary. Written as bytes: committing such a file to THIS repo would
    // (correctly) trip the gate on the repo itself.
    track("clean.ts", "export const answer = 42;\n");
    track("tainted.ts", Buffer.from("export const bad =\0 1;\n", "utf8"));

    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tainted.ts:1:19: NUL (0x00)");
    expect(result.stderr).not.toContain("clean.ts");
  });

  it("ignores untracked files and non-source extensions", () => {
    writeFileSync(join(dir, "untracked.ts"), Buffer.from("const x =\0 1;\n", "utf8"));
    track("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));

    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
