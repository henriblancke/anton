/**
 * Real bd + Dolt round-trip for beads.sync (anton-nyf): a UI-style ticket edit must leave Dolt
 * commits on refs/dolt/data of the git remote, without relying on git hooks. Uses a local bare
 * remote seeded with an initial branch (Dolt's git backend refuses an empty remote). Skipped
 * when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beads } from "./bd";
import { configureBeadsForRepo } from "./config.mjs";
import { updateTicket } from "../ticket-detail";
import type { Project } from "../types";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("bd") && has("git") ? describe : describe.skip;

suite("beads.sync integration (real bd · local bare remote)", () => {
  let sandbox: string;
  let repo: string;
  let bare: string;
  let project: Project;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-dolt-sync-"));
    repo = join(sandbox, "repo");
    bare = join(sandbox, "remote.git");

    execFileSync("git", ["init", "--bare", "-q", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["remote", "add", "origin", bare]);
    g(["push", "-q", "-u", "origin", "main"]); // Dolt push needs an existing branch on the remote

    // --skip-hooks: bd's own pre-commit hook (bd export) deadlocks against bd init's exclusive
    // embedded-Dolt lock in a pristine repo. anton never relies on bd hooks — sync is explicit.
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });
    execFileSync("bd", ["dolt", "remote", "add", "origin", bare], { cwd: repo, stdio: "ignore" });
    // anton-managed config (see CONFIG_KEYS): bd 1.0.2 auto-pushes after each write once a remote
    // named `origin` exists — anton owns push cadence, so managed projects disable it. export.auto is
    // disabled too (anton-1th) so ordinary reads don't regenerate the passive JSONL snapshot; team
    // sync flows through Dolt over refs/dolt/data, never the JSONL.
    execFileSync("bd", ["config", "set", "dolt.auto-push", "false"], { cwd: repo, stdio: "ignore" });
    execFileSync("bd", ["config", "set", "export.auto", "false"], { cwd: repo, stdio: "ignore" });

    project = {
      id: "x", slug: "tmp", name: "tmp", repoPath: repo,
      defaultBranch: "main", hasBeads: true, createdAt: 0,
    };
  }, 60_000);

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  const doltDataRef = () => {
    const refs = execFileSync("git", ["ls-remote", bare], { encoding: "utf8" });
    return refs.split("\n").find((l) => l.endsWith("refs/dolt/data"));
  };

  it("a pull-only pass never moves the remote ref (heartbeats must not push)", async () => {
    // `bd dolt remote add` publishes refs/dolt/data once at wiring time; from then on only
    // write-nudged full passes may move it. A heartbeat pull with local uncommitted-to-remote
    // writes present must leave the remote untouched.
    const before = doltDataRef();
    await beads.create(repo, { title: "Local-only until nudged", type: "task" });
    await beads.pull(repo);
    expect(doltDataRef(), "pull-only pass must never push").toBe(before);
  }, 60_000);

  it("a UI ticket edit lands commits on refs/dolt/data of the git remote", async () => {
    const id = await beads.create(repo, { title: "Sync me", type: "task" });
    const beforeEdit = doltDataRef();

    // The UI PATCH path: updateTicket writes via bd then syncs explicitly.
    await updateTicket(project, id, { title: "Synced title" });

    const afterEdit = doltDataRef();
    expect(afterEdit, "refs/dolt/data exists on the remote after a ticket edit").toBeDefined();
    expect(afterEdit, "the write-nudged sync moved the remote ref").not.toBe(beforeEdit);

    // A second write moves the ref — every write reaches the remote, not just the first.
    await updateTicket(project, id, { priority: 1 });
    expect(doltDataRef()).toBeDefined();
    expect(doltDataRef()).not.toBe(afterEdit);
  }, 60_000);

  it("sync rejects loudly on a real remote failure (unreachable remote is not swallowed)", async () => {
    // Re-point the Dolt remote at a path that doesn't exist (upsert). This is NOT the benign
    // first-publish case (a wired-but-unpushed remote) — the remote is unreachable, so the full
    // pass must reject loudly rather than tolerate it. bd surfaces it at the pull step (which runs
    // before push), so the sync fails there; push-failure rejection is covered in bd.test.ts.
    execFileSync("bd", ["dolt", "remote", "add", "origin", join(sandbox, "missing.git")], {
      cwd: repo,
      stdio: "ignore",
    });
    await expect(beads.sync(repo)).rejects.toThrow(/bd dolt (pull|push) failed/);
  }, 60_000);
});

/**
 * Two anton-managed repositories exchange a beads change over refs/dolt/data with automatic JSONL
 * export disabled (anton-1th). Repo A goes through anton's real init path (configureBeadsForRepo),
 * which now enforces export.auto=false alongside export.git-add=false; it publishes a ticket through
 * Dolt. Repo B is a fresh clone hydrated from the git remote — it never receives issues.jsonl (that
 * export is gitignored) yet still sees the ticket, proving the collaboration channel is refs/dolt/data
 * and not the passive JSONL snapshot.
 */
