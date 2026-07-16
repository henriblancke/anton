import { NextResponse } from "next/server";
import { getProjectBySlug } from "@/lib/projects";
import { getDb } from "@/lib/db";
import { systemClock } from "@/lib/jobs/queue";
import {
  DEFAULT_SCHEDULES,
  ensureSchedule,
  listSchedules,
  updateSchedule,
  type ScheduledJobType,
} from "@/lib/schedules";

export const dynamic = "force-dynamic";

/** List a project's schedules so the settings UI shows each automation's real enabled state. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const schedules = await listSchedules(project.id);
  return NextResponse.json({ schedules });
}

/**
 * PATCH { type, enabled } — flip one automation's schedules.enabled row. A missing row (e.g. a
 * project added before that schedule type existed) is created with its default cron rather than
 * silently no-oping; `created: true` in the response says so. updateSchedule clears/reseeds
 * nextRunAt, so the scheduler loop stops/starts enqueuing immediately.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { type, enabled } = body as { type?: unknown; enabled?: unknown };
  const known = DEFAULT_SCHEDULES.find((d) => d.type === type);
  if (typeof type !== "string" || !known) {
    return NextResponse.json(
      { error: `Unknown schedule type: ${String(type)}` },
      { status: 400 },
    );
  }
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  try {
    const db = getDb();
    const existing = (await listSchedules(project.id)).find((s) => s.type === type);
    const id =
      existing?.id ??
      (await ensureSchedule(db, systemClock, {
        projectId: project.id,
        type: type as ScheduledJobType,
        cron: known.cron,
        enabled,
      }));
    // ensureSchedule already created the row with the right enabled; only patch an existing one.
    if (existing) await updateSchedule(db, systemClock, id, { enabled });

    const schedule = (await listSchedules(project.id)).find((s) => s.id === id);
    return NextResponse.json({ schedule, created: !existing });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update schedule";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
