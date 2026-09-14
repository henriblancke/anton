/**
 * Releases: how the launcher compares versions, names the asset it wants, asks GitHub for the latest
 * one, and what the release bundle must contain to boot at all (anton-k7q2, split out of
 * `anton.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { compareVersions, fetchLatestRelease, platformLabel } from "./anton.mjs";

import { CLI, REPO_ROOT } from "./anton.fixture";

describe("compareVersions", () => {
  it("orders dotted versions, tolerating a leading v", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0); // missing parts treated as 0
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1); // numeric, not lexical
  });
});

describe("platformLabel", () => {
  it("is a <os>-<arch> label matching the running platform", () => {
    const label = platformLabel();
    expect(label).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(label).toContain(process.arch === "x64" ? "x64" : process.arch);
  });
});

// A release bundle symlinks `anton` straight at $RUNTIME/bin/anton.mjs, so every `../src` module the
// launcher statically imports must also be in build-bundle.mjs's hand-maintained copy list. Forget
// one and EVERY command — setup, doctor, start, board-check — dies at module load with
// ERR_MODULE_NOT_FOUND. npm installs are immune (package.json `files` ships all of `src`), so only
// this assertion stands between a new launcher import and a broken release.
describe("launcher's src imports are all in the release bundle", () => {
  /** The cwd-rooted paths build-bundle.mjs copies into the stage, as repo-relative POSIX paths. */
  function bundledPaths(): string[] {
    const script = readFileSync(join(REPO_ROOT, "scripts", "build-bundle.mjs"), "utf8");
    const block = script.match(/for \(const rel of \[\n([\s\S]*?)\n\s*\]\) \{/);
    expect(block, "build-bundle.mjs no longer has a multi-line `for (const rel of [...])` copy list").toBeTruthy();
    return [...(block?.[1] ?? "").matchAll(/join\(([^)]*)\)|^\s*"([^"]+)",/gm)]
      .map(([, args, bare]) => bare ?? [...args.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join("/"))
      .filter(Boolean);
  }

  it("every ../src module bin/anton.mjs imports is copied by build-bundle.mjs", () => {
    const bundled = bundledPaths();
    const imports = [...readFileSync(CLI, "utf8").matchAll(/(?:from|import\()\s*"\.\.\/(src\/[^"]+)"/g)].map(
      (m) => m[1],
    );

    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      const covered = bundled.some((p) => p === spec || spec.startsWith(`${p}/`));
      expect(covered, `${spec} is imported by bin/anton.mjs but missing from build-bundle.mjs`).toBe(true);
    }
  });
});

describe("fetchLatestRelease", () => {
  const TOKEN_VARS = ["ANTON_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
  let realFetch: typeof globalThis.fetch;
  let savedTokens: Record<string, string | undefined>;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Clear token env so header assertions aren't polluted by a token CI itself sets.
    savedTokens = {};
    for (const name of TOKEN_VARS) {
      savedTokens[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const name of TOKEN_VARS) {
      if (savedTokens[name] === undefined) delete process.env[name];
      else process.env[name] = savedTokens[name];
    }
  });

  /** Minimal Response-shaped stub with a case-insensitive header lookup. */
  function fakeResponse({
    ok,
    status,
    headers = {},
    body,
  }: {
    ok: boolean;
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
  }) {
    const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    // Only the fields fetchLatestRelease reads; cast past the full Response shape.
    return {
      ok,
      status,
      headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
      json: async () => body,
    } as unknown as Response;
  }

  it("returns the release on a 200", async () => {
    const release = { tag_name: "v1.2.3", assets: [] };
    globalThis.fetch = (async () => fakeResponse({ ok: true, status: 200, body: release })) as typeof fetch;
    const result = await fetchLatestRelease();
    expect(result).toEqual({ release });
  });

  it("maps 403 + x-ratelimit-remaining:0 to a rate_limit error carrying the reset time", async () => {
    globalThis.fetch = (async () =>
      fakeResponse({
        ok: false,
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
      })) as typeof fetch;
    const result = await fetchLatestRelease();
    expect(result).toEqual({ error: { kind: "rate_limit", reset: 1700000000 } });
  });

  it("maps a timeout/AbortError to a timeout error", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    }) as typeof fetch;
    const result = await fetchLatestRelease();
    expect(result).toEqual({ error: { kind: "timeout" } });
  });

  it("maps a 404 to a not_found error", async () => {
    globalThis.fetch = (async () => fakeResponse({ ok: false, status: 404 })) as typeof fetch;
    const result = await fetchLatestRelease();
    expect(result).toEqual({ error: { kind: "not_found" } });
  });

  it("sends an Authorization header when a token env var is set, and none when unset", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedHeaders = (init.headers ?? {}) as Record<string, string>;
      return fakeResponse({ ok: true, status: 200, body: { tag_name: "v1.0.0" } });
    }) as typeof fetch;

    // No token set (cleared in beforeEach) → no Authorization header.
    await fetchLatestRelease();
    expect(capturedHeaders.Authorization).toBeUndefined();

    // Token set → Bearer header present.
    process.env.ANTON_GITHUB_TOKEN = "secret-token";
    await fetchLatestRelease();
    expect(capturedHeaders.Authorization).toBe("Bearer secret-token");
  });
});
