/**
 * The driver's process seam (anton-kvag): the argv one run is launched with, the off-argv system
 * prompt file, the vitest spawn guard, and the stall watchdog. driver.test.ts proves the same flags
 * reach a real child; these pin the shapes without paying for a process.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  buildClaudeArgs,
  CLAUDE_BIN_ENV,
  createStallWatchdog,
  resolveClaudeBin,
  writeSystemPromptFile,
} from "./driver-spawn";

/** The value a flag was given in argv, or undefined when the flag was omitted. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

describe("buildClaudeArgs", () => {
  it("always runs print mode with stream-json, under bypassPermissions by default", () => {
    const args = buildClaudeArgs({});
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(flag(args, "--permission-mode")).toBe("bypassPermissions");
  });

  it("omits every optional flag whose value is unset or empty", () => {
    const args = buildClaudeArgs({ allowedTools: [], disallowedTools: [], settingSources: [] });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("joins list flags on commas and passes the system prompt as a file, never inline", () => {
    const args = buildClaudeArgs(
      {
        model: "opus",
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Write"],
        disallowedTools: ["Bash(git:*)", "Bash(gh:*)"],
        settingSources: ["user"],
      },
      "/tmp/sys.txt",
    );

    expect(flag(args, "--model")).toBe("opus");
    expect(flag(args, "--permission-mode")).toBe("acceptEdits");
    expect(flag(args, "--allowedTools")).toBe("Read,Write");
    expect(flag(args, "--disallowedTools")).toBe("Bash(git:*),Bash(gh:*)");
    expect(flag(args, "--setting-sources")).toBe("user");
    expect(flag(args, "--append-system-prompt-file")).toBe("/tmp/sys.txt");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("leads with --resume so the recorded argv shows a continuation at a glance (anton-juar)", () => {
    const args = buildClaudeArgs({ resumeSessionId: "sess-abc" });
    expect(args.slice(0, 2)).toEqual(["--resume", "sess-abc"]);
  });
});

describe("writeSystemPromptFile", () => {
  it("writes the prompt to a temp file and removes it on cleanup, idempotently", () => {
    const file = writeSystemPromptFile("be excellent");
    expect(file.path).toBeDefined();
    expect(readFileSync(file.path!, "utf8")).toBe("be excellent");

    file.cleanup();
    file.cleanup();
    expect(existsSync(file.path!)).toBe(false);
  });

  it("writes nothing when there is no system prompt", () => {
    const file = writeSystemPromptFile(undefined);
    expect(file.path).toBeUndefined();
    expect(() => file.cleanup()).not.toThrow();
  });
});

describe("resolveClaudeBin", () => {
  const saved = process.env[CLAUDE_BIN_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[CLAUDE_BIN_ENV];
    else process.env[CLAUDE_BIN_ENV] = saved;
  });

  it("returns the override, and refuses the real billable binary under vitest (anton-lixu)", () => {
    process.env[CLAUDE_BIN_ENV] = "/tmp/fake-claude";
    expect(resolveClaudeBin()).toBe("/tmp/fake-claude");

    delete process.env[CLAUDE_BIN_ENV];
    expect(() => resolveClaudeBin()).toThrow(CLAUDE_BIN_ENV);
  });
});

describe("createStallWatchdog", () => {
  afterEach(() => vi.useRealTimers());

  it("kills once the window elapses with no output, latching `stalled` before the kill", () => {
    vi.useFakeTimers();
    const kills: boolean[] = [];
    const watchdog = createStallWatchdog(1_000, () => kills.push(watchdog.stalled));

    watchdog.arm();
    vi.advanceTimersByTime(1_000);

    expect(kills).toEqual([true]);
    expect(watchdog.stalled).toBe(true);
  });

  it("rearms on output and stops on clear", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createStallWatchdog(1_000, onStall);

    watchdog.arm();
    vi.advanceTimersByTime(900);
    watchdog.arm(); // a byte arrived — the window restarts
    vi.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();

    watchdog.clear();
    vi.advanceTimersByTime(5_000);
    expect(onStall).not.toHaveBeenCalled();
    expect(watchdog.stalled).toBe(false);
  });

  it("is disabled by a non-finite or non-positive window", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();

    for (const stallMs of [0, -1, Number.POSITIVE_INFINITY]) {
      const watchdog = createStallWatchdog(stallMs, onStall);
      watchdog.arm();
    }
    vi.advanceTimersByTime(1_000_000);

    expect(onStall).not.toHaveBeenCalled();
  });
});
