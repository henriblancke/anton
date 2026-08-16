/**
 * Real bd round-trip for the PR seam (anton-is7x): setPrRef writes `metadata.pr`, and a `bd show`
 * read (then getPrRef) reads it back. Proves the seam persists to bd's metadata, not `external_ref`.
 * clearPrRef is proven against real bd on BOTH channels it reads (anton-leit) — including the legacy
 * `gh-*` external_ref, whose clear is a different bd flag (`--external-ref ""`) than the metadata
 * unset, so a partial clear there would leave a pre-migration bead looking in-review forever.
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

    await beads.clearPrRef(bdRepo.repo, stored);
    expect(beads.getPrRef(await beads.show(bdRepo.repo, id))).toBeUndefined();
  });

  it("clears a LEGACY gh- external_ref too — the channel getPrRef still falls back to", async () => {
    const id = await beads.create(bdRepo.repo, { title: "pre-migration work", type: "task" });
    await beads.setExternalRef(bdRepo.repo, id, "gh-42");

    const legacy = await beads.show(bdRepo.repo, id);
    expect(beads.getPrRef(legacy)).toBe("gh-42"); // reads as in-review off external_ref alone

    await beads.clearPrRef(bdRepo.repo, legacy);

    const cleared = await beads.show(bdRepo.repo, id);
    expect(cleared.external_ref).toBeFalsy();
    expect(beads.getPrRef(cleared)).toBeUndefined();
  });

  it("leaves a tracker URL in external_ref alone — it was never the PR channel", async () => {
    const url = "https://linear.app/acme/issue/ABC-123";
    const id = await beads.create(bdRepo.repo, { title: "tracker-linked work", type: "task" });
    await beads.setExternalRef(bdRepo.repo, id, url);
    await beads.setPrRef(bdRepo.repo, id, "gh-99");

    await beads.clearPrRef(bdRepo.repo, await beads.show(bdRepo.repo, id));

    const cleared = await beads.show(bdRepo.repo, id);
    expect(beads.getPrRef(cleared)).toBeUndefined(); // the PR pointer is gone
    expect(cleared.external_ref).toBe(url); // the tracker link is not anton's to drop
  });
});
