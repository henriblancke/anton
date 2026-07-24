import { NextResponse } from "next/server";

import { getDisplayUsage } from "@/lib/claude/usage";
import { getReadyCountCached } from "@/lib/claude/ready-count";
import { budgetGate, isBehindPace } from "@/lib/jobs/budget";
import { budgetAwareProjectPolicies } from "@/lib/projects";
import { clampPct, type ShapingSignal } from "@/lib/usage";

export const dynamic = "force-dynamic";

/**
 * Backlog-starvation signal for the nav shaping nudge (anton-eklj). Resolves the three conditions
 * server-side — behind weekly pace, quota headroom to burn, and the aggregate ready count — so the
 * client renders a pure decision. Fail-soft like `/api/usage`: no usage read answers `204` and the
 * nudge hides.
 *
 * Pace and headroom are evaluated against each budget-aware project's STORED policy
 * (`budgetAwareProjectPolicies` → `resolveBudgetPolicy`), not a hard-coded default — so an operator
 * who tunes `weeklyTargetPct` / `daytimeReservePct` sees the nudge admit/defer at the same
 * thresholds, and on the same local clock, the per-project governor actually applies. The nudge is
 * a workspace-wide glance, so each reported condition holds when it holds for ANY governed project
 * — but the ready-queue sweep (the expensive `bd` spawn, and the value that lets the nudge fire)
 * only runs when some SINGLE project's policy is both behind pace and admitting: pace slack on one
 * project plus headroom on another means no real governor would burn that slack, so we must not
 * prompt to shape for it.
 *
 * Gated on budget-aware execution being enabled for at least one project (anton-7mpv.1): the nudge
 * is built on the same budget signals the governor uses, so with the feature off everywhere it
 * answers `204` and stays hidden — and the cheap enablement check runs first, before any usage read.
 */
export async function GET() {
  const policies = await budgetAwareProjectPolicies();
  if (policies.length === 0) return new NextResponse(null, { status: 204 });

  const usage = await getDisplayUsage();
  if (!usage) return new NextResponse(null, { status: 204 });

  const now = Date.now();
  const verdicts = policies.map((policy) => ({
    behindPace: isBehindPace(usage, policy, now),
    headroomAvailable: budgetGate(usage, policy, now).admit,
  }));
  const behindPace = verdicts.some((v) => v.behindPace);
  const headroomAvailable = verdicts.some((v) => v.headroomAvailable);
  // Sweep (and thereby allow the nudge to fire — a null readyCount suppresses it) only when both
  // conditions hold under the SAME project's policy: that's the project whose governor would
  // actually spend the idle quota being nudged about.
  const anyGovernorWouldBurn = verdicts.some((v) => v.behindPace && v.headroomAvailable);
  const readyCount = anyGovernorWouldBurn ? await getReadyCountCached() : null;

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
