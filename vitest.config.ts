import { defineConfig, configDefaults } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Default (unit) project. The `*.integration.test.ts` suites are deliberately EXCLUDED here and run
// via their own config (`vitest.integration.config.ts`, `bun run test:integration`): they drive
// real Dolt sql-servers that race under full fork parallelism, so they need a capped-concurrency
// pool the fast unit run must not pay for. Excluding them costs this gate no coverage — every
// `*.integration.test.ts` self-skips without its required binary (bd/git for the Dolt suites,
// node-pty's native addon for the pty suite), so they never actually executed here anyway.
// IMPORTANT: parallel-safe route/DB tests that must gate PRs (in-memory or temp-sqlite, no Dolt)
// stay named plain `*.test.ts` so they run in THIS blocking gate — do NOT give them the
// `.integration` infix, or the exclude below silently drops them into the report-only integration
// job. `bun run test` stays the quick, fully-parallel gate.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "bin/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
    // A handful of non-integration suites still touch a temp sqlite db; keep vitest's 5s default
    // comfortably clear of that under load.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      // Report-only (no thresholds yet). `bun run test:coverage` prints a text summary
      // locally; CI uploads the lcov/html report as an artifact — see ci.yml.
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**", "bin/**"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts"],
    },
  },
});
