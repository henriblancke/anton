/**
 * Test-only: the shared harness for `src/**\/*.integration.test.ts`. These tests drive REAL `bd`
 * and `git` subprocesses (never mocked) against throwaway temp repos, plus a file-backed anton.db
 * so route handlers exercise the real `getDb()` singleton. This module centralizes the boilerplate
 * that used to be copy-pasted at the top of every integration test file:
 *   - binary probes (`hasBd`/`hasGit`) and the `describe`/`describe.skip` suite selector
 *   - temp bd+git repo scaffolding, optionally with a bare remote (mirrors `bd`'s Dolt-over-git sync)
 *   - a temp, migrated `anton.db` wired up via `ANTON_DB` before any `getDb()` singleton import
 *   - Next.js route-handler request/params builders
 *   - env save/restore and operator-identity helpers
 *
 * Import this from `*.integration.test.ts` files only — it is not meant for unit tests, which
 * should keep using `@/lib/db/testing`'s in-memory `makeTestDb()` instead.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe } from "vitest";
import { applyMigrationsTo } from "@/lib/db/testing";

// ── binary probes + suite selector ──

/** True iff `cmd --version` runs without throwing (mirrors the copy-pasted `has()` helper). */
function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Is the `bd` CLI available on PATH? */
export const hasBd = (): boolean => has("bd");

/** Is the `git` CLI available on PATH? */
export const hasGit = (): boolean => has("git");

/**
 * `describe` when both `bd` and `git` are on PATH, else `describe.skip` — the standard guard for
 * an integration suite that drives real subprocesses. Equivalent to the copy-pasted
 * `has("bd") && has("git") ? describe : describe.skip`.
 */
export const describeBd = hasBd() && hasGit() ? describe : describe.skip;

// ── temp bd + git repo ──

export interface BdRepo {
  /** The temp dir containing `repo` (and `remote.git` when `bare` was requested). */
  dir: string;
  /** The working repo's path — `cwd` for every `beads`/git call. */
  repo: string;
  /** The bare remote's path, present only when `opts.bare` was requested. */
  bare?: string;
  /** Recursively removes `dir`. Safe to call once, in `afterAll`. */
  cleanup(): void;
}

/**
 * Create a temp working repo with `git init` + `bd init --skip-hooks`, ready for `beads.*` calls.
 *
 * `opts.bare` additionally creates a bare remote and wires it as both the git `origin` and bd's
 * Dolt remote (mirrors `anton setup`: the git remote doubles as the Dolt remote), matching
 * execute-epic's e2e sandbox exactly.
 *
 * `opts.initialCommit` commits a README and pushes it to `origin` BEFORE `bd init` runs — needed
 * whenever a later step (e.g. cloning the remote) expects `origin/main` to already have a commit.
 */
export function makeBdRepo(opts: { bare?: boolean; initialCommit?: boolean } = {}): BdRepo {
  const dir = mkdtempSync(join(tmpdir(), "anton-it-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

  let bare: string | undefined;
  if (opts.bare) {
    bare = join(dir, "remote.git");
    // `-b main` pins the bare HEAD to refs/heads/main so clones of this remote check out main;
    // otherwise hosts whose default branch is `master` leave a clone on an unborn `master` and
    // `git push origin main` fails with "src refspec main does not match any".
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { stdio: "ignore" });
  }

  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "anton-test"]);
  if (bare) g(["remote", "add", "origin", bare]);

  if (opts.initialCommit) {
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    if (bare) g(["push", "-q", "-u", "origin", "main"]);
  }

  // --skip-hooks: bd's own pre-commit hook (bd export) deadlocks against bd init's exclusive
  // embedded-Dolt lock in a pristine repo. anton never relies on bd hooks — sync is explicit.
  execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });

  if (bare) {
    // The git `origin` doubles as the Dolt remote (as `anton setup` wires it).
    execFileSync("bd", ["dolt", "remote", "add", "origin", bare], { cwd: repo, stdio: "ignore" });
    // anton-managed config: disable bd's own auto-push — anton owns push cadence (see CONFIG_KEYS).
    execFileSync("bd", ["config", "set", "dolt.auto-push", "false"], { cwd: repo, stdio: "ignore" });
  }

  return {
    dir,
    repo,
    bare,
    // maxRetries: routes fire off-response-path `bd dolt` syncs (fire-and-forget), so a background
    // subprocess can still be writing inside the repo when afterAll runs — a bare rmSync races it
    // and dies ENOTEMPTY. Node retries ENOTEMPTY/EBUSY with linear backoff when maxRetries is set,
    // which outlives the short-lived subprocess.
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

// ── temp file-backed anton.db ──

export interface FileDb {
  /** The `anton.db` file's path — already assigned to `process.env.ANTON_DB`. */
  path: string;
  /** Recursively removes the temp dir holding the db file. Safe to call once, in `afterAll`. */
  cleanup(): void;
}

/**
 * Create a temp `anton.db`, apply every committed drizzle migration to it, and point
 * `process.env.ANTON_DB` at it — MUST run before any `getDb()` singleton import (route handlers
 * resolve the db path at import time). Reuses `applyMigrationsTo` from `@/lib/db/testing`, the
 * same migration-apply logic `makeTestDb()` uses for its in-memory db.
 */
export function makeFileDb(): FileDb {
  const dir = mkdtempSync(join(tmpdir(), "anton-it-db-"));
  const path = join(dir, "anton.db");
  // Capture ANTON_DB BEFORE overwriting it so cleanup can restore the prior value — the same
  // save/restore contract `saveEnv` gives every other env var this harness touches. Keeps
  // `makeFileDb` composable: a second call in the same process won't silently strand the first.
  const prevDb = process.env.ANTON_DB;
  process.env.ANTON_DB = path;

  const sqlite = new Database(path);
  applyMigrationsTo(sqlite);
  sqlite.close();

  return {
    path,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      if (prevDb === undefined) delete process.env.ANTON_DB;
      else process.env.ANTON_DB = prevDb;
    },
  };
}

// ── route request helpers ──

/** A Next.js dynamic route's `{ params }` second arg, pre-resolved (params are async in Next 15). */
export function paramsCtx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/** A bare `Request` for a route handler test — JSON-encodes `body` when it's not `undefined`. */
export function jsonRequest(method: string, body?: unknown): Request {
  return new Request("http://t/", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ── env + operator helpers ──

/**
 * Snapshot the current value of each env var in `keys`, and return a function that restores every
 * one of them to that snapshot (deleting keys that were unset). Mirrors execute-epic's `prevEnv`
 * save/restore: call this BEFORE mutating any of `keys`, mutate as needed, then call the returned
 * restorer in `afterAll`.
 */
export function saveEnv(keys: string[]): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * Set the resolved operator identity for the next route/job call. Dynamically imports
 * `resetOperatorCache` (rather than a static top-level import) so this module never forces
 * `@/lib/operator` to load before a test has finished setting up `ANTON_DB`/env — matching how the
 * route integration tests themselves defer that import to `beforeAll`.
 */
export async function withOperator(name: string): Promise<void> {
  process.env.ANTON_OPERATOR = name;
  const { resetOperatorCache } = await import("@/lib/operator");
  resetOperatorCache();
}
