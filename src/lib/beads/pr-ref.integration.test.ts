/**
 * Real bd round-trip for the PR seam (anton-is7x): setPrRef writes `metadata.pr`, and a `bd show`
 * read (then getPrRef) reads it back. Proves the seam persists to bd's metadata, not `external_ref`.
 * Uses the shared integration harness (real `bd`/`git` subprocesses against a throwaway repo).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./bd";

describeBd("beads.setPrRef / getPrRef (real bd · metadata.pr round-trip)", () => {
  let bdRepo: BdRepo;

  beforeAll(() => {
    bdRepo = makeBdRepo();
  });

  afterAll(() => bdRepo.cleanup());

  it("round-trips a PR ref through metadata.pr, leaving external_ref untouched", async () => {
    const id = await beads.create(bdRepo.repo, { title: "linkable work", type: "task" });

    await beads.setPrRef(bdRepo.repo, id, "gh-77");

    const stored = await beads.show(bdRepo.repo, id);
    expect(stored.metadata?.pr).toBe("gh-77");
    expect(stored.external_ref).toBeFalsy(); // the seam never writes external_ref
    expect(beads.getPrRef(stored)).toBe("gh-77");
  });
});
