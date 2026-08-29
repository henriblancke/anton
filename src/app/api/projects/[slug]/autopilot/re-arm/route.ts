import { NextResponse } from "next/server";

import { currentDisarm, reArmAutopilot } from "@/lib/autopilot-disarm";
import { getDb } from "@/lib/db";
import { systemClock } from "@/lib/jobs/queue";
import { resolveOperator } from "@/lib/operator";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Re-arm this project's autopilot (anton-5c8h): lift the disarm latch, on the record.
 *
 * The actor is resolved SERVER-side from the operator identity every other authored write uses
 * (`resolveOperator` — ANTON_OPERATOR, else global git user.name, else $USER) rather than taken from
 * the request body. A caller-supplied author on the one button that resumes unattended execution
 * would make the audit trail worth exactly nothing.
 *
 * 409 when nothing is latched — a second click, or a header rendered before someone else re-armed.
 * The state is returned either way so the board settles on the server's answer instead of the one
 * the operator was looking at.
 */
export const POST = withProject<{ slug: string }>(async (_request, { project }) => {
  const actor = await resolveOperator();
  if (!actor) {
    return NextResponse.json(
      { error: "anton could not tell who you are — set ANTON_OPERATOR or a global git user.name" },
      { status: 409 },
    );
  }

  const result = await reArmAutopilot(getDb(), systemClock, { projectId: project.id, actor });
  if (!result.ok) {
    return NextResponse.json(
      { error: "This project's autopilot is already armed — nothing was changed" },
      { status: 409 },
    );
  }

  return NextResponse.json({
    rearmedBy: result.actor,
    rearmedAt: result.at,
    reason: result.reason,
    disarm: (await currentDisarm(project.id)) ?? null,
  });
});
