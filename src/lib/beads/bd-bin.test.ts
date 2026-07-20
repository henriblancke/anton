import { afterEach, describe, expect, it } from "vitest";
import { BD_BIN_ENV, preflightBd, resetBdBinCache, resolveBdBin } from "./bd-bin";

// A guaranteed-executable path on the CI/dev box, used as a stand-in for a resolved bd.
const REAL_EXE = "/bin/sh";

afterEach(() => {
  delete process.env[BD_BIN_ENV];
  resetBdBinCache();
});

describe("resolveBdBin / preflightBd (anton-346)", () => {
  it("preflight resolves to the ANTON_BD_BIN override when it points at an executable", () => {
    process.env[BD_BIN_ENV] = REAL_EXE;
    expect(preflightBd()).toBe(REAL_EXE);
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
