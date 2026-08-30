import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  beads,
  buildCookArgs,
  buildPruneArgs,
  buildUpdateArgs,
  getSyncStatus,
  getSyncStatusToken,
  isBenignSyncOutput,
  isMissingBeadError,
  isNotWiredOutput,
  LABELS,
  parseCookedFormula,
  runDoltSync,
  SYNC_STALL_MS,
  unclaimableStatus,
  type Bead,
} from "./bd";
import { refreshIssueSnapshot, resetIssueSnapshots } from "./snapshot";
import { createDoltSync } from "./sync-coalescer";

const bead = (b: Partial<Bead>): Bead => ({ id: "x", title: "x", status: "open", ...b }) as Bead;

describe("beads.isRunTarget", () => {
  // The five shapes of the runnable rule (docs/design/2026-07-26-tier-and-linear-ux.md).
  const epic = bead({ id: "e-1", issue_type: "epic" });
  const featureChild = bead({ id: "f-1", issue_type: "feature", parent: "e-1" });
  const taskChild = bead({ id: "t-1", issue_type: "task", parent: "e-1" });

  it("accepts a feature — the tier that owns a worktree and a PR", () => {
    const loose = bead({ id: "f-2", issue_type: "feature" });
    expect(beads.isRunTarget(loose, [loose])).toBe(true);
    // Under its epic it is STILL the run target: the epic above it is the container, not the run.
    expect(beads.isRunTarget(featureChild, [epic, featureChild])).toBe(true);
  });

  it("accepts a parentless task or bug (epic-of-one)", () => {
    const task = bead({ issue_type: "task" });
    const bug = bead({ issue_type: "bug" });
    expect(beads.isRunTarget(task, [task])).toBe(true);
    expect(beads.isRunTarget(bug, [bug])).toBe(true);
  });

  it("rejects a task/bug that has a parent — it's a child ticket, run via its run target", () => {
    const task = bead({ issue_type: "task", parent: "bd-1" });
    const bug = bead({ issue_type: "bug", parent_id: "bd-1" });
    expect(beads.isRunTarget(task, [task])).toBe(false);
    expect(beads.isRunTarget(bug, [bug])).toBe(false);
  });

  it("accepts an epic with no feature children — the legacy run target, byte-identical", () => {
    expect(beads.isRunTarget(epic, [epic, taskChild])).toBe(true);
    expect(beads.isRunTarget(epic, [epic])).toBe(true);
  });

  it("rejects an epic that HAS feature children — it is a container, not a run", () => {
    expect(beads.isRunTarget(epic, [epic, featureChild, taskChild])).toBe(false);
    // A closed feature still makes it a container: the tier is structural, not lifecycle-bound.
    expect(beads.isRunTarget(epic, [epic, { ...featureChild, status: "closed" }])).toBe(false);
  });

  it("rejects a non-work type (chore, learning, molecule, …) even when parentless", () => {
    for (const type of ["chore", "learning", "molecule", undefined]) {
      const b = bead({ issue_type: type });
      expect(beads.isRunTarget(b, [b])).toBe(false);
    }
  });
});

describe("beads.isContainer", () => {
  const epic = bead({ id: "e-1", issue_type: "epic" });

  it("is true for an epic with a feature child — the bead that groups run targets", () => {
    const feature = bead({ id: "f-1", issue_type: "feature", parent: "e-1" });
    expect(beads.isContainer(epic, [epic, feature])).toBe(true);
    // parent_id is the field `bd show` populates; both must count.
    const viaParentId = bead({ id: "f-2", issue_type: "feature", parent_id: "e-1" });
    expect(beads.isContainer(epic, [epic, viaParentId])).toBe(true);
  });

  it("is false for an epic whose children are only tasks/bugs", () => {
    const task = bead({ id: "t-1", issue_type: "task", parent: "e-1" });
    const bug = bead({ id: "b-1", issue_type: "bug", parent: "e-1" });
    expect(beads.isContainer(epic, [epic, task, bug])).toBe(false);
    expect(beads.isContainer(epic, [epic])).toBe(false);
  });

  it("is false for a feature that has children — a feature runs its children, it doesn't group runs", () => {
    const feature = bead({ id: "f-1", issue_type: "feature" });
    const task = bead({ id: "t-1", issue_type: "task", parent: "f-1" });
    const nested = bead({ id: "f-2", issue_type: "feature", parent: "f-1" });
    expect(beads.isContainer(feature, [feature, task])).toBe(false);
    expect(beads.isContainer(feature, [feature, nested])).toBe(false);
  });

  it("does not count a feature parented elsewhere", () => {
    const other = bead({ id: "f-1", issue_type: "feature", parent: "e-2" });
    expect(beads.isContainer(epic, [epic, other])).toBe(false);
  });
});

