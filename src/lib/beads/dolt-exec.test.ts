/**
 * The seam dolt-exec and dolt-sync exist to hold (anton-n1m0): bd.ts and sync-coalescer.ts used to
 * import each other — bd.ts for the coalescer, the coalescer for the pass — so neither could be
 * loaded or reasoned about without the other. The pass moved down into dolt-sync (over dolt-exec's
 * spawn), and the only thing keeping it down is this: a nightly stringer scan would refile the cycle
 * a day late, and by then the import that closed it is already something else's dependency.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as bd from "./bd";

const source = (rel: string): string =>
  readFileSync(join(process.cwd(), "src/lib/beads", rel), "utf8");

/** Import specifiers this module pulls from, as written. */
const importsOf = (rel: string): string[] =>
  [...source(rel).matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);

describe("the bd ↔ sync-coalescer cycle stays broken", () => {
  // The runtime edge is ./dolt-sync (it carries runDoltSync); ./dolt-exec is a type-only import, so
  // asserting it alone would stay green while dolt-sync quietly re-closed the cycle.
  it("has the coalescer reach the pass through ./dolt-sync, never back through ./bd", () => {
    const imports = importsOf("sync-coalescer.ts");
    expect(imports).toContain("./dolt-sync");
    expect(imports).not.toContain("./bd");
  });

  it("leaves dolt-sync dependent on neither side it serves", () => {
    expect(importsOf("dolt-sync.ts")).not.toContain("./bd");
    expect(importsOf("dolt-sync.ts")).not.toContain("./sync-coalescer");
  });

  it("leaves dolt-exec dependent on neither side it serves", () => {
    expect(importsOf("dolt-exec.ts")).not.toContain("./bd");
    expect(importsOf("dolt-exec.ts")).not.toContain("./sync-coalescer");
  });
});

describe("bd.ts's public surface survives the move", () => {
  // Every one of these was exported from bd.ts before the split and is imported from there by
  // production code or a suite; a re-export dropped in a later edit fails here, not at a call site.
  it.each([
    "runDoltSync",
    "runBdForTest",
    "preflightSharedServer",
    "resetServerPreflight",
    "isBenignSyncOutput",
    "isNotWiredOutput",
    "isFirstPublishPullOutput",
    "getSyncStatus",
    "getSyncStatusToken",
  ])("still exports %s", (name) => {
    expect(typeof (bd as unknown as Record<string, unknown>)[name]).toBe("function");
  });

  it.each([
    "BD_STEP_TIMEOUT_MS",
    "BD_STEP_TIMEOUT_ENV",
    "BD_KILL_GRACE_ENV",
    "BD_MAX_BUFFER_ENV",
    "PREFLIGHT_TTL_MS",
    "SYNC_STALL_MS",
  ])("still exports %s", (name) => {
    expect((bd as unknown as Record<string, unknown>)[name]).toBeDefined();
  });
});
