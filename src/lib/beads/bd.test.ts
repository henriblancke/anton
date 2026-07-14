import { describe, expect, it } from "vitest";
import {
  buildUpdateArgs,
  createDoltSync,
  getSyncStatus,
  isBenignSyncOutput,
  isNotWiredOutput,
  runDoltSync,
} from "./bd";

describe("buildUpdateArgs", () => {
  it("builds a title-only update", () => {
    expect(buildUpdateArgs("bd-1", { title: "New title" })).toEqual([
      "update",
      "bd-1",
      "--title",
      "New title",
    ]);
  });

  it("builds a status + priority update", () => {
    expect(buildUpdateArgs("bd-1", { status: "in_progress", priority: 1 })).toEqual([
      "update",
      "bd-1",
      "--status",
      "in_progress",
      "--priority",
      "1",
    ]);
  });

  it("passes through acceptance and description", () => {
    expect(
      buildUpdateArgs("bd-1", { acceptance: "- [ ] works", description: "## Goal\nShip it" }),
    ).toEqual([
      "update",
      "bd-1",
      "--acceptance",
      "- [ ] works",
      "--description",
      "## Goal\nShip it",
    ]);
  });

  it("keeps priority 0 (falsy but meaningful)", () => {
    expect(buildUpdateArgs("bd-1", { priority: 0 })).toEqual([
      "update",
      "bd-1",
      "--priority",
      "0",
    ]);
  });

  it("diffs only the changed agent prefix and preserves control labels", () => {
    // agent:nextjs → fastapi; approved / stage:* / source:* must be untouched.
    const args = buildUpdateArgs(
      "bd-1",
      { labels: { agent: "fastapi" } },
      ["agent:nextjs", "risk:low", "approved", "stage:implementing", "source:stringer"],
    );
    expect(args).toEqual([
      "update",
      "bd-1",
      "--remove-label",
      "agent:nextjs",
      "--add-label",
      "agent:fastapi",
    ]);
    // no touch to approved / stage / source / the unchanged risk label
    expect(args).not.toContain("approved");
    expect(args).not.toContain("stage:implementing");
    expect(args).not.toContain("source:stringer");
    expect(args).not.toContain("risk:low");
  });

  it("adds a label when the prefix is not yet present", () => {
    expect(buildUpdateArgs("bd-1", { labels: { domain: "eng" } }, ["agent:nextjs"])).toEqual([
      "update",
      "bd-1",
      "--add-label",
      "domain:eng",
    ]);
  });

  it("is a no-op when the label value is unchanged", () => {
    expect(buildUpdateArgs("bd-1", { labels: { agent: "nextjs" } }, ["agent:nextjs"])).toBeNull();
  });

  it("combines a scalar edit with a label diff in one invocation", () => {
    expect(
      buildUpdateArgs("bd-1", { title: "T", labels: { size: "L" } }, ["size:S", "approved"]),
    ).toEqual([
      "update",
      "bd-1",
      "--title",
      "T",
      "--remove-label",
      "size:S",
      "--add-label",
      "size:L",
    ]);
  });

  it("treats an empty patch as no write", () => {
    expect(buildUpdateArgs("bd-1", {})).toBeNull();
  });

  it("treats empty-string and undefined fields as no-ops", () => {
    expect(buildUpdateArgs("bd-1", { title: "", status: undefined })).toBeNull();
    expect(buildUpdateArgs("bd-1", { labels: { agent: "", risk: undefined } }, ["agent:nextjs"]))
      .toBeNull();
  });
});

describe("isBenignSyncOutput", () => {
  it("matches a clean working set and a missing remote", () => {
    expect(isBenignSyncOutput("Nothing to commit.")).toBe(true);
    expect(isBenignSyncOutput("No remote is configured — skipping.")).toBe(true);
    expect(isBenignSyncOutput("No remotes configured.")).toBe(true);
  });

  it("does not match real failures", () => {
    expect(
      isBenignSyncOutput("Error: push to origin/main: Error 1105: failed to get remote db"),
    ).toBe(false);
    expect(isBenignSyncOutput("Permission denied (publickey).")).toBe(false);
  });
});

