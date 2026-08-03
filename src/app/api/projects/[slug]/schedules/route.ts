import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { parseCron } from "@/lib/jobs/cron";
import { systemClock } from "@/lib/jobs/queue";
import {
  DEFAULT_SCHEDULES,
  ensureSchedule,
  listSchedules,
  updateSchedule,
  type ScheduledJobType,
} from "@/lib/schedules";
import { resolveProject } from "../resolve-project";

export const dynamic = "force-dynamic";

/** List a project's schedules so the settings UI shows each automation's real enabled state. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;
  const schedules = await listSchedules(project.id);
  return NextResponse.json({ schedules });
}

/**
 * PATCH { type, cron?, enabled? } — edit one automation's cadence and/or its enabled flag. Either
 * field alone is a valid patch; what is omitted is left as-is. A missing row (e.g. a project added
 * before that schedule type existed) is created rather than silently no-oped — at the SUBMITTED
 * cron, falling back to the default only when the caller sent none; `created: true` says so.
 *
 * The cron is parsed before anything is written, so a bad expression 400s with the parser's own
 * message and leaves the stored row untouched. updateSchedule recomputes nextRunAt off the new
 * cron, and the scheduler re-reads schedules every tick — so an edited cadence takes effect without
 * a restart. The response carries the full row, including that recomputed nextRunAt.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { type, cron, enabled } = body as { type?: unknown; cron?: unknown; enabled?: unknown };
  const known = DEFAULT_SCHEDULES.find((d) => d.type === type);
  if (typeof type !== "string" || !known) {
    return NextResponse.json(
      { error: `Unknown schedule type: ${String(type)}` },
      { status: 400 },
    );
  }
  if (cron !== undefined && typeof cron !== "string") {
    return NextResponse.json({ error: "cron must be a string" }, { status: 400 });
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (cron === undefined && enabled === undefined) {
    return NextResponse.json({ error: "Provide cron and/or enabled" }, { status: 400 });
  }

  let nextCron: string | undefined;
  if (cron !== undefined) {
    nextCron = cron.trim();
    try {
      parseCron(nextCron);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unparseable";
      return NextResponse.json(
        { error: `Invalid cron "${nextCron}": ${detail}` },
        { status: 400 },
      );
    }
  }

  try {
    const db = getDb();
    const existing = (await listSchedules(project.id)).find((s) => s.type === type);
    const id =
      existing?.id ??
      // A type the operator has to opt into stays opt-in when a cron-only PATCH creates its row.
      (await ensureSchedule(db, systemClock, {
        projectId: project.id,
        type: type as ScheduledJobType,
        cron: nextCron ?? known.cron,
        enabled: enabled ?? known.enabled,
      }));
    // ensureSchedule already created the row from this patch; only patch an existing one.
    if (existing) await updateSchedule(db, systemClock, id, { cron: nextCron, enabled });

    const schedule = (await listSchedules(project.id)).find((s) => s.id === id);
    return NextResponse.json({ schedule, created: !existing });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update schedule";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
