/**
 * Real bd round-trip for the pickup protocol (anton-9anc). The properties under test are the two no
 * fake board can assert:
 *
 *   - the claimable SET is what a live `bd ready` + a live board actually produce — a blocked
 *     feature really is absent, a container epic really does have feature children;
 *   - two claimers racing the SAME bead against a live Dolt-backed board leave exactly one winner,
 *     and the loser reports the winner without mutating anything.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./bd";

describeBd("the pickup protocol (real bd)", () => {
  let repoDir: BdRepo;
  let repo: string;

  beforeAll(() => {
    repoDir = makeBdRepo();
    repo = repoDir.repo;
  });
  afterAll(() => repoDir.cleanup());

  const claimableIds = async () => (await beads.claimableTargets(repo)).map((t) => t.bead.id);

  it("offers the approved unclaimed features and epics-of-one, and nothing else", async () => {
    const container = await beads.create(repo, {
      title: "container epic",
      type: "epic",
      labels: ["approved"],
    });
    const feature = await beads.create(repo, {
      title: "a feature",
      type: "feature",
      labels: ["approved"],
      deps: [`parent-child:${container}`],
    });
    // A child ticket of that feature — the unit of execution, never distributed on its own.
    await beads.create(repo, {
      title: "a child ticket",
      type: "task",
      labels: ["approved"],
      deps: [`parent-child:${feature}`],
    });
    const standalone = await beads.create(repo, {
      title: "an epic-of-one",
      type: "task",
      labels: ["approved"],
    });
    const unapproved = await beads.create(repo, { title: "unapproved", type: "feature" });
    const claimed = await beads.create(repo, {
      title: "already claimed",
      type: "feature",
      labels: ["approved"],
    });
    await beads.assign(repo, claimed, "someone-else");
    // Blocked by the feature above — bd's own readiness keeps it out of the set.
    const blocked = await beads.create(repo, {
      title: "blocked feature",
      type: "feature",
      labels: ["approved"],
    });
    await beads.link(repo, blocked, feature, "blocks");

    const ids = await claimableIds();

    expect(ids.sort()).toEqual([feature, standalone].sort());
    expect(ids).not.toContain(container); // it has a feature child — each feature runs on its own
    expect(ids).not.toContain(unapproved);
    expect(ids).not.toContain(claimed);
    expect(ids).not.toContain(blocked);
  });

  it("ranks by priority, then by how much open work the target unblocks", async () => {
    const scratch = makeBdRepo();
    try {
      const cwd = scratch.repo;
      const mk = async (title: string, priority: number) => {
        const id = await beads.create(cwd, { title, type: "feature", labels: ["approved"] });
        await beads.update(cwd, id, { priority });
        return id;
      };

      const p0 = await mk("critical", 0);
      const hub = await mk("unblocks two", 2);
      const leaf = await mk("unblocks nothing", 2);
      const waiting = await mk("waits on the hub", 2);
      const alsoWaiting = await mk("also waits on the hub", 2);
      await beads.link(cwd, waiting, hub, "blocks");
      await beads.link(cwd, alsoWaiting, hub, "blocks");

      const targets = await beads.claimableTargets(cwd);

      expect(targets.map((t) => t.bead.id)).toEqual([p0, hub, leaf]);
      expect(targets.map((t) => t.unblocks)).toEqual([0, 2, 0]);
    } finally {
      scratch.cleanup();
    }
  });

  it("leaves exactly one winner when two claimers race the same target", async () => {
    const target = await beads.create(repo, {
      title: "contested feature",
      type: "feature",
      labels: ["approved"],
    });

    const [first, second] = await Promise.all([
      beads.claimVerified(repo, target, "worker-a"),
      beads.claimVerified(repo, target, "worker-b"),
    ]);

    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const winner = results.find((r) => r.ok) as { ok: true; bead: { assignee?: string | null } };
    const loser = results.find((r) => !r.ok);
    const holder = (await beads.show(repo, target)).assignee;

    expect(holder).toBe(winner.bead.assignee);
    // The loser names the winner rather than reporting a failure the caller has to interpret.
    expect(loser).toEqual({ ok: false, reason: "lost", owner: holder });
    // …and the winner really holds it: in_progress, claimed, and out of the claimable set.
    expect((await beads.show(repo, target)).status).toBe("in_progress");
    expect(await claimableIds()).not.toContain(target);
  });

  it("re-claiming your own target verifies clean, and another actor still loses", async () => {
    const target = await beads.create(repo, {
      title: "re-claimed feature",
      type: "feature",
      labels: ["approved"],
    });

    await expect(beads.claimVerified(repo, target, "worker-a")).resolves.toMatchObject({ ok: true });
    // Idempotent for the holder — a retry after an unverified verdict must not fail.
    await expect(beads.claimVerified(repo, target, "worker-a")).resolves.toMatchObject({ ok: true });
    await expect(beads.claimVerified(repo, target, "worker-b")).resolves.toEqual({
      ok: false,
      reason: "lost",
      owner: "worker-a",
    });
  });
});
