import { NextResponse } from "next/server";
import { addProject, listProjects } from "@/lib/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  const projects = await listProjects();
  return NextResponse.json({ projects });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.repoPath !== "string" || !body.repoPath.trim()) {
    return NextResponse.json({ error: "repoPath is required" }, { status: 400 });
  }

  try {
    const project = await addProject({
      name: typeof body.name === "string" ? body.name : undefined,
      repoPath: body.repoPath,
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add project";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
