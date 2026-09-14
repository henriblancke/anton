/**
 * The settled-proposal record (anton-m29g) over REAL bd, through the read the pass and the settings
 * page actually use.
 *
 * The unit tests synthesize `close_reason` on hand-built beads, so they prove how the record COUNTS
 * a reason but never that a reason survives the round trip. That gap matters in one direction only:
 * every "this close is not a founder verdict" check — a fold, an unattended apply — answers "no" when
 * the field is missing, so a bd that stopped carrying `close_reason` in its LIST output would
 * silently score every fold and every armed write as founder-approved evidence and inflate a kind
 * straight past its bar. This suite is what breaks instead, on the list path (`loadAllIssues`) rather
 * than the single-bead `bd show` path already covered in bd-batch.integration.test.ts.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "@/lib/beads/bd";
import { loadAllIssues } from "@/lib/beads/issues";
import { appliedCloseReason } from "./apply";
import { proposalFingerprint } from "./detections";
import { foldReason } from "./emit";
import { proposalTrackRecord } from "./track-record";

describeBd("proposalTrackRecord (real bd · list path)", () => {
  let repoDir: BdRepo;
  let repo: string;

  beforeAll(() => {
    repoDir = makeBdRepo();
    repo = repoDir.repo;
  });
  afterAll(() => repoDir.cleanup());

  /** A proposal bead of `implied-order`, carrying the fingerprint label the record reads its kind off. */
  const proposal = async (key: string): Promise<{ id: string; fingerprint: string }> => {
    const fingerprint = proposalFingerprint("implied-order", key);
    const id = await beads.create(repo, {
      title: `proposal ${key}`,
      type: "task",
      labels: [fingerprint],
    });
    return { id, fingerprint };
  };

  it("keeps every close reason readable through loadAllIssues, so only founder verdicts count", async () => {
    const approved = await proposal("approved");
    const declined = await proposal("declined");
    const folded = await proposal("folded");
    const armed = await proposal("armed");

    await beads.close(repo, approved.id, appliedCloseReason("re-parented anton-a", "approval"));
    await beads.abandon(repo, declined.id, "not a real ordering");
    await beads.close(repo, folded.id, foldReason(approved.id, folded.fingerprint));
    await beads.close(repo, armed.id, appliedCloseReason("re-parented anton-b", "policy"));

    const board = await loadAllIssues(repo);
    // The load-bearing assertion: the reason survives the LIST read. Without it the three checks
    // below all pass vacuously by counting everything as an apply.
    for (const { id } of [approved, folded, armed]) {
      expect(board.find((b) => b.id === id)?.close_reason ?? "").not.toBe("");
    }

    // One founder apply and one founder decline. The fold and the armed write are anton's own.
    expect(proposalTrackRecord(board)["implied-order"]).toEqual({ settled: 2, applied: 1 });
  });
});
