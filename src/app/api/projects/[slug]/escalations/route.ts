import { NextResponse } from "next/server";

import { dismissEscalations } from "@/lib/escalation-actions";
import { openEscalations } from "@/lib/escalations";
import { parseJsonBody, withProject } from "../resolve-project";

export const dynamic = "force-dynamic";

/** How many ids one bulk dismissal may carry — a whole storm, and not an unbounded loop of reads. */
const MAX_IDS = 200;

/**
 * Dismiss a SET of escalations in one call (anton-7gxs): `{ action: "dismiss", ids: [...] }`.
 *
 * The collection route rather than a second verb on each row, because "put this whole storm down"
 * is one decision: thirty POSTs would settle thirty rows one at a time, re-render between each, and
 * leave a half-dismissed group behind any failure. It exists at all because the failure mode this
 * feature was built for is a burst — one upstream outage raising one identical alert per job — and
 * a list you can only clear a row at a time is a list nobody clears.
 *
 * Per-row outcomes, never all-or-nothing (see `dismissEscalations`): a row someone else just settled
 * or a kind that cannot be dismissed is reported as skipped, and every other id still lands. The
 * remaining open escalations come back with the response so the page re-renders from the write
 * instead of racing a refetch against it — the same contract the single-row route keeps.
 */
export const POST = withProject<{ slug: string }>(async (request, { project }) => {
  const { body, response: badBody } = await parseJsonBody(request);
  if (badBody) return badBody;

  const payload = body as { action?: unknown; ids?: unknown } | null;
  if (payload?.action !== "dismiss") {
    return NextResponse.json({ error: 'action must be "dismiss"' }, { status: 400 });
  }
  const ids = payload.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "ids must be an array of escalation ids" }, { status: 400 });
  }
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids must name at least one escalation" }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `ids must name at most ${MAX_IDS} escalations` },
      { status: 400 },
    );
  }

  try {
    const result = await dismissEscalations(project, ids as string[]);
    return NextResponse.json({
      dismissed: result.dismissed.length,
      skipped: result.skipped,
      escalations: await openEscalations(project.id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to dismiss the escalations";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
