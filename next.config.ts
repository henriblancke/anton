import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server (.next/standalone) with a minimal, dependency-traced node_modules
  // so the release bundle ships only what the server actually imports (anton-1xp.6). The launcher
  // runs `node server.js` from it in bundle mode.
  output: "standalone",
  // Pin the tracing root to this project so the standalone output uses RELOCATABLE (relative) paths
  // for traced/external modules. Without it, appDir is baked as an absolute build path and the
  // relocated bundle can't resolve native externals (better-sqlite3) on the user's machine.
  outputFileTracingRoot: import.meta.dirname,
  // Keep native addons as real external files (not bundled) so their compiled `.node` binaries are
  // traced into the standalone output intact.
  serverExternalPackages: ["better-sqlite3", "node-pty"],
};

export default nextConfig;
