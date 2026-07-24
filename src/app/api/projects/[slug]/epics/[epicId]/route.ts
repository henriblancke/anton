import { NextResponse } from "next/server";
import { deleteEpic, getEpicDetail, updateEpic } from "@/lib/epic-detail";
import { parseEpicPatch } from "@/lib/epic-patch";
import { notFoundResponse, withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

export const GET = withProject<{ slug: string; epicId: string }>(
  async (_request, { project, params }) => {
    try {
      const detail = await getEpicDetail(project, params.epicId);
      return NextResponse.json({ detail });
    } catch {
      return notFoundResponse("Epic not found");
    }
  },
);

export const PATCH = withProject<{ slug: string; epicId: string }>(
  async (request, { project, params }) => {
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
      const detail = await updateEpic(project, params.epicId, parsed.patch);
      return NextResponse.json({ detail });
    } catch (e) {
      // updateEpic's 404 guard is beads.show, which throws bd's raw "no issue found matching …"; a
      // genuinely missing epic must stay a 404, while a non-lookup failure (disk/write) surfaces as 500.
      const msg = e instanceof Error ? e.message : "";
      if (/not found|no issues? found/i.test(msg)) {
        return notFoundResponse("Epic not found");
      }
      return NextResponse.json({ error: "Failed to update epic" }, { status: 500 });
    }
  },
);

export const DELETE = withProject<{ slug: string; epicId: string }>(
  async (_request, { project, params }) => {
    try {
      await deleteEpic(project, params.epicId);
      return NextResponse.json({ ok: true });
    } catch {
      return notFoundResponse("Epic not found");
    }
  },
);
