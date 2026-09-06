/**
 * Cancellation of the dead-code reference check (anton-23xe), at the one phase the greps don't
 * cover: after `git grep` answers, the matched files still have to be read, and a filter that read
 * them out and returned would let a pass the caller stopped write its scan file and record a health
 * point. Both edges are timing the suite cannot stage from the outside, so `readFile` itself is the
 * hook — the abort lands exactly where it has to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterDeadcodeSignals } from "./scan-deadcode";

// Hoisted so the `node:fs/promises` mock — which vitest lifts above the imports — can close over
// it. The reads run for real; each test only says when the abort arrives around one.
const onRead = vi.hoisted(() => ({
  before: undefined as (() => void) | undefined,
  after: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      onRead.before?.();
      const text = await actual.readFile(...args);
      onRead.after?.();
      return text;
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-deadcode-abort-"));
});

afterEach(() => {
  onRead.before = undefined;
  onRead.after = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A committed tree — the reference check asks git what the repo holds. */
function initRepo(files: Record<string, string>): string {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const run = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "test");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(repo, name, ".."), { recursive: true });
    writeFileSync(join(repo, name), body, "utf8");
  }
  run("add", "-A");
  run("commit", "-qm", "init");
  return repo;
}

const unused = (path: string, symbol: string) => ({
  Source: "deadcode",
  Kind: "unused-function",
  FilePath: path,
  Line: 1,
  Title: `Unused function: ${symbol}`,
  Description: "",
  Confidence: 0.3,
  Tags: ["dead-code"],
});

describe("dead-code reference check cancelled after git grep answers", () => {
  const repoFiles = {
    "src/testing/integration.ts": "export function withOperator() {}\n",
    "src/routes/claim.test.ts": "withOperator();\n",
  };

  it("stops on an abort that arrives while a matched file is being read", async () => {
    const repo = initRepo(repoFiles);
    const ac = new AbortController();
    onRead.before = () => ac.abort();

    await expect(
      filterDeadcodeSignals(repo, [unused("src/testing/integration.ts", "withOperator")], {
        abort: ac.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  // The last file read is the last thing the pass does: with no grep and no read left to check the
  // signal on, only a check on the way out can stop a verdict nobody is waiting for.
  it("stops on an abort that arrives once the last matched file has been read", async () => {
    const repo = initRepo(repoFiles);
    const ac = new AbortController();
    onRead.after = () => ac.abort();

    await expect(
      filterDeadcodeSignals(repo, [unused("src/testing/integration.ts", "withOperator")], {
        abort: ac.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
