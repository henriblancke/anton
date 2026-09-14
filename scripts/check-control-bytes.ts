#!/usr/bin/env bun
/**
 * The `control-bytes` gate (anton-flih): fail when a tracked source file carries a C0 control byte.
 *
 * `.gitattributes` forces `diff` on source globs so a reviewer always gets a patch. That trades
 * away git's own alarm — a NUL byte used to surface as `Binary files differ`, which is how the
 * epic-graph.ts bug was eventually caught (anton-74f8). This is the replacement: same fault, found
 * in CI with a file and byte offset instead of by a reviewer noticing an empty diff.
 *
 *   bun scripts/check-control-bytes.ts             # every tracked source file
 *   bun scripts/check-control-bytes.ts src bin     # only under these pathspecs
 *
 * Read-only. Exits 1 with a `file:line:col:` report when anything is found.
 *
 * This is only the CLI shell: enumeration and reporting. The rule — which paths are in scope and
 * which bytes are forbidden — lives in `@/lib/control-bytes`, next to the test that pins it to
 * `.gitattributes`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { findControlBytes, formatHit, isSourcePath } from "@/lib/control-bytes";

/** Tracked source paths under `pathspecs` (the whole repo when empty), as git reports them. */
function trackedSourceFiles(pathspecs: string[]): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed.split("\0").filter(Boolean).filter(isSourcePath);
}

const files = trackedSourceFiles(process.argv.slice(2));
const failures: string[] = [];

for (const file of files) {
  // Listed in the index but absent from the working tree — a staged delete. Nothing to scan.
  if (!existsSync(file)) continue;
  for (const hit of findControlBytes(readFileSync(file))) failures.push(formatHit(file, hit));
}

if (failures.length > 0) {
  console.error(`Control bytes in tracked source (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nThese are invisible in a patch and were historically caught only by git giving up and\n" +
      "printing `Binary files differ`. .gitattributes now keeps these globs diffable, so this gate\n" +
      "is the alarm. Remove the bytes — do not widen the rule. See\n" +
      ".product/decisions/2026-09-05-source-diffability.md.",
  );
  process.exit(1);
}

console.log(`control-bytes: ${files.length} tracked source files clean`);
