#!/usr/bin/env node
/**
 * Restamp every bundled skill (anton-gsyh): write each `skills/<name>/SKILL.md`'s `version:`
 * frontmatter to the current content digest of its directory.
 *
 * The stamp is what lets an installed copy say "I am pristine, refresh me" instead of only
 * "I differ" — so it must never lag the content it describes. Editing a skill therefore fails
 * `src/lib/claude/skills.test.ts` until this runs. Idempotent; prints only what it changed.
 *
 *   node scripts/stamp-skills.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStamp, skillDigest } from "../src/lib/claude/skill-stamp.mjs";
import { INSTALLED_SKILLS } from "../bin/anton.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Set (or insert, right after `name:`) the frontmatter `version:` line. */
function writeStamp(md, stamp) {
  if (/^version:[^\n]*$/m.test(md)) return md.replace(/^version:[^\n]*$/m, `version: ${stamp}`);
  return md.replace(/^(name:[^\n]*\n)/m, `$1version: ${stamp}\n`);
}

let changed = 0;
for (const name of INSTALLED_SKILLS) {
  const path = join(REPO_ROOT, "skills", name, "SKILL.md");
  const md = readFileSync(path, "utf8");
  // Stamp the digest computed WITHOUT the stamp line, so re-running converges immediately.
  const stamp = skillDigest(join(REPO_ROOT, "skills", name));
  if (readStamp(md) === stamp) continue;
  writeFileSync(path, writeStamp(md, stamp));
  console.log(`stamped ${name} → ${stamp}`);
  changed++;
}
console.log(changed === 0 ? "all skills already stamped." : `${changed} skill(s) restamped.`);
