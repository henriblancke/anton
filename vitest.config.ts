import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "bin/**/*.test.ts"],
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
