/**
 * Pipeline plumbing never reads as work — proven against the REAL poured shape (anton-ve2r).
 *
 * A hand-written fixture would only re-assert what we believe `bd mol pour` produces. This suite
 * pours a real molecule from a real formula and lets bd decide the shape: a `molecule` root, typed
 * `task` step children, and one `gate` child per gated step. Everything below is then discovered
 * from bd's own output by TYPE, never by an id this file made up, so it stays honest if bd changes
 * the shape rather than passing against a stale picture of it.
 *
 * Two facts it pins, both measured against bd 1.1.2 and both load-bearing:
 *
 * 1. **Gates are absent from every ordinary listing.** `bd list --status all` does not carry them;
 *    `--type gate` is the only listing that does — which is why `loadAllIssues` reads both. The
 *    `blocks` edge a gate puts on the bead it gates IS carried in the ordinary listing, so without
 *    the second read a RESOLVED gate reads as an open blocker forever (the blocker helpers fail
 *    safe on a blocker missing from the list) and its bead's approve route 409s permanently.
 * 2. **A gate lands wherever it is put.** A poured gate is parented under the molecule root; an
 *    ad-hoc `bd gate create --blocks <bead>` gate is parentless and can be reparented under the
 *    bead it gates. Both live inside a run target's subtree here, and neither may be dispatched,
 *    counted, or rendered.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads, type Bead } from "./beads/bd";
import { loadAllIssues } from "./beads/issues";
import { resetIssueSnapshots } from "./beads/snapshot";
import { getBoard } from "./board";
import { runTickets } from "./ticket-view";
import type { Project } from "./types";

/** A workflow whose steps carry `gate` fields — the only way to make bd pour gate beads. */
const PROBE_FORMULA = {
  formula: "anton-gate-probe",
  description: "Test-only: a workflow with gated steps, so a pour materialises real gate beads.",
  version: 1,
  type: "workflow",
  vars: { name: { description: "what is being shipped", default: "widget" } },
  steps: [
    { id: "build", type: "task", title: "build {{name}}", description: "build it" },
    {
      id: "review",
      type: "task",
      needs: ["build"],
      title: "review {{name}}",
      description: "review it",
      gate: { type: "human", reason: "a human signs this off" },
    },
    {
      id: "ship",
      type: "task",
      needs: ["review"],
      title: "ship {{name}}",
      description: "ship it",
      gate: { type: "timer", timeout: "2h" },
    },
  ],
};

