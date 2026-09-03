import { NextResponse } from "next/server";

import { RUN_JOB_TYPE, type BudgetSignal } from "@/lib/budget-line";
import { getBurnAverage } from "@/lib/burn";
import { getClaudeUsageCached } from "@/lib/claude/usage";
import { getDb } from "@/lib/db";
import { budgetHeadroom } from "@/lib/jobs/budget";
import { getProjectSettings, resolveBudgetPolicy } from "@/lib/projects";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * What the Up Next lane's budget line is drawn from (anton-vlom / R3.6): the governor's remaining
 * headroom for THIS project, plus the per-type burn averages the queue is charged at.
 *
 * Resolved server-side because both halves are: the headroom needs the project's stored budget
 * policy and a live usage read, and the averages live in this machine's `burn_samples`. The client
 * only walks the ranked queue against the answer (`budgetLine`).
 *
 * `204 No Content` is the FAIL-OPEN path, and it is the same answer for both of its causes: the
 * project isn't budget-aware (no governor, so no line to draw), or usage is unreadable (a line we
 * cannot justify). Either way the lane omits the line rather than guessing one — the governor admits
 * on a null read, and this surface must not contradict it. The enablement check runs first, before
 * any usage read, so an ungoverned project never spends the shared usage cache on this.
 *
 * The read is the governor's STRICT one ({@link getClaudeUsageCached}), not the nav pill's
 * last-good-tolerant `getDisplayUsage`: a transient null after a high reading would leave the
 * display fallback drawing a line — and marking cards as waiting — at the very moment the governor
 * fails open and starts them. An unreadable meter must produce the documented 204 here.
 */
export const GET = withProject<{ slug: string }>(async (_request, { project }) => {
  const db = getDb();
  const settings = await getProjectSettings(db, project.id);
  if (settings.budgetAware !== true) return new NextResponse(null, { status: 204 });

  const usage = await getClaudeUsageCached();
  const headroom = budgetHeadroom(usage, resolveBudgetPolicy(settings), Date.now());
  if (!headroom) return new NextResponse(null, { status: 204 });

  const average = await getBurnAverage(db, RUN_JOB_TYPE);
  const signal: BudgetSignal = {
    headroom,
    burn: {
      [RUN_JOB_TYPE]: {
        sessionPct: average.sessionAvg,
        weeklyPct: average.weeklyAvg,
        seeded: average.seeded,
      },
    },
  };
  return NextResponse.json(signal, { headers: { "Cache-Control": "private, max-age=30" } });
});
