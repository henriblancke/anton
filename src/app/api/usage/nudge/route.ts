import { NextResponse } from "next/server";

import { getClaudeUsageCached } from "@/lib/claude/usage";
import { getReadyCountCached } from "@/lib/claude/ready-count";
import { budgetGate, isBehindPace, DEFAULT_BUDGET_POLICY } from "@/lib/jobs/budget";
import { DEFAULT_PROJECT_BUDGET_POLICY } from "@/lib/projects";
import { clampPct, type ShapingSignal } from "@/lib/usage";

export const dynamic = "force-dynamic";

/**
 * Backlog-starvation signal for the nav shaping nudge (anton-eklj). Resolves the three conditions
 * server-side — behind weekly pace, quota headroom to burn, and the aggregate ready count — so the
 * client renders a pure decision. Fail-soft like `/api/usage`: no usage read answers `204` and the
 * nudge hides. This is a workspace-wide glance, so the pace-line uses the global default policy — but
 * with the project default's `weeklyTargetPct`, so the nudge fires at the same pace threshold the
 * per-project governor (`resolveBudgetPolicy`) actually admits work at, instead of a stricter 100%.
 *
 * The ready-queue sweep only runs when the cheap pace/headroom conditions already hold — otherwise
 * the nudge can't fire, so there's no reason to spawn `bd` on every poll.
 */
export async function GET() {
  const usage = await getClaudeUsageCached();
  if (!usage) return new NextResponse(null, { status: 204 });

  const now = Date.now();
  const policy = {
    ...DEFAULT_BUDGET_POLICY,
    weeklyTargetPct: DEFAULT_PROJECT_BUDGET_POLICY.weeklyTargetPct,
  };
  const behindPace = isBehindPace(usage, policy, now);
  const headroomAvailable = budgetGate(usage, policy, now).admit;
  const readyCount = behindPace && headroomAvailable ? await getReadyCountCached() : null;

  const signal: ShapingSignal = {
    behindPace,
    headroomAvailable,
    readyCount,
    weeklyRemainingPct: Math.round(clampPct(100 - usage.weeklyPct)),
  };
  return NextResponse.json(signal, {
    headers: { "Cache-Control": "private, max-age=30" },
  });
}
