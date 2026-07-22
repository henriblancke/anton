import { NextResponse } from "next/server";
import { deleteEpic, getEpicDetail, updateEpic } from "@/lib/epic-detail";
import { parseEpicPatch } from "@/lib/epic-patch";
import { resolveProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  try {
    const detail = await getEpicDetail(project, epicId);
    return NextResponse.json({ detail });
  } catch {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseEpicPatch(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const detail = await updateEpic(project, epicId, parsed.patch);
    return NextResponse.json({ detail });
  } catch (e) {
    // updateEpic's 404 guard is beads.show, which throws bd's raw "no issue found matching …"; a
    // genuinely missing epic must stay a 404, while a non-lookup failure (disk/write) surfaces as 500.
    const msg = e instanceof Error ? e.message : "";
    if (/not found|no issues? found/i.test(msg)) {
      return NextResponse.json({ error: "Epic not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to update epic" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  try {
    await deleteEpic(project, epicId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }
}
