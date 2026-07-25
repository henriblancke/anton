/**
 * Unit coverage for the integration harness's temp-dir removal. The behavior under test is the one
 * that reddened a fully-passing CI run: a fire-and-forget `bd dolt` push still writing inside the
 * temp repo when afterAll removes it. Cleanup must retry, and — when the race outlasts the retries —
 * warn and continue instead of failing a suite whose assertions all passed. A non-race error must
 * still surface.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./integration";

const errno = (code: string) => Object.assign(new Error(`${code}: busy`), { code });

describe("removeTempRepo", () => {
  afterEach(() => vi.restoreAllMocks());

  it("removes the dir and its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "anton-rm-test-"));
    writeFileSync(join(dir, "f.txt"), "x");

    removeTempRepo(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it("asks for retries so a still-running bd subprocess is outlived, not raced", () => {
    const rm = vi.fn();

    removeTempRepo("/tmp/anton-rm-test-none", rm as never);

    expect(rm).toHaveBeenCalledWith(
      "/tmp/anton-rm-test-none",
      expect.objectContaining({ recursive: true, force: true, maxRetries: 20, retryDelay: 150 }),
    );
  });

  it("warns instead of throwing when the dir is still busy after the retries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rm = vi.fn(() => {
      throw errno("ENOTEMPTY");
    });

    expect(() => removeTempRepo("/tmp/anton-rm-test-busy", rm as never)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/tmp/anton-rm-test-busy"));
  });

  it("rethrows an error that isn't the subprocess race", () => {
    const rm = vi.fn(() => {
      throw errno("EACCES");
    });

    expect(() => removeTempRepo("/tmp/anton-rm-test-denied", rm as never)).toThrow(/EACCES/);
  });
});
