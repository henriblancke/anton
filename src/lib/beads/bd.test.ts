import { describe, expect, it } from "vitest";
import {
  beads,
  buildUpdateArgs,
  createDoltSync,
  getSyncStatus,
  getSyncStatusToken,
  isBenignSyncOutput,
  isNotWiredOutput,
  LABELS,
  runDoltSync,
  type Bead,
} from "./bd";

const bead = (b: Partial<Bead>): Bead => ({ id: "x", title: "x", status: "open", ...b }) as Bead;

describe("beads.isRunTarget", () => {
  it("accepts an epic (the classic run target)", () => {
    expect(beads.isRunTarget(bead({ issue_type: "epic" }))).toBe(true);
  });

  it("accepts a parentless task or bug (epic-of-one)", () => {
    expect(beads.isRunTarget(bead({ issue_type: "task" }))).toBe(true);
    expect(beads.isRunTarget(bead({ issue_type: "bug" }))).toBe(true);
  });

  it("rejects a task/bug that has a parent — it's a child ticket, run via its epic", () => {
    expect(beads.isRunTarget(bead({ issue_type: "task", parent: "bd-1" }))).toBe(false);
    expect(beads.isRunTarget(bead({ issue_type: "bug", parent_id: "bd-1" }))).toBe(false);
  });

  it("rejects a non-work type (learning, molecule, …) even when parentless", () => {
    expect(beads.isRunTarget(bead({ issue_type: "learning" }))).toBe(false);
    expect(beads.isRunTarget(bead({ issue_type: "molecule" }))).toBe(false);
    expect(beads.isRunTarget(bead({ issue_type: undefined }))).toBe(false);
  });
});