/** A promisified-execFile-shaped failure: message + captured stdout/stderr. */
const execError = (out: { stdout?: string; stderr?: string }) =>
  Object.assign(new Error("Command failed: bd"), out);

describe("isNotWiredOutput", () => {
  it("matches only the missing-remote outcome, not a clean working set", () => {
    expect(isNotWiredOutput("No remote is configured — skipping.")).toBe(true);
    expect(isNotWiredOutput("No remotes configured.")).toBe(true);
    expect(isNotWiredOutput("Nothing to commit.")).toBe(false);
  });
});

describe("runDoltSync", () => {
  it("a full pass runs `bd dolt pull`, `commit`, `push` in order against the given cwd", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    await expect(
      runDoltSync("/repo", async (cwd, args) => {
        calls.push({ cwd, args });
        return "";
      }),
    ).resolves.toBe("synced");
    expect(calls).toEqual([
      { cwd: "/repo", args: ["dolt", "pull"] },
      { cwd: "/repo", args: ["dolt", "commit"] },
      { cwd: "/repo", args: ["dolt", "push"] },
    ]);
  });

  it("a pull-only pass never invokes commit or push", async () => {
    const calls: string[][] = [];
    await expect(
      runDoltSync(
        "/repo",
        async (_cwd, args) => {
          calls.push(args);
          return "";
        },
        "pull",
      ),
    ).resolves.toBe("synced");
    expect(calls).toEqual([["dolt", "pull"]]);
  });

  it("resolves not-wired (and stops the pass) when no remote is configured", async () => {
    const calls: string[][] = [];
    await expect(
      runDoltSync("/repo", async (_cwd, args) => {
        calls.push(args);
        throw execError({ stderr: "No remote is configured — skipping.\n" });
      }),
    ).resolves.toBe("not-wired");
    expect(calls).toEqual([["dolt", "pull"]]); // no push attempt against a not-wired workspace
  });

  it("tolerates nothing-to-commit", async () => {
    await expect(
      runDoltSync("/repo", async (_cwd, args) => {
        if (args[1] === "commit") throw execError({ stdout: "Nothing to commit.\n" });
        return "";
      }),
    ).resolves.toBe("synced");
  });

  it("a full pass survives a pull failure (never-pushed remote) and proceeds to push", async () => {
    const calls: string[][] = [];
    await expect(
      runDoltSync("/repo", async (_cwd, args) => {
        calls.push(args);
        if (args[1] === "pull") throw execError({ stderr: "fatal: couldn't find remote ref\n" });
        return "";
      }),
    ).resolves.toBe("synced");
    expect(calls).toEqual([
      ["dolt", "pull"],
      ["dolt", "commit"],
      ["dolt", "push"],
    ]);
  });

  it("a pull-only pass rejects on a real pull failure", async () => {
    await expect(
      runDoltSync(
        "/repo",
        async () => {
          throw execError({ stderr: "Error: failed to get remote db\n" });
        },
        "pull",
      ),
    ).rejects.toThrow(/bd dolt pull failed [\s\S]*failed to get remote db/);
  });

  it("rejects on a real push failure, carrying the bd output", async () => {
    await expect(
      runDoltSync("/repo", async (_cwd, args) => {
        if (args[1] === "commit" || args[1] === "pull") return "";
        throw execError({ stderr: "Error: push to origin/main: permission denied\n" });
      }),
    ).rejects.toThrow(/bd dolt push failed [\s\S]*permission denied/);
  });

  it("a real commit failure stops the sync before push runs", async () => {
    const calls: string[][] = [];
    await expect(
      runDoltSync("/repo", async (_cwd, args) => {
        calls.push(args);
        if (args[1] === "pull") return "";
        throw execError({ stderr: "database is locked" });
      }),
    ).rejects.toThrow(/bd dolt commit failed/);
    expect(calls).toEqual([
      ["dolt", "pull"],
      ["dolt", "commit"],
    ]);
  });
});

