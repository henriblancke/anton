import { describe, expect, it } from "vitest";
import { findOnPath, resolveBin, type BinSpec } from "./bin";

// A fake filesystem: only the listed absolute paths are "executable".
const execIn = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

const BD: BinSpec = { name: "bd", envVar: "ANTON_BD_BIN", install: "https://example/beads" };

describe("findOnPath", () => {
  it("returns the first PATH dir that holds an executable, earlier dirs winning", () => {
    const isExec = execIn("/a/bd", "/b/bd");
    expect(findOnPath("bd", "/a:/b", [], isExec)).toBe("/a/bd");
    expect(findOnPath("bd", "/z:/b", [], isExec)).toBe("/b/bd");
  });

  it("falls through to extraDirs when PATH omits the binary (the daemon-PATH case)", () => {
    // Minimal PATH like a launchd/systemd server; bd lives in ~/.local/bin only.
    const isExec = execIn("/home/u/.local/bin/bd");
    expect(findOnPath("bd", "/usr/bin:/bin", ["/home/u/.local/bin"], isExec)).toBe(
      "/home/u/.local/bin/bd",
    );
  });

  it("returns undefined when the binary is nowhere and skips non-executable candidates", () => {
    expect(findOnPath("bd", "/usr/bin:/bin", ["/opt"], execIn("/elsewhere/bd"))).toBeUndefined();
  });
});

describe("resolveBin", () => {
  const base = { env: { PATH: "/usr/bin:/bin" }, extraDirs: [] as string[] };

  it("resolves via PATH when no override is set", () => {
    expect(resolveBin(BD, { ...base, isExec: execIn("/usr/bin/bd") })).toBe("/usr/bin/bd");
  });

  it("resolves bd from extraDirs when PATH can't reach it (spawn bd ENOENT regression)", () => {
    const resolved = resolveBin(BD, {
      env: { PATH: "/usr/bin:/bin" },
      extraDirs: ["/home/u/.local/bin"],
      isExec: execIn("/home/u/.local/bin/bd"),
    });
    expect(resolved).toBe("/home/u/.local/bin/bd");
  });

  it("honors an absolute ANTON_BD_BIN override", () => {
    const env = { PATH: "/usr/bin", ANTON_BD_BIN: "/opt/bd" };
    expect(resolveBin(BD, { env, extraDirs: [], isExec: execIn("/opt/bd") })).toBe("/opt/bd");
  });

  it("honors a bare-name override, resolving it on the augmented path", () => {
    const env = { PATH: "/usr/bin", ANTON_BD_BIN: "bd-next" };
    const opts = { env, extraDirs: ["/home/u/bin"], isExec: execIn("/home/u/bin/bd-next") };
    expect(resolveBin(BD, opts)).toBe("/home/u/bin/bd-next");
  });

  it("throws (never silently falls back to PATH) when the override isn't executable", () => {
    const env = { PATH: "/usr/bin", ANTON_BD_BIN: "/opt/stale-bd" };
    // A real bd exists on PATH, but the pinned override must win-or-fail, not fall back.
    expect(() => resolveBin(BD, { env, extraDirs: [], isExec: execIn("/usr/bin/bd") })).toThrow(
      /ANTON_BD_BIN=\/opt\/stale-bd/,
    );
  });

  it("throws an actionable error naming the binary, env var, and install hint when unresolved", () => {
    expect(() => resolveBin(BD, { ...base, isExec: execIn() })).toThrow(
      /Could not resolve the 'bd' binary[\s\S]*example\/beads[\s\S]*ANTON_BD_BIN/,
    );
  });
});
