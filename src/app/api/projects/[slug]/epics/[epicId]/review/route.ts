import { NextResponse } from "next/server";
import { isMissingBeadError } from "@/lib/beads/bd";
import { getReviewReport } from "@/lib/review-report";
import { withProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * A run target's self-review history (anton-tprv): every round it recorded, and the findings the
 * last one left open.
 *
 * Its own endpoint rather than a field on the epic detail, because it costs a hydrated
 * `bd show --include-comments` and the detail open is deliberately spawn-free (anton-8s1t): the
 * page renders off the warm snapshot and the score series fills in beside it. Per PAGE, never per
 * card — the board's own score reads come off labels already in its snapshot.
 */
export const GET = withProject<{ slug: string; epicId: string }>(
  async (_request, { project, params }) => {
    try {
      return NextResponse.json({ report: await getReviewReport(project.repoPath, params.epicId) });
    } catch (err) {
      // Only bd ANSWERING "no such bead" is a 404. A bd that couldn't answer at all (absent, dolt
      // wedged) is a 500 — reporting it as not-found would tell the founder their target is gone.
      if (isMissingBeadError(err)) {
        return NextResponse.json(
          { error: `Ticket ${params.epicId} not found on the board` },
          { status: 404 },
        );
      }
      console.error(`[review] could not read ${params.epicId}'s review report`, err);
      return NextResponse.json({ error: "Could not read the review report" }, { status: 500 });
    }
  },
);
