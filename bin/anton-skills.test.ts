/**
 * Skill provisioning — what `anton setup` installs into a `~/.claude`, and how it tells its own
 * out-of-date copy from a user's edited one (anton-k7q2, split out of `anton.test.ts`).
 *
 * The claim the whole suite adds up to: anton owns the copies it wrote and nothing else. It refreshes
 * an untouched copy of another release without being asked, reports a hand-edited one as stale rather
 * than clobbering it, and never treats a file the user added as its own (anton-gsyh).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  provisionAgentsSkills,
  installSkillDir,
  staleSkills,
  INSTALLED_SKILLS,
  REQUIRED_SKILLS,
} from "./anton.mjs";

// The runtime's canonical skill lists. The launcher must stay pure Node (it runs before any build),
// so it duplicates them; these aliases exist only to pin the copies equal.
import {
  INSTALLED_SKILLS as RUNTIME_INSTALLED_SKILLS,
  REQUIRED_SKILLS as RUNTIME_REQUIRED_SKILLS,
} from "../src/lib/claude/prompt";
import { readSkillStamp, skillDigest } from "../src/lib/claude/skill-stamp.mjs";

import { exists, REPO_ROOT, seedOtherRelease, tempDir, tempDirs } from "./anton.fixture";

// The launcher's skill lists are a hand-maintained copy of src/lib/claude/prompt.ts's — the
// installer is pure Node and can't import the TS module. Nothing but this assertion stops them
// drifting, and drift is silent-but-fatal in one direction: a skill the runtime loads but the
// installer never copies makes every job that needs it die on a missing SKILL.md. Iterating the
// launcher's own stale list (as the install tests do) can't catch that.
describe("launcher skill lists match the runtime's", () => {
  it("REQUIRED_SKILLS is identical to src/lib/claude/prompt.ts's, in order", () => {
    expect(REQUIRED_SKILLS).toEqual([...RUNTIME_REQUIRED_SKILLS]);
  });

  it("INSTALLED_SKILLS is identical to src/lib/claude/prompt.ts's, in order", () => {
    expect(INSTALLED_SKILLS).toEqual([...RUNTIME_INSTALLED_SKILLS]);
  });

  it("every listed skill exists as a shippable asset", () => {
    for (const name of INSTALLED_SKILLS) {
      expect(existsSync(join(REPO_ROOT, "skills", name, "SKILL.md"))).toBe(true);
    }
  });
});

describe("provisionAgentsSkills (into a temp ~/.claude)", () => {
  let claudeRoot: string;
  const skillPath = (name: string) => join(claudeRoot, "skills", name, "SKILL.md");

  afterEach(async () => {
    if (claudeRoot) await rm(claudeRoot, { recursive: true, force: true });
  });

  it("installs required skills + a selected agent, and is idempotent (no-clobber)", async () => {
    claudeRoot = await tempDir("anton-claude-");

    // Non-interactive selection via flag so no TTY prompt is needed.
    const first = await provisionAgentsSkills(["--agents", "nextjs"], { claudeRoot, appRoot: REPO_ROOT });
    expect(first.installed).toBe(INSTALLED_SKILLS.length + 1); // every installed skill + 1 agent
    for (const req of INSTALLED_SKILLS) expect(await exists(skillPath(req))).toBe(true);
    expect(await exists(join(claudeRoot, "agents", "nextjs.md"))).toBe(true);
    // setup's bundled templates travel with the skill directory (anton-olh) — the `.product/` layer
    // and the `.beads/formulas/` assets `/setup` installs into a project (anton-8mnr, anton-hrql).
    for (const rel of [
      [".product", "PRODUCT.md"],
      [".beads", "formulas", "anton-bead.formula.json"],
      [".beads", "formulas", "anton-run.formula.toml"],
    ]) {
      expect(await exists(join(claudeRoot, "skills", "setup", "templates", ...rel))).toBe(true);
    }

    // Re-run: everything already present, zero writes.
    const second = await provisionAgentsSkills(["--agents", "nextjs"], { claudeRoot, appRoot: REPO_ROOT });
    expect(second.installed).toBe(0);
    expect(second.skipped).toBe(INSTALLED_SKILLS.length + 1);
  });

  it("with --no-agents installs only the required skills", async () => {
    claudeRoot = await tempDir("anton-claude-");
    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    expect(r.installed).toBe(INSTALLED_SKILLS.length);
    expect(r.agents).toEqual([]);
    expect(await exists(join(claudeRoot, "agents"))).toBe(false);
  });

  // No-clobber used to make a skill installed once frozen at that release forever, reported as
  // "already present" by every later setup (anton-tier-invariants). Drift is now named, and
  // --force-skills is the way out.
  it("reports a drifted skill as stale and leaves it untouched", async () => {
    claudeRoot = await tempDir("anton-claude-");
    await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });

    writeFileSync(skillPath("shape"), "# an old release's copy\n");
    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });

    expect(r.stale).toEqual(["shape"]);
    expect(r.updated).toBe(0);
    expect(r.refreshed).toEqual([]);
    expect(r.skipped).toBe(INSTALLED_SKILLS.length - 1);
    expect(await readFile(skillPath("shape"), "utf8")).toBe("# an old release's copy\n");
  });

  // The regression the stamp exists for (anton-gsyh): a copy left behind by an older release keeps
  // producing that release's conventions — a pre-tier `~/.claude/skills/bd` shaped epics-as-work-
  // buckets for weeks. Because such a copy is UNTOUCHED (its stamp matches its own content), a plain
  // re-run may re-sync it: no flag, no lost edits, and it says which skills it refreshed.
  it("refreshes an untouched copy of another release with no flag, and reports it", async () => {
    claudeRoot = await tempDir("anton-claude-");
    await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    seedOtherRelease(join(claudeRoot, "skills", "bd"), "# the pre-tier conventions\n");

    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });

    expect(r.refreshed).toEqual(["bd"]);
    expect(r.stale).toEqual([]);
    expect(r.updated).toBe(0);
    const bundled = await readFile(join(REPO_ROOT, "skills", "bd", "SKILL.md"), "utf8");
    expect(await readFile(skillPath("bd"), "utf8")).toBe(bundled);

    // …and the re-run after that has nothing left to do.
    expect((await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT })).refreshed).toEqual([]);
  });

  // A refresh has to leave the copy hashing to the stamp it just wrote. When an older bundle shipped
  // an asset this one dropped, rewriting only what the bundle still ships leaves that file behind and
  // the digest permanently off its own stamp — so the copy reads as hand-edited from then on, doctor
  // tells the user it "carries local edits" when it carries none, and it never auto-refreshes again.
  it("deletes assets the bundle no longer ships, so a refreshed copy matches its own stamp", async () => {
    claudeRoot = await tempDir("anton-claude-");
    await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    const dest = join(claudeRoot, "skills", "bd");
    // An asset the older release shipped and this bundle does not. Seeding AFTER it means the stamp
    // covers it — this is a pristine copy of that release, not a user who added a file.
    mkdirSync(join(dest, "templates"), { recursive: true });
    writeFileSync(join(dest, "templates", "dropped.md"), "# shipped by v1, gone in v2\n");
    seedOtherRelease(dest, "# the pre-tier conventions\n");

    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });

    expect(r.refreshed).toEqual(["bd"]);
    expect(await exists(join(dest, "templates", "dropped.md"))).toBe(false);
    expect(await exists(join(dest, "templates"))).toBe(false); // …and no empty debris directory.
    // The point of the prune: the copy's content hashes to the stamp it now declares, so it stays
    // refreshable instead of being misread as edited forever.
    expect(readSkillStamp(dest)).toBe(skillDigest(dest));
    expect((await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT })).stale).toEqual([]);
  });

  // The mirror case: an extra file anton cannot prove it wrote. Dropping a note into a skill dir is
  // not drift — every shipped file is still byte-identical — so it stays silent and never pruned.
  it("leaves a user-added file alone without calling the copy drifted", async () => {
    claudeRoot = await tempDir("anton-claude-");
    await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    const dest = join(claudeRoot, "skills", "bd");
    writeFileSync(join(dest, "my-notes.md"), "# mine\n");

    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });

    expect(r.refreshed).toEqual([]);
    expect(r.stale).toEqual([]);
    expect(r.skipped).toBe(INSTALLED_SKILLS.length);
    expect(await readFile(join(dest, "my-notes.md"), "utf8")).toBe("# mine\n");
  });

  // …and once a real release difference arrives, that added file is what proves the copy is not
  // anton's to overwrite: it breaks the destination digest, so the copy is edited, not refreshable.
  it("treats a copy carrying a user-added file as edited once it actually drifts", async () => {
    claudeRoot = await tempDir("anton-claude-");
    await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    const dest = join(claudeRoot, "skills", "bd");
    // A pristine copy of some other release — drift anton would refresh — that the user then adds a
    // file to. Seeding BEFORE the note is what makes it the user's file rather than that release's.
    seedOtherRelease(dest, "# the pre-tier conventions\n");
    writeFileSync(join(dest, "my-notes.md"), "# mine\n");

    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });

    expect(r.refreshed).toEqual([]);
    expect(r.stale).toEqual(["bd"]);
    expect(await readFile(join(dest, "my-notes.md"), "utf8")).toBe("# mine\n");
    expect(await readFile(skillPath("bd"), "utf8")).toContain("# the pre-tier conventions");
  });

  it("never auto-refreshes a copy carrying local edits", async () => {
    claudeRoot = await tempDir("anton-claude-");
    await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    // A stamped copy the user then edited: the stamp no longer describes the body, which is exactly
    // how anton tells "my file, out of date" from "their file, customized".
    seedOtherRelease(join(claudeRoot, "skills", "bd"), "# mine\n");
    const edited = (await readFile(skillPath("bd"), "utf8")) + "\nmy own note\n";
    writeFileSync(skillPath("bd"), edited);

    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });

    expect(r.refreshed).toEqual([]);
    expect(r.stale).toEqual(["bd"]);
    expect(await readFile(skillPath("bd"), "utf8")).toBe(edited);
  });

  it("--force-skills re-syncs a drifted skill from the bundle", async () => {
    claudeRoot = await tempDir("anton-claude-");
    await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    writeFileSync(skillPath("shape"), "# an old release's copy\n");

    const r = await provisionAgentsSkills(["--no-agents", "--force-skills"], {
      claudeRoot,
      appRoot: REPO_ROOT,
    });

    expect(r.stale).toEqual([]);
    expect(r.updated).toBe(1);
    const bundled = await readFile(join(REPO_ROOT, "skills", "shape", "SKILL.md"), "utf8");
    expect(await readFile(skillPath("shape"), "utf8")).toBe(bundled);
  });

  it("leaves a user's extra file in a skill dir alone when forcing", async () => {
    claudeRoot = await tempDir("anton-claude-");
    await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    const mine = join(claudeRoot, "skills", "shape", "NOTES.md");
    writeFileSync(mine, "mine\n");
    writeFileSync(skillPath("shape"), "drifted\n");

    await provisionAgentsSkills(["--no-agents", "--force-skills"], { claudeRoot, appRoot: REPO_ROOT });

    expect(await readFile(mine, "utf8")).toBe("mine\n");
  });
});

describe("installSkillDir", () => {
  let dest: string;
  let src: string;

  beforeEach(async () => {
    src = await tempDir("anton-skill-src-");
    dest = await tempDir("anton-skill-dest-");
    writeFileSync(join(src, "SKILL.md"), "v2\n");
    await rm(dest, { recursive: true, force: true }); // an absent destination, not an empty one
  });

  afterEach(async () => {
    for (const d of [src, dest]) if (d) await rm(d, { recursive: true, force: true });
  });

  it("installs when absent, skips when byte-identical", () => {
    expect(installSkillDir(src, dest)).toBe("installed");
    expect(installSkillDir(src, dest)).toBe("skipped");
  });

  it("reports stale rather than clobbering, and updates only under force", () => {
    installSkillDir(src, dest);
    writeFileSync(join(dest, "SKILL.md"), "v1\n");
    expect(installSkillDir(src, dest)).toBe("stale");
    expect(installSkillDir(src, dest, { force: true })).toBe("updated");
    expect(installSkillDir(src, dest)).toBe("skipped");
  });

  it("refreshes — without force — a copy whose stamp still matches its own content", () => {
    installSkillDir(src, dest);
    seedOtherRelease(dest, "an older release\n");
    expect(installSkillDir(src, dest)).toBe("refreshed");
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("v2\n");
    expect(installSkillDir(src, dest)).toBe("skipped");
  });

  it("restores a bundled file the user deleted", () => {
    writeFileSync(join(src, "templates.md"), "t\n");
    installSkillDir(src, dest);
    rmSync(join(dest, "templates.md"));
    expect(installSkillDir(src, dest)).toBe("stale");
    expect(installSkillDir(src, dest, { force: true })).toBe("updated");
    expect(existsSync(join(dest, "templates.md"))).toBe(true);
  });
});

describe("staleSkills", () => {
  const dirs = tempDirs();

  afterEach(dirs.cleanup);

  /** A skill source tree with one skill, plus an install root holding a copy of it. */
  async function fixture(body: string | ((dir: string) => void)) {
    const src = await dirs.make("anton-skillsrc-");
    const root = await dirs.make("anton-skillroot-");
    mkdirSync(join(src, "bd"), { recursive: true });
    writeFileSync(join(src, "bd", "SKILL.md"), "---\nname: bd\nversion: bundled-stamp\n---\n\nbundled\n");
    const installed = join(root, ".claude", "skills", "bd");
    mkdirSync(installed, { recursive: true });
    if (typeof body === "string") writeFileSync(join(installed, "SKILL.md"), body);
    else body(installed);
    return { src, root };
  }

  const check = async (src: string, root: string) =>
    staleSkills(src, { claudeRoot: await dirs.make("anton-empty-"), projectRoot: root });

  it("reports a project-scope skill that differs from the bundle", async () => {
    const { src, root } = await fixture("frozen at an old release\n");
    expect(await check(src, root)).toEqual([
      { scope: "project", name: "bd", state: "unstamped", installed: null, bundled: "bundled-stamp" },
    ]);
  });

  // The state is the whole point: it decides whether the fix anton prints is "re-run setup" or
  // "your call — --force-skills". An untouched copy of another release is anton's to refresh…
  it("calls an untouched copy of another release outdated", async () => {
    const { src, root } = await fixture((dir) => seedOtherRelease(dir, "an older release\n"));
    const [drift] = await check(src, root);
    expect(drift.state).toBe("outdated");
    expect(drift.bundled).toBe("bundled-stamp");
  });

  // …while a stamped copy whose content no longer matches its stamp was edited by hand.
  it("calls a hand-edited copy modified", async () => {
    const { src, root } = await fixture((dir) => {
      seedOtherRelease(dir, "an older release\n");
      writeFileSync(join(dir, "SKILL.md"), readFileSync(join(dir, "SKILL.md"), "utf8") + "my note\n");
    });
    expect((await check(src, root))[0].state).toBe("modified");
  });

  it("stays silent when the installed copy matches", async () => {
    const { src, root } = await fixture("---\nname: bd\nversion: bundled-stamp\n---\n\nbundled\n");
    expect(await check(src, root)).toEqual([]);
  });
});
