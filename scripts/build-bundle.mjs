#!/usr/bin/env node
/**
 * build-bundle (anton-1xp.1) — assemble a self-contained, prebuilt anton runtime bundle so a user
 * can install and run anton with NO local toolchain and NO build step (the foolery model: a
 * per-platform prebuilt bundle behind a thin launcher, not a compiled single binary).
 *
 * What it produces (under <out>/):
 *   anton-<os>-<arch>/            the runnable runtime dir (this is what install.sh extracts)
 *     .next/                      prebuilt Next.js production output (copied from a repo build)
 *     node_modules/               PRODUCTION deps only, native modules built for THIS platform
 *     bin/anton.mjs               the launcher (detects RELEASE_VERSION → bundle/daemon mode)
 *     src/prompts/                system-base.md + agents/ (read at runtime, cwd-rooted)
 *     skills/                     vendored SKILL.md assets (read at runtime, cwd-rooted)
 *     drizzle/                    migration SQL (applied in-process at setup — no drizzle-kit)
 *     public/ package.json next.config.ts drizzle.config.ts bun.lock
 *     RELEASE_VERSION             marker the launcher keys bundle mode off of
 *   anton-<os>-<arch>.tar.gz      the release asset
 *
 * Why prod deps + an in-process migration applier: `next start` needs the production dep tree with
 * native addons (better-sqlite3, node-pty, sharp) built for the runner's os/arch — which is exactly
 * why the asset is per-platform. drizzle-kit is a devDep we deliberately do NOT ship; bundle-mode
 * `anton setup` applies the drizzle SQL directly via better-sqlite3 (see bin/anton.mjs).
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

  // 2) Stage the runtime tree (everything the server + launcher read at run time).
  console.log(`[2/5] stage runtime → ${stage}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const COPY = [
    ".next",
    "public",
    "bin",
    "skills",
    "drizzle",
    join("src", "prompts"), // system-base.md + agents/*.md, read cwd-rooted at runtime
    "package.json",
    "bun.lock",
    "next.config.ts",
    "drizzle.config.ts",
  ];
  // `next start` only needs the compiled output — NOT the dev-server / build caches, which can be
  // hundreds of MB of Turbopack/webpack artifacts. Drop them so the asset stays lean.
  const NEXT_DROP = new Set(["dev", "cache", "trace"].map((d) => join(REPO_ROOT, ".next", d)));
  for (const rel of COPY) {
    const from = join(REPO_ROOT, rel);
    if (!existsSync(from)) {
      if (rel === "bun.lock") continue; // optional; prod install falls back to package.json
      throw new Error(`bundle source missing: ${rel}`);
    }
    cpSync(from, join(stage, rel), {
      recursive: true,
      filter: (src) => !NEXT_DROP.has(src),
    });
  }

  // 3) Install PRODUCTION deps into the stage — this builds native addons for THIS platform.
  console.log("[3/5] bun install --production (native build for this platform)");
  run("bun", ["install", "--production"], { cwd: stage });

  // 3b) node-pty vendors prebuilt binaries for EVERY platform (~60MB). Keep only this one.
  const ptyPrebuilds = join(stage, "node_modules", "node-pty", "prebuilds");
  if (existsSync(ptyPrebuilds)) {
    const keep = platform; // e.g. darwin-arm64
    for (const entry of readdirSync(ptyPrebuilds)) {
      if (entry !== keep) rmSync(join(ptyPrebuilds, entry), { recursive: true, force: true });
    }
  }

  // 4) Drop the marker the launcher keys bundle mode off of.
  console.log("[4/5] write RELEASE_VERSION");
  writeFileSync(join(stage, "RELEASE_VERSION"), `${version}\n`);

  // 5) Tarball the stage dir (the stage dir name is the top-level entry, so it extracts cleanly).
  console.log("[5/5] tar");
  const tarball = join(outRoot, `${stageName}.tar.gz`);
  run("tar", ["-czf", tarball, "-C", outRoot, stageName]);

  console.log(`\n✓ bundle: ${stage}`);
  console.log(`✓ asset:  ${tarball}\n`);
}

main(process.argv);
