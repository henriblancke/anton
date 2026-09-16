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
import { chmod, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyMigrations, cmdDev, ensureBetterSqlite3, ensureMigrated, healNativeAbi, NODE_DEV, nodeBand, resolveJsBin, runLocalPinnedToThisNode } from "./anton.mjs";

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

  it("runs a vendored bin's JS through this runtime, so the shebang never gets a vote", async () => {
    // The Bun hole (PR #298 review): under `bun bin/anton.mjs`, `process.execPath` is `bun`, and
    // ~/.bun/bin holds no executable named `node` — so prepending that directory pins NOTHING and a
    // `#!/usr/bin/env node` child still falls through to ambient Node, while the heal targeted Bun's
    // ABI. Handing the bin's JS to process.execPath directly removes the question: the process that
    // loads the addon IS the one we healed for, whatever runtime that is.
    expect(resolveJsBin("next")).toBe(await realpath(join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next")));
    expect(resolveJsBin("drizzle-kit")).toBe(await realpath(join(REPO_ROOT, "node_modules", "drizzle-kit", "bin.cjs")));
  });

  it("falls back to spawning the bin when it is not resolvable JS", () => {
    // Degrade to the PATH pin rather than fail: a bare command meant to come off PATH, a missing
    // vendored entry, and an explicit path the caller means literally are all spawned as before.
    expect(resolveJsBin("definitely-not-a-vendored-bin")).toBe(null);
    expect(resolveJsBin("/tmp/some/explicit/path")).toBe(null);
  });

  it("still pins when the bin is spawned rather than resolved (the fallback path)", async () => {
    dir = await tempDir("anton-node-pin-fallback-");
    // The probe below is passed as a PATH, so resolveJsBin returns null and this exercises the
    // fallback — which must still put this runtime first, exactly as it did before.
    const decoy = join(dir, "node");
    await writeFile(decoy, `#!/bin/sh\necho DECOY > "$ANTON_PIN_SEEN"\nexit 0\n`);
    await chmod(decoy, 0o755);
    const probe = join(dir, "probe");
    await writeFile(probe, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ANTON_PIN_SEEN, process.execPath);\n`);
    await chmod(probe, 0o755);
    const seen = join(dir, "seen.txt");

    expect(runLocalPinnedToThisNode(probe, [], { PATH: pathWith(dir), ANTON_PIN_SEEN: seen })).toBe(0);
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

describe("cmdDev (heals before it pins, like every other spawning command)", () => {
  // The regression the second review round caught in the first fix: pinning `next dev` without
  // healing first TRADES one crash for another. Unpinned, the child resolved its own node and could
  // land on the ABI the installed addon was built for; the pin removes that coincidence, so a dev
  // server nobody healed fails where it used to boot — in the most-run command (PR #298 review).
  it("heals the ABI BEFORE spawning next dev", () => {
    const calls: string[] = [];
    const rc = cmdDev([], {
      heal: () => {
        calls.push("heal");
        return 0;
      },
      run: (bin: string, args: string[]) => {
        calls.push(`run:${bin} ${args.join(" ")}`);
        return 0;
      },
    });
    expect(rc).toBe(0);
    expect(calls).toEqual(["heal", "run:next dev"]);
  });

  it("does not start the dev server at all when the heal fails", () => {
    const calls: string[] = [];
    // A dev server on an unhealable ABI would boot and then die inside instrumentation, which is
    // the ERR_DLOPEN_FAILED wall this bead exists to replace. Refuse with the heal's own exit code.
    const rc = cmdDev([], { heal: () => 1, run: (bin: string) => (calls.push(bin), 0) });
    expect(rc).toBe(1);
    expect(calls).toEqual([]);
  });

  it("heals without migrating, so dev still comes up mid-migration", () => {
    // Deliberately unlike `cmdStart`: `next dev` should serve whatever schema is on disk, so a
    // developer can start the server on a branch whose migrations are not written yet.
    const calls: string[] = [];
    cmdDev([], { heal: () => (calls.push("heal"), 0), run: () => (calls.push("run"), 0) });
    expect(calls).not.toContain("migrate");
  });
});

describe("healNativeAbi (reports instead of throwing past main's missing catch)", () => {
  it("returns 0 on a healthy build", () => {
    expect(healNativeAbi(REPO_ROOT)).toBe(0);
  });

  it("returns 1 rather than throwing when the heal cannot succeed", async () => {
    // `main` runs as `Promise.resolve(main(...)).then(...)` with NO top-level catch, so a throw
    // from any command body becomes an unhandled rejection and a raw stack — exactly the output
    // this bead replaces with one line of advice (PR #298 review).
    //
    // The root must be OUTSIDE the repo: node resolves `node_modules` upward, so a bogus path under
    // REPO_ROOT still finds the repo's own healthy better-sqlite3 and heals fine. A tmpdir has no
    // node_modules above it, so the require throws — the non-ABI branch `ensureBetterSqlite3`
    // re-throws and this must catch.
    const isolated = await tempDir("anton-heal-isolated-");
    try {
      expect(healNativeAbi(isolated)).toBe(1);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});

describe("every bin this launcher spawns is pinned to anton's own node", () => {
  // Structural, because the alternative is a real two-node machine. `next` and `drizzle-kit` are
  // both `#!/usr/bin/env node`, and both load better-sqlite3 — drizzle-kit to migrate, next through
  // instrumentation as the server boots. A bare `runLocal` call site is a child free to resolve a
  // different node than the one `ensureBetterSqlite3` just healed for, which moves the crash rather
  // than fixing it: migrations pass, then the server dies on the reversed mismatch (PR #298 review).
  it("has no bare runLocal(...) call site OUTSIDE the pinned wrapper", async () => {
    const src = await readFile(join(REPO_ROOT, "bin", "anton.mjs"), "utf8");
    const lines = src.split("\n");
    // `runLocal` is legal in exactly two places: its own definition, and inside
    // `runLocalPinnedToThisNode`, which delegates to it. Anywhere else is a child left free to
    // resolve its own runtime. Scoping by enclosing function (rather than by matching each allowed
    // line's text) means the wrapper can be rewritten without the guard needing to learn its
    // new shape — only the boundary matters.
    const startsFn = (line: string, name: string) =>
      new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`).test(line);
    let enclosing = "";
    const bare: string[] = [];
    lines.forEach((raw, i) => {
      const line = raw.trim();
      // `async function` counts too (PR #298 review): matching only `function` let `enclosing` go
      // STALE across every async declaration, so a bare `runLocal(` sitting in one of those
      // stretches while `enclosing` still read "runLocalPinnedToThisNode" was skipped outright —
      // this guard silently passing the exact regression it exists to catch. Verified by planting
      // one: before this fix the scan missed it.
      const decl = /^(?:async\s+)?function\s+(\w+)\s*\(/.exec(line);
      if (decl) enclosing = decl[1];
      if (startsFn(line, "runLocal") || startsFn(line, "runLocalPinnedToThisNode")) return;
      if (line.startsWith("*") || line.startsWith("//")) return;
      if (!/(?<!PinnedToThisNode)\brunLocal\(/.test(line)) return;
      if (enclosing === "runLocalPinnedToThisNode") return;
      bare.push(`${i + 1} (in ${enclosing}): ${line}`);
    });
    expect(bare).toEqual([]);
  });

  it("rebuilds node-pty through the pinned helper, not a bare or PATH-pinned npm", async () => {
    // node-pty is the OTHER per-ABI addon here, and `npm rebuild` resolves its own node from PATH —
    // so on the two-runtime split this bead is about, setup would build it for the runtime the
    // server is no longer using. Setup and start both pass; the interactive terminal fails on first
    // open instead, which is the same bug displaced into the one surface nothing here tests.
    //
    // It must go through `runLocalPinnedToThisNode`, not a hand-rolled PATH prepend — that was this
    // fix's first draft and it is the WEAKER pin: under Bun it prepends a directory containing no
    // `node`, so npm's own `#!/usr/bin/env node` still finds ambient Node (PR #298 review).
    const src = await readFile(join(REPO_ROOT, "bin", "anton.mjs"), "utf8");
    expect(src).toContain('runLocalPinnedToThisNode("npm", ["rebuild", "node-pty"])');
    expect(src).not.toContain('spawnSync("npm", ["rebuild", "node-pty"]');
  });

  it("resolves a PATH-only node script, so `npm` is pinnable at all", () => {
    // The rebuild pin rests on this: npm is NOT vendored in node_modules/.bin, so resolveJsBin has
    // to find it on PATH and follow the symlink to npm-cli.js. If this returned null, the rebuild
    // would silently fall back to the PATH prepend — the exact weaker pin the case above forbids.
    const npm = resolveJsBin("npm");
    expect(npm, "npm did not resolve to a JS file — the rebuild pin degrades to a PATH prepend").not.toBeNull();
    expect(npm).toMatch(/\.(js|cjs|mjs)$/);
  });

  it("returns null for a real binary, which must keep being spawned directly", () => {
    // `git` is a compiled executable, not a node script: executing it with process.execPath would
    // be nonsense, so the fallback has to hold for anything without a node shebang.
    expect(resolveJsBin("git")).toBe(null);
  });

  it("daemonizes the server with process.execPath, not a PATH-resolved node", async () => {
    // startDaemon spawns the server directly rather than through runLocal, so the same pin has to
    // be spelled out there — it migrates first, then must launch under the node it healed for.
    const src = await readFile(join(REPO_ROOT, "bin", "anton.mjs"), "utf8");
    expect(src).toContain("spawn(process.execPath, spawnArgs");
    expect(src).not.toContain('spawn("node", spawnArgs');
  });
});

describe("nodeBand (the two Node floors, decided purely)", () => {
  // Extracted from `checkPrereqs` precisely so this is assertable: that function reads
  // `process.versions.node` directly, so the band was only reachable by mocking a global, and the
  // claim that it had been "checked across 18/20/22/24/26" rested on a throwaway script rather than
  // anything committed (PR #298 review). These are that check, committed.
  it("fails below the runtime floor", () => {
    expect(nodeBand("18.20.0")).toBe("unsupported");
    expect(nodeBand("v18.20.0")).toBe("unsupported"); // `v`-prefixed, as `node -v` prints it
  });

  it("passes-with-warning between the runtime floor and the dev pin", () => {
    // Supported — the bundle self-heals per ABI — but not what this repo builds against.
    expect(nodeBand("20.11.0")).toBe("below-dev");
    expect(nodeBand("22.22.0")).toBe("below-dev");
  });

  it("warns on a 24 BELOW the pin, rather than waving the whole major through", () => {
    // The dev pin is a pin: `.nvmrc` and release.yml name 24.21.0 exactly. A major-only comparison
    // (the first draft) called 24.0.0 clean, which is the silent gap this warning exists to close.
    expect(nodeBand("24.0.0")).toBe("below-dev");
    expect(nodeBand("24.20.9")).toBe("below-dev");
  });

  it("is clean at the pin and above", () => {
    expect(nodeBand(NODE_DEV)).toBe("ok");
    expect(nodeBand("24.21.1")).toBe("ok");
    expect(nodeBand("26.8.2")).toBe("ok");
  });

  it("agrees with the Node this suite is running on", () => {
    // Ties the pure function to the real input `checkPrereqs` feeds it, so a version string shape
    // node actually emits can never drift away from what the bands were tested with.
    expect(["unsupported", "below-dev", "ok"]).toContain(nodeBand(process.versions.node));
  });
});