describe("createDoltSync", () => {
  it("coalesces syncs requested during an in-flight run into one trailing run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "commit") {
        runs += 1;
        if (runs === 1) await gate; // park the first run so a burst can pile up behind it
      }
      return "";
    });

    const first = sync("/repo");
    const second = sync("/repo");
    const third = sync("/repo");
    expect(second).toBe(third); // the burst shares ONE trailing sync
    expect(second).not.toBe(first);

    release();
    await Promise.all([first, second, third]);
    expect(runs).toBe(2); // 3 requests → 1 running + 1 trailing
  });

  it("does not coalesce across different repos", async () => {
    const cwds: string[] = [];
    const sync = createDoltSync(async (cwd, args) => {
      if (args[1] === "commit") cwds.push(cwd);
      return "";
    });
    await Promise.all([sync("/repo-a"), sync("/repo-b")]);
    expect(cwds.sort()).toEqual(["/repo-a", "/repo-b"]);
  });

  it("a failing run rejects its own callers but not the trailing run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "commit") runs += 1;
      if (runs === 1) {
        await gate;
        throw execError({ stderr: "Error: push failed: connection reset" });
      }
      return "";
    });

    const first = sync("/repo");
    const second = sync("/repo");
    release();
    await expect(first).rejects.toThrow(/connection reset/);
    await expect(second).resolves.toBeUndefined();
  });

  it("runs again after a completed sync (no stale in-flight state)", async () => {
    let runs = 0;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "commit") runs += 1;
      return "";
    });
    await sync("/repo");
    await sync("/repo");
    expect(runs).toBe(2);
  });

  it("a queued pull-only trailing pass upgrades to full when a write nudge arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const passes: string[][][] = [];
    let current: string[][] = [];
    let first = true;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "pull") {
        current = [];
        passes.push(current);
      }
      current.push(args);
      if (first && args[1] === "pull") {
        first = false;
        await gate; // park the first (pull-only) run so requests queue behind it
      }
      return "";
    });

    const heartbeat1 = sync("/repo", "pull"); // in-flight
    const heartbeat2 = sync("/repo", "pull"); // queues a pull-only trailing pass
    const nudge = sync("/repo", "full"); // upgrades the queued pass to full
    expect(nudge).toBe(heartbeat2);

    release();
    await Promise.all([heartbeat1, heartbeat2, nudge]);
    expect(passes).toEqual([
      [["dolt", "pull"]], // the parked heartbeat stayed pull-only
      [
        ["dolt", "pull"],
        ["dolt", "commit"],
        ["dolt", "push"],
      ], // the trailing pass ran as full after the upgrade
    ]);
  });

  it("records syncing → synced status with lastSyncedAt on success", async () => {
    const cwd = `/repo-status-ok-${Math.random()}`;
    const sync = createDoltSync(async () => "");
    await sync(cwd);
    const status = getSyncStatus(cwd);
    expect(status.state).toBe("synced");
    expect(status.lastSyncedAt).toBeTypeOf("number");
    expect(status.lastError).toBeNull();
  });

  it("records failing with the error, keeping lastSyncedAt from the prior success", async () => {
    const cwd = `/repo-status-fail-${Math.random()}`;
    let fail = false;
    const sync = createDoltSync(async () => {
      if (fail) throw execError({ stderr: "Error: push failed: connection reset" });
      return "";
    });
    await sync(cwd);
    const syncedAt = getSyncStatus(cwd).lastSyncedAt;
    fail = true;
    await expect(sync(cwd)).rejects.toThrow(/connection reset/);
    const status = getSyncStatus(cwd);
    expect(status.state).toBe("failing");
    expect(status.lastError).toMatch(/connection reset/);
    expect(status.lastSyncedAt).toBe(syncedAt);

    fail = false; // recovery flips back to synced
    await sync(cwd);
    expect(getSyncStatus(cwd).state).toBe("synced");
    expect(getSyncStatus(cwd).lastError).toBeNull();
  });

  it("records not-wired for a workspace with no remote", async () => {
    const cwd = `/repo-status-unwired-${Math.random()}`;
    const sync = createDoltSync(async () => {
      throw execError({ stderr: "No remote is configured — skipping.\n" });
    });
    await sync(cwd);
    expect(getSyncStatus(cwd).state).toBe("not-wired");
  });

  it("getSyncStatus defaults to unknown for a never-synced cwd", () => {
    expect(getSyncStatus(`/never-${Math.random()}`)).toEqual({
      state: "unknown",
      lastSyncedAt: null,
      lastError: null,
    });
  });
});
