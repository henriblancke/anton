import { builtinModules } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Modules that must never reach the browser bundle. `client-only` can't guard the client-safe
 * modules below — server code imports them too (`src/lib/runs.ts`), so the package's server throw
 * would fire on a legitimate import. Lint keeps the one-way dependency honest instead: a violation
 * reads as a rule failure here, not as a better-sqlite3 reference deep in a browser bundle.
 */
const SERVER_ONLY_IMPORT_MESSAGE =
  "This module is client-safe and is bundled for the browser — it may not import node builtins, the db, or server-only packages. Declare the shape here and do the server work in src/lib.";

/**
 * `src/lib` is the server layer, and lint can only see the edge in front of it — never the
 * transitive one behind it. So the whole directory is off limits rather than an enumerated list of
 * today's server entry points, which would go stale the first time a new one lands: `@/lib/runs`
 * looks innocent at the import site but reaches better-sqlite3 two hops in.
 */
const SERVER_LAYER_IMPORT_MESSAGE =
  "src/lib is the server layer — importing any of it can pull better-sqlite3 into the browser bundle transitively. The dependency points server -> client-safe: declare the shape here and let src/lib import it, never the reverse.";

const CLIENT_SAFE_MODULES = ["src/components/runs/run-view-utils.ts"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prebuilt release bundles (anton-1xp) — generated output, never linted.
    "dist/**",
  ]),
  {
    files: CLIENT_SAFE_MODULES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules.map((name) => ({ name, message: SERVER_ONLY_IMPORT_MESSAGE })),
          patterns: [
            {
              group: ["node:*", "better-sqlite3", "node-pty", "drizzle-orm", "drizzle-orm/*"],
              message: SERVER_ONLY_IMPORT_MESSAGE,
            },
            {
              // Both spellings of the server layer: the `@/lib` alias and any relative path into it.
              group: ["@/lib", "@/lib/**", "**/lib", "**/lib/**"],
              message: SERVER_LAYER_IMPORT_MESSAGE,
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
