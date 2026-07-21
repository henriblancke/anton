import { defineConfig, configDefaults } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Default (unit) project. The bd/git-backed `*.integration.test.ts` suites are deliberately
// EXCLUDED here and run via their own config (`vitest.integration.config.ts`, `bun run
// test:integration`): they drive real Dolt sql-servers that race under full fork parallelism, so
// they need a capped-concurrency pool the fast unit run must not pay for. `bun run test` stays the
// quick, fully-parallel gate (it never actually ran the integration suites anyway — without `bd`
// on PATH they self-skipped).
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
