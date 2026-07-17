import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetOperatorCache, resolveOperator } from "./operator";

// Isolate the global git-config rung: pointing GIT_CONFIG_GLOBAL at a path that doesn't exist
// makes `git config --global user.name` read an empty config, so gitGlobalUserName() reliably
// returns undefined regardless of the host's real git identity. Without this, machines with a
// global user.name would satisfy resolveOperator() from the git rung and never exercise the
// $USER / $USERNAME fallbacks these tests are meant to cover.
const NO_GLOBAL_GITCONFIG = join(tmpdir(), "anton-operator-test-nonexistent-gitconfig");

/**
 * resolveOperator resolution order (anton-g3v): ANTON_OPERATOR > global git user.name > $USER.
 * The $USER fallback matters because the resolved value is stamped as the claim's assignee; if it
 * diverged from what bd's own fallback would stamp, review-fix's ownership filter would reject the
 * instance's own PRs. These tests pin the precedence and the fallback so that can't regress.
 */
describe("resolveOperator", () => {
  const saved = {
    ANTON_OPERATOR: process.env.ANTON_OPERATOR,
    USER: process.env.USER,
    USERNAME: process.env.USERNAME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  };

  beforeEach(() => {
    resetOperatorCache();
    delete process.env.ANTON_OPERATOR;
    process.env.GIT_CONFIG_GLOBAL = NO_GLOBAL_GITCONFIG;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetOperatorCache();
  });

  it("prefers ANTON_OPERATOR over every other source", async () => {
    process.env.ANTON_OPERATOR = "  alice  "; // trimmed
    process.env.USER = "root";
    expect(await resolveOperator()).toBe("alice");
  });

  it("falls back to $USER when ANTON_OPERATOR and global git user.name are unset", async () => {
    // GIT_CONFIG_GLOBAL (set in beforeEach) neutralizes the git rung, so this exercises the
    // $USER fallback specifically: its claims stay owned by itself on a later review-fix sweep
    // rather than silently disowned. A regression in osUser() would now fail here.
    process.env.USER = "svc-anton";
    delete process.env.USERNAME;
    expect(await resolveOperator()).toBe("svc-anton");
  });

  it("resolves to $USERNAME when $USER is absent (Windows-style)", async () => {
    // Git rung neutralized via GIT_CONFIG_GLOBAL (beforeEach) and $USER unset, so the resolver
    // must reach the $USERNAME rung — a regression in that fallback fails this assertion.
    delete process.env.USER;
    process.env.USERNAME = "winuser";
    expect(await resolveOperator()).toBe("winuser");
  });

  it("memoizes — a second call returns the cached value without re-resolving", async () => {
    process.env.ANTON_OPERATOR = "bob";
    expect(await resolveOperator()).toBe("bob");
    process.env.ANTON_OPERATOR = "carol"; // ignored: already cached
    expect(await resolveOperator()).toBe("bob");
    resetOperatorCache();
    expect(await resolveOperator()).toBe("carol"); // reset re-resolves
  });
});
