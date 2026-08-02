/**
 * The primed-session end-to-end (anton-z45e): a worker with NO anton runtime, executing only the
 * commands `.beads/PRIME.md` prints, claims and releases a fixture feature correctly.
 *
 * `claim-verified.integration.test.ts` proves the same protocol through anton's TypeScript seam.
 * This one deliberately shells `bd` the way a plain Claude Code session in another clone would —
 * the docs are the implementation under test, so a protocol that only works via `beads.*` (or a
 * PRIME.md whose commands have drifted from the binary) reddens here.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";

/** The claiming worker; a second actor races it below. */
const ACTOR = "primed-worker";
const RIVAL = "other-machine";

describeBd("a session primed from .beads/PRIME.md alone", () => {
  let sandbox: BdRepo;
  let feature = "";
  let unapproved = "";
  let children: string[] = [];

  /** Every bd call the protocol names, run exactly as printed. */
  const bd = (args: string[], actor?: string): string =>
    execFileSync("bd", args, {
      cwd: sandbox.repo,
      encoding: "utf8",
      env: actor ? { ...process.env, BEADS_ACTOR: actor } : process.env,
    });

  const create = (title: string, type: string, extra: string[] = []): string => {
    const parsed = JSON.parse(bd(["create", title, "--type", type, "--json", ...extra]));
    return (Array.isArray(parsed) ? parsed[0] : parsed).id;
  };

  /** §1 of PRIME.md — the canonical pool query, verbatim. */
  const claimablePool = (): string[] =>
    JSON.parse(bd(["ready", "--label", "approved", "--unassigned", "--json", "--limit", "0"])).map(
      (b: { id: string }) => b.id,
    );

  const assigneeOf = (id: string): string =>
    (JSON.parse(bd(["show", id, "--json"]))[0]?.assignee ?? "").trim();

  beforeAll(() => {
    sandbox = makeBdRepo({ bare: true, initialCommit: true });
    const epic = create("Fixture outcome", "epic", ["--labels", "approved"]);
    feature = create("Fixture feature", "feature", [
      "--labels",
      "approved",
      "--deps",
      `parent-child:${epic}`,
    ]);
    // Children carry `approved` too, so they are in the raw pool until the claim reserves them —
    // the exclusion under test has to come from the protocol, not from an unlabelled fixture.
    children = ["First step", "Second step"].map((t) =>
      create(t, "task", ["--labels", "approved", "--deps", `parent-child:${feature}`]),
    );
    unapproved = create("Not approved yet", "feature");
    // Publish the fixture board once, so the sandbox matches what a worker actually meets: a remote
    // that HAS the board. A never-pushed Dolt remote has no branches, and `bd dolt pull` fails
    // outright on it — the first-publish case anton's sync tolerates, not something the protocol has
    // to teach.
    bd(["dolt", "commit"]);
    bd(["dolt", "push"]);
  });

  afterAll(() => sandbox?.cleanup());

  it("offers the approved, unclaimed feature and withholds unapproved work", () => {
    const pool = claimablePool();
    expect(pool).toContain(feature);
    expect(pool).not.toContain(unapproved);
  });

  it("claims the feature and proves the claim held", () => {
    bd(["dolt", "pull"]);
    bd(["update", feature, "--claim"], ACTOR);
    bd(["dolt", "commit"]);
    bd(["dolt", "push"]);
    // The protocol's 2s settle is skipped: it buys a near-simultaneous rival time to reach the
    // remote, and there is no second writer here. Every step that decides the verdict is run.
    bd(["dolt", "pull"]);
    expect(assigneeOf(feature)).toBe(ACTOR); // step 6 — the only step that makes it trustworthy
  });

  it("refuses a rival's claim and leaves the board untouched", () => {
    expect(() => bd(["update", feature, "--claim"], RIVAL)).toThrow();
    expect(assigneeOf(feature)).toBe(ACTOR);
  });

  it("reserves the children, so no other worker is served them", () => {
    for (const child of children) bd(["assign", child, ACTOR]);
    // A reservation, not a claim: the child must still read as open backlog.
    expect(JSON.parse(bd(["show", children[0], "--json"]))[0].status).toBe("open");
    const pool = claimablePool();
    expect(pool).not.toContain(feature);
    for (const child of children) expect(pool).not.toContain(child);
  });

  it("hands the children back when the run releases them", () => {
    for (const child of children) bd(["assign", child, ""]);
    // Releasing the target itself takes both writes: `--claim` also flipped it to in_progress, and a
    // bead left there is out of `bd ready` no matter who owns it.
    bd(["assign", feature, ""]);
    bd(["update", feature, "--status", "open"]);
    for (const child of children) expect(assigneeOf(child)).toBe("");
    const pool = claimablePool();
    expect(pool).toContain(feature);
    for (const child of children) expect(pool).toContain(child);
  });
});
