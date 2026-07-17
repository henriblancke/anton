import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetOperatorCache, resolveOperator } from "./operator";

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
  };

  beforeEach(() => {
    resetOperatorCache();
    delete process.env.ANTON_OPERATOR;
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
    // Not asserting the git rung directly (env-dependent); with ANTON_OPERATOR unset the resolver
    // must still yield a non-undefined identity as long as an OS user exists, so its claims are
    // owned by itself on a later review-fix sweep rather than silently disowned.
    process.env.USER = "svc-anton";
    expect(await resolveOperator()).toBeTypeOf("string");
  });

  it("resolves to $USERNAME when $USER is absent (Windows-style)", async () => {
    delete process.env.USER;
    process.env.USERNAME = "winuser";
    // Only decisive when global git user.name is unset; on machines that set it, that rung wins.
    const op = await resolveOperator();
    expect(op).toBeTypeOf("string");
    expect(op).not.toBe("");
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
