import { describe, expect, it } from "vitest";
import { attachPrUrl, githubSlugFromBase, prUrlFromRef, webBaseFromRemote } from "./remote";

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
