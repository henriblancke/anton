import { NextResponse } from "next/server";
import { DEFAULT_SCHEDULES } from "@/lib/schedules";
import { runScheduleNow } from "@/lib/jobs/service";
import { withProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * POST — fire one automation's job right now, outside its cron (Settings → Automation's "Run
 * now"). Requires the automation to already have a row AND be enabled: unlike the schedules PATCH
 * route, this never creates a row or turns one on — the switch is the one place an operator decides
 * whether a type may run at all, and "Run now" is not a second way to reach that decision.
 *
 * 404 unknown type or no schedule row yet; 409 `{ error, reason }` when the automation is off or a
 * job of this type is already active for the project (the runner's own inflight coalescing, mirrored
 * here so a click can't double-fire a pass that's already running); 200 `{ jobId }` on success.
 */
export const POST = withProject<{ slug: string; type: string }>(
  async (_request, { project, params }) => {
    const known = DEFAULT_SCHEDULES.find((d) => d.type === params.type);
    if (!known) {
      return NextResponse.json({ error: `Unknown schedule type: ${params.type}` }, { status: 404 });
    }

    const result = await runScheduleNow(project.id, known.type);
    if (result.ok) {
      return NextResponse.json({ jobId: result.jobId });
    }

    if (result.reason === "not-found") {
      return NextResponse.json(
        { error: `No schedule for ${known.type} yet — enable it first`, reason: result.reason },
        { status: 404 },
      );
    }
    const message =
      result.reason === "disabled"
        ? `${known.type} is off — turn it on to run it manually`
        : result.reason === "already-running"
          ? `${known.type} is already running`
          : "Project is being deleted";
    return NextResponse.json({ error: message, reason: result.reason }, { status: 409 });
  },
);
