import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachPrUrl,
  githubRepoSlug,
  githubSlugFromBase,
  prUrlFromRef,
  REMOTE_TTL_MS,
  resetRemoteCache,
  webBaseFromRemote,
} from "./remote";

describe("webBaseFromRemote", () => {
  it("normalizes scp-style ssh remotes", () => {
    expect(webBaseFromRemote("git@github.com:owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
    expect(webBaseFromRemote("git@github.com:owner/repo")).toBe("https://github.com/owner/repo");
  });

  it("normalizes https + ssh scheme remotes and strips .git", () => {
    expect(webBaseFromRemote("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
    expect(webBaseFromRemote("ssh://git@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("supports GitHub Enterprise hosts", () => {
    expect(webBaseFromRemote("git@ghe.corp.com:team/app.git")).toBe(
      "https://ghe.corp.com/team/app",
    );
  });

  it("returns undefined for empty/garbage", () => {
    expect(webBaseFromRemote(undefined)).toBeUndefined();
    expect(webBaseFromRemote("")).toBeUndefined();
    expect(webBaseFromRemote("not-a-remote")).toBeUndefined();
  });
});

describe("githubSlugFromBase", () => {
  it("yields the owner/repo GH_REPO takes", () => {
    expect(githubSlugFromBase(webBaseFromRemote("git@github.com:owner/repo.git"))).toBe(
      "owner/repo",
    );
    expect(githubSlugFromBase("https://github.com/owner/repo")).toBe("owner/repo");
  });

  it("declines anything that isn't github.com — GH_REPO would misdirect gh, not protect it", () => {
    expect(githubSlugFromBase("https://ghe.corp.com/team/app")).toBeUndefined();
    expect(githubSlugFromBase("https://github.com/owner")).toBeUndefined();
    expect(githubSlugFromBase(undefined)).toBeUndefined();
  });
});

describe("prUrlFromRef", () => {
  const base = "https://github.com/owner/repo";

  it("expands a gh-<n> ref against the base", () => {
    expect(prUrlFromRef("gh-218", base)).toBe("https://github.com/owner/repo/pull/218");
  });

  it("returns a full-url ref as-is regardless of base", () => {
    const url = "https://github.com/o/r/pull/9";
    expect(prUrlFromRef(url, undefined)).toBe(url);
    expect(prUrlFromRef(url, base)).toBe(url);
  });

  it("returns undefined for a short ref with no base, or no ref", () => {
    expect(prUrlFromRef("gh-218", undefined)).toBeUndefined();
    expect(prUrlFromRef(undefined, base)).toBeUndefined();
    expect(prUrlFromRef("", base)).toBeUndefined();
  });
});

/**
 * The slug is what `GH_REPO` takes, and GH_REPO overrides which repository `gh` resolves for every
 * beads gate check — so it must not outlive the remote it was read from. Real git, real cache.
 */
describe("githubRepoSlug caching", () => {
  const repos: string[] = [];

  const repoWithOrigin = (url: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "anton-remote-"));
    repos.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", url], { cwd: dir });
    return dir;
  };

  afterEach(() => {
    vi.useRealTimers();
    resetRemoteCache();
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("re-reads a retargeted origin once the TTL lapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const repo = repoWithOrigin("git@github.com:owner/old.git");
    expect(await githubRepoSlug(repo)).toBe("owner/old");

    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:owner/new.git"], {
      cwd: repo,
    });
    expect(await githubRepoSlug(repo)).toBe("owner/old"); // still inside the TTL

    vi.setSystemTime(Date.now() + REMOTE_TTL_MS + 1);
    // A gate evaluated against `owner/old` here could close on a same-numbered PR in the wrong repo.
    expect(await githubRepoSlug(repo)).toBe("owner/new");
  });

  it("yields no slug for a non-github origin, and re-checks that too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const repo = repoWithOrigin("git@ghe.corp.com:team/app.git");
    expect(await githubRepoSlug(repo)).toBeUndefined();

    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:owner/repo.git"], {
      cwd: repo,
    });
    vi.setSystemTime(Date.now() + REMOTE_TTL_MS + 1);
    expect(await githubRepoSlug(repo)).toBe("owner/repo");
  });
});

describe("attachPrUrl", () => {
  type Item = { prRef?: string; prUrl?: string };
  it("sets prUrl when resolvable and leaves it unset otherwise", () => {
    const base = "https://github.com/owner/repo";
    expect(attachPrUrl<Item>({ prRef: "gh-7" }, base).prUrl).toBe(
      "https://github.com/owner/repo/pull/7",
    );
    expect(attachPrUrl<Item>({ prRef: "gh-7" }, undefined).prUrl).toBeUndefined();
    expect(attachPrUrl<Item>({}, base).prUrl).toBeUndefined();
  });
});
