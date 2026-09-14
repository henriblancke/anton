import { builtinModules } from "node:module";
import { posix as path } from "node:path";
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

const SERVER_LAYER_DIR = "src/lib";

/**
 * Every spelling of `src/lib` reachable from a client-safe module: the `@/lib` alias, plus the
 * relative path from each module's own directory. Derived per module rather than globbed as
 * `**\/lib` — that shape also matches a third-party `some-package/lib/x`, which would report a
 * server-layer violation for an import that has nothing to do with the server layer. Deriving it
 * keeps the guard exhaustive as the list above grows, whatever depth a module sits at.
 */
const SERVER_LAYER_PATTERNS = [
  ...new Set([
    "@/lib",
    "@/lib/**",
    ...CLIENT_SAFE_MODULES.flatMap((file) => {
      const relative = path.relative(path.dirname(file), SERVER_LAYER_DIR);
      return [relative, `${relative}/**`];
    }),
  ]),
];

/**
 * `builtinModules` reflects whichever runtime runs ESLint — under Node it omits Bun's `bun:*`
 * builtins, under Bun it includes them. The patterns below name them explicitly, so drop them here
 * to keep the guard exhaustive and the report identical either way.
 */
const NODE_BUILTIN_PATHS = builtinModules.filter(
  (name) => name !== "bun" && !name.startsWith("bun:"),
);

/**
 * The canonical display locale (anton-icda) is a repo-wide convention, and a convention nobody can
 * see is one grep away from being re-broken. A `toLocale*` call with no locale is not "the user's
 * locale" — it is the *server's* under SSR and the *browser's* after hydration, which is how a
 * server-rendered client component ends up with two different strings for one timestamp.
 */
const HOST_LOCALE_MESSAGE =
  "Format user-facing dates and times with DISPLAY_LOCALE from @/lib/time, not the host locale. Omitting the locale (or passing `undefined`) resolves to the server's locale during SSR and the browser's on the client, so anything that server-renders can hydrate to different text. See docs/ui-brief.md -> Foundations.";

/** Every locale-sensitive `toLocale*` method — dates, times, and the string-case pair. */
const HOST_LOCALE_CALL = "CallExpression[callee.property.name=/^toLocale/]";

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
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: `${HOST_LOCALE_CALL}[arguments.length=0]`, message: HOST_LOCALE_MESSAGE },
        {
          selector: `${HOST_LOCALE_CALL}[arguments.0.type="Identifier"][arguments.0.name="undefined"]`,
          message: HOST_LOCALE_MESSAGE,
        },
      ],
    },
  },
  {
    files: CLIENT_SAFE_MODULES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: NODE_BUILTIN_PATHS.map((name) => ({ name, message: SERVER_ONLY_IMPORT_MESSAGE })),
          patterns: [
            {
              group: [
                "node:*",
                "bun",
                "bun:*",
                "better-sqlite3",
                "node-pty",
                "drizzle-orm",
                "drizzle-orm/*",
              ],
              message: SERVER_ONLY_IMPORT_MESSAGE,
            },
            {
              group: SERVER_LAYER_PATTERNS,
              message: SERVER_LAYER_IMPORT_MESSAGE,
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
