/**
 * Real-db + real-bd route test for POST /api/projects/[slug]/epics/[epicId]/approve. Mirrors the
 * graph route test's harness (temp anton.db + real bd repo). Covers the readiness gate: a blocked
 * epic (open cross-epic blocker) must be rejected with 409 *before* any approve/enqueue happens,
 * so a dependent epic can't start before its blocker completes. Skipped when `bd`/`git` are absent.
 *
 * This is the "gating" slice of `approve/route.integration.test.ts` — readiness/blocker/type/404
 * gates and the read-economy cases — split out so it runs in parallel with its sibling
 * `approve-*.route.integration.test.ts` file (anton-0oi).
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { actAs, ctx, executeEpicJobs, setupApproveSuite, type ApproveSuiteCtx } from "../approve.fixture";
import { describeBd, jsonRequest } from "@/lib/testing/integration";

let fileDb: ApproveSuiteCtx["fileDb"];
let bdRepo: ApproveSuiteCtx["bdRepo"];
let repo: string;
let approve: ApproveSuiteCtx["approve"];
// The raw handler, for the one case that needs a hand-built request rather than `approve()`.
let POST: ApproveSuiteCtx["POST"];
let beads: ApproveSuiteCtx["beads"];
let resetOperatorCache: ApproveSuiteCtx["resetOperatorCache"];

describeBd("POST /api/projects/[slug]/epics/[epicId]/approve — gating (temp anton.db + real bd)", () => {
  let blocked = "";
  // A ready epic used to prove the gate reads fresh beads, not a warm board snapshot.
  let ready = "";
  let readyChild = "";
  let externalBlockerChild = "";

  beforeAll(async () => {
    const s = await setupApproveSuite();
    ({
      fileDb,
      bdRepo,
      repo,
      approve,
      POST,
      beads,
      resetOperatorCache,
      blocked,
      ready,
      readyChild,
      externalBlockerChild,
    } = s);
  });

  afterAll(() => {
    fileDb?.cleanup();
    bdRepo?.cleanup();
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  it("409s a blocked epic without approving it", async () => {
    const res = await approve(blocked);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/blocked by/i);

    // The gate must reject *before* tagging: the epic stays un-approved.
    const bead = await beads.show(repo, blocked);
    expect(beads.isApproved(bead)).toBe(false);
  });

  it("re-reads beads before gating, so a blocker added behind a warm snapshot still 409s", async () => {
    // Warm the board snapshot while `ready` has no blockers — the cached view sees it as ready.
    const { allIssues } = await import("@/lib/beads/issues");
    await allIssues(repo);

    // Add the cross-epic `blocks` edge through the raw CLI (mirrors beads.link's args) so the
    // wrapper's snapshot invalidation never fires — exactly the stale-snapshot race under review.
    execFileSync("bd", ["link", readyChild, externalBlockerChild, "--type", "blocks"], {
      cwd: repo,
      stdio: "ignore",
    });

    const res = await approve(ready);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/blocked by/i);

    const bead = await beads.show(repo, ready);
    expect(beads.isApproved(bead)).toBe(false);
  });

  it("enqueues a standalone bug and applies the approved label", async () => {
    // A parentless bug is a run target (epic-of-one) — approval must label + enqueue it, not reject.
    const bug = await beads.create(repo, { title: "Loose bug", type: "bug", acceptance: "- [ ] it works" });
    const res = await approve(bug);
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBeTruthy();
    expect(beads.isApproved(await beads.show(repo, bug))).toBe(true);
  });

  it("defaults a bodyless approval to an immediate run; pacing is opt-in via immediate:false", async () => {
    // Bodyless callers (the ticket dialog's "Approve & run"/"Force run") predate the run-directly
    // flag (anton-d8i4) and promise an immediate run — a missing body must not silently become a
    // paced queue request on a budget-aware project. Only an explicit `immediate: false` opts in.
    const bodyless = await beads.create(repo, { title: "Bodyless-immediate bug", type: "bug", acceptance: "- [ ] it works" });
    const paced = await beads.create(repo, { title: "Opt-in paced bug", type: "bug", acceptance: "- [ ] it works" });

    expect((await approve(bodyless)).status).toBe(200);
    expect((await approve(paced, { immediate: false })).status).toBe(200);

    const payloadOf = async (id: string) => {
      const jobs = await executeEpicJobs(id);
      expect(jobs).toHaveLength(1);
      return JSON.parse(jobs[0].payloadJson ?? "{}") as { bypassBudget?: boolean };
    };
    expect((await payloadOf(bodyless)).bypassBudget).toBe(true);
    // `bypassBudget` is written only when true, so a paced enqueue carries no flag at all.
    expect((await payloadOf(paced)).bypassBudget).toBeUndefined();
  });

  it("returns the post-write approved + assignee in the 200 body, not the retained pre-write snapshot", async () => {
    // Read-after-write: the approve write only marks the board snapshot stale (retaining the
    // pre-write beads), so building the 200 body straight off the stale-tolerant getBoard would echo
    // the old unapproved/unclaimed values — and ClaimControl, which consumes `assignee`, would keep
    // showing no owner until a later poll. The route forces a fresh read before responding, so the
    // body must carry the just-written approval and the auto-claim.
    actAs("anton-test");
    const bug = await beads.create(repo, { title: "Fresh-body bug", type: "bug", acceptance: "- [ ] it works" });
    // Warm the snapshot with the pre-write (unapproved, unclaimed) bead, reproducing the stale-read race.
    const { allIssues } = await import("@/lib/beads/issues");
    await allIssues(repo);

    const res = await approve(bug);
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.approved).toBe(true);
    expect(item.assignee).toBe("anton-test");
  });

  it("409s a standalone task blocked by an open prerequisite, without approving it", async () => {
    // A parentless task/bug is a run target, but a `blocks` edge still gates it — its blockers
    // aren't in the epic-graph rollup, so the route derives them from the target's own edges.
    // Approval enqueues immediately, so a still-blocked standalone must be rejected before labeling.
    const blocker = await beads.create(repo, { title: "Standalone blocker", type: "task", acceptance: "- [ ] it works" });
    const dependent = await beads.create(repo, { title: "Standalone dependent", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, dependent, blocker, "blocks");

    const res = await approve(dependent);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/blocked by/i);
    expect(body.error).toContain(blocker);
    expect(beads.isApproved(await beads.show(repo, dependent))).toBe(false);
  });

  it("enqueues a standalone task once its blocker closes", async () => {
    // The same blocks edge stops gating once the prerequisite is done — the standalone becomes ready.
    const blocker = await beads.create(repo, { title: "Standalone blocker (closes)", type: "task", acceptance: "- [ ] it works" });
    const dependent = await beads.create(repo, { title: "Standalone dependent (ready)", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, dependent, blocker, "blocks");
    await beads.close(repo, blocker);

    const res = await approve(dependent);
    expect(res.status).toBe(200);
    expect(beads.isApproved(await beads.show(repo, dependent))).toBe(true);
  });

  // anton-zztt: a target-level blocker roll-up can't tell "one gated tail child" from "nothing can
  // run", so a single cross-run-gated child used to make the whole run unapprovable while its
  // independent siblings sat idle (issue #58). Approval now gates on the per-child verdict.
  it("approves a partially-gated epic — one child is held, the rest can run", async () => {
    const epic = await beads.create(repo, { title: "Partly gated epic", type: "epic", acceptance: "- [ ] it works" });
    const runnable = await beads.create(repo, { title: "Independent ticket", type: "task", acceptance: "- [ ] it works" });
    const held = await beads.create(repo, { title: "Gated ticket", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, runnable, epic, "parent-child");
    await beads.link(repo, held, epic, "parent-child");

    // The gate: another run target's open ticket, so the block is genuinely cross-run.
    const prereq = await beads.create(repo, { title: "Prerequisite epic", type: "epic", acceptance: "- [ ] it works" });
    const prereqChild = await beads.create(repo, { title: "Prerequisite ticket", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, prereqChild, prereq, "parent-child");
    await beads.link(repo, held, prereqChild, "blocks");

    const res = await approve(epic);
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBeTruthy();
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(true);
  });

  it("409s a run target whose every ticket is held, and does not approve it", async () => {
    // The other half of the same verdict: zero runnable tickets is still a dead card. Approving it
    // would enqueue a run with nothing to dispatch.
    const epic = await beads.create(repo, { title: "Fully gated epic", type: "epic", acceptance: "- [ ] it works" });
    const first = await beads.create(repo, { title: "Gated ticket A", type: "task", acceptance: "- [ ] it works" });
    const second = await beads.create(repo, { title: "Gated ticket B", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, first, epic, "parent-child");
    await beads.link(repo, second, epic, "parent-child");

    const prereq = await beads.create(repo, { title: "Prerequisite epic (all)", type: "epic", acceptance: "- [ ] it works" });
    const prereqChild = await beads.create(repo, { title: "Prerequisite ticket (all)", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, prereqChild, prereq, "parent-child");
    await beads.link(repo, first, prereqChild, "blocks");
    await beads.link(repo, second, prereqChild, "blocks");

    const res = await approve(epic);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/blocked by/i);
    expect(body.error).toContain(prereq);
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(false);
  });

  it("enqueues a real epic with no blockers and applies the approved label", async () => {
    const epic = await beads.create(repo, { title: "Free epic", type: "epic", acceptance: "- [ ] it works" });
    const child = await beads.create(repo, { title: "Free epic child", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, child, epic, "parent-child");
    const res = await approve(epic);
    expect(res.status).toBe(200);
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(true);
  });

  // anton-j9zs: approve is the chokepoint every run target passes, so the bead contract is enforced
  // here — but only its BLOCKING half. Approving a bead the runner would just poison-park is a false
  // green; refusing one over a missing `## Goal` would gate the board on prose.
  it("422s a run target with no Acceptance, names the section, and does not approve it", async () => {
    const unshaped = await beads.create(repo, { title: "Unshaped feature", type: "feature" });
    const res = await approve(unshaped);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain(unshaped);
    expect(body.error).toMatch(/Acceptance/);
    expect(body.error).toContain("bd update --acceptance"); // the error carries the fix
    expect(body.sections).toEqual(["Acceptance"]);
    // Refused before the write: no label, no enqueue — nothing to unwind.
    expect(beads.isApproved(await beads.show(repo, unshaped))).toBe(false);
    expect(await executeEpicJobs(unshaped)).toHaveLength(0);
  });

  it("422s an epic with no Success Criteria — the epic tier's blocking section", async () => {
    // The tiers gate on different sections: an epic is read, not executed, so what it owes is the
    // Success Criteria its features add up to.
    const epic = await beads.create(repo, { title: "Outcome with no criteria", type: "epic" });
    const child = await beads.create(repo, { title: "Its child", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, child, epic, "parent-child");

    const res = await approve(epic);
    expect(res.status).toBe(422);
    expect((await res.json()).sections).toEqual(["Success Criteria"]);
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(false);
  });

  // anton-tier-invariants: the tier taxonomy gates beside the contract. Same severity split — a
  // DEAD bead refuses, a merely wrong shape rides the 200 body.
  it("422s a feature nested under a feature — both are run targets, so it ships twice", async () => {
    const outer = await beads.create(repo, { title: "Outer feature", type: "feature", acceptance: "- [ ] it works" });
    const inner = await beads.create(repo, { title: "Nested feature", type: "feature", acceptance: "- [ ] it works" });
    await beads.link(repo, inner, outer, "parent-child");

    const res = await approve(outer);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain(inner); // the operator is told WHICH bead is misplaced
    expect(body.error).toMatch(/tier structure/i);
    expect(body.rules).toEqual(["feature-under-non-epic"]);
    expect(beads.isApproved(await beads.show(repo, outer))).toBe(false);
    expect(await executeEpicJobs(outer)).toHaveLength(0);
  });

  it("approves a childless, parentless feature and reports both shapes as advisory", async () => {
    // A feature with no tickets is a legitimate single-ticket run (beads.groupsChildren), and a
    // parentless one runs fine — it just shows on no roadmap. Refusing either would strand honest
    // work over shape judgement, so both are heard and neither blocks.
    const solo = await beads.create(repo, { title: "Solo feature", type: "feature", acceptance: "- [ ] it works" });

    const res = await approve(solo);
    expect(res.status).toBe(200);
    const advisory = (await res.json()).advisory.join("\n");
    expect(advisory).toMatch(/no tickets/);
    expect(advisory).toMatch(/no epic parent/);
    expect(beads.isApproved(await beads.show(repo, solo))).toBe(true);
  });

  it("approves a target whose only gaps are advisory, and reports them in the body", async () => {
    // Goal / Context / Out of scope / Verify degrade a run without making it unrunnable. Approval
    // proceeds — and says what's thin, so the gaps are heard once rather than never.
    const thin = await beads.create(repo, { title: "Thin but runnable", type: "bug", acceptance: "- [ ] the flake stops" });
    const res = await approve(thin);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobId).toBeTruthy();
    expect(body.advisory.join("\n")).toMatch(/Goal[\s\S]*Context[\s\S]*Out of scope[\s\S]*Verify/);
    expect(beads.isApproved(await beads.show(repo, thin))).toBe(true);
  });

  it("422s a conformant epic whose open child ticket has no Acceptance, and names the child", async () => {
    // The gate must judge the whole dispatch set, not just the target: execute-epic checks
    // `[target, ...tickets]` and poison-parks on the child, so approving here would write the
    // `approved` label and answer "running" for a run that never reaches a PR — the false green.
    const epic = await beads.create(repo, { title: "Conformant epic", type: "epic", acceptance: "- [ ] it works" });
    const unshaped = await beads.create(repo, { title: "Unshaped child" , type: "task" });
    await beads.link(repo, unshaped, epic, "parent-child");

    const res = await approve(epic);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain(unshaped); // the operator is told WHICH bead to repair
    expect(body.sections).toEqual(["Acceptance"]);
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(false);
    expect(await executeEpicJobs(epic)).toHaveLength(0);
  });

  it("approves an epic whose only non-conformant child is closed — the runner skips it", async () => {
    // A closed ticket is resume-skipped by execute-epic: its agent never runs again, so its missing
    // spec can't strand the run. Gating on it would strand approval on already-delivered work.
    const epic = await beads.create(repo, { title: "Epic with delivered child", type: "epic", acceptance: "- [ ] it works" });
    const done = await beads.create(repo, { title: "Delivered child", type: "task" });
    const open = await beads.create(repo, { title: "Remaining child", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, done, epic, "parent-child");
    await beads.link(repo, open, epic, "parent-child");
    await beads.close(repo, done);

    const res = await approve(epic);
    expect(res.status).toBe(200);
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(true);
  });

  it("reports a child's advisory gaps in the 200 body without refusing the approval", async () => {
    // Advisory gaps degrade a run, they don't stop it — but they're the operator's to hear, and a
    // thin CHILD is exactly what the target-only check used to swallow.
    const epic = await beads.create(repo, {
      title: "Well-shaped epic",
      type: "epic",
      acceptance: "- [ ] every child ships",
      description: "Reports leave the app in a format a customer can open.",
      labels: ["area:reports"], // an epic owes exactly one — otherwise it carries its own advisory
    });
    const thin = await beads.create(repo, { title: "Thin child", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, thin, epic, "parent-child");

    const res = await approve(epic);
    expect(res.status).toBe(200);
    const body = await res.json();
    // One line per offending bead, each naming its id — across a ticket set, bare messages leave
    // the operator no way to tell WHICH bead is thin.
    expect(body.advisory).toHaveLength(1);
    expect(body.advisory[0]).toContain(thin);
    expect(body.advisory[0]).toMatch(/Goal[\s\S]*Context[\s\S]*Out of scope[\s\S]*Verify/);
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(true);
  });

  it("names every human ticket the run will stop for, however deep it nests", async () => {
    // anton-qfso.2: `agent:human` work is real, approved work the run reaches and then HOLDS for a
    // person. It never refuses the approval — it is what the operator is signing up for, and the
    // only moment they can weigh it is here, not three hours into the run.
    const target = await beads.create(repo, { title: "Feature with human work", type: "feature", acceptance: "- [ ] it works" });
    const agentWork = await beads.create(repo, { title: "Agent ticket", type: "task", acceptance: "- [ ] it works" });
    const personWork = await beads.create(repo, {
      title: "Buy the domain",
      type: "task",
      acceptance: "- [ ] the domain resolves",
      labels: ["agent:human"],
    });
    await beads.link(repo, agentWork, target, "parent-child");
    // A grandchild ships in the same PR, so its gate is this run's gate.
    await beads.link(repo, personWork, agentWork, "parent-child");

    const res = await approve(target);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.humanGates).toEqual([`${personWork} → Buy the domain`]);
    // The target itself is agent work, so the run really does start and hold — absent, not false.
    expect(body).not.toHaveProperty("humanTarget");
    expect(beads.isApproved(await beads.show(repo, target))).toBe(true);
  });

  it("marks a human TARGET as a run that never starts, not one that stops", async () => {
    // PR #214 review: execute-epic poisons a target labelled `agent:human` before it dispatches a
    // single child, so the "anton runs the rest" toast the gate lines earn would be a promise about
    // a run that never begins. The distinction rides in the body, not in the client's guesswork.
    const target = await beads.create(repo, {
      title: "Buy the domain",
      type: "task",
      acceptance: "- [ ] the domain resolves",
      labels: ["agent:human"],
    });

    const res = await approve(target);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.humanGates).toEqual([`${target} → Buy the domain`]);
    expect(body.humanTarget).toBe(true);
  });

  it("marks a human target whose run would dispatch nothing — recovery still hits the poison", async () => {
    // `contractGatedBeads` empties for a grouped target whose children are all closed, which is one
    // of the Force-run recovery shapes the contract gate deliberately lets through. The target-level
    // poison still fires on that re-run, so deriving this from the dispatch set would answer the
    // recovery with silence about the only thing that decides its outcome (PR #214 review).
    const target = await beads.create(repo, {
      title: "Sign the contract",
      type: "feature",
      acceptance: "- [ ] it works",
      labels: ["agent:human"],
    });
    const done = await beads.create(repo, { title: "Shipped ticket", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, done, target, "parent-child");
    await beads.close(repo, done);

    const res = await approve(target);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.humanTarget).toBe(true);
    // No ticket is dispatched, so there is no gate line to name — and none is needed.
    expect(body).not.toHaveProperty("humanGates");
  });

  it("reports the child gates the LOCKED board carries, not the ones the gate read", async () => {
    // PR #214 review: the executor reloads the board and gates on `agent:human` as of the write, so
    // a label that moves between the pre-lock gate read and the claim-locked read must move the
    // report with it — otherwise the toast omits a stop the run will arm, or promises one for work
    // an agent will simply do. Both directions ride the same window; the label flips between the
    // route's two `bd list` reads (its only two — see the read-economy cases below).
    actAs("anton-test");
    const target = await beads.create(repo, { title: "Gates move mid-approval", type: "feature", acceptance: "- [ ] it works" });
    const gains = await beads.create(repo, { title: "Sign the DPA", type: "task", acceptance: "- [ ] it works" });
    const loses = await beads.create(repo, {
      title: "Was human work",
      type: "task",
      acceptance: "- [ ] it works",
      labels: ["agent:human"],
    });
    await beads.link(repo, gains, target, "parent-child");
    await beads.link(repo, loses, target, "parent-child");

    const realList = beads.list.bind(beads);
    let flipped = false;
    // The route takes exactly two board reads — the gate's, then the claim-locked one — so flipping
    // immediately before the second puts the change squarely in the window under test.
    const listSpy = vi.spyOn(beads, "list").mockImplementation(async (cwd, extra) => {
      if (!flipped && listSpy.mock.calls.length === 2) {
        flipped = true;
        await beads.tag(repo, gains, ["agent:human"]);
        await beads.untag(repo, loses, ["agent:human"]);
      }
      return realList(cwd, extra);
    });
    try {
      const res = await approve(target);
      expect(res.status).toBe(200);
      expect((await res.json()).humanGates).toEqual([`${gains} → Sign the DPA`]);
    } finally {
      listSpy.mockRestore();
    }
  });

  it("says nothing about human work on a run that stops for nobody", async () => {
    const target = await beads.create(repo, { title: "All agent work", type: "feature", acceptance: "- [ ] it works" });
    const child = await beads.create(repo, { title: "Agent ticket", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, child, target, "parent-child");

    const res = await approve(target);
    expect(res.status).toBe(200);
    // Absent, not empty: an empty list is still a thing the client has to decide not to say.
    const body = await res.json();
    expect(body).not.toHaveProperty("humanGates");
    expect(body).not.toHaveProperty("humanTarget");
  });

  it("approves a bead repaired since the board last read it — the gate reads fresh", async () => {
    // The contract gate rides the same forced fresh read as the blocker gate: a bead whose
    // Acceptance was written after the board snapshot warmed must approve, not 422 on stale text.
    const repaired = await beads.create(repo, { title: "Repaired feature", type: "feature" });
    const { allIssues } = await import("@/lib/beads/issues");
    await allIssues(repo); // warm the snapshot while it is still non-conformant

    // Write the acceptance through the raw CLI so the wrapper's snapshot invalidation never fires.
    execFileSync("bd", ["update", repaired, "--acceptance", "- [ ] it works"], {
      cwd: repo,
      stdio: "ignore",
    });

    const res = await approve(repaired);
    expect(res.status).toBe(200);
    expect(beads.isApproved(await beads.show(repo, repaired))).toBe(true);
  });

  it("422s a child ticket of an epic, points at its parent, and does not approve it", async () => {
    // A task WITH a parent runs via its epic's PR, never standalone — approving it must be rejected.
    const parentEpic = await beads.create(repo, { title: "Parent epic", type: "epic", acceptance: "- [ ] it works" });
    const child = await beads.create(repo, { title: "Child ticket", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, child, parentEpic, "parent-child");
    const res = await approve(child);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/child ticket/i);
    expect(body.error).toContain(parentEpic); // guidance names the epic to approve instead
    expect(beads.isApproved(await beads.show(repo, child))).toBe(false);
  });

  it("enqueues a feature and applies the approved label", async () => {
    // anton-s67y: a feature is THE run target — one worktree, one PR. Approval must label + enqueue.
    const feature = await beads.create(repo, { title: "Shippable feature", type: "feature", acceptance: "- [ ] it works" });
    const res = await approve(feature);
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBeTruthy();
    expect(beads.isApproved(await beads.show(repo, feature))).toBe(true);
  });

  it("422s a container epic — one with feature children — and points at its features", async () => {
    // Approval is a per-PR gate. An epic that groups features would approve N PRs with one click,
    // so it stops being approvable the moment a feature lands under it. The error must say so.
    const container = await beads.create(repo, { title: "Outcome epic", type: "epic", acceptance: "- [ ] it works" });
    const feature = await beads.create(repo, { title: "Feature under it", type: "feature", acceptance: "- [ ] it works" });
    await beads.link(repo, feature, container, "parent-child");

    const res = await approve(container);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/container/i);
    expect(body.error).toMatch(/feature/i);
    expect(beads.isApproved(await beads.show(repo, container))).toBe(false);
  });

  it("still approves a legacy epic whose only children are tasks — the migration-free clause", async () => {
    const legacy = await beads.create(repo, { title: "Legacy epic", type: "epic", acceptance: "- [ ] it works" });
    const child = await beads.create(repo, { title: "Legacy child", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, child, legacy, "parent-child");

    const res = await approve(legacy);
    expect(res.status).toBe(200);
    expect(beads.isApproved(await beads.show(repo, legacy))).toBe(true);
  });

  it("422s a non-work type (molecule) with an honest error and does not approve it", async () => {
    // `beads.create` only makes epic/task/bug; a non-work type needs the raw CLI.
    const out = execFileSync("bd", ["create", "A molecule", "--type", "molecule", "--json"], {
      cwd: repo,
      encoding: "utf8",
    });
    const molecule = JSON.parse(out).id as string;
    const res = await approve(molecule);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/not runnable/i);
    expect(beads.isApproved(await beads.show(repo, molecule))).toBe(false);
  });

  it("404s an unknown bead id without approving anything", async () => {
    const res = await approve("approvy-nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it("404s with {error} for an unknown slug", async () => {
    const res = await approve(blocked, undefined, "nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  // anton-hwkx: read economy. Approve used to spend up to four `bd list`/`bd show` reads of its own
  // around the single write — a forced list + board build before it, an ownership `show`, then a
  // second forced list + board build after it — with every one of them queued behind the Dolt lock on
  // the operator's critical path. The trimmed path reads once and answers off state it already holds.
  it("spends at most two bd reads on a normal approve", async () => {
    // A target the operator already owns (the UI's Force run / re-approve): the CAS finds the
    // assignee already where it wants it, so the whole request is one forced `bd list` for the
    // readiness gate plus one under-lock re-read — no board refresh after the write, no ownership
    // `show`. The under-lock read is a `bd list` rather than a `bd show` because it re-judges the
    // board SHAPE (has a feature child landed under this target?), not just the assignee — and the
    // CAS reuses it, so re-validating the shape costs no extra spawn.
    actAs("anton-test");
    const epic = await beads.create(repo, { title: "Read-economy epic", type: "epic", acceptance: "- [ ] it works" });
    const child = await beads.create(repo, { title: "Read-economy epic child", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "anton-test");

    // The remote push is fire-and-forget off the response path; stub it so its spawns aren't counted.
    const syncSpy = vi.spyOn(beads, "sync").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(beads, "list");
    const showSpy = vi.spyOn(beads, "show");
    // Count reads as of the approve write — the last step of the approve chain. What follows is the
    // enqueue's own cross-machine liveness gate (liveRunCheck, anton-jz1), a separate concern.
    let readsAtWrite = -1;
    const realTag = beads.tag.bind(beads);
    const tagSpy = vi.spyOn(beads, "tag").mockImplementation(async (cwd, id, labels) => {
      if (id === epic) readsAtWrite = listSpy.mock.calls.length + showSpy.mock.calls.length;
      return realTag(cwd, id, labels);
    });
    try {
      const res = await approve(epic);
      expect(res.status).toBe(200);
      expect(readsAtWrite).toBeLessThanOrEqual(2);
      // The readiness gate + the under-lock re-check; the board build reuses the first, and the CAS
      // reuses the second, so re-validating the shape adds no `bd show` before the write.
      expect(listSpy).toHaveBeenCalledTimes(2);
    } finally {
      tagSpy.mockRestore();
      listSpy.mockRestore();
      showSpy.mockRestore();
      syncSpy.mockRestore();
    }
    // Behaviour is unchanged by the trim: the label landed and the reservation stands.
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
  });

  it("reads for the gate and the lock, and never re-reads the board after the write", async () => {
    // An unclaimed target additionally pays the CAS write chain (assign + its post-write verify
    // read), which is the claim guard and stays. What must NOT come back is a second forced `bd list`
    // for the RESPONSE: the write flags the snapshot pendingWrite, so the client's next poll blocks
    // on a fresh read anyway — and the 200 body still carries the just-written approval + assignee.
    // The two lists both sit BEFORE the write: the readiness gate, then the under-lock shape
    // re-check the approval's correctness rests on.
    actAs("anton-test");
    const epic = await beads.create(repo, { title: "Read-economy unclaimed", type: "epic", acceptance: "- [ ] it works" });
    const child = await beads.create(repo, { title: "Read-economy unclaimed child", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, child, epic, "parent-child");

    const syncSpy = vi.spyOn(beads, "sync").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(beads, "list");
    try {
      const res = await approve(epic);
      expect(res.status).toBe(200);
      const { item } = await res.json();
      expect(item.approved).toBe(true);
      expect(item.assignee).toBe("anton-test");
      expect(listSpy).toHaveBeenCalledTimes(2);
    } finally {
      listSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });

  // The half of the container race the pre-lock gate cannot cover (codex review, PR #151). The
  // Add-work commit (lib/backlog.ts `createDraftFeature`) attaches a feature to an existing epic
  // while holding that epic's write lock — the SAME lock approval takes. When the feature wins the
  // lock, approval's pre-lock run-target verdict is already stale by the time it writes, so the
  // verdict has to be re-taken inside the lock or a container gets labelled `approved` and enqueued
  // for a runner that can only poison-park it.
  it("422s a target that became a container while the approval waited for the lock", async () => {
    actAs("anton-test");
    const epic = await beads.create(repo, { title: "Containerized mid-approval", type: "epic", acceptance: "- [ ] it works" });
    const child = await beads.create(repo, { title: "Its ticket", type: "task", acceptance: "- [ ] it works" });
    await beads.link(repo, child, epic, "parent-child");

    // Synchronization: `request.json()` must fire AFTER `refreshAllIssues` (route.ts:132) populates
    // `allBeads`. The pre-lock gate answers from that snapshot, so releasing the feature write only
    // once the route has ALREADY read the board is what makes the gate see a non-container — leaving
    // the in-lock `loadAllIssues` as the only thing that can catch the now-container, which is the
    // path this test exists to cover. `readApprovalBody` (route.ts:215) sits after both the read and
    // the gate, which makes it a usable signal — but the load-bearing dependency is the board read.
    // Released before the gate, the feature would land first, the PRE-lock gate would 422 it, and
    // this test would pass without exercising the in-lock re-check at all.
    let gatesPassed!: () => void;
    const gatesDone = new Promise<void>((resolve) => (gatesPassed = resolve));

    // The Add-work commit's half of the race, holding the lock FIRST so the approval queues behind it.
    const { withBeadWriteLock } = await import("@/lib/beads/claim-lock");
    const featureLanded = withBeadWriteLock(repo, epic, async () => {
      await gatesDone;
      return beads.create(repo, {
        title: "Feature that containerizes it",
        type: "feature",
        acceptance: "- [ ] it works",
        deps: [`parent-child:${epic}`],
      });
    });

    const request = jsonRequest("POST");
    Object.defineProperty(request, "json", {
      value: async () => {
        gatesPassed();
        await featureLanded;
        return {};
      },
    });

    const res = await POST(request, ctx("approvy", epic));
    await featureLanded;

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/container epic/);
    // Refused before the write: no label, no enqueue — the feature under it is the run target now.
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(false);
    expect(await executeEpicJobs(epic)).toHaveLength(0);
  });

  // Same window, different verdict (PR #214 review). `humanTarget` answers "does a run start at
  // all", and the executor decides that from the label as of the write — so a label landing between
  // the pre-lock read and the locked one must be what the response reports. Taken from the stale
  // read, this approval would tell the operator their run started while the job is already poison.
  // Synchronization mirrors the container race above: the write holds the lock and releases only
  // once the pre-lock gates have answered.
  it("reads humanTarget off the locked bead when the label lands mid-approval", async () => {
    actAs("anton-test");
    const target = await beads.create(repo, {
      title: "Becomes a person's job mid-approval",
      type: "task",
      acceptance: "- [ ] it works",
    });

    let gatesPassed!: () => void;
    const gatesDone = new Promise<void>((resolve) => (gatesPassed = resolve));

    const { withBeadWriteLock } = await import("@/lib/beads/claim-lock");
    const labelLanded = withBeadWriteLock(repo, target, async () => {
      await gatesDone;
      await beads.tag(repo, target, ["agent:human"]);
    });

    const request = jsonRequest("POST");
    Object.defineProperty(request, "json", {
      value: async () => {
        gatesPassed();
        await labelLanded;
        return {};
      },
    });

    const res = await POST(request, ctx("approvy", target));
    await labelLanded;

    expect(res.status).toBe(200);
    expect((await res.json()).humanTarget).toBe(true);
  });
});
