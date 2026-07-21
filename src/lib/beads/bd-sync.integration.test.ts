/**
 * Real bd + Dolt round-trip for beads.sync (anton-nyf): a UI-style ticket edit must leave Dolt
 * commits on refs/dolt/data of the git remote, without relying on git hooks. Uses a local bare
 * remote seeded with an initial branch (Dolt's git backend refuses an empty remote). Skipped
 * when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./bd";
import { configureBeadsForRepo, configYamlHas } from "./config.mjs";
import { updateTicket } from "../ticket-detail";
import type { Project } from "../types";

describeBd("beads.sync integration (real bd · local bare remote)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let bare: string;
  let project: Project;

  beforeAll(() => {
    bdRepo = makeBdRepo({ bare: true, initialCommit: true });
    repo = bdRepo.repo;
    bare = bdRepo.bare!;

    // anton-managed config (see CONFIG_KEYS): export.auto is disabled too (anton-1th) so ordinary
    // reads don't regenerate the passive JSONL snapshot; team sync flows through Dolt over
    // refs/dolt/data, never the JSONL. Not part of makeBdRepo's standard bare-remote wiring, so
    // it's set explicitly here.
    execFileSync("bd", ["config", "set", "export.auto", "false"], { cwd: repo, stdio: "ignore" });

    project = {
      id: "x", slug: "tmp", name: "tmp", repoPath: repo,
      defaultBranch: "main", hasBeads: true, createdAt: 0,
    };
  });

  afterAll(() => {
    bdRepo.cleanup();
  });

  const doltDataRef = () => {
    const refs = execFileSync("git", ["ls-remote", bare], { encoding: "utf8" });
    return refs.split("\n").find((l) => l.endsWith("refs/dolt/data"));
  };

  // updateTicket fires its Dolt push fire-and-forget (off the save response path), so the remote ref
  // moves shortly AFTER updateTicket resolves, not synchronously. Poll until it settles.
  const waitForRef = async (
    predicate: (ref: string | undefined) => boolean,
    label: string,
  ): Promise<string | undefined> => {
    for (let i = 0; i < 100; i++) {
      const ref = doltDataRef();
      if (predicate(ref)) return ref;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for refs/dolt/data: ${label}`);
  };

  it("a pull-only pass never moves the remote ref (heartbeats must not push)", async () => {
    // `bd dolt remote add` publishes refs/dolt/data once at wiring time; from then on only
    // write-nudged full passes may move it. A heartbeat pull with local uncommitted-to-remote
    // writes present must leave the remote untouched.
    const before = doltDataRef();
    await beads.create(repo, { title: "Local-only until nudged", type: "task" });
    await beads.pull(repo);
    expect(doltDataRef(), "pull-only pass must never push").toBe(before);
  });

  it("a UI ticket edit lands commits on refs/dolt/data of the git remote", async () => {
    const id = await beads.create(repo, { title: "Sync me", type: "task" });
    const beforeEdit = doltDataRef();

    // The UI PATCH path: updateTicket writes via bd then fires the sync off the response path.
    await updateTicket(project, id, { title: "Synced title" });

    const afterEdit = await waitForRef(
      (ref) => ref !== undefined && ref !== beforeEdit,
      "moved after the first edit",
    );
    expect(afterEdit, "refs/dolt/data exists on the remote after a ticket edit").toBeDefined();
    expect(afterEdit, "the write-nudged sync moved the remote ref").not.toBe(beforeEdit);

    // A second write moves the ref — every write reaches the remote, not just the first.
    await updateTicket(project, id, { priority: 1 });
    const afterSecond = await waitForRef(
      (ref) => ref !== undefined && ref !== afterEdit,
      "moved after the second edit",
    );
    expect(afterSecond).toBeDefined();
    expect(afterSecond).not.toBe(afterEdit);
  });

  it("sync rejects loudly on a real remote failure (unreachable remote is not swallowed)", async () => {
    // Re-point the Dolt remote at a path that doesn't exist (upsert). This is NOT the benign
    // first-publish case (a wired-but-unpushed remote) — the remote is unreachable, so the full
    // pass must reject loudly rather than tolerate it. bd surfaces it at the pull step (which runs
    // before push), so the sync fails there; push-failure rejection is covered in bd.test.ts.
    execFileSync("bd", ["dolt", "remote", "add", "origin", join(bdRepo.dir, "missing.git")], {
      cwd: repo,
      stdio: "ignore",
    });
    await expect(beads.sync(repo)).rejects.toThrow(/bd dolt (pull|push) failed/);
  });
});

/**
 * Two anton-managed repositories exchange a beads change over refs/dolt/data with automatic JSONL
 * export disabled (anton-1th). Repo A goes through anton's real init path (configureBeadsForRepo),
 * which now enforces export.auto=false alongside export.git-add=false; it publishes a ticket through
 * Dolt. Repo B is a fresh clone hydrated from the git remote — it never receives issues.jsonl (that
 * export is gitignored) yet still sees the ticket, proving the collaboration channel is refs/dolt/data
 * and not the passive JSONL snapshot.
 *
 * Both repos here are bootstrapped by hand rather than via `makeBdRepo`: repo A's `bd init` must run
 * through `configureBeadsForRepo` (the code under test, not a raw `bd init`), and repo B is a clone of
 * repo A's remote rather than a fresh repo — neither shape fits the shared helper.
 */
describeBd("two managed repos exchange a change over refs/dolt/data with export.auto disabled (anton-1th)", () => {
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
  });

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it("both repos commit export.auto=false alongside export.git-add=false", () => {
    // Assert semantically (via configYamlHas), not on the raw text: bd 1.1.0 writes these keys as a
    // nested `export:` map rather than the flat `export.auto: false` line 1.0.4 emits (anton-qhoz).
    for (const repo of [repoA, repoB]) {
      const beadsDir = join(repo, ".beads");
      expect(configYamlHas(beadsDir, "export.auto", "false"), `${repo} must disable the automatic JSONL export`).toBe(
        true,
      );
      expect(configYamlHas(beadsDir, "export.git-add", "false"), `${repo} must still keep the export unstaged`).toBe(
        true,
      );
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
