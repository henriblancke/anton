/**
 * Unit tests for the review session's OS-level filesystem containment (anton-t6tu). What matters
 * here is not that a `sandbox` object is produced but that it is produced CLOSED: the lockdown
 * booleans, the ref store in `denyWrite`, and a refusal — never a permissive fallback — whenever
 * either of those cannot be established.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isPoisonError } from "./errors";
import {
  assertReviewSandboxSupported,
  resolveReviewSandbox,
  reviewSandboxDenyWrite,
  reviewSandboxSettings,
} from "./review-sandbox";

const WORKTREE = "/repos/.anton-worktrees/anton/anton-t6tu";
const COMMON_DIR = "/repos/anton/.git";

describe("reviewSandboxSettings (anton-t6tu)", () => {
  it("enables the sandbox, fails closed when it is unavailable, and drops the escape hatch", () => {
    // The three together are the guard. `enabled` alone leaves Claude Code warning-and-continuing on
    // a host without a sandbox, and leaves the model free to retry a blocked command with
    // `dangerouslyDisableSandbox` — which under bypassPermissions runs unconfined and unprompted.
    expect(reviewSandboxSettings([COMMON_DIR])).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: [COMMON_DIR] },
      },
    });
  });

  it("denies writes only — the reviewer still has to read the tree it is judging", () => {
    const { filesystem } = reviewSandboxSettings([COMMON_DIR]).sandbox;
    expect(Object.keys(filesystem)).toEqual(["denyWrite"]);
  });
});

describe("reviewSandboxDenyWrite (anton-t6tu)", () => {
  it("pins the shared ref store shut — the one place the worktree fingerprint cannot see", () => {
    // `printf <sha> > <repo>/.git/refs/heads/anton/<future-bead>` plants a branch `createWorktree`
    // later adopts, while HEAD, the symbolic ref, and porcelain status all stay identical.
    expect(reviewSandboxDenyWrite(WORKTREE, COMMON_DIR)).toContain(COMMON_DIR);
  });

  it("denies the worktree's own `.git` too, so the pointer at the ref store cannot be redirected", () => {
    expect(reviewSandboxDenyWrite(WORKTREE, COMMON_DIR)).toEqual([COMMON_DIR, `${WORKTREE}/.git`]);
  });

  it("collapses the two in a plain checkout, where they are the same path", () => {
    expect(reviewSandboxDenyWrite("/repos/anton", "/repos/anton/.git")).toEqual(["/repos/anton/.git"]);
  });
});

describe("assertReviewSandboxSupported (anton-t6tu)", () => {
  it("refuses to review on native Windows, where no Bash sandbox exists", () => {
    // Decided and explicit: a review anton cannot contain is worth less than no review, because the
    // PR ships either way. Poison, so the run parks for a human instead of burning its attempts on a
    // host no retry can make sandboxable.
    let thrown: unknown;
    try {
      assertReviewSandboxSupported("win32");
    } catch (e) {
      thrown = e;
    }
    expect(isPoisonError(thrown)).toBe(true);
    expect(String(thrown)).toMatch(/WSL2/);
  });

  it("passes on the platforms Claude Code sandboxes — WSL2 among them, as `linux`", () => {
    expect(() => assertReviewSandboxSupported("darwin")).not.toThrow();
    expect(() => assertReviewSandboxSupported("linux")).not.toThrow();
  });
});

describe("resolveReviewSandbox (anton-t6tu)", () => {
  it("scopes the sandbox to the repository the worktree belongs to", async () => {
    const settings = await resolveReviewSandbox({
      worktreePath: WORKTREE,
      readGitCommonDir: async () => COMMON_DIR,
      platform: "darwin",
    });
    expect(settings.sandbox.filesystem.denyWrite).toEqual([COMMON_DIR, `${WORKTREE}/.git`]);
    expect(settings.sandbox.enabled).toBe(true);
  });

  it("refuses before it even reads git when the platform cannot be sandboxed", async () => {
    let read = false;
    await expect(
      resolveReviewSandbox({
        worktreePath: WORKTREE,
        readGitCommonDir: async () => {
          read = true;
          return COMMON_DIR;
        },
        platform: "win32",
      }),
    ).rejects.toThrow(/cannot be sandboxed/);
    expect(read).toBe(false);
  });

  it("denies a symlinked path in both forms, so the rule bites whichever one the kernel sees", async () => {
    // `/var/folders/…` is a symlink to `/private/var/folders/…` on every macOS host anton runs on,
    // and git answers with the resolved form while a configured repo path may carry the other.
    const root = mkdtempSync(join(tmpdir(), "anton-sandbox-"));
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(join(real, ".git"), { recursive: true });
    symlinkSync(real, link);

    try {
      const { denyWrite } = (
        await resolveReviewSandbox({
          worktreePath: link,
          readGitCommonDir: async () => join(real, ".git"),
          platform: "darwin",
        })
      ).sandbox.filesystem;
      expect(denyWrite).toContain(join(real, ".git"));
      expect(denyWrite).toContain(join(link, ".git"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propagates a ref store it cannot locate instead of sandboxing without it", async () => {
    // A sandbox whose `denyWrite` silently lost the common dir is a guard with a hole in it, and it
    // looks exactly like a working one from the dispatch site.
    await expect(
      resolveReviewSandbox({
        worktreePath: WORKTREE,
        readGitCommonDir: async () => {
          throw new Error("not a git repository");
        },
        platform: "darwin",
      }),
    ).rejects.toThrow(/not a git repository/);
  });
});
