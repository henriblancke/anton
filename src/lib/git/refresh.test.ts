/**
 * Real-git round-trip for {@link refreshCheckout} (anton-qor2): a checkout behind its remote is
 * fast-forwarded onto the tree that shipped, and every checkout anton must NOT touch — dirty,
 * diverged, off-branch, remote-less — comes back as drift with the reason a human would need.
 * Skipped when `git` isn't installed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshCheckout } from "./refresh";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

suite("refreshCheckout (real git)", () => {
  let sandbox: string;
  let repo: string;
  let bare: string;
  /** A second clone standing in for "everyone else", so origin can move without touching `repo`. */
  let other: string;

  const git = (cwd: string, args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

  const head = (cwd: string): string => git(cwd, ["rev-parse", "HEAD"]);

  /** Commit `file` in `cwd` and push it to origin/main — how the remote gets ahead. */
  const commitAndPush = (cwd: string, file: string, body: string): string => {
    writeFileSync(join(cwd, file), body);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", `add ${file}`]);
    git(cwd, ["push", "-q", "origin", "main"]);
    return head(cwd);
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-refresh-"));
    bare = join(sandbox, "remote.git");
    repo = join(sandbox, "repo");
    other = join(sandbox, "other");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { stdio: "ignore" });

    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "anton-test"]);
    git(repo, ["remote", "add", "origin", bare]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);

    execFileSync("git", ["clone", "-q", bare, other], { stdio: "ignore" });
    git(other, ["config", "user.email", "t@example.com"]);
    git(other, ["config", "user.name", "anton-test"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("fast-forwards a clean checkout onto the remote tip and reports the tree it left it at", async () => {
    const was = head(repo);
    const shipped = commitAndPush(other, "shipped.ts", "export const shipped = true;\n");

    const refresh = await refreshCheckout(repo, "main");

    expect(refresh.drift).toBeUndefined();
    expect(refresh.head).toBe(shipped);
    expect(refresh.advancedFrom).toBe(was);
    // The WORKING TREE moved, not just a ref: this is what the scan then measures.
    expect(head(repo)).toBe(shipped);
  });

  it("leaves a checkout that already holds the remote tip alone", async () => {
    const at = head(repo);

    const refresh = await refreshCheckout(repo, "main");

    expect(refresh.drift).toBeUndefined();
    expect(refresh.head).toBe(at);
    expect(refresh.advancedFrom).toBeUndefined();
  });

  it("refuses a dirty checkout rather than merging over someone's work", async () => {
    commitAndPush(other, "shipped.ts", "export const shipped = true;\n");
    writeFileSync(join(repo, "README.md"), "# sandbox\nlocal work in progress\n");
    const was = head(repo);

    const refresh = await refreshCheckout(repo, "main");

    expect(refresh.drift).toContain("uncommitted change");
    expect(refresh.transient).toBeUndefined();
    expect(refresh.head).toBe(was);
    expect(head(repo)).toBe(was);
  });

  it("tolerates untracked files — every repo has scratch, and none of it blocks a fast-forward", async () => {
    const shipped = commitAndPush(other, "shipped.ts", "export const shipped = true;\n");
    writeFileSync(join(repo, "scratch.txt"), "notes\n");

    const refresh = await refreshCheckout(repo, "main");

    expect(refresh.drift).toBeUndefined();
    expect(head(repo)).toBe(shipped);
  });

  it("refuses a diverged checkout — reconciling it is a human's call", async () => {
    commitAndPush(other, "shipped.ts", "export const shipped = true;\n");
    writeFileSync(join(repo, "local.ts"), "export const local = true;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "local commit"]);
    const was = head(repo);

    const refresh = await refreshCheckout(repo, "main");

    expect(refresh.drift).toContain("diverged");
    expect(refresh.head).toBe(was);
    expect(head(repo)).toBe(was);
  });

  it("refuses a checkout parked on another branch while origin moved on", async () => {
    commitAndPush(other, "shipped.ts", "export const shipped = true;\n");
    git(repo, ["checkout", "-q", "-b", "scratch"]);
    const was = head(repo);

    const refresh = await refreshCheckout(repo, "main");

    expect(refresh.drift).toContain("scratch");
    expect(head(repo)).toBe(was);
  });

  it("reports a repo with no origin as drift — nothing there names the tree that shipped", async () => {
    git(repo, ["remote", "remove", "origin"]);

    const refresh = await refreshCheckout(repo, "main");

    expect(refresh.drift).toContain("origin");
    // Permanent: no retry conjures a remote, only a human wiring one.
    expect(refresh.transient).toBeUndefined();
  });

  it("reports an unreachable remote as TRANSIENT drift — a fetch that didn't answer is worth retrying", async () => {
    commitAndPush(other, "shipped.ts", "export const shipped = true;\n");
    rmSync(bare, { recursive: true, force: true });
    const was = head(repo);

    const refresh = await refreshCheckout(repo, "main");

    expect(refresh.drift).toContain("fetching origin/main failed");
    expect(refresh.transient).toBe(true);
    expect(head(repo)).toBe(was);
  });
});
