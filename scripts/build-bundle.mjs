#!/usr/bin/env node
/**
 * build-bundle (anton-1xp.1) — assemble a self-contained, prebuilt anton runtime bundle so a user
 * can install and run anton with NO local toolchain and NO build step (the foolery model: a
 * per-platform prebuilt bundle behind a thin launcher, not a compiled single binary).
 *
 * What it produces (under <out>/):
 *   anton-<os>-<arch>/            the runnable runtime dir (this is what install.sh extracts)
 *     server.js                   Next.js STANDALONE server (run with `node server.js`, PORT env)
 *     node_modules/               MINIMAL, dependency-traced deps (+ vendored node-pty)
 *     .next/                      compiled server output + static/ (copied in — standalone omits it)
 *     bin/anton.mjs               the launcher (detects RELEASE_VERSION → bundle/daemon mode)
 *     src/prompts/                system-base.md + agents/ (read at runtime, cwd-rooted)
 *     skills/                     vendored SKILL.md assets (read at runtime, cwd-rooted)
 *     drizzle/                    migration SQL (applied in-process at setup — no drizzle-kit)
 *     public/ package.json
 *     RELEASE_VERSION             marker the launcher keys bundle mode off of
 *   anton-<os>-<arch>.tar.gz      the release asset (~14MB — Next standalone tracing, not a prod install)
 *
 * Why standalone: `output:'standalone'` (next.config.ts) traces only the files the server actually
 * imports, so the bundle ships megabytes, not the whole prod dep tree. The tracer can't follow two
 * things, which this script adds by hand: `.next/static` (standalone excludes it) and node-pty (lazy
 * import for /shape). Native addons (better-sqlite3, node-pty) are per-os/arch, so the asset is too.
 * drizzle-kit is a devDep we don't ship; bundle-mode `anton setup` applies the drizzle SQL directly
 * via better-sqlite3 (see bin/anton.mjs).
 *
 * Usage:
 *   node scripts/build-bundle.mjs [--out dist] [--tag v0.1.0] [--platform darwin-arm64] [--skip-build]
 *
 * Pure Node, zero deps. Meant to run in CI (per-platform matrix) or locally to smoke-test the bundle.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse `--flag value` / `--flag=value` / boolean `--flag` from argv. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; } else out[key] = true;
    }
  }
  return out;
}

/** Node's os labels → the release-asset labels install.sh resolves (`<os>-<arch>`). */
function defaultPlatform() {
  const os = osPlatform() === "darwin" ? "darwin" : osPlatform() === "linux" ? "linux" : osPlatform();
  const arch = osArch() === "arm64" ? "arm64" : osArch() === "x64" ? "x64" : osArch();
  return `${os}-${arch}`;
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function main(argv) {
  const args = parseArgs(argv.slice(2));
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const version = String(args.tag ?? pkg.version).replace(/^v/, "");
  const platform = String(args.platform ?? defaultPlatform());
  const outRoot = join(REPO_ROOT, String(args.out ?? "dist"));
  const stageName = `anton-${platform}`;
  const stage = join(outRoot, stageName);

  console.log(`\nBuilding anton bundle  ${stageName}  (v${version})\n`);

  // 1) Ensure a fresh production Next build exists in the repo (full deps available here).
  if (!args["skip-build"]) {
    console.log("[1/5] next build (in repo)");
    run("bun", ["run", "build"], { cwd: REPO_ROOT });
  } else if (!existsSync(join(REPO_ROOT, ".next", "BUILD_ID"))) {
    throw new Error("--skip-build set but repo has no .next/BUILD_ID — build first.");
  }

  // 2) Assemble the stage from Next's STANDALONE output — a minimal, dependency-traced server whose
  //    node_modules holds only what the app actually imports (the big size win vs. a prod install).
  const standalone = join(REPO_ROOT, ".next", "standalone");
  if (!existsSync(join(standalone, "server.js"))) {
    throw new Error("no .next/standalone/server.js — is output:'standalone' set in next.config.ts?");
  }
  console.log(`[2/6] stage from standalone → ${stage}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  // The traced server, its minimal deps, the compiled output, and the package manifest.
  for (const rel of ["server.js", "node_modules", ".next", "package.json"]) {
    cpSync(join(standalone, rel), join(stage, rel), { recursive: true });
  }

  // 3) Add what standalone omits or its tracer can't see: client assets (standalone excludes
  //    .next/static), public/, and the files anton reads via process.cwd() at run time
  //    (skills/, drizzle/ migrations, src/prompts + the base/agent prompts) plus the launcher.
  console.log("[3/6] add static assets, public, and cwd-rooted runtime reads");
  cpSync(join(REPO_ROOT, ".next", "static"), join(stage, ".next", "static"), { recursive: true });
  for (const rel of ["public", "skills", "drizzle", join("src", "prompts"), "bin"]) {
    cpSync(join(REPO_ROOT, rel), join(stage, rel), { recursive: true });
  }

  // 4) Vendor node-pty (powers the interactive /shape terminal). It's imported lazily, so Next's
  //    tracer skips it — copy the real package, then keep only this platform's prebuilt binary.
  console.log("[4/6] vendor node-pty (+ prune foreign prebuilds)");
  const ptyDst = join(stage, "node_modules", "node-pty");
  if (!existsSync(ptyDst)) {
    cpSync(join(REPO_ROOT, "node_modules", "node-pty"), ptyDst, { recursive: true });
  }
  const ptyPrebuilds = join(ptyDst, "prebuilds");
  if (existsSync(ptyPrebuilds)) {
    for (const entry of readdirSync(ptyPrebuilds)) {
      if (entry !== platform) rmSync(join(ptyPrebuilds, entry), { recursive: true, force: true });
    }
  }

  // 5) Drop the marker the launcher keys bundle mode off of.
  console.log("[5/6] write RELEASE_VERSION");
  writeFileSync(join(stage, "RELEASE_VERSION"), `${version}\n`);

  // 6) Tarball the stage dir (the stage dir name is the top-level entry, so it extracts cleanly).
  console.log("[6/6] tar");
  const tarball = join(outRoot, `${stageName}.tar.gz`);
  run("tar", ["-czf", tarball, "-C", outRoot, stageName]);

  console.log(`\n✓ bundle: ${stage}`);
  console.log(`✓ asset:  ${tarball}\n`);
}

main(process.argv);
