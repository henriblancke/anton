import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Integration project: the bd/git-backed `*.integration.test.ts` suites only. Split out from the
// default unit config (`vitest.config.ts`) because these tests each drive a REAL, per-repo Dolt
// sql-server that `bd` auto-starts on an auto-detected port. At full fork parallelism (one fork per
// CPU) a dozen servers spin up at once and race on port selection / the embedded-Dolt lock, which
// deadlocks `bd dolt pull` — the whole suite then hangs indefinitely rather than failing. Capping
// the fork pool keeps only a few servers starting concurrently, which reliably clears the deadlock.
// Run with `bun run test:integration`.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // `.tsx` too: an e2e whose acceptance is what the BOARD renders (anton-bz1w) drives the real
    // job and then renders the panel off what it stored, so the suite is both bd-backed and JSX.
    include: ["src/**/*.integration.test.ts", "src/**/*.integration.test.tsx"],
    // The same database guard the unit config installs. These suites build their own temp anton.db
    // via `makeFileDb`, which assigns ANTON_DB inside the test file and so wins over this default.
    setupFiles: ["./vitest.setup.ts"],
    // Generous, UNIFORM headroom: each case shells out to bd/Dolt/git many times, so under load (or
    // a busy CI runner) a normally-15s e2e case can spike well past a tight limit. Integration tests
    // rely on this single ceiling rather than scattered per-`it` literals — a per-test timeout would
    // OVERRIDE this and silently reintroduce the tight caps we're widening. 150s covers the longest
    // legitimate case; a genuine deadlock hangs indefinitely, so it still surfaces here.
    testTimeout: 150_000,
    hookTimeout: 150_000,
    // Reliability knob, not just a speed one: above ~4 concurrent workers the Dolt-server race
    // above reappears. `maxWorkers` caps how many test FILES run at once (vitest 4 replaced
    // `poolOptions.forks.maxForks` with this top-level option). Tune up only alongside evidence the
    // suite still completes without hanging.
    maxWorkers: 4,
  },
});
