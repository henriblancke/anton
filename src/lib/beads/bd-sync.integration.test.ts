/**
 * Real bd + Dolt round-trip for beads.sync (anton-nyf): a UI-style ticket edit must leave Dolt
 * commits on refs/dolt/data of the git remote, without relying on git hooks. Uses a local bare
 * remote seeded with an initial branch (Dolt's git backend refuses an empty remote). Skipped
 * when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beads } from "./bd";
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

    execFileSync("bd", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("bd", ["dolt", "remote", "add", "origin", bare], { cwd: repo, stdio: "ignore" });

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

  it("a UI ticket edit lands commits on refs/dolt/data of the git remote", async () => {
    const id = await beads.create(repo, { title: "Sync me", type: "task" });
    expect(doltDataRef(), "no dolt data pushed before the first sync").toBeUndefined();

    // The UI PATCH path: updateTicket writes via bd then syncs explicitly.
    await updateTicket(project, id, { title: "Synced title" });

    const afterEdit = doltDataRef();
    expect(afterEdit, "refs/dolt/data exists on the remote after a ticket edit").toBeDefined();

    // A second write moves the ref — every write reaches the remote, not just the first.
    await updateTicket(project, id, { priority: 1 });
    expect(doltDataRef()).toBeDefined();
    expect(doltDataRef()).not.toBe(afterEdit);
  }, 60_000);

  it("sync rejects loudly on a real push failure", async () => {
    // Re-point the Dolt remote at a path that doesn't exist (upsert) — push must fail, not skip.
    execFileSync("bd", ["dolt", "remote", "add", "origin", join(sandbox, "missing.git")], {
      cwd: repo,
      stdio: "ignore",
    });
    await expect(beads.sync(repo)).rejects.toThrow(/bd dolt push failed/);
  }, 60_000);
});
