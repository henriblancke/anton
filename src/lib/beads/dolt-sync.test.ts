/**
 * Direct suite for dolt-sync.ts (anton-ql1n): one sync pass (runDoltSync) and the shared-server
 * preflight that guards it (preflightSharedServer), tested against the module itself with a fake
 * `exec` — no real bd/dolt is spawned. Board mode is controlled via board-mode.ts's `pinBoardMode`,
 * the one sanctioned way to simulate a server-mode repo without writing metadata.json.
 *
 * board-mode.test.ts already exercises this behaviour end-to-end through ./bd's re-export; this
 * file exists so the module itself is reachable by a test that imports it by name (the stringer
 * missing-tests signal), and pins the branches its own docstring calls out directly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBenignSyncOutput,
  isFirstPublishPullOutput,
  isNotWiredOutput,
  PREFLIGHT_TTL_MS,
  preflightSharedServer,
  resetServerPreflight,
  runDoltSync,
} from "@/lib/beads/dolt-sync";
import { pinBoardMode, resetBoardModeCache } from "@/lib/beads/board-mode";
import { BOARD_READ_PROBE } from "@/lib/beads/config.mjs";

const REPO = "/repos/widgets";

type TestExec = (cwd: string, args: string[]) => Promise<string>;

afterEach(() => {
  resetBoardModeCache();
  resetServerPreflight();
});

describe("isBenignSyncOutput / isNotWiredOutput / isFirstPublishPullOutput", () => {
  it("matches the documented benign phrasings", () => {
    expect(isBenignSyncOutput("Nothing to commit.")).toBe(true);
    expect(isBenignSyncOutput("No remote is configured — skipping.")).toBe(true);
    expect(isBenignSyncOutput("Permission denied (publickey).")).toBe(false);
  });

  it("matches both wordings bd uses for 'no remote', push and pull alike", () => {
    expect(isNotWiredOutput("No remote is configured — skipping.")).toBe(true);
    expect(isNotWiredOutput("fetch from origin/main: Error 1105: no remote")).toBe(true);
    expect(isNotWiredOutput("fetch from origin/main: Error 1105: no remote branch found")).toBe(false);
    expect(isNotWiredOutput("Permission denied (publickey).")).toBe(false);
  });

  it("matches only the never-pushed-remote pull failure", () => {
    expect(isFirstPublishPullOutput("no branches found in remote")).toBe(true);
    expect(isFirstPublishPullOutput("couldn't find remote ref refs/heads/main")).toBe(true);
    expect(isFirstPublishPullOutput("Permission denied (publickey).")).toBe(false);
  });
});

describe("runDoltSync — embedded mode", () => {
  it("runs pull, commit, push in order for a full pass", async () => {
    pinBoardMode(REPO, { mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      return "";
    };
    await expect(runDoltSync(REPO, exec, "full")).resolves.toBe("synced");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull", "dolt commit", "dolt push"]);
  });

  it("runs only pull for a pull-only pass", async () => {
    pinBoardMode(REPO, { mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      return "";
    };
    await expect(runDoltSync(REPO, exec, "pull")).resolves.toBe("synced");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull"]);
  });

  it("stops the pass and reports not-wired when a step answers with no-remote", async () => {
    pinBoardMode(REPO, { mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      if (args.join(" ") === "dolt pull") throw Object.assign(new Error("x"), { stderr: "No remote is configured — skipping.\n" });
      return "";
    };
    await expect(runDoltSync(REPO, exec, "full")).resolves.toBe("not-wired");
    // The pass stops at the first not-wired step — commit/push never run.
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull"]);
  });

  it("tolerates a benign step failure and continues the pass", async () => {
    pinBoardMode(REPO, { mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      if (args.join(" ") === "dolt commit") throw Object.assign(new Error("x"), { stderr: "Nothing to commit.\n" });
      return "";
    };
    await expect(runDoltSync(REPO, exec, "full")).resolves.toBe("synced");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull", "dolt commit", "dolt push"]);
  });

  it("tolerates a first-publish pull failure only, and still pushes", async () => {
    pinBoardMode(REPO, { mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      if (args.join(" ") === "dolt pull") {
        throw Object.assign(new Error("x"), { stderr: "no branches found in remote\n" });
      }
      return "";
    };
    await expect(runDoltSync(REPO, exec, "full")).resolves.toBe("synced");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull", "dolt commit", "dolt push"]);
  });

  it("does NOT tolerate a first-publish-shaped failure on push — only pull gets that pass", async () => {
    pinBoardMode(REPO, { mode: "embedded" });
    const exec: TestExec = async (_cwd, args) => {
      if (args.join(" ") === "dolt push") {
        throw Object.assign(new Error("x"), { stderr: "no branches found in remote\n" });
      }
      return "";
    };
    await expect(runDoltSync(REPO, exec, "full")).rejects.toThrow(/bd dolt push failed/);
  });

  it("rejects on a real pull failure before push ever runs", async () => {
    pinBoardMode(REPO, { mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      if (args.join(" ") === "dolt pull") {
        throw Object.assign(new Error("x"), { stderr: "Permission denied (publickey).\n" });
      }
      return "";
    };
    await expect(runDoltSync(REPO, exec, "full")).rejects.toThrow(/bd dolt pull failed in \/repos\/widgets/);
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull"]);
  });

  it("rejects on a real commit/push failure, with bd's output attached", async () => {
    pinBoardMode(REPO, { mode: "embedded" });
    const exec: TestExec = async (_cwd, args) => {
      if (args.join(" ") === "dolt push") {
        throw Object.assign(new Error("x"), { stderr: "Error 1105: failed to get remote db\n" });
      }
      return "";
    };
    await expect(runDoltSync(REPO, exec, "full")).rejects.toThrow(/failed to get remote db/);
  });
});

describe("runDoltSync — server mode", () => {
  it("spawns no pull/commit/push, and returns shared-server after a successful preflight", async () => {
    pinBoardMode(REPO, { mode: "server", host: "h", port: 3306 });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      return "";
    };
    await expect(runDoltSync(REPO, exec, "full")).resolves.toBe("shared-server");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt test", BOARD_READ_PROBE.join(" ")]);
  });

  it("skips the preflight entirely when probeServer is false, and spawns nothing", async () => {
    pinBoardMode(REPO, { mode: "server", host: "h", port: 3306 });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      return "";
    };
    await expect(runDoltSync(REPO, exec, "full", false)).resolves.toBe("shared-server");
    expect(calls).toEqual([]);
  });
});

describe("preflightSharedServer — refusal paths", () => {
  it("resolves once both probes succeed, and caches so a second call spawns nothing more", async () => {
    pinBoardMode(REPO, { mode: "server", host: "h", port: 3306 });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      return "";
    };
    await expect(preflightSharedServer(REPO, exec)).resolves.toBeUndefined();
    await expect(preflightSharedServer(REPO, exec)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2); // one round of probes, not two
  });

  it("names the configured target and the underlying error when the server itself is unreachable", async () => {
    pinBoardMode(REPO, { mode: "server", host: "dolt.example.dev", port: 3306, database: "anton" });
    const exec: TestExec = async (_cwd, args) => {
      if (args.join(" ") === "dolt test") {
        throw Object.assign(new Error("boom"), { stderr: "dial tcp 127.0.0.1:3306: connection refused\n" });
      }
      return "";
    };
    await expect(preflightSharedServer(REPO, exec)).rejects.toThrow(/shared Dolt server unreachable/);
    await expect(preflightSharedServer(REPO, exec)).rejects.toThrow(/dolt\.example\.dev:3306\/anton/);
    await expect(preflightSharedServer(REPO, exec)).rejects.toThrow(/connection refused/);
  });

  it("refuses with a distinct message when the server answers but will not serve this board", async () => {
    pinBoardMode(REPO, { mode: "server", host: "h", port: 3306 });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd, args) => {
      calls.push(args);
      if (args.join(" ") === BOARD_READ_PROBE.join(" ")) {
        throw Object.assign(new Error("boom"), { stderr: "PROJECT IDENTITY MISMATCH — refusing to connect\n" });
      }
      return "";
    };
    await expect(preflightSharedServer(REPO, exec)).rejects.toThrow(/will not serve the board/);
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt test", BOARD_READ_PROBE.join(" ")]);
  });

  it("does not cache a failed round — the next call re-probes rather than waiting out a TTL it never earned", async () => {
    pinBoardMode(REPO, { mode: "server", host: "h", port: 3306 });
    let attempts = 0;
    const exec: TestExec = async (_cwd, args) => {
      if (args.join(" ") === "dolt test") {
        attempts++;
        if (attempts === 1) throw new Error("connection refused");
      }
      return "";
    };
    await expect(preflightSharedServer(REPO, exec)).rejects.toThrow();
    await expect(preflightSharedServer(REPO, exec)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("re-probes after PREFLIGHT_TTL_MS, so a server that dies post-startup surfaces", async () => {
    pinBoardMode(REPO, { mode: "server", host: "h", port: 3306 });
    let up = true;
    let attempts = 0;
    const exec: TestExec = async (_cwd, args) => {
      if (args.join(" ") === "dolt test") {
        attempts++;
        if (!up) throw new Error("connection refused");
      }
      return "";
    };

    vi.useFakeTimers();
    try {
      await expect(preflightSharedServer(REPO, exec)).resolves.toBeUndefined();
      up = false;
      vi.advanceTimersByTime(PREFLIGHT_TTL_MS - 1);
      await expect(preflightSharedServer(REPO, exec)).resolves.toBeUndefined();
      expect(attempts).toBe(1); // still within the TTL — the cached pass holds

      vi.advanceTimersByTime(1);
      await expect(preflightSharedServer(REPO, exec)).rejects.toThrow(/unreachable/);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
