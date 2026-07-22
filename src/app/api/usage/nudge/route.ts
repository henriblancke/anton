import { NextResponse } from "next/server";

import { getDisplayUsage } from "@/lib/claude/usage";
import { getReadyCountCached } from "@/lib/claude/ready-count";
import { budgetGate, isBehindPace, DEFAULT_BUDGET_POLICY } from "@/lib/jobs/budget";
import { DEFAULT_PROJECT_BUDGET_POLICY, isBudgetAwareEnabledAnywhere } from "@/lib/projects";
import { clampPct, type ShapingSignal } from "@/lib/usage";

export const dynamic = "force-dynamic";

/**
 * Backlog-starvation signal for the nav shaping nudge (anton-eklj). Resolves the three conditions
 * server-side — behind weekly pace, quota headroom to burn, and the aggregate ready count — so the
 * client renders a pure decision. Fail-soft like `/api/usage`: no usage read answers `204` and the
 * nudge hides. This is a workspace-wide glance, so the pace-line uses the global default policy —
 * with every operator-facing knob overridden from `DEFAULT_PROJECT_BUDGET_POLICY`, so the nudge
 * admits/defers at the same thresholds (pace target, daytime reserve, day window, session floor)
 * the per-project governor (`resolveBudgetPolicy`) actually applies. Without that the nudge would
 * suppress itself (40% reserve, 08–22 day window) exactly when the 15%-reserve governor is
 * admitting work — "quota idle but backlog thin" failing to fire when it matters most.
 *
 * The ready-queue sweep only runs when the cheap pace/headroom conditions already hold — otherwise
 * the nudge can't fire, so there's no reason to spawn `bd` on every poll.
 *
 * Gated on budget-aware execution being enabled for at least one project (anton-7mpv.1): the nudge is
 * built on the same budget signals the governor uses, so with the feature off everywhere it answers
 * `204` and stays hidden — and the cheap enablement check runs first, before any usage read.
 */
export async function GET() {
  if (!(await isBudgetAwareEnabledAnywhere())) return new NextResponse(null, { status: 204 });

  const usage = await getDisplayUsage();
  if (!usage) return new NextResponse(null, { status: 204 });

  const now = Date.now();
  const policy = {
    ...DEFAULT_BUDGET_POLICY,
    weeklyTargetPct: DEFAULT_PROJECT_BUDGET_POLICY.weeklyTargetPct,
    daytimeReservePct: DEFAULT_PROJECT_BUDGET_POLICY.daytimeReservePct,
    dayStartHour: DEFAULT_PROJECT_BUDGET_POLICY.dayWindow[0],
    dayEndHour: DEFAULT_PROJECT_BUDGET_POLICY.dayWindow[1],
    minSessionHeadroomPct: DEFAULT_PROJECT_BUDGET_POLICY.minSessionHeadroomPct,
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
