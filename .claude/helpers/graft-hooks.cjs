#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// The dist/claude dir of @nanonets/graft resolved from a base whose node_modules is searched.
function fromPkg(base) {
  try {
    const pkg = require.resolve('@nanonets/graft/package.json', { paths: [base] });
    return path.join(path.dirname(pkg), 'dist', 'claude');
  } catch { return null; }
}

// Where .mcp.json's `npx -y @nanonets/graft` itself lands: npm caches an on-demand install under
// `<npm cache>/_npx/<hash>/node_modules`. The hash is npm's own resolution, not this machine's or
// user's, so it can never be baked in as a constant — but a machine that has run the MCP server
// the same way anton's .mcp.json does already has it cached, and finding it back is a plain
// readdir, no npm/network call needed.
function npxGraftDirs() {
  const roots = [process.env.npm_config_cache, path.join(os.homedir(), '.npm')];
  if (process.platform === 'win32') roots.push(path.join(process.env.LOCALAPPDATA || '', 'npm-cache'));
  const dirs = [];
  for (const root of roots.filter(Boolean)) {
    let entries;
    try { entries = fs.readdirSync(path.join(root, '_npx')); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(root, '_npx', entry, 'node_modules', '@nanonets', 'graft', 'dist', 'claude');
      if (fs.existsSync(candidate)) dirs.push(candidate);
    }
  }
  return dirs;
}

// The global node_modules dir per npm (handles Homebrew/Windows/volta). Queried on demand.
function globalRoot() {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim();
    return root || null;
  } catch { return null; /* npm unavailable */ }
}

// The version of the package a dist/claude dir belongs to, or null if unreadable.
function versionOf(distClaude) {
  try {
    return JSON.parse(fs.readFileSync(path.join(distClaude, '..', '..', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

// Numeric-dotted compare of the release part; an unreadable version loses to any known one.
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const p = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = p(a), pb = p(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// The highest-versioned dir in `dirs` that actually contains `name`, or null.
function best(dirs, name) {
  let bestDir = null, bestVer = null;
  for (const d of dirs) {
    if (!d || !fs.existsSync(path.join(d, name))) continue;
    const v = versionOf(d);
    if (bestDir === null || newer(v, bestVer)) { bestDir = d; bestVer = v; }
  }
  return bestDir;
}

function entry(name) {
  // Cheap candidates first, and only shell out to npm when every one of them misses.
  const cheap = [
    ...npxGraftDirs(),
    fromPkg(dir),
    fromPkg(path.join(path.dirname(process.execPath), '..', 'lib')),
  ];
  const hit = best(cheap, name);
  if (hit) return path.join(hit, name);
  const gr = globalRoot();
  const global = gr && path.join(gr, '@nanonets', 'graft', 'dist', 'claude');
  if (global && fs.existsSync(path.join(global, name))) return path.join(global, name);
  return path.join(dir, 'dist', 'claude', name); // last-ditch; import will no-op if absent
}

import(pathToFileURL(entry("hooks.js")).href).then((m) => m.main(process.argv[2])).catch(() => { /* graft unavailable — no-op */ });
