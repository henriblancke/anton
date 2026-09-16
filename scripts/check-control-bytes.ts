#!/usr/bin/env bun
/**
 * The `control-bytes` gate (anton-flih, extended by anton-33xn): fail when a tracked source file
 * carries a C0 control byte, a bidirectional-override character, or a zero-width character.
 *
 * `.gitattributes` forces `diff` on source globs so a reviewer always gets a patch. That trades
 * away git's own alarm — a NUL byte used to surface as `Binary files differ`, which is how the
 * epic-graph.ts bug was eventually caught (anton-74f8). This is the replacement: found in CI with a
 * file and offset instead of by a reviewer noticing an empty diff. Bidi overrides and zero-width
 * characters are the same consequence by a different mechanism — the "Trojan Source" class, where
 * source renders one way to a reviewer and compiles another — so they fail the same gate.
 *
 *   bun scripts/check-control-bytes.ts             # every tracked source file
 *   bun scripts/check-control-bytes.ts src bin     # only under these pathspecs
 *
 * Read-only. Exits 1 with a `file:line:col:` report when anything is found.
 *
 * This is only the CLI shell: enumeration and reporting. The rules — which paths are in scope and
 * which bytes/codepoints are forbidden — live in `@/lib/control-bytes` and `@/lib/invisible-unicode`,
 * next to the tests that pin the former to `.gitattributes` and the latter's allowlist.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { findControlBytes, formatHit as formatControlByteHit, isSourcePath } from "@/lib/control-bytes";
import { findInvisibleUnicode, formatHit as formatInvisibleUnicodeHit } from "@/lib/invisible-unicode";

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
  const bytes = readFileSync(file);
  for (const hit of findControlBytes(bytes)) failures.push(formatControlByteHit(file, hit));
  for (const hit of findInvisibleUnicode(bytes.toString("utf8"))) failures.push(formatInvisibleUnicodeHit(file, hit));
}

if (failures.length > 0) {
  console.error(`Control bytes / invisible Unicode in tracked source (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nThese are invisible in a patch — either because git gives up and prints `Binary files\n" +
      "differ`, or because a bidi override / zero-width character renders as nothing. Remove the\n" +
      "offending byte or codepoint — do not widen the rule. See\n" +
      ".product/decisions/2026-09-05-source-diffability.md and\n" +
      ".product/decisions/2026-09-15-invisible-unicode-gate.md.",
  );
  process.exit(1);
}

console.log(`control-bytes: ${files.length} tracked source files clean`);
