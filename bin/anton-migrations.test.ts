/**
 * The schema the launcher brings up before it serves anything (anton-k7q2, split out of
 * `anton.test.ts`): the native better-sqlite3 ABI check, the in-process migration apply that stands
 * in for drizzle-kit in a release bundle, and `ensureMigrated`'s start-time composition of the two.
 *
 * Every case runs against the repo's REAL `drizzle/*.sql` over a throwaway DB, because the property
 * under test is that a second start applies nothing — a claim fixture SQL could not make.
 *
 * The source-checkout branch (anton-m6pg6) is covered here too. It used to be the only migration
 * path with no ABI heal: `applyMigrations` protects the bundle, while a source checkout shelled
 * straight out to drizzle-kit, so `anton setup` died inside drizzle-kit on a raw ERR_DLOPEN_FAILED.
 * Both halves of the fix are asserted below — that the heal runs at all, and that the drizzle-kit
 * child is pinned to the node it healed for, since a `#!/usr/bin/env node` child resolving its own
 * node from PATH is what made the heal aim at the wrong ABI in the first place.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyMigrations, ensureBetterSqlite3, ensureMigrated, runLocalPinnedToThisNode } from "./anton.mjs";

import { exists, pathWith, REPO_ROOT, tempDir, withDb } from "./anton.fixture";

describe("ensureBetterSqlite3", () => {
  it("returns 'ok' when the shipped binary matches the running Node (repo build)", () => {
    // The repo's better-sqlite3 was built for this exact Node, so no ABI fix is needed.
    expect(ensureBetterSqlite3(REPO_ROOT)).toBe("ok");
  });
});

describe("applyMigrations (in-process, no drizzle-kit)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("applies the real migration set to a temp DB, idempotently", async () => {
    dir = await tempDir("anton-mig-");
    const dbPath = join(dir, "anton.db");

    // Uses the repo's real drizzle/*.sql + better-sqlite3 (appRoot = REPO_ROOT).
    const first = applyMigrations(dbPath, { appRoot: REPO_ROOT });
    expect(first.total).toBeGreaterThan(0);
    expect(first.ran).toBe(first.total);
    expect(await exists(dbPath)).toBe(true);

    // Second run is a no-op — the journal records what's applied.
    const second = applyMigrations(dbPath, { appRoot: REPO_ROOT });
    expect(second.ran).toBe(0);
    expect(second.total).toBe(first.total);

    // The schema is really there: journal table + more than one user table.
    withDb(dbPath, (sqlite) => {
      const journal = sqlite.prepare("SELECT COUNT(*) AS n FROM __anton_migrations").get() as { n: number };
      expect(journal.n).toBe(first.total);
      const tables = sqlite
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
        .get() as { n: number };
      expect(tables.n).toBeGreaterThan(1);
    });
  });

  it("leaves legacy attempt counters unattributed because routing was not recorded", async () => {
    dir = await tempDir("anton-mig-provenance-");
    const dbPath = join(dir, "anton.db");
    applyMigrations(dbPath, { appRoot: REPO_ROOT });

    withDb(dbPath, (sqlite) => {
      const now = Math.floor(Date.now() / 1000);
      sqlite.prepare(
        "INSERT INTO projects (id, slug, name, repo_path, settings_json) VALUES (?, ?, ?, ?, ?)",
      ).run("project", "project", "project", "/tmp/project", "{}");
      sqlite.prepare(
        "INSERT INTO jobs (id, type, project_id, payload_json, status, spent_attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("job", "execute-epic", "project", "{}", "done", 3, now);
      sqlite.prepare("DELETE FROM __anton_migrations WHERE name = ?").run("0041_legacy-quota-attempt-backfill.sql");
    });

    // Replaying the real migration models an upgrader whose current settings no longer reveal
    // whether this week's legacy attempts went through a router or Anthropic.
    applyMigrations(dbPath, { appRoot: REPO_ROOT });
    withDb(dbPath, (sqlite) => {
      const rows = sqlite.prepare("SELECT meter_key FROM quota_attempts WHERE job_id = ?").all("job");
      expect(rows).toEqual([]);
    });
  });
});

describe("ensureMigrated (bundle mode → in-process apply, before serving)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("applies pending migrations, then is a clean no-op on the next start", async () => {
    dir = await tempDir("anton-start-mig-");
    const dbPath = join(dir, "anton.db");

    // Bundle branch: apply the real committed SQL in-process (no drizzle-kit), like `anton start`.
    const first = ensureMigrated({ isBundle: true, dbPath, appRoot: REPO_ROOT });
    expect(first.ran).toBeGreaterThan(0);
    expect(await exists(dbPath)).toBe(true);

    // Re-running start with nothing pending applies zero migrations.
    const second = ensureMigrated({ isBundle: true, dbPath, appRoot: REPO_ROOT });
    expect(second.ran).toBe(0);
  });
});

describe("runLocalPinnedToThisNode (source checkout → drizzle-kit under THIS node)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("wins over a different node already first on PATH", async () => {
    dir = await tempDir("anton-node-pin-");

    // A decoy `node` earlier on PATH stands in for the real split on a dev machine — nvm's shim and
    // Homebrew's node, where which one answers depends on whether the shell was a login shell. A
    // plain `#!/usr/bin/env node` child resolves THIS one, which is how the heal came to target the
    // wrong ABI: anton healed for its own node, the child loaded the addon under another.
    const decoy = join(dir, "node");
    await writeFile(decoy, `#!/bin/sh\necho DECOY > "$ANTON_PIN_SEEN"\nexit 0\n`);
    await chmod(decoy, 0o755);

    // Reports the node that actually ran it, so the assertion is about which node resolved rather
    // than about drizzle-kit (which would need a database before it did anything observable).
    const probe = join(dir, "probe");
    await writeFile(probe, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ANTON_PIN_SEEN, process.execPath);\n`);
    await chmod(probe, 0o755);

    const seen = join(dir, "seen.txt");
    const rc = runLocalPinnedToThisNode(probe, [], { PATH: pathWith(dir), ANTON_PIN_SEEN: seen });

    expect(rc).toBe(0);
    // The decoy would have written "DECOY"; the pin means the child ran under anton's own node.
    expect(await readFile(seen, "utf8")).toBe(process.execPath);
  });

  it("prepends to PATH rather than replacing it, so the child keeps the rest of its tools", async () => {
    dir = await tempDir("anton-node-pin-path-");

    // Pinning must not cost the child every other binary it needs (git, bd). Only node's
    // precedence changes; everything already on PATH stays reachable behind it.
    const marker = join(dir, "only-here");
    await writeFile(marker, `#!/bin/sh\necho FOUND > "$ANTON_PIN_SEEN"\n`);
    await chmod(marker, 0o755);

    const seen = join(dir, "seen.txt");
    const rc = runLocalPinnedToThisNode("only-here", [], { PATH: pathWith(dir), ANTON_PIN_SEEN: seen });

    expect(rc).toBe(0);
    expect((await readFile(seen, "utf8")).trim()).toBe("FOUND");
  });

  it("does not mutate the parent's own PATH", () => {
    const before = process.env.PATH;
    runLocalPinnedToThisNode("true", []);
    expect(process.env.PATH).toBe(before);
  });
});

describe("ensureMigrated (source checkout → heals the native ABI before drizzle-kit)", () => {
  // The regression this guards: `ensureBetterSqlite3` existed with exactly ONE call site, inside
  // applyMigrations (bundle-only), so a source checkout reached drizzle-kit unprotected. These
  // drive `ensureMigrated({ isBundle: false })` itself — deleting the heal from that branch must
  // turn a case here RED, which a direct `ensureBetterSqlite3` probe could never do (PR #298 review).
  const trace = () => {
    const calls: string[] = [];
    return {
      calls,
      heal: (appRoot?: string) => {
        calls.push(`heal:${appRoot ?? "default"}`);
        return "ok" as const;
      },
      run: (bin: string, args: string[]) => {
        calls.push(`run:${bin} ${args.join(" ")}`);
        return 0;
      },
    };
  };

  it("heals the ABI BEFORE spawning drizzle-kit, not after", () => {
    const t = trace();
    expect(ensureMigrated({ isBundle: false, appRoot: REPO_ROOT, heal: t.heal, run: t.run })).toEqual({ ran: null });
    // Order is the whole fix: healing after the spawn is the crash this bead was filed for.
    expect(t.calls).toEqual([`heal:${REPO_ROOT}`, "run:drizzle-kit migrate"]);
  });

  it("does not spawn drizzle-kit at all when the heal throws", () => {
    const t = trace();
    const boom = () => {
      throw new Error("no prebuilt better-sqlite3 for Node v99 on this platform");
    };
    // An unhealable ABI must surface as ITS own error. Falling through to drizzle-kit would bury it
    // under the raw ERR_DLOPEN_FAILED stack that made this read as a migration bug.
    expect(() => ensureMigrated({ isBundle: false, appRoot: REPO_ROOT, heal: boom, run: t.run })).toThrow(/no prebuilt/);
    expect(t.calls).toEqual([]);
  });

  it("fails start when drizzle-kit exits non-zero", () => {
    const t = trace();
    expect(() =>
      ensureMigrated({ isBundle: false, appRoot: REPO_ROOT, heal: t.heal, run: () => 1 }),
    ).toThrow(/drizzle-kit migrate failed/);
  });

  it("runs the REAL heal when only the spawn is stubbed", () => {
    // The cases above stub both seams, so they would still pass if `heal` defaulted to a no-op.
    // Leaving `heal` at its default sends the branch through the actual `ensureBetterSqlite3`
    // against the repo's own build: it must probe better-sqlite3 for real and come back clean.
    const t = trace();
    expect(ensureMigrated({ isBundle: false, appRoot: REPO_ROOT, run: t.run })).toEqual({ ran: null });
    expect(t.calls).toEqual(["run:drizzle-kit migrate"]);
  });
});

describe("every bin this launcher spawns is pinned to anton's own node", () => {
  // Structural, because the alternative is a real two-node machine. `next` and `drizzle-kit` are
  // both `#!/usr/bin/env node`, and both load better-sqlite3 — drizzle-kit to migrate, next through
  // instrumentation as the server boots. A bare `runLocal` call site is a child free to resolve a
  // different node than the one `ensureBetterSqlite3` just healed for, which moves the crash rather
  // than fixing it: migrations pass, then the server dies on the reversed mismatch (PR #298 review).
  it("has no bare runLocal(...) call site left in anton.mjs", async () => {
    const src = await readFile(join(REPO_ROOT, "bin", "anton.mjs"), "utf8");
    const bare = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /(?<!PinnedToThisNode)\brunLocal\(/.test(line) && !line.startsWith("*"))
      // Two legal mentions: `runLocal`'s own definition, and the one delegation to it from inside
      // `runLocalPinnedToThisNode`. Every OTHER call site is a child left free to pick its own node.
      .filter(({ line }) => !line.startsWith("function runLocal(bin, args"))
      .filter(({ line }) => !line.startsWith("return runLocal(bin, args, { ...env, PATH:"));
    expect(bare.map(({ n, line }) => `${n}: ${line}`)).toEqual([]);
  });

  it("daemonizes the server with process.execPath, not a PATH-resolved node", async () => {
    // startDaemon spawns the server directly rather than through runLocal, so the same pin has to
    // be spelled out there — it migrates first, then must launch under the node it healed for.
    const src = await readFile(join(REPO_ROOT, "bin", "anton.mjs"), "utf8");
    expect(src).toContain("spawn(process.execPath, spawnArgs");
    expect(src).not.toContain('spawn("node", spawnArgs');
  });
});
