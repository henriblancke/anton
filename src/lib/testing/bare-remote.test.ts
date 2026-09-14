/**
 * Unit coverage for the integration harness's sandbox remote. Like removeTempRepo's suite, the
 * behavior under test is one that reddened otherwise-green CI runs: `git receive-pack` firing a
 * DETACHED `git gc --auto` on the remote once a suite's pushes cross the pack limit, then repacking
 * — and deleting the old packs — underneath the next clone or `bd dolt push`.
 *
 * Asserted behaviorally rather than by reading config back: pushing past the limit must leave every
 * pack in place. With auto-gc on, git collapses them (60 packs became 10 when this was measured).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasGit, initBareRemote } from "./integration";

/** Comfortably past git's `gc.autoPackLimit` default of 50 — one push lands one pack here. */
const PUSHES = 60;

const describeGit = hasGit() ? describe : describe.skip;

describeGit("initBareRemote", () => {
  it("keeps every pack a suite pushes — auto-gc never repacks underneath a concurrent reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "anton-bare-test-"));
    try {
      const bare = join(dir, "remote.git");
      const work = join(dir, "work");
      initBareRemote(bare);

      const g = (...args: string[]) => execFileSync("git", ["-C", work, ...args], { stdio: "ignore" });
      execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "ignore" });
      g("config", "user.email", "t@example.com");
      g("config", "user.name", "anton-test");
      g("remote", "add", "origin", bare);

      for (let i = 0; i < PUSHES; i++) {
        writeFileSync(join(work, "f.txt"), `${i}\n`);
        g("add", "-A");
        g("commit", "-q", "-m", `c${i}`);
        g("push", "-q", "origin", "main");
      }

      const packs = readdirSync(join(bare, "objects", "pack")).filter((f) => f.endsWith(".pack"));
      expect(packs).toHaveLength(PUSHES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