describeBd("gate + molecule beads are never work (real pour)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let project: Project;

  /** The run target the whole poured molecule is hung under. */
  let featureId: string;
  /** The feature's one REAL ticket — the only bead any of these surfaces may show or dispatch. */
  let ticketId: string;
  /** The ad-hoc gate blocking that ticket, reparented under it (a gate inside the run subtree). */
  let adHocGateId: string;
  /** Poured, discovered from bd by type. */
  let moleculeId: string;
  let pouredGateIds: string[];
  let pouredStepIds: string[];

  const bd = (args: string[]): string => execFileSync("bd", args, { cwd: repo, encoding: "utf8" });

  const listByType = (type: string): Bead[] =>
    JSON.parse(bd(["list", "--json", "--limit", "0", "--status", "all", "--type", type]));

  /** Every bead the board and the runner must refuse to treat as work. */
  const plumbing = (): string[] => [moleculeId, ...pouredGateIds, adHocGateId];

  const board = async () => {
    resetIssueSnapshots(); // the raw `bd` calls above bypass the write-through invalidation
    return getBoard(project);
  };

  beforeAll(async () => {
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
    project = {
      id: "x", slug: "tmp", name: "tmp", repoPath: repo,
      defaultBranch: "main", hasBeads: true, createdAt: 0,
    };

    mkdirSync(join(repo, ".beads", "formulas"), { recursive: true });
    writeFileSync(
      join(repo, ".beads", "formulas", `${PROBE_FORMULA.formula}.formula.json`),
      JSON.stringify(PROBE_FORMULA, null, 2),
    );

    featureId = await beads.create(repo, {
      title: "Ship the exporter",
      type: "feature",
      description: "## Goal\nShip it.\n\n## Acceptance\n- [ ] it ships",
    });
    ticketId = await beads.create(repo, {
      title: "Write the exporter",
      type: "task",
      description: "## Goal\nWrite it.\n\n## Acceptance\n- [ ] it is written",
    });
    await beads.link(repo, ticketId, featureId, "parent-child");

    // An ad-hoc gate on the ticket, then parented under it: a gate as deep inside a run target's
    // subtree as one can get, which is the placement the exclusion has to survive.
    adHocGateId = await beads.gateCreate(repo, {
      blocks: ticketId,
      type: "human",
      reason: "an operator signs this off",
    });
    bd(["update", adHocGateId, "--parent", ticketId]);

    bd(["mol", "pour", PROBE_FORMULA.formula, "--var", "name=exporter"]);

    const molecules = listByType("molecule");
    expect(molecules, "the pour materialised exactly one molecule root").toHaveLength(1);
    moleculeId = molecules[0]!.id;
    // Hang the whole poured workflow under the feature — the leak this ticket exists to prevent.
    bd(["update", moleculeId, "--parent", featureId]);

    pouredGateIds = listByType("gate")
      .filter((g) => g.id !== adHocGateId)
      .map((g) => g.id);
    pouredStepIds = listByType("task")
      .filter((t) => beads.parentOf(t) === moleculeId)
      .map((t) => t.id);
  });

  afterAll(() => bdRepo.cleanup());

  it("pours the shape this suite depends on: a molecule root with typed steps AND gate children", () => {
    // If bd ever stops pouring gates, every assertion below would pass vacuously — so pin the shape
    // first, and pin the omission that makes the second read necessary.
    expect(pouredGateIds.length, "one gate bead per gated step").toBe(2);
    expect(pouredStepIds.length, "typed task step children").toBe(3);

    const ordinary = JSON.parse(bd(["list", "--json", "--limit", "0", "--status", "all"])) as Bead[];
    const ordinaryIds = new Set(ordinary.map((b) => b.id));
    expect(
      [...pouredGateIds, adHocGateId].filter((id) => ordinaryIds.has(id)),
      "bd omits gate beads from the ordinary listing — `--type gate` is the only one that carries them",
    ).toEqual([]);
    expect(ordinaryIds.has(moleculeId), "a molecule root IS in the ordinary listing").toBe(true);
  });

  it("reads gates into the raw bead list, so their real status is knowable", async () => {
    const all = await loadAllIssues(repo);
    const byId = new Map(all.map((b) => [b.id, b]));
    for (const id of plumbing()) {
      expect(byId.get(id), `${id} present as data`).toBeDefined();
    }
    expect(all.filter((b) => b.id === adHocGateId), "merged, never doubled").toHaveLength(1);
  });

  it("never renders a gate or molecule as a card, a ticket, or a chip", async () => {
    const { columns, standalone } = await board();
    const cards = Object.values(columns).flat();
    const rendered = new Set([
      ...cards.map((c) => c.id),
      ...cards.flatMap((c) => c.tickets.map((t) => t.id)),
      ...Object.values(standalone).flat().map((s) => s.id),
    ]);

    expect(rendered.has(featureId), "the run target still renders").toBe(true);
    expect(plumbing().filter((id) => rendered.has(id))).toEqual([]);
  });

  it("counts only real tickets — bd mol current counts gates as steps, anton must not", async () => {
    const { columns } = await board();
    const card = Object.values(columns).flat().find((c) => c.id === featureId);

    expect(card, "the feature card").toBeDefined();
    // The poured steps ride on the MOLECULE, whose gates bd sequences — not on the feature the
    // molecule happens to hang under, whose run would dispatch them ungated in one worktree.
    expect(card!.tickets.map((t) => t.id)).toEqual([ticketId]);
  });

  it("never dispatches one as a ticket — the set the runner works through and the PR body lists", async () => {
    const all = await loadAllIssues(repo);
    const dispatched = runTickets(all, featureId).map((b) => b.id);

    expect(dispatched).toEqual([ticketId]);
    expect(dispatched.filter((id) => plumbing().includes(id))).toEqual([]);
    for (const id of plumbing()) {
      const bead = all.find((b) => b.id === id)!;
      expect(beads.isRunTarget(bead, all), `${id} is not runnable on its own`).toBe(false);
      expect(runTickets(all, id), `${id} contains no run of its own`).toEqual([]);
    }
  });

  it("stops blocking its bead once resolved — a gate is a wait, not a permanent blocker", async () => {
    const cardOf = async () =>
      Object.values((await board()).columns).flat().find((c) => c.id === featureId)!;

    // The fail-safe still holds while the gate is genuinely open…
    expect((await cardOf()).blockedBy, "open gate blocks its run target").toContain(adHocGateId);
    expect((await cardOf()).ready).toBe(false);

    bd(["gate", "resolve", adHocGateId]);

    // …and lifts the moment it resolves. Before the gate listing was read, this stayed blocked
    // forever: the gate was absent from the list, so the missing-blocker fail-safe kept it open.
    expect((await cardOf()).blockedBy).toEqual([]);
    expect((await cardOf()).ready).toBe(true);
  });
});
