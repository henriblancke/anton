/**
 * The client-safe boundary (anton-f3qj) is a lint rule, so it is worth as much as its coverage: a
 * rule that names only `better-sqlite3` still waves through `@/lib/runs`, which reaches it two hops
 * in. These cases run the project's real eslint config over the client-safe module's path and pin
 * what it rejects — including the transitive spellings a hand-listed denylist would miss.
 */
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const CLIENT_SAFE_FILE = "src/components/runs/run-view-utils.ts";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint();
});

async function importErrors(source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: CLIENT_SAFE_FILE });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message ?? "");
}

describe("the client-safe module's import boundary", () => {
  it.each([
    ["a node builtin", "import { readFileSync } from 'node:fs';"],
    ["a bare node builtin", "import { readFileSync } from 'fs';"],
    ["a server-only package", "import Database from 'better-sqlite3';"],
    ["the db module", "import { db } from '@/lib/db';"],
    ["a db submodule", "import { runs } from '@/lib/db/schema';"],
    // The finding this suite exists for: server-layer modules that only reach the db transitively.
    ["a server-layer module", "import { listRuns } from '@/lib/runs';"],
    ["another server-layer module", "import { listProjects } from '@/lib/projects';"],
    ["a nested server-layer module", "import { x } from '@/lib/jobs/run-formula';"],
    ["a relative path into the server layer", "import { listRuns } from '../../lib/runs';"],
  ])("rejects %s", async (_label, source) => {
    expect(await importErrors(source)).toHaveLength(1);
  });

  it("allows client-safe imports", async () => {
    const source = "import { useState } from 'react';\nexport const x = useState;\n";
    expect(await importErrors(source)).toEqual([]);
  });
});
