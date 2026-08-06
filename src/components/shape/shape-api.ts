/**
 * The three network calls the Add-work surface makes: spawn the `/shape` pty, land the accepted
 * draft in backlog, and tear the pty down behind it. Kept out of the panes so both write paths share
 * one failure shape — the route's own `error` message when it sends one, a status-carrying fallback
 * when it doesn't — and so the panes are left sequencing UI rather than fetches.
 */
import type { ShapeDraftFields } from "./shape-draft";

async function postOrThrow(url: string, body: unknown, failure: string): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `${failure} (${res.status})`);
  }
  return res;
}

/** Spawns the `claude` pty. An empty `description` means "no seed", not an empty seed. */
export async function startShapeSession(slug: string, description: string): Promise<string> {
  const res = await postOrThrow(
    `/api/projects/${slug}/sessions/shape`,
    { description: description || undefined },
    "shape session failed",
  );
  // A 200 without an id would leave the surface frozen on the composer while a live pty on the
  // server has no id anyone can track or kill — better to fail loudly and let the caller toast.
  const { sessionId } = (await res.json()) as { sessionId?: string };
  if (!sessionId) throw new Error("shape session failed: no session id in response");
  return sessionId;
}

/** Creates the open, unapproved epic bead from the accepted draft. */
export async function createBacklogEpic(slug: string, fields: ShapeDraftFields): Promise<void> {
  await postOrThrow(
    `/api/projects/${slug}/backlog`,
    {
      title: fields.title.trim(),
      goal: fields.goal.trim(),
      successCriteria: fields.successCriteria.trim(),
      area: fields.area.trim(),
    },
    "create failed",
  );
}

/**
 * Unmounting PtyTerminal only aborts the SSE stream — the live pty (and the `claude` process behind
 * it) outlives the page unless we kill it explicitly. `keepalive` lets the DELETE finish even though
 * the navigation that follows tears this surface down.
 */
export function killShapeSession(slug: string, sessionId: string): void {
  void fetch(`/api/projects/${slug}/sessions/${sessionId}/pty`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => {
    /* best-effort teardown — the pty exits on its own if this never lands */
  });
}

/** Turns a thrown call into toast text: the route's message when it gave one, else the fallback. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message || fallback : fallback;
}
