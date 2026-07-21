import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBdVersion,
  BD_BIN_ENV,
  MIN_BD_VERSION,
  parseBdVersion,
  preflightBd,
  resetBdBinCache,
  resolveBdBin,
} from "./bd-bin";

// A guaranteed-executable path on the CI/dev box, used as a stand-in for a resolved bd where the
// version gate is not exercised (resolveBdBin itself never checks the version).
const REAL_EXE = "/bin/sh";

const tmps: string[] = [];

/** Write an executable fake `bd` whose `--version` prints `line`, and return its absolute path. */
function fakeBd(line: string): string {
  const dir = mkdtempSync(join(tmpdir(), "anton-fakebd-"));
  tmps.push(dir);
  const bin = join(dir, "bd");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${line}"; exit 0; fi\nexit 0\n`);
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  delete process.env[BD_BIN_ENV];
  resetBdBinCache();
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("parseBdVersion", () => {
  it("parses the `bd version X.Y.Z (hash)` line", () => {
    expect(parseBdVersion("bd version 1.1.0 (8e4e59d39)")).toEqual({ major: 1, minor: 1, patch: 0 });
    expect(parseBdVersion("bd version 1.0.4 (ce242a879)")).toEqual({ major: 1, minor: 0, patch: 4 });
  });

  it("returns null when no dotted version is present", () => {
    expect(parseBdVersion("bd (dev build)")).toBeNull();
  });
});

describe("assertBdVersion (anton-qwsq)", () => {
  const okRun = (out: string) => () => ({ status: 0, stdout: out });

  it("passes on the minimum version and newer", () => {
    expect(() => assertBdVersion("bd", okRun("bd version 1.1.0 (x)"))).not.toThrow();
    expect(() => assertBdVersion("bd", okRun("bd version 1.2.5 (x)"))).not.toThrow();
    expect(() => assertBdVersion("bd", okRun("bd version 2.0.0 (x)"))).not.toThrow();
  });

  it("throws with upgrade guidance on an older bd", () => {
    expect(() => assertBdVersion("bd", okRun("bd version 1.0.4 (x)"))).toThrow(
      new RegExp(`1\\.0\\.4[\\s\\S]*requires bd >= ${MIN_BD_VERSION.replace(/\./g, "\\.")}`),
    );
    expect(() => assertBdVersion("bd", okRun("bd version 1.0.4 (x)"))).toThrow(/migration\.md/);
  });

  it("throws when the version can't be read (non-zero exit or unparseable output)", () => {
    expect(() => assertBdVersion("bd", () => ({ status: 127 }))).toThrow(/Could not read the bd version/);
    expect(() => assertBdVersion("bd", () => ({ status: 0, stdout: "garbage" }))).toThrow(/Could not read the bd version/);
    expect(() => assertBdVersion("bd", () => ({ status: 1, error: new Error("ENOENT") }))).toThrow(/Could not read the bd version/);
  });

  it("treats a thrown runner as unreadable rather than crashing", () => {
    expect(() =>
      assertBdVersion("bd", () => {
        throw new Error("spawn failed");
      }),
    ).toThrow(/Could not read the bd version/);
  });
});

describe("resolveBdBin / preflightBd (anton-346, anton-qwsq)", () => {
  it("preflight resolves to the ANTON_BD_BIN override when it points at a bd >= min version", () => {
    const bin = fakeBd(`bd version ${MIN_BD_VERSION} (fake)`);
    process.env[BD_BIN_ENV] = bin;
    expect(preflightBd()).toBe(bin);
  });

  it("preflight fails loud when the resolved bd is too old", () => {
    const bin = fakeBd("bd version 1.0.4 (fake)");
    process.env[BD_BIN_ENV] = bin;
    expect(() => preflightBd()).toThrow(/too old — anton requires bd >= 1\.1\.0/);
  });

  it("caches the resolved path so bd's hot spawn path doesn't re-stat each call", () => {
    process.env[BD_BIN_ENV] = REAL_EXE;
    expect(resolveBdBin()).toBe(REAL_EXE);
    // Change the override WITHOUT clearing the cache — the memoized path must still win.
    process.env[BD_BIN_ENV] = "/nonexistent/bd";
    expect(resolveBdBin()).toBe(REAL_EXE);
    // A forced re-resolve (as the startup preflight does) now sees the bad override and fails loud.
    expect(() => resolveBdBin(true)).toThrow(/ANTON_BD_BIN=\/nonexistent\/bd/);
  });

  it("preflight throws with actionable guidance when bd cannot be resolved", () => {
    process.env[BD_BIN_ENV] = "/nonexistent/bd";
    expect(() => preflightBd()).toThrow(/does not point at an executable bd binary/);
  });
});
