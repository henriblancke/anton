import { NextResponse } from "next/server";

import { DISMISSED_PAGE, dismissedEscalations } from "@/lib/escalations";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * One page of the dismissed history (PR #261 review): `?offset=50`.
 *
 * The Health page server-renders the first page, and the disclosure that shows it is the ONLY
 * surface carrying `Restore`. That mattered more than a list length suggests: a dismissal is
 * durable, so every row still down is an active suppression, and a row the operator cannot see is a
 * stall anton will never mention again with no affordance to undo it. One bulk call dismisses up to
 * 200 (the collection route's `MAX_IDS`), so overflowing one page is a single click away, not a
 * thousand-storm hypothetical. This route is how the rest stay reachable.
 *
 * Read-only and offset-paged rather than cursor-paged: the list is short, ordered on an indexed
 * column with a total ordering (`dismissedAt`, then `id`), and it is walked by a human clicking
 * "Show older" — the failure a cursor buys protection from (a row inserted mid-walk shifting the
 * window) moves rows toward page 1, which this walk has already passed.
 */
export const GET = withProject<{ slug: string }>(async (request, { project }) => {
  const raw = new URL(request.url).searchParams.get("offset");
  const offset = raw == null ? 0 : Number(raw);
  if (!Number.isInteger(offset) || offset < 0) {
    return NextResponse.json({ error: "offset must be a non-negative integer" }, { status: 400 });
  }

  const { rows, total } = await dismissedEscalations(project.id, {
    limit: DISMISSED_PAGE,
    offset,
  });
  return NextResponse.json({
    dismissed: rows,
    total,
    offset,
    limit: DISMISSED_PAGE,
  });
});