describe("run-lease helpers (anton-jz1)", () => {
  const now = 1_000_000_000_000;

  it("LABELS.runLease stamps an optional owner into the label", () => {
    expect(LABELS.runLease(now)).toBe(`run-lease:${now}`);
    expect(LABELS.runLease(now, "run-abc")).toBe(`run-lease:${now}:run-abc`);
  });

  it("runLeaseExpiry parses both legacy and owner-stamped labels, taking the max", () => {
    expect(beads.runLeaseExpiry(bead({ labels: [`run-lease:${now}`] }))).toBe(now);
    expect(beads.runLeaseExpiry(bead({ labels: [`run-lease:${now}:run-abc`] }))).toBe(now);
    // A lingering older lease can't make a fresher one read as expired.
    expect(
      beads.runLeaseExpiry(
        bead({ labels: [`run-lease:${now - 5}:run-old`, `run-lease:${now}:run-new`] }),
      ),
    ).toBe(now);
    expect(beads.runLeaseExpiry(bead({ labels: ["run-lease:not-a-number"] }))).toBeUndefined();
    expect(beads.runLeaseExpiry(bead({ labels: [] }))).toBeUndefined();
  });

  it("foreignRunLeaseLive: an unexpired lease owned by ANOTHER run reads foreign", () => {
    const b = bead({ labels: [LABELS.runLease(now + 60_000, "run-other")] });
    expect(beads.foreignRunLeaseLive(b, now, "run-mine")).toBe(true);
  });

  it("foreignRunLeaseLive: this run's OWN unexpired lease is not foreign (crash-resume sweep)", () => {
    const b = bead({ labels: [LABELS.runLease(now + 60_000, "run-mine")] });
    expect(beads.foreignRunLeaseLive(b, now, "run-mine")).toBe(false);
  });

  it("foreignRunLeaseLive: an EXPIRED foreign lease reads not-foreign (dead, safe to sweep)", () => {
    const b = bead({ labels: [LABELS.runLease(now - 1_000, "run-other")] });
    expect(beads.foreignRunLeaseLive(b, now, "run-mine")).toBe(false);
  });

  it("foreignRunLeaseLive: an owner-less unexpired lease is conservatively foreign", () => {
    // Legacy/liveness-only publish that recorded no owner — treat as foreign; parking is recoverable.
    const b = bead({ labels: [`run-lease:${now + 60_000}`] });
    expect(beads.foreignRunLeaseLive(b, now, "run-mine")).toBe(true);
  });

  it("foreignRunLeaseLive: no lease at all reads not-foreign", () => {
    expect(beads.foreignRunLeaseLive(bead({ labels: ["stage:implementing"] }), now, "run-mine")).toBe(
      false,
    );
  });

  it("ownRunLeaseLabels: returns only leases stamped with this run's id", () => {
    const mine = LABELS.runLease(now + 60_000, "run-mine");
    const other = LABELS.runLease(now + 60_000, "run-other");
    const b = bead({ labels: ["stage:implementing", mine, other, `run-lease:${now}`] });
    // Only the owner-matched lease is swept; a foreign lease and an owner-less legacy lease are left.
    expect(beads.ownRunLeaseLabels(b, "run-mine")).toEqual([mine]);
  });

  it("ownRunLeaseLabels: no owned lease reads empty", () => {
    const b = bead({ labels: [LABELS.runLease(now + 60_000, "run-other")] });
    expect(beads.ownRunLeaseLabels(b, "run-mine")).toEqual([]);
    expect(beads.ownRunLeaseLabels(bead({ labels: [] }), "run-mine")).toEqual([]);
  });

  it("winsRunLeaseRace: uncontested (only our own lease) proceeds", () => {
    const b = bead({ labels: [LABELS.runLease(now + 60_000, "run-mine")] });
    expect(beads.winsRunLeaseRace(b, now, "run-mine")).toBe(true);
  });

  it("winsRunLeaseRace: no lease at all proceeds", () => {
    expect(beads.winsRunLeaseRace(bead({ labels: ["stage:implementing"] }), now, "run-mine")).toBe(
      true,
    );
  });

  it("winsRunLeaseRace: lower owner wins, higher owner yields (deterministic + symmetric)", () => {
    // Both runs published concurrently, so each sees BOTH leases in the merged label set. The
    // lexicographically-lowest owner keeps the lease; every other colliding run parks.
    const b = bead({
      labels: [LABELS.runLease(now + 60_000, "run-aaa"), LABELS.runLease(now + 60_000, "run-bbb")],
    });
    expect(beads.winsRunLeaseRace(b, now, "run-aaa")).toBe(true);
    expect(beads.winsRunLeaseRace(b, now, "run-bbb")).toBe(false);
  });

  it("winsRunLeaseRace: an EXPIRED foreign lease is not a contender", () => {
    const b = bead({
      labels: [LABELS.runLease(now + 60_000, "run-mine"), LABELS.runLease(now - 1_000, "run-aaa")],
    });
    // run-aaa sorts below run-mine but its lease is dead, so it doesn't cost us the race.
    expect(beads.winsRunLeaseRace(b, now, "run-mine")).toBe(true);
  });

  it("winsRunLeaseRace: an owner-less foreign live lease yields (can't arbitrate)", () => {
    const b = bead({ labels: [`run-lease:${now + 60_000}`, LABELS.runLease(now + 60_000, "run-mine")] });
    expect(beads.winsRunLeaseRace(b, now, "run-mine")).toBe(false);
  });
});

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

  it("a full pass rejects a real (non-first-publish) pull failure before push", async () => {
    const calls: string[][] = [];
    await expect(
      runDoltSync("/repo", async (_cwd, args) => {
        calls.push(args);
        if (args[1] === "pull") throw execError({ stderr: "Error: failed to get remote db\n" });
        return "";
      }),
    ).rejects.toThrow(/bd dolt pull failed [\s\S]*failed to get remote db/);
    expect(calls).toEqual([["dolt", "pull"]]); // never reached commit/push
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
      if (args[1] === "push") {
        runs += 1;
        if (runs === 1) {
          await gate;
          throw execError({ stderr: "Error: push failed: connection reset" });
        }
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
    const healthyToken = getSyncStatusToken(cwd);
    fail = true;
    await expect(sync(cwd)).rejects.toThrow(/connection reset/);
    const status = getSyncStatus(cwd);
    expect(status.state).toBe("failing");
    expect(status.lastError).toMatch(/connection reset/);
    expect(status.lastSyncedAt).toBe(syncedAt);
    expect(getSyncStatusToken(cwd)).not.toBe(healthyToken);

    fail = false; // recovery flips back to synced
    await sync(cwd);
    expect(getSyncStatus(cwd).state).toBe("synced");
    expect(getSyncStatus(cwd).lastError).toBeNull();
    expect(getSyncStatusToken(cwd)).toBe(healthyToken);
  });

  it("records not-wired for a workspace with no remote", async () => {
    const cwd = `/repo-status-unwired-${Math.random()}`;
    const sync = createDoltSync(async () => {
      throw execError({ stderr: "No remote is configured — skipping.\n" });
    });
    await sync(cwd);
    expect(getSyncStatus(cwd).state).toBe("not-wired");
  });

  it("resolves a backstop to a push-retry when ahead and to pull-only otherwise", async () => {
    const cwd = `/backstop-resolve-${Math.random()}`;
    let pushFails = false;
    const calls: string[][] = [];
    const sync = createDoltSync(async (_cwd, args) => {
      calls.push(args);
      if (args[1] === "push" && pushFails) {
        throw execError({ stderr: "Error: push failed: connection reset" });
      }
      return "";
    });

    // The first backstop reconciles the repo with a full pass (its push lands), so it is caught up.
    await sync(cwd, "backstop");
    expect(calls).toContainEqual(["dolt", "push"]);

    // Caught up and reconciled: the backstop drops to pull-only.
    calls.length = 0;
    await sync(cwd, "backstop");
    expect(calls).toEqual([["dolt", "pull"]]);

    // A write-nudged full pass whose push fails leaves the repo ahead of its remote.
    pushFails = true;
    await sync(cwd, "full").catch(() => {});

    // Now the backstop retries the push (still failing → still ahead).
    calls.length = 0;
    await sync(cwd, "backstop").catch(() => {});
    expect(calls).toContainEqual(["dolt", "push"]);

    // Once the push lands the repo is no longer ahead: the backstop drops back to pull-only.
    pushFails = false;
    await sync(cwd, "backstop"); // this retry lands the push, clearing the ahead flag
    calls.length = 0;
    await sync(cwd, "backstop");
    expect(calls).toEqual([["dolt", "pull"]]);
  });

  it("a cold-start backstop reconciles stranded commits even when the in-memory count is 0", async () => {
    // Simulates a restart: a fresh coalescer (empty in-memory backlog) whose local Dolt has commits
    // a crashed process committed but never pushed. The count reads 0, yet the first backstop must
    // still run a full pass so those commits ship — never pull forever without pushing them.
    const cwd = `/backstop-coldstart-${Math.random()}`;
    let pushFails = true;
    const calls: string[][] = [];
    const sync = createDoltSync(async (_cwd, args) => {
      calls.push(args);
      if (args[1] === "push" && pushFails) throw execError({ stderr: "Error: push failed: reset" });
      return "";
    });

    // Count is 0 (nothing recorded this process), yet the very first backstop attempts a push.
    expect(getSyncStatus(cwd).unpushedCount).toBe(0);
    await sync(cwd, "backstop").catch(() => {});
    expect(calls).toContainEqual(["dolt", "push"]);

    // The push still fails, so the repo stays unreconciled: the next backstop keeps trying a full
    // pass rather than lapsing to pull-only and stranding the commits.
    calls.length = 0;
    await sync(cwd, "backstop").catch(() => {});
    expect(calls).toContainEqual(["dolt", "push"]);

    // Once the push lands, the repo is reconciled and the backstop goes quiet (pull-only).
    pushFails = false;
    await sync(cwd, "backstop");
    calls.length = 0;
    await sync(cwd, "backstop");
    expect(calls).toEqual([["dolt", "pull"]]);
  });

  it("a backstop push coalesces behind an in-flight full pass (never a concurrent push)", async () => {
    const cwd = `/backstop-coalesce-${Math.random()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstPushFails = true;
    let park = false;
    let parked = false;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "push" && firstPushFails) {
        firstPushFails = false;
        throw execError({ stderr: "Error: push failed: connection reset" });
      }
      if (args[1] === "commit" && park && !parked) {
        parked = true;
        await gate; // hold the in-flight full pass so a backstop must queue behind it
      }
      return "";
    });

    // Leave the repo ahead: the first full pass commits but its push fails.
    await sync(cwd, "full").catch(() => {});

    park = true;
    const running = sync(cwd, "full"); // parks at commit, before its push
    const backstop = sync(cwd, "backstop"); // ahead → resolves to full → must coalesce, not push now
    const alsoBackstop = sync(cwd, "backstop");
    expect(backstop).toBe(alsoBackstop); // the burst shares ONE trailing pass
    expect(backstop).not.toBe(running); // and does not run concurrently with the in-flight pass

    release();
    await Promise.all([running, backstop, alsoBackstop]);
  });

  it("getSyncStatus defaults to unknown for a never-synced cwd", () => {
    expect(getSyncStatus(`/never-${Math.random()}`)).toEqual({
      state: "unknown",
      lastSyncedAt: null,
      lastPushedAt: null,
      unpushedCount: 0,
      lastError: null,
    });
  });

  it("stamps lastPushedAt and clears the unpushed count when a full pass pushes", async () => {
    const cwd = `/repo-pushed-${Math.random()}`;
    const sync = createDoltSync(async () => "");
    await sync(cwd, "full");
    const status = getSyncStatus(cwd);
    expect(status.lastPushedAt).toBeTypeOf("number");
    expect(status.unpushedCount).toBe(0);
  });

  it("grows the unpushed count per failed push and clears it once a retry lands", async () => {
    const cwd = `/repo-unpushed-${Math.random()}`;
    let pushFails = true;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "push" && pushFails) throw execError({ stderr: "Error: push failed: reset" });
      return "";
    });

    await sync(cwd, "full").catch(() => {});
    expect(getSyncStatus(cwd).unpushedCount).toBe(1);
    await sync(cwd, "full").catch(() => {});
    expect(getSyncStatus(cwd).unpushedCount).toBe(2);

    pushFails = false;
    await sync(cwd, "full");
    expect(getSyncStatus(cwd).unpushedCount).toBe(0);
    expect(getSyncStatus(cwd).lastPushedAt).toBeTypeOf("number");
  });

  it("failed backstop retries do not inflate the unpushed count (one stranded change stays 1)", async () => {
    const cwd = `/repo-backstop-noinflate-${Math.random()}`;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "push") throw execError({ stderr: "Error: push failed: reset" });
      return "";
    });

    // One write-nudged full pass strands a single change locally.
    await sync(cwd, "full").catch(() => {});
    expect(getSyncStatus(cwd).unpushedCount).toBe(1);

    // Every heartbeat backstop resolves to a full push-retry (repo is ahead) and fails, but retries
    // re-attempt the same commit and must never grow the count — a flaky remote can't fake a backlog.
    for (let i = 0; i < 4; i++) await sync(cwd, "backstop").catch(() => {});
    expect(getSyncStatus(cwd).unpushedCount).toBe(1);
  });

  it("a durable push always runs a full push, even caught up where a backstop drops to pull-only", async () => {
    // The durable sync-push job (anton-nowq) must retry the write's push unconditionally — a backstop
    // here would read count 0 on a reconciled repo and pull only, so a failed push would go unretried.
    const cwd = `/repo-push-forces-full-${Math.random()}`;
    const calls: string[][] = [];
    const sync = createDoltSync(async (_cwd, args) => {
      calls.push(args);
      return "";
    });

    // Reconcile with a clean full pass: repo is now caught up (count 0, reconciled).
    await sync(cwd, "full");
    expect(getSyncStatus(cwd).unpushedCount).toBe(0);

    calls.length = 0;
    await sync(cwd, "backstop");
    expect(calls).toEqual([["dolt", "pull"]]); // backstop drops to pull-only here…

    calls.length = 0;
    await sync(cwd, "push");
    expect(calls).toContainEqual(["dolt", "push"]); // …but a durable push still pushes.
  });

  it("a durable push coalescing behind a failing in-flight write pass still retries the push (anton-nowq)", async () => {
    // The race the durable job must survive: it coalesces behind a write full pass and snapshots
    // count 0 BEFORE that push fails. A backstop would have resolved to pull-only and left the failed
    // push unretried; a "push" request resolves to full and lands the retry.
    const cwd = `/repo-push-race-${Math.random()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let arm = false; // hold only the raced write pass, not the reconcile
    let held = false;
    let writePushFails = true;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "commit" && arm && !held) {
        held = true;
        await gate; // hold the in-flight write full pass at commit, before its push
      }
      if (args[1] === "push" && writePushFails && held) {
        writePushFails = false; // only the in-flight write push fails; the coalesced retry lands
        throw execError({ stderr: "Error: push failed: connection reset" });
      }
      return "";
    });

    // Reconcile so the repo reads "caught up" (count 0, reconciled) — where a backstop would pull-only.
    await sync(cwd, "full");
    // Let the coalescer's bookkeeping clear the settled pass from `running` (a trailing .finally), so
    // the next full pass starts fresh rather than coalescing behind the reconcile.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(getSyncStatus(cwd).unpushedCount).toBe(0);

    arm = true;
    const writePass = sync(cwd, "full"); // held at commit; its push will fail
    const durablePush = sync(cwd, "push"); // coalesces as a trailing pass; must resolve to full
    expect(durablePush).not.toBe(writePass);

    release();
    await writePass.catch(() => {}); // its push failed → repo left ahead (count 1)
    await durablePush; // the trailing durable pass retries the push and lands it

    const status = getSyncStatus(cwd);
    expect(status.unpushedCount).toBe(0); // cleared by the retry — not a pull-only no-op
    expect(status.state).toBe("synced");
    expect(status.lastPushedAt).toBeTypeOf("number");
  });

  it("failed durable push retries do not inflate the unpushed count (anton-rn88)", async () => {
    const cwd = `/repo-push-noinflate-${Math.random()}`;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "push") throw execError({ stderr: "Error: push failed: reset" });
      return "";
    });

    // One write-nudged full pass strands a single change locally.
    await sync(cwd, "full").catch(() => {});
    expect(getSyncStatus(cwd).unpushedCount).toBe(1);

    // The durable job retries via "push"; like a backstop, it re-attempts already-counted work and
    // must never grow the count — a flaky remote can't inflate one change into "N unpushed".
    for (let i = 0; i < 4; i++) await sync(cwd, "push").catch(() => {});
    expect(getSyncStatus(cwd).unpushedCount).toBe(1);
  });

  it("a pull-only pass moves lastSyncedAt but not lastPushedAt or the unpushed count", async () => {
    const cwd = `/repo-pull-only-${Math.random()}`;
    let pushFails = true;
    const sync = createDoltSync(async (_cwd, args) => {
      if (args[1] === "push" && pushFails) throw execError({ stderr: "Error: push failed: reset" });
      return "";
    });
    // Leave the repo ahead of its remote (a full push failed), then run a pull-only pass.
    await sync(cwd, "full").catch(() => {});
    expect(getSyncStatus(cwd).unpushedCount).toBe(1);
    pushFails = false; // a push would now succeed, but pull-only must not attempt one
    await sync(cwd, "pull");
    const status = getSyncStatus(cwd);
    expect(status.state).toBe("synced");
    expect(status.lastSyncedAt).toBeTypeOf("number");
    expect(status.lastPushedAt).toBeNull(); // never pushed successfully
    expect(status.unpushedCount).toBe(1); // still ahead — the backlog survives a pull
  });
});