describe("beads.groupsChildren", () => {
  // The rule execute-epic (which tickets a run works through) and epic-detail (which tickets its
  // page shows) share, so a run and its detail page can't disagree about the target's contents.
  const child = bead({ id: "t-1", issue_type: "task", parent: "f-1" });

  it("an epic always groups — even a childless one (it poisons as a run, exactly as before)", () => {
    const epic = bead({ id: "e-1", issue_type: "epic" });
    expect(beads.groupsChildren(epic, [])).toBe(true);
    expect(beads.groupsChildren(epic, [child])).toBe(true);
  });

  it("a feature groups once tickets are shaped under it", () => {
    const feature = bead({ id: "f-1", issue_type: "feature" });
    expect(beads.groupsChildren(feature, [child])).toBe(true);
  });

  it("a feature with no children IS its own ticket — a leaf, not an empty group", () => {
    expect(beads.groupsChildren(bead({ id: "f-1", issue_type: "feature" }), [])).toBe(false);
  });

  it("a task/bug is always a leaf", () => {
    expect(beads.groupsChildren(bead({ id: "t-9", issue_type: "task" }), [child])).toBe(false);
    expect(beads.groupsChildren(bead({ id: "b-9", issue_type: "bug" }), [])).toBe(false);
  });
});

describe("beads.getPrRef (PR seam, anton-is7x)", () => {
  it("reads the PR pointer from metadata.pr", () => {
    expect(beads.getPrRef(bead({ metadata: { pr: "gh-44" } }))).toBe("gh-44");
  });

  it("prefers metadata.pr over a legacy external_ref", () => {
    expect(beads.getPrRef(bead({ metadata: { pr: "gh-44" }, external_ref: "gh-9" }))).toBe("gh-44");
  });

  it("falls back to a legacy gh-* external_ref until migration (anton-ftar)", () => {
    expect(beads.getPrRef(bead({ external_ref: "gh-9" }))).toBe("gh-9");
    expect(beads.getPrRef(bead({ external_ref: "GH-9" }))).toBe("GH-9");
  });

  it("ignores a non-gh external_ref (a tracker URL is not a PR)", () => {
    expect(beads.getPrRef(bead({ external_ref: "https://tracker.example/ISSUE-7" }))).toBeUndefined();
    expect(beads.getPrRef(bead({ external_ref: "PROJ-42" }))).toBeUndefined();
  });

  it("returns undefined when there is no pointer at all", () => {
    expect(beads.getPrRef(bead({}))).toBeUndefined();
    expect(beads.getPrRef(bead({ metadata: { pr: "" } }))).toBeUndefined();
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

  it("manages `area:` as its own prefix, leaving `domain:` untouched", () => {
    // The two answer different questions — company function vs product surface — so a bead may
    // carry both (.product/decisions/2026-07-26-engine-designator-prefix.md).
    expect(buildUpdateArgs("bd-1", { labels: { area: "ingest" } }, ["domain:eng"])).toEqual([
      "update",
      "bd-1",
      "--add-label",
      "area:ingest",
    ]);
    // Single-valued like every other managed prefix: a new value replaces the old one.
    expect(buildUpdateArgs("bd-1", { labels: { area: "ingest" } }, ["area:ontology"])).toEqual([
      "update",
      "bd-1",
      "--remove-label",
      "area:ontology",
      "--add-label",
      "area:ingest",
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

describe("buildPruneArgs (anton-uobe)", () => {
  it("previews an age window via --older-than + --dry-run by default", () => {
    expect(buildPruneArgs("30d")).toEqual(["prune", "--older-than", "30d", "--dry-run", "--json"]);
    expect(buildPruneArgs("90d")).toEqual(["prune", "--older-than", "90d", "--dry-run", "--json"]);
  });

  it("deletes an age window via --older-than + --force", () => {
    expect(buildPruneArgs("30d", { force: true })).toEqual([
      "prune",
      "--older-than",
      "30d",
      "--force",
      "--json",
    ]);
    expect(buildPruneArgs("90d", { force: true })).toEqual([
      "prune",
      "--older-than",
      "90d",
      "--force",
      "--json",
    ]);
  });

  it("maps 'all closed' to --pattern '*' (bd's everything-closed sweep)", () => {
    expect(buildPruneArgs("all")).toEqual(["prune", "--pattern", "*", "--dry-run", "--json"]);
    expect(buildPruneArgs("all", { force: true })).toEqual([
      "prune",
      "--pattern",
      "*",
      "--force",
      "--json",
    ]);
  });

  it("always scopes: every argv carries --older-than or --pattern (bd's safety gate)", () => {
    for (const age of ["30d", "90d", "all"] as const) {
      for (const force of [false, true]) {
        const args = buildPruneArgs(age, { force });
        expect(args.some((a) => a === "--older-than" || a === "--pattern")).toBe(true);
      }
    }
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

describe("isMissingBeadError", () => {
  // The distinction callers act on: bd ANSWERING that a bead is gone is evidence of a deliberate
  // deletion (refuse to resume it); bd failing to answer is not, and must stay fail-open.
  it("matches bd's not-found exit, on stderr or on the message alone", () => {
    expect(isMissingBeadError(execError({ stderr: 'Error: no issue found matching "anton-e1"' }))).toBe(true);
    expect(isMissingBeadError(execError({ stderr: "no issues found matching the provided IDs" }))).toBe(true);
    expect(isMissingBeadError(new Error("bd: issue anton-e1 not found"))).toBe(true);
  });

  it("does not match a bd that could not answer at all", () => {
    expect(isMissingBeadError(execError({ stderr: "Error 1105: database is locked" }))).toBe(false);
    expect(isMissingBeadError(new Error("bd timed out after 120000ms"))).toBe(false);
    expect(isMissingBeadError(undefined)).toBe(false);
  });

  // A missing RESOURCE is not a missing bead: bd reports a wedged workspace with the same
  // "not found" wording, and reading that as a deletion would settle an escalation as
  // `target-gone` on nothing but an operational failure.
  it("does not match another missing resource reported as 'not found'", () => {
    expect(isMissingBeadError(execError({ stderr: "Error: database not found" }))).toBe(false);
    expect(isMissingBeadError(execError({ stderr: 'schema "beads" not found' }))).toBe(false);
    expect(isMissingBeadError(new Error("bd: executable not found in $PATH"))).toBe(false);
  });
});

describe("unclaimableStatus", () => {
  // The distinction the epic-claim path acts on (anton-e5ix): a status refusal repeats identically
  // forever (park now, name the status), everything else is worth a retry.
  it("returns the status bd named, from stderr or from the message alone", () => {
    expect(
      unclaimableStatus(
        execError({ stderr: "Error claiming anton-f5f3: issue not claimable: status blocked\n" }),
      ),
    ).toBe("blocked");
    expect(unclaimableStatus(execError({ stderr: "issue not claimable: status closed" }))).toBe(
      "closed",
    );
    expect(
      unclaimableStatus(new Error("Command failed: bd\nissue not claimable: status in_progress")),
    ).toBe("in_progress");
  });

  it("ignores failures a retry can clear, and an ownership conflict", () => {
    // "already claimed by" is the take-over branch's business, not a status refusal — classifying it
    // here would poison a run the owner re-read is written to explain.
    expect(
      unclaimableStatus(execError({ stderr: "Error claiming anton-f5f3: issue already claimed by bob" })),
    ).toBeUndefined();
    expect(unclaimableStatus(execError({ stderr: "Error 1105: database is locked" }))).toBeUndefined();
    expect(unclaimableStatus(new Error("bd update --claim exceeded its 60000ms budget"))).toBeUndefined();
    expect(unclaimableStatus(undefined)).toBeUndefined();
  });
});

describe("isNotWiredOutput", () => {
  it("matches only the missing-remote outcome, not a clean working set", () => {
    expect(isNotWiredOutput("No remote is configured — skipping.")).toBe(true);
    expect(isNotWiredOutput("No remotes configured.")).toBe(true);
    // The same condition as bd's PULL words it — a solo board must not read as `failing`.
    expect(
      isNotWiredOutput("Error: fetch from origin/main: Error 1105: no remote\n\nPulling..."),
    ).toBe(true);
    // …but a real fetch failure that merely mentions a remote is not "no remote at all".
    expect(isNotWiredOutput("fetch from origin/main: Error 1105: no remote branch found")).toBe(
      false,
    );
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

  it("waits for an in-flight background board read before taking the Dolt lock (anton-3dpp)", async () => {
    // An embedded board is single-holder: `bd dolt pull` FAILS (it does not queue) while a `bd list`
    // still holds the repo's lock — and the snapshot layer fires those reads un-awaited, including
    // one this engine itself triggers when a pass ends. A pass that starts on top of one is a
    // self-inflicted failure, and a run publishing its lease through it parks as "live elsewhere".
    resetIssueSnapshots();
    let releaseRead!: () => void;
    const read = new Promise<void>((r) => (releaseRead = r));
    void refreshIssueSnapshot("/repo", async () => {
      await read;
      return [];
    });

    const spawned: string[] = [];
    const sync = createDoltSync(async (_cwd, args) => {
      spawned.push(args.join(" "));
      return "";
    });

    const pass = sync("/repo");
    // A full macrotask turn: without the guard the pass reaches `bd dolt pull` well inside this.
    await new Promise((r) => setTimeout(r, 5));
    expect(spawned).toEqual([]); // it must not have: the read still holds the lock

    releaseRead();
    await expect(pass).resolves.toBe("synced");
    expect(spawned).toContain("dolt pull");
    resetIssueSnapshots();
  });

  it("still runs its pass when the background read it waited on FAILED (anton-3dpp)", async () => {
    // The read's rejection is the reader's business — it released the lock either way, so a failed
    // board read must never swallow the push that publishes a run's work.
    resetIssueSnapshots();
    void refreshIssueSnapshot("/repo-read-fails", async () => {
      throw new Error("bd list failed");
    }).catch(() => {});

    const spawned: string[] = [];
    const sync = createDoltSync(async (_cwd, args) => {
      spawned.push(args.join(" "));
      return "";
    });
    await expect(sync("/repo-read-fails")).resolves.toBe("synced");
    expect(spawned).toContain("dolt push");
    resetIssueSnapshots();
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
    await expect(second).resolves.toBe("synced");
  });

  it("resolves the pass's outcome so callers can tell delivery from a not-wired repo", async () => {
    // The durable sync-push job settles on this value: "not-wired" published nothing, so a caller
    // that only saw the promise resolve would mark undelivered work done (anton-x7la review).
    const wired = createDoltSync(async () => "");
    await expect(wired("/repo-wired", "push")).resolves.toBe("synced");

    const bare = createDoltSync(async () => {
      throw execError({ stderr: "No remote is configured — skipping.\n" });
    });
    await expect(bare("/repo-bare", "push")).resolves.toBe("not-wired");
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
      stalledForMs: null,
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

describe("sync stall detection (anton-jfjw.3)", () => {
  /** A bd invocation that never settles — a wedged `bd dolt pull`, the exact failure mode that
   * leaves the registry pinned at `syncing`: it neither resolves nor rejects, so nothing else runs. */
  const wedged = () => new Promise<string>(() => {});

  /** Start a pass that hangs forever, and report when its `syncing` stamp was written. */
  function wedgedPass(): { cwd: string; startedAt: number } {
    const cwd = `/repo-stalled-${Math.random()}`;
    const startedAt = Date.now();
    void createDoltSync(wedged)(cwd); // never settles, by design
    return { cwd, startedAt };
  }

  it("ages a pass pinned at 'syncing' past the window into stalled, carrying how long it's been stuck", () => {
    const { cwd, startedAt } = wedgedPass();
    const now = startedAt + SYNC_STALL_MS + 60_000;
    const status = getSyncStatus(cwd, now);
    expect(status.state).toBe("stalled");
    expect(status.stalledForMs).toBeGreaterThanOrEqual(SYNC_STALL_MS);
  });

  it("leaves a slow-but-live pass under the window reading as syncing — no false alarms", () => {
    const { cwd, startedAt } = wedgedPass();
    const status = getSyncStatus(cwd, startedAt + SYNC_STALL_MS - 60_000);
    expect(status.state).toBe("syncing");
    expect(status.stalledForMs).toBeNull();
  });

  it("logs the stall once per occurrence, not once per read", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { cwd, startedAt } = wedgedPass();
      const now = startedAt + SYNC_STALL_MS + 60_000;
      for (let i = 0; i < 5; i++) getSyncStatus(cwd, now);
      const mine = spy.mock.calls.filter((c) => String(c[0]).includes(cwd));
      expect(mine).toHaveLength(1);
      expect(String(mine[0][0])).toMatch(/stuck in 'syncing'/);
    } finally {
      spy.mockRestore();
    }
  });

  it("surfaces the stall through the board refresh token, and advances it while stuck", () => {
    const { cwd, startedAt } = wedgedPass();
    const healthy = getSyncStatusToken(cwd, startedAt);
    const stalled = getSyncStatusToken(cwd, startedAt + SYNC_STALL_MS + 60_000);
    expect(healthy).toContain("syncing");
    expect(stalled).toContain("stalled");
    // The badge renders a server-computed "stuck Xm" — the token must keep moving or it freezes.
    expect(getSyncStatusToken(cwd, startedAt + SYNC_STALL_MS + 120_000)).not.toBe(stalled);
  });

  it("never announces a stall for a slow pass that COMPLETED — even one that failed", async () => {
    // Recording a failure reads the backlog count while the registry still holds this pass at
    // `syncing`. Reading it through getSyncStatus would fire the wedged log for a pass that
    // actually returned — the stall message exists only for passes that never come back.
    const previous = process.env.ANTON_SYNC_STALL_MS;
    process.env.ANTON_SYNC_STALL_MS = "1";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cwd = `/repo-slow-failure-${Math.random()}`;
      const sync = createDoltSync(async (_cwd, args) => {
        await new Promise((r) => setTimeout(r, 10)); // outlives the stall window, then returns
        if (args[1] === "push") throw execError({ stderr: "Error: push failed: reset" });
        return "";
      });

      await sync(cwd, "full").catch(() => {});
      expect(spy.mock.calls.filter((c) => String(c[0]).includes(cwd))).toHaveLength(0);
      expect(getSyncStatus(cwd).unpushedCount).toBe(1); // the backlog still grows
    } finally {
      spy.mockRestore();
      if (previous === undefined) delete process.env.ANTON_SYNC_STALL_MS;
      else process.env.ANTON_SYNC_STALL_MS = previous;
    }
  });

  it("clears the stall clock when a pass completes, so a later slow pass isn't born stalled", async () => {
    const cwd = `/repo-stall-clear-${Math.random()}`;
    const sync = createDoltSync(async () => "");
    const startedAt = Date.now();
    await sync(cwd);
    // Long past the window, but the pass finished — a synced repo can never read as stalled.
    const status = getSyncStatus(cwd, startedAt + SYNC_STALL_MS * 10);
    expect(status.state).toBe("synced");
    expect(status.stalledForMs).toBeNull();
  });
});

// ── beads.cook: the formula seam (anton-brdg) ──

/**
 * Recorded verbatim from `bd cook <file> --mode=compile --json` on bd 1.1.2 against a six-step
 * anton-run formula (one gate, one `needs` chain). Recorded rather than hand-written so the parser
 * is pinned to bd's ACTUAL output — including the details a hand-written fixture would get wrong:
 * bd sorts each step's keys alphabetically, echoes the absolute `source` path, and reports the
 * formula's name under `formula` (not `name`).
 */
const COOK_COMPILE_JSON = JSON.stringify({
  description: "anton's default run pipeline",
  formula: "anton-run",
  schema_version: 1,
  source: "/repo/.beads/formulas/anton-run.formula.toml",
  steps: [
    { id: "implement", labels: ["step:implement"], title: "Implement {{target}}", type: "task" },
    {
      id: "verify",
      labels: ["step:verify"],
      needs: ["implement"],
      title: "Verify {{target}}",
      type: "task",
    },
    {
      id: "review",
      labels: ["step:review"],
      needs: ["verify"],
      title: "Self-review {{target}}",
      type: "task",
    },
    {
      id: "commit",
      labels: ["step:commit"],
      needs: ["review"],
      title: "Commit {{target}}",
      type: "task",
    },
    {
      gate: { type: "human" },
      id: "signoff",
      needs: ["commit"],
      title: "Human sign-off on {{target}}",
      type: "task",
    },
    {
      id: "pr",
      labels: ["step:pr"],
      needs: ["signoff"],
      title: "Open the PR for {{target}}",
      type: "task",
    },
  ],
  type: "workflow",
  vars: { target: { default: "TODO", description: "The run target bead" } },
  version: 1,
});

/** The same formula recorded from `--mode=runtime --var target=anton-ev6d`: titles substituted. */
const COOK_RUNTIME_JSON = COOK_COMPILE_JSON.replaceAll("{{target}}", "anton-ev6d");

/** An exec that records what it was handed and replays a recorded cook. */
function recordingExec(stdout: string) {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  return {
    calls,
    exec: async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      return stdout;
    },
  };
}

describe("buildCookArgs (anton-brdg)", () => {
  it("cooks compile-time by default: --mode is explicit and --json is always on", () => {
    expect(buildCookArgs(".beads/formulas/anton-run.formula.toml")).toEqual([
      "cook",
      ".beads/formulas/anton-run.formula.toml",
      "--mode=compile",
      "--json",
    ]);
  });

  it("infers runtime mode from vars and passes each as --var k=v", () => {
    expect(buildCookArgs("anton-run", { vars: { target: "anton-ev6d", run: "42" } })).toEqual([
      "cook",
      "anton-run",
      "--mode=runtime",
      "--var",
      "target=anton-ev6d",
      "--var",
      "run=42",
      "--json",
    ]);
  });

  it("honours an explicit runtime mode with no vars (every var must then have a default)", () => {
    expect(buildCookArgs("anton-run", { mode: "runtime" })).toEqual([
      "cook",
      "anton-run",
      "--mode=runtime",
      "--json",
    ]);
  });

  it("passes a value containing '=' through untouched — bd splits on the FIRST '=' only", () => {
    expect(buildCookArgs("anton-run", { vars: { flag: "a=b" } })).toContain("flag=a=b");
  });

  it("rejects compile mode with vars — bd substitutes anyway, so the argv would lie", () => {
    expect(() => buildCookArgs("anton-run", { mode: "compile", vars: { target: "x" } })).toThrow(
      /cannot be combined with vars/,
    );
  });

  it("rejects a variable NAME containing '=' — it would silently set a different variable", () => {
    expect(() => buildCookArgs("anton-run", { vars: { "a=b": "c" } })).toThrow(
      /invalid variable name/,
    );
    expect(() => buildCookArgs("anton-run", { vars: { "": "c" } })).toThrow(/invalid variable name/);
  });

  it("never persists — cooking is a read, and --persist would materialise a proto bead", () => {
    expect(buildCookArgs("anton-run", { vars: { target: "x" } })).not.toContain("--persist");
  });
});

describe("beads.cook (anton-brdg)", () => {
  it("spawns bd in the cwd it was GIVEN, never process.cwd()", async () => {
    const { calls, exec } = recordingExec(COOK_COMPILE_JSON);
    const cwd = "/repos/some-other-project";
    expect(cwd).not.toBe(process.cwd()); // the fallback this test exists to rule out
    await beads.cook(cwd, "anton-run", {}, exec);
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(cwd);
    expect(calls[0].cwd).not.toBe(process.cwd());
  });

  it("builds the expected argv and returns the typed pipeline in declaration order", async () => {
    const { calls, exec } = recordingExec(COOK_COMPILE_JSON);
    const cooked = await beads.cook("/repo", "anton-run", {}, exec);
    expect(calls[0].args).toEqual(["cook", "anton-run", "--mode=compile", "--json"]);
    expect(cooked.formula).toBe("anton-run");
    expect(cooked.source).toBe("/repo/.beads/formulas/anton-run.formula.toml");
    expect(cooked.steps.map((s) => s.id)).toEqual([
      "implement",
      "verify",
      "review",
      "commit",
      "signoff",
      "pr",
    ]);
  });

  it("carries each step's type, labels, needs and gate — callers never parse bd stdout", async () => {
    const { exec } = recordingExec(COOK_COMPILE_JSON);
    const cooked = await beads.cook("/repo", "anton-run", {}, exec);
    expect(cooked.steps[0]).toEqual({
      id: "implement",
      title: "Implement {{target}}",
      type: "task",
      labels: ["step:implement"],
    });
    // The DAG edge the floor validator (anton-6b99) orders steps by.
    expect(cooked.steps[1].needs).toEqual(["implement"]);
    // A gated step: the gate is reported, not resolved (gate verbs are anton-uk95's).
    expect(cooked.steps[4].gate).toEqual({ type: "human" });
    expect(cooked.steps[4].labels).toBeUndefined();
  });

  it("substitutes variables: a runtime cook returns steps with {{var}} resolved", async () => {
    const { calls, exec } = recordingExec(COOK_RUNTIME_JSON);
    const cooked = await beads.cook(
      "/repo",
      "anton-run",
      { vars: { target: "anton-ev6d" } },
      exec,
    );
    expect(calls[0].args).toEqual([
      "cook",
      "anton-run",
      "--mode=runtime",
      "--var",
      "target=anton-ev6d",
      "--json",
    ]);
    expect(cooked.steps.map((s) => s.title)).toEqual([
      "Implement anton-ev6d",
      "Verify anton-ev6d",
      "Self-review anton-ev6d",
      "Commit anton-ev6d",
      "Human sign-off on anton-ev6d",
      "Open the PR for anton-ev6d",
    ]);
    expect(JSON.stringify(cooked)).not.toContain("{{");
  });

  it("propagates bd's failure with its stderr intact — the park message reads it, not a rewrite", async () => {
    await expect(
      beads.cook("/repo", "anton-run", { mode: "runtime" }, async () => {
        throw execError({ stderr: "Error: runtime mode requires all variables to have values\n" });
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("runtime mode requires all variables"),
    });
  });
});

describe("parseCookedFormula (anton-brdg)", () => {
  it("fails loud when bd printed something that is not JSON", () => {
    expect(() => parseCookedFormula("Error: no such formula\n", "anton-run")).toThrow(
      /output was not JSON/,
    );
  });

  it("fails loud on a cooked document with no steps array", () => {
    expect(() => parseCookedFormula(JSON.stringify({ formula: "anton-run" }), "anton-run")).toThrow(
      /no steps array/,
    );
    expect(() => parseCookedFormula(JSON.stringify([]), "anton-run")).toThrow(
      /expected a formula object/,
    );
  });

  it("fails loud on a step with no id — an unidentifiable step can't be dispatched or named", () => {
    const doc = JSON.stringify({
      formula: "anton-run",
      steps: [{ id: "implement" }, { title: "nameless" }],
    });
    expect(() => parseCookedFormula(doc, "anton-run")).toThrow(/step 1 has no id/);
  });

  it("drops empty/malformed optional fields rather than surfacing them as empty values", () => {
    const doc = JSON.stringify({
      formula: "anton-run",
      steps: [{ id: "implement", labels: [], needs: "not-an-array", gate: {} }],
    });
    expect(parseCookedFormula(doc, "anton-run").steps[0]).toEqual({ id: "implement" });
  });

  // bd accepts both spellings and cooks each through verbatim (pinned against a real bd in
  // cook.integration.test.ts). Reading only `needs` would hand the walker a formula with no edges,
  // so a `depends_on` pipeline would run in declaration order — or be rejected by the invariant
  // floor for an ordering the file actually expressed.
  it("normalises `depends_on` into `needs` — bd's other spelling of the same edge", () => {
    const doc = JSON.stringify({
      formula: "anton-run",
      steps: [{ id: "commit", depends_on: ["implement"] }],
    });
    expect(parseCookedFormula(doc, "anton-run").steps[0]).toEqual({
      id: "commit",
      needs: ["implement"],
    });
  });

  it("merges both spellings on one step, deduped — an edge declared twice is still one edge", () => {
    const doc = JSON.stringify({
      formula: "anton-run",
      steps: [{ id: "pr", needs: ["commit", "review"], depends_on: ["commit", "verify"] }],
    });
    expect(parseCookedFormula(doc, "anton-run").steps[0].needs).toEqual([
      "commit",
      "review",
      "verify",
    ]);
  });
});

describe("the bd seam takes cwd explicitly (anton-brdg)", () => {
  it("bd.ts never calls process.cwd() — every verb is told which repo it acts on", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/beads/bd.ts"), "utf8");
    expect(src).not.toContain("process.cwd()");
  });
});
