/**
 * anton-jyrhf — {@link warmWorktreeBestEffort} REPORTS what warming did, instead of dropping it into
 * a console nobody persists.
 *
 * The failure this closes: a warm that died on an unresolvable dependency was invisible for minutes
 * and then misattributed, surfacing as a git push error naming an unrelated subsystem. These cases
 * assert the two halves that make it queryable at the moment it happens — a distinguishable outcome
 * per state, and a failure carrying WHICH command failed and what it said — plus the two invariants
 * the record must not cost: warming still never throws, and the loud log stays.
 *
 * No git here: warming operates on a directory, so a temp dir standing in for a checkout exercises
 * the whole decision. The shell-out is a pinned fake (WARM_COMMAND_ENV), never a real installer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Fails `resolveWarmPlan` itself, which is the only way to reach the unexpected-throw path. */
const resolutionFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync(path: Parameters<typeof actual.existsSync>[0]) {
      if (resolutionFailure.enabled && String(path).endsWith("bun.lock")) {
        throw new Error("temporary filesystem failure");
      }
      return actual.existsSync(path);
    },
  };
});

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmWorktreeBestEffort, WARM_COMMAND_ENV, WARM_ENV, type Worktree } from "./worktree";

const dirs: string[] = [];
let warn: ReturnType<typeof vi.spyOn>;

/** A worktree-shaped temp dir containing `files` (name → contents). */
function worktree(files: Record<string, string> = {}): Worktree {
  const dir = mkdtempSync(join(tmpdir(), "anton-warm-outcome-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { path: dir, branch: "anton/anton-abc", baseBranch: "main", createdBranch: true, repoPath: "/repo" };
}

/** Pin the command warming runs, so nothing here ever shells out to a real package manager. */
function pin(command: string): void {
  process.env[WARM_COMMAND_ENV] = command;
}

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  resolutionFailure.enabled = false;
  delete process.env[WARM_COMMAND_ENV];
  delete process.env[WARM_ENV];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("warmWorktreeBestEffort reports its outcome", () => {
  it("records ok with the command that ran", async () => {
    pin("mkdir -p node_modules");

    expect(await warmWorktreeBestEffort(worktree())).toEqual({
      outcome: "ok",
      command: "mkdir -p node_modules",
    });
  });

  it("records a failure with its command label and the tail of what it said — and still returns", async () => {
    pin("echo 'error: Could not resolve @tailwindcss/vite' >&2; exit 1");
    const wt = worktree();

    const outcome = await warmWorktreeBestEffort(wt);

    expect(outcome.outcome).toBe("failed");
    expect(outcome.command).toBe("echo 'error: Could not resolve @tailwindcss/vite' >&2; exit 1");
    expect(outcome.error).toContain("Could not resolve @tailwindcss/vite");
    // The record is an addition, not a trade: a human tailing the daemon still sees the failure.
    expect(warn.mock.calls.flat().join(" ")).toContain("Could not resolve @tailwindcss/vite");
  });

  it("bounds the stderr tail, so a runaway installer cannot grow a run row without limit", async () => {
    pin("head -c 20000 /dev/zero | tr '\\0' 'x' >&2; exit 1");

    const outcome = await warmWorktreeBestEffort(worktree());

    expect(outcome.outcome).toBe("failed");
    expect(outcome.error).toHaveLength(2000);
  });

  it("records disabled when warming is turned off — nothing was even looked for", async () => {
    process.env[WARM_ENV] = "off";
    pin("exit 1"); // The opt-out wins over a pinned command, and nothing runs.

    expect(await warmWorktreeBestEffort(worktree({ "bun.lock": "{}" }))).toEqual({ outcome: "disabled" });
  });

  it("records skipped when warming looked and found nothing to run", async () => {
    // VITEST short-circuits as `disabled` by design, so the detection path needs it out of the way.
    const priorVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      // No recognized lockfile — a go/rust/python repo warms to a no-op.
      expect(await warmWorktreeBestEffort(worktree({ "go.mod": "module tmp" }))).toEqual({
        outcome: "skipped",
      });

      // And the reuse path: a resumed run whose checkout already carries a completed install.
      const warmed = worktree({ "bun.lock": "{}" });
      mkdirSync(join(warmed.path, "node_modules"));
      writeFileSync(join(warmed.path, "node_modules", ".anton-warm"), "2\nbun install --frozen-lockfile\n");
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(warmed.path, "bun.lock"), old, old);

      expect(await warmWorktreeBestEffort(warmed)).toEqual({ outcome: "skipped" });
    } finally {
      if (priorVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = priorVitest;
    }
  });

  // A skipped warm ran and found nothing; a disabled one never looked. The run row has to keep them
  // apart — one explains a warm tree, the other explains a cold one.
  it("keeps skipped and disabled distinguishable for the same installable checkout", async () => {
    const priorVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const wt = worktree({ "go.mod": "module tmp" });
      expect((await warmWorktreeBestEffort(wt)).outcome).toBe("skipped");

      process.env[WARM_ENV] = "off";
      expect((await warmWorktreeBestEffort(wt)).outcome).toBe("disabled");
    } finally {
      if (priorVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = priorVitest;
    }
  });

  // Warming broke before it could resolve a command, so there is no label to name — but this path is
  // as invisible to a later symptom as a failed install, and just as worth having on the row.
  it("records a failure with no command when warming breaks before resolving one", async () => {
    const priorVitest = process.env.VITEST;
    delete process.env.VITEST;
    resolutionFailure.enabled = true;
    try {
      const outcome = await warmWorktreeBestEffort(worktree({ "bun.lock": "{}" }));

      expect(outcome).toEqual({ outcome: "failed", error: "temporary filesystem failure" });
      expect(warn.mock.calls.flat().join(" ")).toContain("failed unexpectedly");
    } finally {
      if (priorVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = priorVitest;
    }
  });
});
