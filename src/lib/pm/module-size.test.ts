/**
 * The bound the decomposition was for (anton-qbqk): one job per module under `src/lib/pm`, none over
 * ~400 lines.
 *
 * Pinned as a test because the ceiling is a property of the DIRECTORY, not of any one file — the
 * module that grew past it last time did so a guard at a time, and every individual commit looked
 * reasonable. A number the suite asserts is the only kind that survives the next feature.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Loose enough that no honest module is contorted to satisfy it, tight enough to catch a rewrite. */
const MAX_LINES = 400;
const PM_DIR = join(process.cwd(), "src/lib/pm");

/** Sources only: a test file's length is its cases, which nothing here is trying to cap. */
const modules = (): string[] =>
  readdirSync(PM_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

const lineCount = (file: string): number =>
  readFileSync(join(PM_DIR, file), "utf8").trimEnd().split("\n").length;

describe("the pm modules", () => {
  it.each(modules())("keeps %s under the line ceiling", (file) => {
    expect(lineCount(file)).toBeLessThanOrEqual(MAX_LINES);
  });
});