suite("two managed repos exchange a change over refs/dolt/data with export.auto disabled (anton-1th)", () => {
  let sandbox: string;
  let bare: string;
  let repoA: string;
  let repoB: string;
  let ticketId: string;

  const gitIn = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-1th-fixture-"));
    bare = join(sandbox, "remote.git");
    repoA = join(sandbox, "a");
    repoB = join(sandbox, "b");

    // Bare git remote seeded with an initial main branch (Dolt's git backend refuses an empty remote).
    // Pin HEAD to main so the clone at repoB checks out the pushed branch — without this the bare repo's
    // HEAD follows git's default (still `master` on many hosts), and the clone would land on an empty
    // working tree that never receives .beads/config.yaml, silently defeating the repoB assertions.
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", repoA]);
    gitIn(repoA, ["config", "user.email", "a@example.com"]);
    gitIn(repoA, ["config", "user.name", "anton-a"]);
    writeFileSync(join(repoA, "README.md"), "# a\n");
    gitIn(repoA, ["add", "-A"]);
    gitIn(repoA, ["commit", "-q", "-m", "init"]);
    gitIn(repoA, ["remote", "add", "origin", bare]);
    gitIn(repoA, ["push", "-q", "-u", "origin", "main"]);

    // Anton's real init path: bd init → team-config (export.auto=false + export.git-add=false + …) →
    // .beads/.gitignore → Dolt remote wiring (publishes refs/dolt/data). This is the code under test.
    const cfg = configureBeadsForRepo(repoA, { prefix: "ex", log: () => {} });
    if (!cfg.configured) throw new Error(`configureBeadsForRepo(A) failed: ${cfg.errors.join("; ")}`);

    // A creates a ticket and publishes it through Dolt (never through the JSONL export).
    const created = JSON.parse(
      execFileSync("bd", ["create", "Cross-machine ticket", "--type", "task", "--json"], {
        cwd: repoA,
        encoding: "utf8",
      }),
    );
    ticketId = (Array.isArray(created) ? created[0] : created).id;
    execFileSync("bd", ["dolt", "commit", "-m", "add ticket"], { cwd: repoA, stdio: "ignore" });
    execFileSync("bd", ["dolt", "push"], { cwd: repoA, stdio: "ignore" });

    // Commit the beads team-config so a clone inherits export.auto=false. config.yaml is tracked; the
    // JSONL exports and Dolt runtime state stay gitignored (they must NOT travel through git).
    gitIn(repoA, ["add", "-f", ".beads/config.yaml", ".beads/.gitignore", ".beads/metadata.json"]);
    gitIn(repoA, ["commit", "-q", "-m", "beads team-config"]);
    gitIn(repoA, ["push", "-q", "origin", "main"]);

    // Second machine: clone the git repo, then hydrate the Dolt DB from the remote. `bd init` pulls
    // refs/dolt/data on a clone whose Dolt DB is gitignored (absent); the explicit pull confirms it.
    execFileSync("git", ["clone", "-q", bare, repoB]);
    gitIn(repoB, ["config", "user.email", "b@example.com"]);
    gitIn(repoB, ["config", "user.name", "anton-b"]);
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repoB, stdio: "ignore" });
    execFileSync("bd", ["dolt", "remote", "add", "origin", bare], { cwd: repoB, stdio: "ignore" });
    execFileSync("bd", ["dolt", "pull"], { cwd: repoB, stdio: "ignore" });
  }, 120_000);

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it("both repos commit export.auto=false alongside export.git-add=false", () => {
    for (const repo of [repoA, repoB]) {
      const cfg = readFileSync(join(repo, ".beads", "config.yaml"), "utf8");
      expect(cfg, `${repo} must disable the automatic JSONL export`).toMatch(/^export\.auto:\s*false\s*$/m);
      expect(cfg, `${repo} must still keep the export unstaged`).toMatch(/^export\.git-add:\s*false\s*$/m);
    }
  });

  it("the change travels through refs/dolt/data, not the JSONL export", () => {
    // The clone never received issues.jsonl (it is gitignored), yet the ticket is present — proof the
    // board hydrated from Dolt over refs/dolt/data with automatic JSONL export disabled.
    expect(existsSync(join(repoB, ".beads", "issues.jsonl")), "issues.jsonl must not travel via git").toBe(false);
    const parsed = JSON.parse(execFileSync("bd", ["list", "--json"], { cwd: repoB, encoding: "utf8" }));
    const issues: Array<{ id: string }> = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
    expect(issues.map((i) => i.id)).toContain(ticketId);
  });
});
