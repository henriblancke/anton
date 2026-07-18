import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerifyGates } from "./shell";
import type { VerifyGate } from "../projects";

// runVerifyGates is the shared backstop (anton-3oh8) that both execute-epic and review-fix run
// before committing/pushing: a non-zero gate throws, so the commit never happens. These tests
// pin that fail path plus ordering and the no-op-when-empty guarantee.
describe("runVerifyGates (anton-3oh8)", () => {
  let dir: string;
  let logPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "anton-gates-test-"));
    logPath = join(dir, "session.log");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fail = (gate: VerifyGate, code: number | null) => `${gate.label} failed (exit ${code})`;

  it("resolves when every gate exits zero, running them in order", async () => {
    const gates: VerifyGate[] = [
      { label: "tests", command: "echo tests-ran" },
      { label: "lint", command: "echo lint-ran" },
    ];
    await expect(runVerifyGates(gates, dir, undefined, logPath, fail)).resolves.toBeUndefined();
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("[tests] echo tests-ran");
    expect(log).toContain("tests-ran");
    expect(log).toContain("[lint] echo lint-ran");
  });

  it("throws on the first non-zero gate — blocking the commit — and skips later gates", async () => {
    const marker = join(dir, "should-not-exist");
    const gates: VerifyGate[] = [
      { label: "tests", command: "true" },
      { label: "lint", command: "exit 3" },
      { label: "build", command: `touch ${marker}` },
    ];
    await expect(runVerifyGates(gates, dir, undefined, logPath, fail)).rejects.toThrow(
      "lint failed (exit 3)",
    );
    // The build gate after the failing lint gate never ran.
    expect(() => readFileSync(marker)).toThrow();
  });

  it("is a no-op when there are no gates (unchanged behavior)", async () => {
    await expect(runVerifyGates([], dir, undefined, logPath, fail)).resolves.toBeUndefined();
  });
});
