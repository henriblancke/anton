/**
 * Real bd round-trip for the one-time PR-ref backfill (anton-ftar). Seeds a board carrying a legacy
 * `gh-44` external_ref (the pre-cutover PR channel) and a Linear-URL external_ref (a tracker link),
 * then proves the cutover: the gh one lands on metadata.pr with external_ref cleared, the Linear one
 * is untouched, and a second run is a no-op. Uses the shared integration harness (real bd/git).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./bd";
import { migratePrRefs } from "./migrate-pr-ref";

const LINEAR_URL = "https://linear.app/acme/issue/ABC-123";

describeBd("migratePrRefs (real bd · gh- backfill to metadata.pr)", () => {
  let bdRepo: BdRepo;
  let ghId: string;
  let linearId: string;

  beforeAll(async () => {
    bdRepo = makeBdRepo();
    ghId = await beads.create(bdRepo.repo, { title: "in-flight PR", type: "task" });
    await beads.setExternalRef(bdRepo.repo, ghId, "gh-44");
    linearId = await beads.create(bdRepo.repo, { title: "tracker-linked", type: "task" });
    await beads.setExternalRef(bdRepo.repo, linearId, LINEAR_URL);
  });

  afterAll(() => bdRepo.cleanup());

  it("moves the gh- ref to metadata.pr, clears external_ref, and leaves the Linear ref alone", async () => {
    const moved = await migratePrRefs(bdRepo.repo);
    expect(moved).toEqual([{ id: ghId, ref: "gh-44" }]);

    const gh = await beads.show(bdRepo.repo, ghId);
    expect(gh.metadata?.pr).toBe("gh-44");
    expect(gh.external_ref).toBeFalsy(); // cleared for the gh- ref
    expect(beads.getPrRef(gh)).toBe("gh-44");

    const linear = await beads.show(bdRepo.repo, linearId);
    expect(linear.external_ref).toBe(LINEAR_URL); // tracker link untouched
    expect(linear.metadata?.pr).toBeFalsy();
  });

  it("is idempotent — a second run migrates nothing and preserves both beads", async () => {
    const moved = await migratePrRefs(bdRepo.repo);
    expect(moved).toEqual([]);

    const gh = await beads.show(bdRepo.repo, ghId);
    expect(gh.metadata?.pr).toBe("gh-44");
    expect(gh.external_ref).toBeFalsy();

    const linear = await beads.show(bdRepo.repo, linearId);
    expect(linear.external_ref).toBe(LINEAR_URL);
  });
});
