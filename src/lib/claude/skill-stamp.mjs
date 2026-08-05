/**
 * Skill version stamps (anton-gsyh) — how anton tells "an older release's copy" apart from "the
 * user's own edit" in an installed `.claude/skills/<name>/`.
 *
 * The prompt IS the behavior of every producer, so a skill copy frozen at an older release keeps
 * shaping work against rules this release already replaced (found 2026-07-30: a pre-tier
 * `~/.claude/skills/bd` was still producing epics-as-work-buckets). Byte comparison alone can only
 * say "differs" — never whether the difference is anton's to overwrite. So every shipped SKILL.md
 * carries a `version:` stamp that IS the content digest of its whole skill directory, which makes
 * an installed copy self-describing:
 *
 *   declared stamp == digest of the copy's own files → pristine. Whichever release wrote it, no
 *                                                      local work is in it → safe to refresh.
 *   declared stamp != digest, or no stamp at all     → hand-edited (or pre-stamp) → never
 *                                                      overwritten without `--force-skills`.
 *
 * The stamp is DERIVED, never hand-maintained: skills.test.ts recomputes it for every bundled
 * skill, so editing a skill without restamping fails the suite — the stamp cannot itself go stale.
 *
 * Pure Node, no deps: bin/anton.mjs (the launcher, which runs before any build) imports this.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** Digest length. 12 hex chars (48 bits) — collision-proof for a handful of files, readable in a warning. */
const STAMP_LENGTH = 12;

/** Editor/OS droppings that must not decide whether a skill copy counts as pristine. */
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

/** Recursively list every file under `dir` as paths relative to `dir` (files only, sorted). */
export function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else if (entry.isFile()) out.push(abs.slice(base.length + 1));
  }
  return out.sort();
}

/** Byte-equal? The drift test — an installed asset differing from the bundled one is out of date. */
export function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** The `---`-delimited frontmatter block's inner bounds, or null when there is none. */
function frontmatterBounds(md) {
  if (!md.startsWith("---\n")) return null;
  const end = md.indexOf("\n---", 4);
  return end < 0 ? null : { start: 4, end: end + 1 };
}

/**
 * The declared stamp of a SKILL.md's text, or null when unstamped. The key is `version:` because
 * that is standard skill frontmatter — every other tool already ignores it.
 */
export function readStamp(md) {
  const bounds = frontmatterBounds(md);
  if (!bounds) return null;
  const m = md.slice(bounds.start, bounds.end).match(/^version:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

/** A skill directory's declared stamp (from its SKILL.md), or null when absent/unstamped. */
export function readSkillStamp(dir) {
  try {
    return readStamp(readFileSync(join(dir, "SKILL.md"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The SKILL.md text with its own stamp line removed. The stamp digests the file that carries it, so
 * it has to be excluded from its own input — otherwise no fixed point exists.
 */
export function withoutStamp(md) {
  const bounds = frontmatterBounds(md);
  if (!bounds) return md;
  const block = md.slice(bounds.start, bounds.end).replace(/^version:[^\n]*\n?/m, "");
  return md.slice(0, bounds.start) + block + md.slice(bounds.end);
}

/**
 * Content digest of a whole skill DIRECTORY — SKILL.md plus every bundled asset (setup's
 * `templates/`), so a template edit bumps the stamp exactly like a prose edit. Path names are part
 * of the input, so adding or renaming a file changes the digest too.
 */
export function skillDigest(dir) {
  const h = createHash("sha256");
  for (const rel of listFiles(dir)) {
    if (IGNORED_FILES.has(basename(rel))) continue;
    const raw = readFileSync(join(dir, rel));
    h.update(rel);
    h.update("\0");
    h.update(rel === "SKILL.md" ? Buffer.from(withoutStamp(raw.toString("utf8")), "utf8") : raw);
    h.update("\0");
  }
  return h.digest("hex").slice(0, STAMP_LENGTH);
}

/**
 * Classify an installed skill copy against the bundled source. Returns
 * `{ state, bundled, installed, drifted, extra }` where `drifted` lists the bundled files (relative
 * paths) whose bytes differ — the exact set a refresh must rewrite, and the whole bundle when
 * nothing is installed yet — and `extra` lists installed files the bundle no longer ships.
 *
 *   "missing"   — nothing installed there yet.
 *   "current"   — every bundled file is byte-identical. Nothing to do.
 *   "outdated"  — differs, but the copy is pristine (its stamp matches its own content): it is some
 *                 other release's copy, carries no local work, and is anton's to refresh.
 *   "modified"  — differs and the stamp does NOT match its content: someone edited it. Left alone.
 *   "unstamped" — differs and carries no stamp at all: written before stamps existed, so anton
 *                 cannot tell an old release's copy from a customization. Left alone, reported.
 *
 * Drift is judged on bytes rather than on stamps alone, so a bundled file the user DELETED still
 * counts as drift (a stamp comparison would call that copy current).
 *
 * `extra` exists because the digest walks the DESTINATION: a file an older bundle shipped and this
 * one dropped would otherwise survive a refresh and keep the refreshed copy's digest off its own
 * freshly-written stamp forever — reported to the user as "carries local edits" when it carries
 * none. Only a refresh may act on it, and safely: a "pristine" verdict means the whole directory
 * hashes to the stamp some release wrote, which no user-added file could survive, so on that path
 * every extra file is provably a previous bundle's leftover rather than the user's.
 */
export function skillState(srcDir, destDir) {
  const bundled = readSkillStamp(srcDir);
  if (!existsSync(join(destDir, "SKILL.md"))) {
    return { state: "missing", bundled, installed: null, drifted: listFiles(srcDir), extra: [] };
  }
  const installed = readSkillStamp(destDir);
  const shipped = new Set(listFiles(srcDir));
  const drifted = [...shipped].filter((rel) => !sameBytes(join(srcDir, rel), join(destDir, rel)));
  const extra = listFiles(destDir).filter((rel) => !shipped.has(rel) && !IGNORED_FILES.has(basename(rel)));
  if (drifted.length === 0 && extra.length === 0) return { state: "current", bundled, installed, drifted, extra };
  if (installed === null) return { state: "unstamped", bundled, installed, drifted, extra };
  const pristine = installed === skillDigest(destDir);
  return { state: pristine ? "outdated" : "modified", bundled, installed, drifted, extra };
}
