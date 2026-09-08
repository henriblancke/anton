import { NextResponse } from "next/server";

import { RUN_JOB_TYPE, type BudgetSignal } from "@/lib/budget-line";
import { getBurnAverage, getProjectBurnAverage } from "@/lib/burn";
import { getClaudeUsageCached } from "@/lib/claude/usage";
import { getDb } from "@/lib/db";
import { budgetHeadroom, withQuotaShare } from "@/lib/jobs/budget";
import { budgetAwareQuotaShares, getProjectSettings, resolveBudgetPolicy } from "@/lib/projects";
import { resolveGovernedShare } from "@/lib/quota-share";
import { projectWeeklySpendPct } from "@/lib/quota-spend";
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

  // Carrying the share in force RIGHT NOW (R6.1/R6.4), the same resolution the governor applies at
  // lease time: a lane drawn against the unshared ceiling would show headroom for work the governor
  // is about to defer — and would hide the extra room an idle neighbour's renormalized share buys.
  const share = resolveGovernedShare(project.id, await budgetAwareQuotaShares());
  const policy = withQuotaShare(resolveBudgetPolicy(settings), share.sharePct);

  const usage = await getClaudeUsageCached();
  // The share is spent against this project's own attributed burn, so the lane has to charge the
  // same meter the governor does: the account-wide read above cannot say whose spend it is.
  const projectWeeklyPct = await projectWeeklySpendPct(db, project.id, usage).catch(() => null);
  const headroom = budgetHeadroom(usage, policy, Date.now(), { projectWeeklyPct });
  if (!headroom) return new NextResponse(null, { status: 204 });

  // Each meter is charged at the rate it is spent at, the same split the runner applies: the session
  // and weekly account meters move with every repo, so they take the global per-type average
  // (`valueGateHolds`, and the cap/pace-line the gate reads off `usage.weeklyPct`); the share is
  // spent from THIS project's attributed burn, so it takes the project's own average
  // (`projectWeeklyBurn`). The line picks the weekly rate by which hold binds: charging a cheap
  // project's rate against the account cap would show cards the fleet's burn exhausts sooner, and
  // the reverse for an expensive one.
  const [account, projectAverage] = await Promise.all([
    getBurnAverage(db, RUN_JOB_TYPE),
    getProjectBurnAverage(db, project.id, RUN_JOB_TYPE),
  ]);
  const signal: BudgetSignal = {
    headroom,
    burn: {
      [RUN_JOB_TYPE]: {
        sessionPct: account.sessionAvg,
        weeklyPct: account.weeklyAvg,
        shareWeeklyPct: projectAverage.weeklyAvg,
        seeded: account.seeded || projectAverage.seeded,
      },
    },
  };
  return NextResponse.json(signal, { headers: { "Cache-Control": "private, max-age=30" } });
});
