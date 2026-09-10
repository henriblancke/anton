import { NextResponse } from "next/server";

import { DISMISSED_PAGE, dismissedEscalations } from "@/lib/escalations";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * One page of the dismissed history (PR #261 review): `?before=…&beforeId=…`.
 *
 * The Health page server-renders the first page, and the disclosure that shows it is the ONLY
 * surface carrying `Restore`. That mattered more than a list length suggests: a dismissal is
 * durable, so every row still down is an active suppression, and a row the operator cannot see is a
 * stall anton will never mention again with no affordance to undo it. One bulk call dismisses up to
 * 200 (the collection route's `MAX_IDS`), so overflowing one page is a single click away, not a
 * thousand-storm hypothetical. This route is how the rest stay reachable.
 *
 * Read-only and cursor-paged: the `(dismissedAt, id)` ordering is total, so a concurrent restore or
 * dismissal cannot shift an offset boundary and strand a still-suppressed row behind it.
 */
export const GET = withProject<{ slug: string }>(async (request, { project }) => {
  const params = new URL(request.url).searchParams;
  const rawBefore = params.get("before");
  const beforeId = params.get("beforeId");
  if ((rawBefore == null) !== (beforeId == null)) {
    return NextResponse.json({ error: "before and beforeId must be supplied together" }, { status: 400 });
  }
  const dismissedAt = rawBefore == null ? undefined : Number(rawBefore);
  if (dismissedAt !== undefined && (!Number.isInteger(dismissedAt) || dismissedAt < 0)) {
    return NextResponse.json({ error: "before must be a non-negative integer" }, { status: 400 });
  }

  const { rows, total } = await dismissedEscalations(project.id, {
    limit: DISMISSED_PAGE,
    before: dismissedAt === undefined || beforeId == null ? undefined : { dismissedAt, id: beforeId },
  });
  const last = rows.at(-1);
  return NextResponse.json({
    dismissed: rows,
    total,
    limit: DISMISSED_PAGE,
    nextCursor:
      last?.dismissedAt == null ? null : { dismissedAt: last.dismissedAt, id: last.id },
  });
});
