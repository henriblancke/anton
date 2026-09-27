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
  // The off-thread build-identity reader (anton-fzarz) is started with `new Worker(<path>)` at run
  // time, so nft cannot see it: webpack bundles `identity.mjs` into the server chunk and neither file
  // survives as a real sibling in `.next/standalone`. Both are named because an include COPIES
  // matches rather than re-tracing them — the worker alone would land beside no `./identity.mjs` to
  // import, and die at module load. `scripts/build-bundle.mjs` stages the same two files for the
  // release bundle, whose stage is assembled from the repo rather than from this output.
  outputFileTracingIncludes: {
    "/**": ["src/lib/build/identity-worker.mjs", "src/lib/build/identity.mjs"],
  },
};

export default nextConfig;
