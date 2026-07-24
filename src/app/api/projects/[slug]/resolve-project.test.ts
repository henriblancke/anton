/**
 * Unit tests for the shared `[slug]` route prelude (anton-mnxu): `withProject` resolves the
 * project and hands it to the wrapped handler with the awaited params; an unknown slug
 * short-circuits with resolveProject's standard 404 without ever invoking the handler.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const project = { id: "p-1", slug: "known", name: "Known", repoPath: "/tmp/known" };
const getProjectBySlug = vi.fn(async (slug: string) => (slug === "known" ? project : null));
vi.mock("@/lib/projects", () => ({ getProjectBySlug: (slug: string) => getProjectBySlug(slug) }));

const { notFoundResponse, resolveProject, withProject } = await import("./resolve-project");

afterEach(() => vi.clearAllMocks());

describe("withProject", () => {
  const ctx = <P extends { slug: string }>(params: P) => ({ params: Promise.resolve(params) });

  it("resolves the project and passes it to the handler with the awaited params", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const GET = withProject<{ slug: string; epicId: string }>(handler);

    const request = new Request("http://t/epics/e-1");
    const res = await GET(request, ctx({ slug: "known", epicId: "e-1" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith(request, {
      project,
      params: { slug: "known", epicId: "e-1" },
    });
  });

  it("404s on an unknown slug and never invokes the handler", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const GET = withProject<{ slug: string }>(handler);

    const res = await GET(new Request("http://t/x"), ctx({ slug: "never-was" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found" });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("resolveProject", () => {
  it("keeps the custom not-found message for routes that pass one", async () => {
    const { project: none, response } = await resolveProject("gone", "Project not found: gone");
    expect(none).toBeUndefined();
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: "Project not found: gone" });
  });
});

describe("notFoundResponse", () => {
  it("builds the standard { error } 404 body", async () => {
    const res = notFoundResponse("Epic not found");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Epic not found" });
  });
});
